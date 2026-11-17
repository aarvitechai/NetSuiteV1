/**
 * Phase 9: customer portal API and prototype.
 * The key security requirement: "one customer cannot access another customer's invoices".
 */
import pino from 'pino';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { MockNetSuiteAdapter } from '../../src/adapters/netsuite/mock-netsuite';
import { createApp } from '../../src/app';
import { createContainer } from '../../src/container';
import { loadConfig } from '../../src/shared/config';
import { auth, makeTestContext, TOKENS } from '../helpers';

function setup() {
  const ctx = makeTestContext();
  ctx.container.provider.setDeliver(async (raw, signature) => {
    await request(ctx.app)
      .post('/webhooks/payment-provider')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(raw);
  });
  return ctx;
}

const statement = (app: Parameters<typeof request>[0], token: string) =>
  request(app).get('/api/v1/portal/statement').set(auth(token));

describe('portal API: customer scoping', () => {
  it('returns only the signed-in customer’s profile, balance and invoices', async () => {
    const { app } = setup();
    expect((await request(app).get('/api/v1/portal/me').set(auth(TOKENS.acme))).body).toEqual({
      customerExternalId: 'CUST-ACME',
      companyName: 'Acme Retail Corp',
      currency: 'USD',
    });
    const s = (await statement(app, TOKENS.acme)).body;
    expect(s.openBalance).toEqual([{ currency: 'USD', amount: '1700.00' }]);
    expect(
      s.invoices.map((i: { externalId: string; state: string; daysOverdue: number }) => [
        i.externalId,
        i.state,
        i.daysOverdue,
      ]),
    ).toEqual([
      ['INV-2001', 'overdue', 20],
      ['INV-2002', 'open', 0],
    ]);
  });

  it('customer A never sees customer B’s invoices, even by tampering with the request', async () => {
    const { app } = setup();
    const acme = JSON.stringify((await statement(app, TOKENS.acme)).body);
    for (const foreign of ['INV-2003', 'INV-2004', 'INV-2005', 'CUST-GLOBEX'])
      expect(acme).not.toContain(foreign);
    // Query-string or body tricks are ignored. The endpoint has no customer parameter at all.
    const tampered = await request(app)
      .get('/api/v1/portal/statement?customer=CUST-GLOBEX')
      .set(auth(TOKENS.acme));
    expect(JSON.stringify(tampered.body)).not.toContain('INV-2003');
    // Paying a foreign invoice: 404 (does not even reveal that it exists).
    const pay = await request(app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.acme))
      .set('Idempotency-Key', 'portal-tamper-1')
      .send({ invoiceExternalIds: ['INV-2003'] });
    expect(pay.status).toBe(404);
  });

  it('portal endpoints are for customers only', async () => {
    const { app } = setup();
    expect((await statement(app, TOKENS.ar)).status).toBe(403);
    expect((await request(app).get('/api/v1/portal/statement')).status).toBe(401);
  });
});

describe('portal: pending versus settled payments', () => {
  it('shows "Awaiting payment" → "Payment received – processing" → "Completed"', async () => {
    const { app, container } = setup();
    const intent = (
      await request(app)
        .post('/api/v1/payment-intents')
        .set(auth(TOKENS.acme))
        .set('Idempotency-Key', 'portal-pay-001')
        .send({ invoiceExternalIds: ['INV-2001'] })
    ).body;

    let s = (await statement(app, TOKENS.acme)).body;
    expect(s.invoices.find((i: { externalId: string }) => i.externalId === 'INV-2001').state).toBe(
      'payment_pending',
    );
    expect(s.payments[0].status).toBe('Awaiting payment');

    await container.provider.completeCheckout(intent.providerRef, 'tok_visa_ok');
    await container.webhooks.drain();
    s = (await statement(app, TOKENS.acme)).body;
    expect(s.payments[0].status).toBe('Payment received – processing');
    expect(s.openBalance).toEqual([{ currency: 'USD', amount: '1200.00' }]);

    await container.provider.settle('2026-11-21');
    await container.webhooks.drain();
    expect((await statement(app, TOKENS.acme)).body.payments[0].status).toBe('Completed');
  });
});

describe('portal prototype (static) and simulated checkout', () => {
  it('serves the prototype, clearly labelled, with a strict Content-Security-Policy', async () => {
    const { app } = setup();
    const page = await request(app).get('/portal/');
    expect(page.status).toBe(200);
    expect(page.text).toContain('LOCAL PROTOTYPE: not a SuiteCommerce MyAccount extension');
    expect(page.headers['content-security-policy']).toContain("script-src 'self'");
    expect((await request(app).get('/portal/app.js')).status).toBe(200);
  });

  it('completes a payment through the simulated hosted checkout page', async () => {
    const { app } = setup();
    const intent = (
      await request(app)
        .post('/api/v1/payment-intents')
        .set(auth(TOKENS.acme))
        .set('Idempotency-Key', 'portal-pay-002')
        .send({ invoiceExternalIds: ['INV-2002'] })
    ).body;
    const page = await request(app).get(`/dev/checkout/${intent.providerRef}`);
    expect(page.text).toContain('SIMULATED HOSTED CHECKOUT');
    expect(page.text).toContain('USD 1200.00');
    const done = await request(app)
      .post(`/dev/checkout/${intent.providerRef}/complete`)
      .type('form')
      .send({ outcome: 'tok_visa_ok' });
    expect(done.status).toBe(303);
    expect(done.headers.location).toBe(`/portal/?returnFrom=checkout&intent=${intent.id}`);
    expect(
      (await request(app).get(`/api/v1/payment-intents/${intent.id}`).set(auth(TOKENS.acme))).body.status,
    ).toBe('SUCCEEDED');
  });

  it('does not expose the simulated checkout in production', async () => {
    const prodConfig = loadConfig({
      NODE_ENV: 'production',
      LOG_LEVEL: 'silent',
      WEBHOOK_SIGNING_SECRET: 'x'.repeat(32),
      API_TOKENS: 'prod-token:ops:olivia',
    });
    const app = createApp(
      createContainer(prodConfig, { logger: pino({ level: 'silent' }), netsuite: new MockNetSuiteAdapter() }),
    );
    expect((await request(app).get('/dev/checkout/cs_aaaaaaaaaaaaaaaaaaaa')).status).toBe(404);
  });
});
