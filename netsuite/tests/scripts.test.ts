/**
 * Behaviour tests for each SuiteScript type, using fake N/* modules.
 * These prove the scripts' LOGIC. Real NetSuite behaviour must still be verified in a sandbox.
 */
import { describe, expect, it } from 'vitest';
import { loadSuiteScript } from './harness/amd-loader';
import {
  defaultStubs,
  FakeRecord,
  makeRecordModule,
  makeRuntimeModule,
  makeSearchModule,
  makeTaskModule,
  UserEventType,
} from './harness/ns-stubs';

type Fn = (...args: unknown[]) => unknown;
const bill = (values: Record<string, unknown>, id: number | null = null) =>
  new FakeRecord('vendorbill', id, {
    tranid: 'INV-1',
    usertotal: 100,
    trandate: new Date(2026, 0, 1),
    duedate: new Date(2026, 0, 31),
    entity: 7,
    currency: 1,
    ...values,
  });

describe('User Event: nsd_ue_vendor_bill', () => {
  const load = (stubs = defaultStubs()) =>
    loadSuiteScript<Record<string, Fn>>('user-events/nsd_ue_vendor_bill.js', stubs);

  it('sets integration status PENDING on create', () => {
    const ue = load();
    const rec = bill({});
    ue.beforeSubmit!({ type: 'create', UserEventType, newRecord: rec });
    expect(rec.values.custbody_nsd_int_status).toBe('PENDING');
  });

  it('rejects an invalid bill', () => {
    const ue = load();
    expect(() =>
      ue.beforeSubmit!({ type: 'create', UserEventType, newRecord: bill({ usertotal: 0 }) }),
    ).toThrow(/greater than zero/);
  });

  it('rejects a duplicate vendor invoice number', () => {
    const ue = load(defaultStubs({ 'N/search': makeSearchModule({ count: 1 }) }));
    expect(() => ue.beforeSubmit!({ type: 'create', UserEventType, newRecord: bill({}) })).toThrow(
      /already exists/,
    );
  });

  it('blocks amount changes while payment is in progress', () => {
    const ue = load();
    const oldRecord = bill({ custbody_nsd_pay_in_progress: true }, 5);
    const newRecord = bill({ usertotal: 999 }, 5);
    expect(() => ue.beforeSubmit!({ type: 'edit', UserEventType, newRecord, oldRecord })).toThrow(
      /Locked fields changed: usertotal/,
    );
  });

  it('allows a memo-only inline edit while in progress', () => {
    const ue = load();
    const oldRecord = bill({ custbody_nsd_pay_in_progress: true }, 5);
    const newRecord = new FakeRecord('vendorbill', 5, { memo: 'note' }); // XEDIT: only changed fields
    expect(() => ue.beforeSubmit!({ type: 'xedit', UserEventType, newRecord, oldRecord })).not.toThrow();
  });

  it('writes an integration log only for web-service creates', () => {
    const recordMod = makeRecordModule();
    const ue = load(
      defaultStubs({ 'N/record': recordMod, 'N/runtime': makeRuntimeModule({ context: 'RESTWEBSERVICES' }) }),
    );
    ue.afterSubmit!({ type: 'create', UserEventType, newRecord: bill({}, 11) });
    expect(recordMod.created[0]?.type).toBe('customrecord_nsd_int_log');
    expect(recordMod.created[0]?.values.custrecord_nsd_il_record_id).toBe('11');
  });
});

describe('Client Script: nsd_cs_vendor_bill', () => {
  it('blocks save when rules fail, allows when they pass', () => {
    const alerts: unknown[] = [];
    const cs = loadSuiteScript<Record<string, Fn>>(
      'client/nsd_cs_vendor_bill.js',
      defaultStubs({ 'N/ui/dialog': { alert: (a: unknown) => alerts.push(a) } }),
    );
    expect(cs.saveRecord!({ currentRecord: bill({ tranid: '' }) })).toBe(false);
    expect(alerts).toHaveLength(1);
    expect(cs.saveRecord!({ currentRecord: bill({}) })).toBe(true);
  });
});

describe('Scheduled Script: nsd_ss_stale_payments', () => {
  const results = [1, 2, 3].map((i) => ({
    id: String(i),
    values: { tranid: `B${i}`, custbody_nsd_pay_batch_ref: 'PB-1' },
  }));

  it('logs a warning per stale bill', () => {
    const recordMod = makeRecordModule();
    const ss = loadSuiteScript<Record<string, Fn>>(
      'scheduled/nsd_ss_stale_payments.js',
      defaultStubs({ 'N/record': recordMod, 'N/search': makeSearchModule({ results }) }),
    );
    expect(ss.execute!({})).toEqual({ reported: 3, rescheduled: false });
    expect(recordMod.created).toHaveLength(3);
  });

  it('reschedules itself instead of exceeding governance', () => {
    const task = makeTaskModule();
    const ss = loadSuiteScript<Record<string, Fn>>(
      'scheduled/nsd_ss_stale_payments.js',
      defaultStubs({
        'N/search': makeSearchModule({ results }),
        'N/runtime': makeRuntimeModule({ usage: [5000, 100] }), // second check is below the safety margin
        'N/task': task,
      }),
    );
    expect(ss.execute!({})).toEqual({ reported: 1, rescheduled: true });
    expect(task.submitted).toHaveLength(1);
  });
});

describe('Map/Reduce: nsd_mr_collections', () => {
  const load = (recordMod = makeRecordModule()) =>
    loadSuiteScript<Record<string, Fn>>(
      'map-reduce/nsd_mr_collections.js',
      defaultStubs({ 'N/record': recordMod }),
    );

  const mapCtx = (values: Record<string, unknown>, isRestarted = false) => {
    const written: { key: string; value: string }[] = [];
    return {
      written,
      ctx: {
        isRestarted,
        key: '1',
        value: JSON.stringify({ id: '42', values }),
        write: (w: { key: string; value: string }) => written.push(w),
      },
    };
  };

  it('emits a new stage only when it changes', () => {
    const mr = load();
    const a = mapCtx({
      formulanumeric: '35',
      custbody_nsd_collection_stage: 'REMINDER_1',
      custbody_nsd_dispute: false,
    });
    mr.map!(a.ctx);
    expect(a.written).toEqual([{ key: '42', value: 'REMINDER_2' }]);

    const b = mapCtx({
      formulanumeric: '35',
      custbody_nsd_collection_stage: 'REMINDER_2',
      custbody_nsd_dispute: false,
    });
    mr.map!(b.ctx);
    expect(b.written).toEqual([]);
  });

  it('is restart-safe: processing the same invoice twice gives the same result', () => {
    const mr = load();
    const first = mapCtx({ formulanumeric: '70', custbody_nsd_dispute: false });
    const again = mapCtx({ formulanumeric: '70', custbody_nsd_dispute: false }, true);
    mr.map!(first.ctx);
    mr.map!(again.ctx);
    expect(first.written).toEqual(again.written);
  });

  it('reduce writes the stage with submitFields', () => {
    const recordMod = makeRecordModule();
    const mr = load(recordMod);
    mr.reduce!({ key: '42', values: ['ESCALATED'], write: () => undefined });
    expect(recordMod.submitted).toEqual([
      { type: 'invoice', id: '42', values: { custbody_nsd_collection_stage: 'ESCALATED' } },
    ]);
  });

  it('summarize logs partial failures to the integration log', () => {
    const recordMod = makeRecordModule();
    const mr = load(recordMod);
    const iter = (pairs: [string, string][]) => ({
      iterator: () => ({
        each: (cb: (k: string, v: string) => boolean) => pairs.forEach(([k, v]) => cb(k, v)),
      }),
    });
    const out = mr.summarize!({
      inputSummary: { error: null },
      mapSummary: { errors: iter([['7', 'SSS_USAGE_LIMIT_EXCEEDED']]) },
      reduceSummary: { errors: iter([]) },
      output: iter([
        ['ESCALATED', '1'],
        ['ESCALATED', '2'],
      ]),
    }) as { counts: Record<string, number>; errors: string[] };
    expect(out.counts).toEqual({ ESCALATED: 2 });
    expect(out.errors).toHaveLength(1);
    expect(recordMod.created[0]?.values.custrecord_nsd_il_status).toBe('ERROR');
  });
});

describe('Suitelet: nsd_sl_batch_review', () => {
  it('renders a read-only list and refuses POST', () => {
    const rows: unknown[] = [];
    const serverWidget = {
      SublistType: { LIST: 'LIST' },
      FieldType: { TEXT: 'TEXT' },
      createForm: () => ({
        addSublist: () => ({ addField: () => undefined, setSublistValue: (v: unknown) => rows.push(v) }),
      }),
    };
    const sl = loadSuiteScript<Record<string, Fn>>(
      'suitelets/nsd_sl_batch_review.js',
      defaultStubs({
        'N/ui/serverWidget': serverWidget,
        'N/search': makeSearchModule({
          results: [
            {
              id: '1',
              values: { custrecord_nsd_pb_batch_ref: 'PB-1', custrecord_nsd_pb_status: 'Submitted' },
            },
          ],
        }),
      }),
    );
    let page: unknown;
    sl.onRequest!({
      request: { method: 'GET', parameters: {} },
      response: { writePage: (f: unknown) => (page = f) },
    });
    expect(page).toBeDefined();
    expect(rows).toHaveLength(2); // only non-empty columns are set

    let written = '';
    sl.onRequest!({
      request: { method: 'POST', parameters: {} },
      response: { write: ({ output }: { output: string }) => (written = output) },
    });
    expect(written).toBe('Method not allowed');
  });
});

describe('RESTlet: nsd_rl_integration_status', () => {
  const load = (recordMod = makeRecordModule()) =>
    loadSuiteScript<Record<string, Fn>>(
      'restlets/nsd_rl_integration_status.js',
      defaultStubs({ 'N/record': recordMod }),
    );

  it('updates only allow-listed fields', () => {
    const recordMod = makeRecordModule();
    const rl = load(recordMod);
    rl.put!({ type: 'vendorbill', id: '12', status: 'SYNCED', providerRef: 'BANK-9', usertotal: 1 });
    expect(recordMod.submitted[0]?.values).toEqual({
      custbody_nsd_int_status: 'SYNCED',
      custbody_nsd_provider_ref: 'BANK-9',
    });
  });

  it('rejects disallowed record types, bad ids and bad statuses', () => {
    const rl = load();
    expect(() => rl.put!({ type: 'employee', id: '1', status: 'SYNCED' })).toThrow(/not allowed/);
    expect(() => rl.put!({ type: 'invoice', id: '1 OR 1=1', status: 'SYNCED' })).toThrow(/numeric/);
    expect(() => rl.put!({ type: 'invoice', id: '1', status: 'PAID' })).toThrow(/status must be/);
  });

  it('GET returns the integration fields', () => {
    const recordMod = makeRecordModule();
    recordMod.lookups['invoice:5'] = { custbody_nsd_int_status: 'ERROR', custbody_nsd_error_detail: 'boom' };
    const rl = load(recordMod);
    expect(rl.get!({ type: 'invoice', id: '5' })).toMatchObject({ status: 'ERROR', errorDetail: 'boom' });
  });
});
