/**
 * Phase 11 security controls: headers, rate limiting, metrics access, secret rotation, log redaction.
 */
import { Writable } from 'node:stream';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signPayload } from '../../src/adapters/payment-provider/webhook-signature';
import {
  CachedSecretProvider,
  EnvSecretProvider,
  hydrateSecrets,
} from '../../src/infrastructure/secrets/secret-provider';
import { runWithContext } from '../../src/shared/context';
import { createLogger } from '../../src/shared/logger';
import { auth, makeTestContext, TOKENS } from '../helpers';

describe('HTTP hardening', () => {
  it('sets security headers and no-store on API responses', async () => {
    const { app } = makeTestContext();
    const r = await request(app).get('/api/v1/vendors').set(auth(TOKENS.ops));
    expect(r.headers).toMatchObject({
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('rate-limits a noisy client with 429 + Retry-After', async () => {
    const { app } = makeTestContext({}, { RATE_LIMIT_PER_MINUTE: '3' });
    const codes: number[] = [];
    for (let i = 0; i < 5; i++)
      codes.push((await request(app).get('/api/v1/vendors').set(auth(TOKENS.ops))).status);
    expect(codes).toEqual([200, 200, 200, 429, 429]);
    const r = await request(app).get('/api/v1/vendors').set(auth(TOKENS.ops));
    expect(r.body.error.code).toBe('RATE_LIMITED');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    // Health checks are never rate-limited (the load balancer must always reach them).
    expect((await request(app).get('/health')).status).toBe(200);
  });

  it('rejects oversized JSON bodies', async () => {
    const { app } = makeTestContext();
    const huge = { records: ['x'.repeat(300_000)] };
    expect(
      (
        await request(app)
          .post('/api/v1/sync/vendors')
          .set(auth(TOKENS.ops))
          .set('Idempotency-Key', 'huge-body-01')
          .send(huge)
      ).status,
    ).toBe(413);
  });
});

describe('monitoring endpoints', () => {
  it('/metrics and the ops dashboard require the ops role and expose health signals', async () => {
    const { app } = makeTestContext();
    expect((await request(app).get('/metrics')).status).toBe(401);
    expect((await request(app).get('/metrics').set(auth(TOKENS.maker))).status).toBe(403);
    await request(app).get('/api/v1/vendors').set(auth(TOKENS.ops));
    const m = await request(app).get('/metrics').set(auth(TOKENS.ops));
    expect(m.text).toContain('http_requests_total{method="GET",route="/api/v1/vendors",status="200"} 1');
    expect(m.text).toContain('nsd_outbox_pending 0');
    expect(m.text).toContain('http_request_duration_ms_bucket');
    const d = await request(app).get('/api/v1/ops/dashboard').set(auth(TOKENS.ops));
    expect(d.body).toMatchObject({
      outbox: { pending: 0 },
      deadLetters: { open: 0 },
      bankFiles: { quarantined: 0 },
    });
  });
});

describe('secrets', () => {
  it('accepts webhooks signed with the previous secret during a rotation, and nothing else', async () => {
    const oldSecret = 'old-webhook-secret-0123456789abcdef';
    const { app } = makeTestContext({}, { WEBHOOK_SIGNING_SECRET_PREVIOUS: oldSecret });
    const raw = JSON.stringify({
      id: 'evt_rot',
      version: '2026-01',
      created: '2026-11-20T09:00:00Z',
      type: 'settlement.paid',
      data: {
        settlementId: 'po_rot',
        date: '2026-11-20',
        currency: 'USD',
        gross: '0.00',
        fees: '0.00',
        net: '0.00',
        payments: [],
      },
    });
    const t = Math.floor(new Date('2026-11-20T09:00:00Z').getTime() / 1000);
    const send = (secret: string) =>
      request(app)
        .post('/webhooks/payment-provider')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signPayload(secret, raw, t))
        .send(raw);
    expect((await send(oldSecret)).status).toBe(202);
    expect((await send('some-other-secret-0123456789abcd')).status).toBe(401);
  });

  it('caches secrets for a TTL so rotated values are picked up without a restart', async () => {
    const env: Record<string, string> = { API_KEY: 'v1' };
    let now = 0;
    const p = new CachedSecretProvider(new EnvSecretProvider(env), 1000, () => now);
    expect(await p.get('API_KEY')).toBe('v1');
    env.API_KEY = 'v2'; // rotated in the secret store
    expect(await p.get('API_KEY')).toBe('v1'); // still cached
    now = 1500;
    expect(await p.get('API_KEY')).toBe('v2');

    const target: Record<string, string | undefined> = {};
    await hydrateSecrets(p, ['API_KEY', 'MISSING'], target);
    expect(target).toEqual({ API_KEY: 'v2' });
  });
});

describe('log redaction', () => {
  it('never writes secrets or payment data to logs, but keeps the correlation ID', async () => {
    let out = '';
    const sink = new Writable({
      write(chunk, _enc, cb) {
        out += chunk.toString();
        cb();
      },
    });
    const logger = createLogger('info', sink);
    runWithContext({ correlationId: 'corr-redaction-test', actor: 'test' }, () => {
      logger.info(
        {
          req: { headers: { authorization: 'Bearer super-secret-token' } },
          vendor: { password: 'hunter2', token: 'tok_live_123', accountNumber: '000123456789' },
          card: { cardNumber: '4111111111111111', cvv: '123' },
          consumerSecret: 'cs-abc',
        },
        'test',
      );
    });
    for (const secret of [
      'super-secret-token',
      'hunter2',
      'tok_live_123',
      '000123456789',
      '4111111111111111',
      'cs-abc',
    ]) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('[REDACTED]');
    expect(out).toContain('corr-redaction-test');
  });
});
