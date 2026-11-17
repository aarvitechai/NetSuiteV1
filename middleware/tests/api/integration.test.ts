/**
 * Phase 6 end-to-end: master data sync, partial failure, DLQ, replay and correlation-ID tracing.
 */
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, makeTestContext, TOKENS } from '../helpers';

const vendor = (code: string, extra: Record<string, unknown> = {}) => ({
  vendor_code: code,
  legal_name: `${code} Ltd`,
  ccy: 'USD',
  status: 'ACTIVE',
  pay_method: 'ACH',
  bank_ref: `tok_bank_${code.toLowerCase().replace(/-/g, '_')}`,
  ...extra,
});

const post = (app: Express, path: string, body: object, key: string, correlationId?: string) => {
  const req = request(app).post(path).set(auth(TOKENS.ops)).set('Idempotency-Key', key);
  if (correlationId) req.set('X-Correlation-Id', correlationId);
  return req.send(body);
};

describe('master data sync', () => {
  it('creates new vendors, updates existing ones and reports invalid rows', async () => {
    const { app, netsuite } = makeTestContext();
    const r = await post(
      app,
      '/api/v1/sync/vendors',
      { records: [vendor('VEND-NEW1'), vendor('VEND-ACMESUP'), { vendor_code: 'x' }] },
      'sync-0001',
    );
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ received: 3, created: 1, updated: 1, invalid: 1, failed: 0 });
    expect((await netsuite.getVendor('VEND-NEW1'))?.companyName).toBe('VEND-NEW1 Ltd');
  });

  it('does not create duplicates when the same batch is retried with a new key', async () => {
    const { app, netsuite } = makeTestContext();
    await post(app, '/api/v1/sync/vendors', { records: [vendor('VEND-DUP')] }, 'sync-a-0001');
    const again = await post(app, '/api/v1/sync/vendors', { records: [vendor('VEND-DUP')] }, 'sync-b-0001');
    expect(again.body).toMatchObject({ created: 0, updated: 1 });
    expect((await netsuite.listVendors()).filter((v) => v.externalId === 'VEND-DUP')).toHaveLength(1);
  });

  it('replays the stored response for the same Idempotency-Key (NetSuite is not called again)', async () => {
    const { app, netsuite } = makeTestContext();
    const body = { records: [vendor('VEND-IDEM')] };
    await post(app, '/api/v1/sync/vendors', body, 'sync-idem-01');
    const calls = netsuite.calls.length;
    const replay = await post(app, '/api/v1/sync/vendors', body, 'sync-idem-01');
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(netsuite.calls.length).toBe(calls);
  });

  it('requires the ops role and an Idempotency-Key', async () => {
    const { app } = makeTestContext();
    expect(
      (await request(app).post('/api/v1/sync/vendors').set(auth(TOKENS.maker)).send({ records: [] })).status,
    ).toBe(403);
    const noKey = await request(app)
      .post('/api/v1/sync/vendors')
      .set(auth(TOKENS.ops))
      .send({ records: [vendor('V-1')] });
    expect(noKey.status).toBe(400);
  });
});

describe('failure → retry → DLQ → replay (with correlation ID)', () => {
  it('retries a transient blip transparently', async () => {
    const { app, netsuite } = makeTestContext();
    netsuite.injectFault('rate_limit', 2, 'upsertVendor');
    const r = await post(app, '/api/v1/sync/vendors', { records: [vendor('VEND-BLIP')] }, 'sync-blip-01');
    expect(r.body).toMatchObject({ created: 1, failed: 0 });
  });

  it('sends a record to the DLQ after retries are exhausted, then replays it after the outage', async () => {
    const { app, netsuite } = makeTestContext();
    const corr = 'outage-demo-0001';
    netsuite.injectFault('unavailable', 4, 'upsertVendor', 'VEND-OUTAGE'); // 4 = every attempt fails
    const r = await post(
      app,
      '/api/v1/sync/vendors',
      { records: [vendor('VEND-OUTAGE'), vendor('VEND-OK')] },
      'sync-out-01',
      corr,
    );

    // Partial failure: the healthy record still went through.
    expect(r.body).toMatchObject({ created: 1, failed: 1 });
    expect(r.body.items.find((i: { sourceRef: string }) => i.sourceRef === 'VEND-OUTAGE').error).toBe(
      'NETSUITE_UNAVAILABLE',
    );

    const dlq = await request(app).get('/api/v1/dead-letters').set(auth(TOKENS.ops));
    expect(dlq.body.items).toHaveLength(1);
    const dl = dlq.body.items[0];
    expect(dl).toMatchObject({
      topic: 'netsuite.vendor.upsert',
      correlationId: corr,
      attempts: 4,
      status: 'OPEN',
    });

    // NetSuite is back: replay.
    const replay = await request(app).post(`/api/v1/dead-letters/${dl.id}/replay`).set(auth(TOKENS.ops));
    expect(replay.status).toBe(200);
    expect(replay.body.job.status).toBe('SUCCEEDED');
    expect(replay.body.job.correlationId).toBe(corr); // same trace ID end to end
    expect(await netsuite.getVendor('VEND-OUTAGE')).toBeDefined();

    // Replaying twice is refused.
    expect(
      (await request(app).post(`/api/v1/dead-letters/${dl.id}/replay`).set(auth(TOKENS.ops))).status,
    ).toBe(409);

    // The full story is visible under one correlation ID.
    const trail = await request(app).get(`/api/v1/audit?correlationId=${corr}`).set(auth(TOKENS.ops));
    expect(trail.body.items.map((e: { action: string }) => e.action)).toEqual(
      expect.arrayContaining(['DEAD_LETTERED', 'DEAD_LETTER_REPLAYED', 'VENDOR_SYNC']),
    );
  });

  it('dead-letters permanent errors immediately (no pointless retries) and allows discard with a reason', async () => {
    const { app, netsuite } = makeTestContext();
    netsuite.injectFault('business', 1, 'upsertVendor');
    await post(app, '/api/v1/sync/vendors', { records: [vendor('VEND-BIZ')] }, 'sync-biz-01');
    expect(netsuite.calls.filter((c) => c === 'upsertVendor')).toHaveLength(1);

    const dl = (await request(app).get('/api/v1/dead-letters').set(auth(TOKENS.ops))).body.items[0];
    expect(dl.error).toMatchObject({ code: 'NETSUITE_BUSINESS_ERROR', transient: false });
    expect(
      (
        await request(app)
          .post(`/api/v1/dead-letters/${dl.id}/discard`)
          .set(auth(TOKENS.ops))
          .send({ reason: 'x' })
      ).status,
    ).toBe(400);
    const d = await request(app)
      .post(`/api/v1/dead-letters/${dl.id}/discard`)
      .set(auth(TOKENS.ops))
      .send({ reason: 'Vendor merged into VEND-ACMESUP' });
    expect(d.body.status).toBe('DISCARDED');
  });

  it('exposes job details', async () => {
    const { app } = makeTestContext();
    const r = await post(
      app,
      '/api/v1/sync/customers',
      { records: [{ customer_code: 'CUST-NEW', name: 'New', ccy: 'USD', billing_email: 'a@b.example' }] },
      'sync-cust-01',
    );
    const job = await request(app).get(`/api/v1/jobs/${r.body.items[0].jobId}`).set(auth(TOKENS.ops));
    expect(job.body).toMatchObject({ type: 'netsuite.customer.upsert', status: 'SUCCEEDED', attempts: 1 });
  });
});
