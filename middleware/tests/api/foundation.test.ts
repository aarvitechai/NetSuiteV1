/**
 * API tests for the middleware foundation: health, auth, roles, validation, correlation IDs,
 * error format and the OpenAPI document.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { auth, makeTestContext, TOKENS } from '../helpers';

describe('middleware foundation', () => {
  const { app, netsuite } = makeTestContext();

  it('liveness and readiness', async () => {
    expect((await request(app).get('/health')).body).toEqual({ status: 'ok' });
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(200);
    expect(ready.body.checks).toEqual({ database: 'ok', netsuite: 'ok' });
  });

  it('readiness reports NetSuite outages with 503', async () => {
    netsuite.injectFault('unavailable', 1, 'ping');
    const ready = await request(app).get('/ready');
    expect(ready.status).toBe(503);
    expect(ready.body.checks.netsuite).toMatch(/error/);
  });

  it('rejects missing or wrong tokens with 401 and a JSON error', async () => {
    const r1 = await request(app).get('/api/v1/vendors');
    expect(r1.status).toBe(401);
    expect(r1.body.error.code).toBe('UNAUTHORIZED');
    expect((await request(app).get('/api/v1/vendors').set(auth('nope'))).status).toBe(401);
  });

  it('enforces roles (customer cannot list vendors)', async () => {
    const r = await request(app).get('/api/v1/vendors').set(auth(TOKENS.acme));
    expect(r.status).toBe(403);
  });

  it('never exposes vendor bank tokens', async () => {
    const r = await request(app).get('/api/v1/vendors').set(auth(TOKENS.maker));
    expect(r.status).toBe(200);
    expect(r.body.items.length).toBeGreaterThan(0);
    expect(JSON.stringify(r.body)).not.toContain('tok_bank');
  });

  it('echoes a valid caller correlation ID and generates one otherwise', async () => {
    const mine = await request(app).get('/health').set('X-Correlation-Id', 'my-trace-12345');
    expect(mine.headers['x-correlation-id']).toBe('my-trace-12345');
    const bad = await request(app).get('/health').set('X-Correlation-Id', '<script>');
    expect(bad.headers['x-correlation-id']).toMatch(/^corr-/);
  });

  it('validates path parameters', async () => {
    const r = await request(app).get('/api/v1/vendors/bad%20id!').set(auth(TOKENS.maker));
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe('VALIDATION_FAILED');
    expect(r.body.error.correlationId).toBeDefined();
  });

  it('returns 404 JSON for unknown routes and unknown records', async () => {
    expect((await request(app).get('/api/v1/nope').set(auth(TOKENS.ops))).status).toBe(404);
    expect((await request(app).get('/api/v1/vendors/VEND-NOPE').set(auth(TOKENS.ops))).body.error.code).toBe(
      'NOT_FOUND',
    );
  });

  it('maps NetSuite transient failures to 503', async () => {
    netsuite.injectFault('rate_limit', 1, 'listOpenVendorBills');
    const r = await request(app).get('/api/v1/bills/open').set(auth(TOKENS.maker));
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('NETSUITE_RATE_LIMITED');
  });

  it('serves the OpenAPI document', async () => {
    const r = await request(app).get('/api/v1/openapi.yaml');
    expect(r.status).toBe(200);
    expect(r.text).toContain('openapi: 3.0.3');
  });

  it('filters open invoices by customer', async () => {
    const r = await request(app).get('/api/v1/invoices/open?customer=CUST-GLOBEX').set(auth(TOKENS.ar));
    expect(r.body.items.map((i: { externalId: string }) => i.externalId).sort()).toEqual([
      'INV-2003',
      'INV-2004',
    ]);
  });
});
