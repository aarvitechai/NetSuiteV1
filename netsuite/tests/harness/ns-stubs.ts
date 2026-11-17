/**
 * Fake implementations of the NetSuite N/* modules, used only in tests.
 *
 * Each fake implements just the methods our scripts call, and records the calls so tests can check
 * what the script *would* have done in NetSuite.
 */
import { fakeLog } from './amd-loader';

/** A fake in-memory record (enough for create/setValue/getValue/save). */
export class FakeRecord {
  values: Record<string, unknown>;
  constructor(
    public type: string,
    public id: number | null = null,
    values: Record<string, unknown> = {},
  ) {
    this.values = { ...values };
  }
  getValue({ fieldId }: { fieldId: string }) {
    return this.values[fieldId];
  }
  setValue({ fieldId, value }: { fieldId: string; value: unknown }) {
    this.values[fieldId] = value;
    return this;
  }
  getFields() {
    return Object.keys(this.values);
  }
  save() {
    this.id = this.id ?? Math.floor(Math.random() * 1e6);
    return this.id;
  }
}

export function makeRecordModule() {
  const created: FakeRecord[] = [];
  const submitted: { type: string; id: string; values: Record<string, unknown> }[] = [];
  const lookups: Record<string, Record<string, unknown>> = {};
  return {
    created,
    submitted,
    lookups,
    Type: { INVOICE: 'invoice', VENDOR_BILL: 'vendorbill' },
    create: ({ type }: { type: string }) => {
      const r = new FakeRecord(type);
      created.push(r);
      return r;
    },
    submitFields: (opts: { type: string; id: string; values: Record<string, unknown> }) => {
      submitted.push({ type: opts.type, id: String(opts.id), values: opts.values });
      return opts.id;
    },
    lookupFields: ({ type, id }: { type: string; id: string }) => lookups[`${type}:${id}`] ?? {},
  };
}

/** Fake N/search that returns pre-programmed results. */
export function makeSearchModule(
  opts: { count?: number; results?: { id: string; values: Record<string, unknown> }[] } = {},
) {
  const created: { type: string; filters: unknown[]; columns: unknown[] }[] = [];
  const results = (opts.results ?? []).map((r) => ({
    id: r.id,
    getValue: ({ name }: { name: string }) => r.values[name],
  }));
  return {
    created,
    Type: { VENDOR_BILL: 'vendorbill', INVOICE: 'invoice', TRANSACTION: 'transaction' },
    createColumn: (c: Record<string, unknown>) => c,
    create: (def: { type: string; filters: unknown[]; columns: unknown[] }) => {
      created.push(def);
      return {
        runPaged: () => ({ count: opts.count ?? 0 }),
        run: () => ({
          each: (cb: (r: unknown) => boolean) => {
            for (const r of results) if (!cb(r)) break;
          },
          getRange: () => results,
        }),
        save: () => 1,
      };
    },
  };
}

export function makeErrorModule() {
  return {
    create: ({ name, message }: { name: string; message: string }) =>
      Object.assign(new Error(message), { name }),
  };
}

export function makeRuntimeModule(
  opts: { params?: Record<string, unknown>; usage?: number[]; context?: string } = {},
) {
  const usage = [...(opts.usage ?? [10000])];
  return {
    ContextType: {
      REST_WEBSERVICES: 'RESTWEBSERVICES',
      WEBSERVICES: 'WEBSERVICES',
      RESTLET: 'RESTLET',
      USER_INTERFACE: 'USERINTERFACE',
    },
    executionContext: opts.context ?? 'USERINTERFACE',
    getCurrentScript: () => ({
      id: 'customscript_test',
      deploymentId: 'customdeploy_test',
      getParameter: ({ name }: { name: string }) => opts.params?.[name] ?? null,
      // Returns the next programmed value each call (lets a test simulate usage running out).
      getRemainingUsage: () => (usage.length > 1 ? usage.shift()! : usage[0]!),
    }),
  };
}

export function makeTaskModule() {
  const submitted: unknown[] = [];
  return {
    submitted,
    TaskType: { SCHEDULED_SCRIPT: 'SCHEDULED_SCRIPT' },
    create: (def: unknown) => ({ submit: () => submitted.push(def) }),
  };
}

/** Bundles default stubs; individual tests override what they need. */
export function defaultStubs(overrides: Record<string, unknown> = {}) {
  return {
    'N/log': fakeLog(),
    'N/record': makeRecordModule(),
    'N/search': makeSearchModule(),
    'N/error': makeErrorModule(),
    'N/runtime': makeRuntimeModule(),
    'N/task': makeTaskModule(),
    'N/ui/dialog': { alert: () => undefined },
    ...overrides,
  };
}

/** UserEventType values as NetSuite passes them in context.UserEventType. */
export const UserEventType = { CREATE: 'create', EDIT: 'edit', XEDIT: 'xedit', DELETE: 'delete' };
