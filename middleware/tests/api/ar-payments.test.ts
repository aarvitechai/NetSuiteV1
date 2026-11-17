/**
 * Phase 8 end-to-end: invoice → payment intent → hosted checkout → signed webhook → NetSuite Customer
 * Payment → provider settlement → Deposit (fees separate). Also covers duplicate webhooks, bad
 * signatures, declines, manual capture and void, refunds, chargebacks and settlement mismatches.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { signPayload } from '../../src/adapters/payment-provider/webhook-signature';
import { auth, makeTestContext, TOKENS, WEBHOOK_SECRET } from '../helpers';

let n = 0;
const key = () => `ar-key-${++n}-${Date.now()}`;

/** A test context whose payment provider delivers webhooks to the app over (in-memory) HTTP. */
function setup() {
  const ctx = makeTestContext();
  const deliveries: { status: number; body: unknown }[] = [];
  ctx.container.provider.setDeliver(async (raw, signature) => {
    const r = await request(ctx.app)
      .post('/webhooks/payment-provider')
      .set('Content-Type', 'application/json')
      .set('X-Signature', signature)
      .send(raw);
    deliveries.push({ status: r.status, body: r.body });
  });
  const settle = async () => ctx.container.webhooks.drain();
  return { ...ctx, deliveries, settle };
}

async function payAsCustomer(
  s: ReturnType<typeof setup>,
  token: string,
  invoices: string[],
  card: 'tok_visa_ok' | 'tok_card_declined' = 'tok_visa_ok',
) {
  const created = await request(s.app)
    .post('/api/v1/payment-intents')
    .set(auth(token))
    .set('Idempotency-Key', key())
    .send({ invoiceExternalIds: invoices });
  expect(created.status).toBe(201);
  await s.container.provider.completeCheckout(created.body.providerRef, card);
  await s.settle();
  return (await request(s.app).get(`/api/v1/payment-intents/${created.body.id}`).set(auth(token))).body;
}

describe('customer online payment (hosted checkout, automatic capture)', () => {
  it('pays an invoice end to end and posts a Customer Payment in NetSuite', async () => {
    const s = setup();
    const intent = await payAsCustomer(s, TOKENS.acme, ['INV-2001']);
    expect(intent).toMatchObject({
      status: 'SUCCEEDED',
      amount: '500.00',
      currency: 'USD',
      customerExternalId: 'CUST-ACME',
    });
    expect(intent.checkoutUrl).toMatch(/^https:\/\/checkout\.simpay\.example\/pay\//);
    expect(intent.netsuitePaymentId).toBeDefined();
    expect(s.deliveries[0]!.status).toBe(202); // acknowledged fast, processed afterwards
    expect((await s.netsuite.getInvoice('INV-2001'))!.amountRemaining).toBe('0.00');
    expect(s.netsuite.countTransactions('CustPymt')).toBe(1);
  });

  it('enforces ownership: a customer cannot pay or read another customer’s invoice', async () => {
    const s = setup();
    const r = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.acme))
      .set('Idempotency-Key', key())
      .send({ invoiceExternalIds: ['INV-2003'] });
    expect(r.status).toBe(404);
    // Body customerExternalId is ignored for customers (no impersonation).
    const r2 = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.acme))
      .set('Idempotency-Key', key())
      .send({ customerExternalId: 'CUST-GLOBEX', invoiceExternalIds: ['INV-2003'] });
    expect(r2.status).toBe(404);
    const globexIntent = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.globex))
      .set('Idempotency-Key', key())
      .send({ invoiceExternalIds: ['INV-2003'] });
    expect(
      (await request(s.app).get(`/api/v1/payment-intents/${globexIntent.body.id}`).set(auth(TOKENS.acme)))
        .status,
    ).toBe(404);
  });

  it('never accepts card data', async () => {
    const s = setup();
    const r = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.acme))
      .set('Idempotency-Key', key())
      .send({ invoiceExternalIds: ['INV-2001'], cardNumber: '4111111111111111', cvv: '123' });
    expect(r.status).toBe(400);
    expect(JSON.stringify(await s.container.store.repo('payment_intents').list())).not.toContain('4111');
  });

  it('a declined card leaves the invoice open and allows a new attempt', async () => {
    const s = setup();
    const failed = await payAsCustomer(s, TOKENS.acme, ['INV-2001'], 'tok_card_declined');
    expect(failed).toMatchObject({ status: 'FAILED', failureReason: 'card_declined' });
    expect(s.netsuite.countTransactions('CustPymt')).toBe(0);
    expect((await payAsCustomer(s, TOKENS.acme, ['INV-2001'])).status).toBe('SUCCEEDED');
  });

  it('blocks a second simultaneous payment for the same invoice', async () => {
    const s = setup();
    await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.acme))
      .set('Idempotency-Key', key())
      .send({ invoiceExternalIds: ['INV-2001'] });
    const again = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.acme))
      .set('Idempotency-Key', key())
      .send({ invoiceExternalIds: ['INV-2001'] });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('PAYMENT_ALREADY_IN_PROGRESS');
  });
});

describe('webhook security and idempotency', () => {
  it('ignores a duplicate delivery of the same event (no double posting)', async () => {
    const s = setup();
    await payAsCustomer(s, TOKENS.acme, ['INV-2001']);
    const evt = s.container.provider.events.find((e) => e.event.type === 'payment.succeeded')!;
    await s.container.provider.redeliver(evt.event.id);
    await s.settle();
    expect(s.deliveries.at(-1)).toMatchObject({ status: 200, body: { status: 'duplicate' } });
    expect(s.netsuite.countTransactions('CustPymt')).toBe(1);
  });

  it('rejects forged, missing and expired signatures', async () => {
    const s = setup();
    const raw = JSON.stringify({
      id: 'evt_x',
      version: '2026-01',
      created: '2026-11-20T09:00:00Z',
      type: 'payment.failed',
      data: { sessionId: 's', intentId: 'i', reason: 'x' },
    });
    const post = (sig?: string) => {
      const r = request(s.app).post('/webhooks/payment-provider').set('Content-Type', 'application/json');
      if (sig) r.set('X-Signature', sig);
      return r.send(raw);
    };
    const now = Math.floor(new Date('2026-11-20T09:00:00Z').getTime() / 1000);
    expect((await post()).status).toBe(401);
    expect((await post(signPayload('wrong-secret-wrong-secret', raw, now))).status).toBe(401);
    expect((await post(signPayload(WEBHOOK_SECRET, raw, now - 3600))).body.error.code).toBe(
      'WEBHOOK_SIGNATURE_INVALID',
    ); // replay of an old capture
    expect(await s.container.store.repo('webhook_receipts').list()).toHaveLength(0); // nothing stored
  });

  it('rejects a validly signed body that was modified', async () => {
    const s = setup();
    const raw = '{"id":"evt_1"}';
    const now = Math.floor(new Date('2026-11-20T09:00:00Z').getTime() / 1000);
    const sig = signPayload(WEBHOOK_SECRET, raw, now);
    const r = await request(s.app)
      .post('/webhooks/payment-provider')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send('{"id":"evt_2"}');
    expect(r.status).toBe(401);
  });
});

describe('authorization, capture, void, refund, chargeback', () => {
  it('manual capture: authorization does not post; capture does', async () => {
    const s = setup();
    const created = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.ar))
      .set('Idempotency-Key', key())
      .send({ customerExternalId: 'CUST-GLOBEX', invoiceExternalIds: ['INV-2003'], captureMode: 'manual' });
    await s.container.provider.completeCheckout(created.body.providerRef, 'tok_visa_ok');
    await s.settle();
    expect((await s.container.ar.getIntent(created.body.id)).status).toBe('AUTHORIZED');
    expect(s.netsuite.countTransactions('CustPymt')).toBe(0);

    const captured = await request(s.app)
      .post(`/api/v1/payment-intents/${created.body.id}/capture`)
      .set(auth(TOKENS.ar));
    expect(captured.body.status).toBe('SUCCEEDED');
    expect(s.netsuite.countTransactions('CustPymt')).toBe(1);
  });

  it('void cancels an authorization without any accounting', async () => {
    const s = setup();
    const created = await request(s.app)
      .post('/api/v1/payment-intents')
      .set(auth(TOKENS.ar))
      .set('Idempotency-Key', key())
      .send({ customerExternalId: 'CUST-INITECH', invoiceExternalIds: ['INV-2005'], captureMode: 'manual' });
    await s.container.provider.completeCheckout(created.body.providerRef, 'tok_visa_ok');
    await s.settle();
    const voided = await request(s.app)
      .post(`/api/v1/payment-intents/${created.body.id}/void`)
      .set(auth(TOKENS.ar));
    expect(voided.body.status).toBe('CANCELED');
    expect(s.netsuite.countTransactions()).toBe(0);
  });

  it('partial refund posts a Customer Refund and re-opens that amount; over-refund is refused', async () => {
    const s = setup();
    const paid = await payAsCustomer(s, TOKENS.acme, ['INV-2001']);
    const r = await request(s.app)
      .post(`/api/v1/payment-intents/${paid.id}/refunds`)
      .set(auth(TOKENS.ar))
      .set('Idempotency-Key', key())
      .send({ amount: '50.00', reason: 'damaged goods' });
    expect(r.status).toBe(202);
    await s.settle();
    const after = await s.container.ar.getIntent(paid.id);
    expect(after).toMatchObject({ status: 'PARTIALLY_REFUNDED', refundedAmount: '50.00' });
    expect(after.refunds[0]!.netsuiteRefundId).toBeDefined();
    expect((await s.netsuite.getInvoice('INV-2001'))!.amountRemaining).toBe('50.00');
    const over = await request(s.app)
      .post(`/api/v1/payment-intents/${paid.id}/refunds`)
      .set(auth(TOKENS.ar))
      .set('Idempotency-Key', key())
      .send({ amount: '451.00', reason: 'too much' });
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_PAYMENT');
  });

  it('chargeback (payment.returned) reverses the payment', async () => {
    const s = setup();
    const paid = await payAsCustomer(s, TOKENS.acme, ['INV-2001']);
    await s.container.provider.chargeback(paid.providerRef, 'fraudulent');
    await s.settle();
    expect((await s.container.ar.getIntent(paid.id)).status).toBe('RETURNED');
    expect(s.netsuite.getTransaction('CustRfnd', `${paid.id}-RET`)).toBeDefined();
    expect((await s.netsuite.getInvoice('INV-2001'))!.amountRemaining).toBe('500.00');
  });
});

describe('provider settlement → NetSuite Deposit (fees separate)', () => {
  it('deposits the NET amount and records the fees separately', async () => {
    const s = setup();
    await payAsCustomer(s, TOKENS.acme, ['INV-2001']); // 500.00 → fee 14.80 (2.9% + 0.30)
    await payAsCustomer(s, TOKENS.globex, ['INV-2003']); // 3400.00 → fee 98.90
    await s.container.provider.settle('2026-11-21');
    await s.settle();
    const [settlement] = (await request(s.app).get('/api/v1/settlements').set(auth(TOKENS.ar))).body.items;
    expect(settlement).toMatchObject({ status: 'POSTED', gross: '3900.00', fees: '113.70', net: '3786.30' });
    const deposit = s.netsuite.getTransaction('Deposit', settlement.id)!;
    expect(deposit.amount).toBe('3786.30'); // what the bank statement will show
  });

  it('waits for payments to be posted first (ordering), then replays from the DLQ', async () => {
    const s = setup();
    s.netsuite.injectFault('unavailable', 4, 'createCustomerPayment');
    const paid = await payAsCustomer(s, TOKENS.acme, ['INV-2001']);
    expect(paid.netsuitePaymentId).toBeUndefined();
    await s.container.provider.settle('2026-11-21');
    await s.settle();
    const dlq = await s.container.jobs.listDeadLetters();
    expect(dlq.map((d) => d.topic).sort()).toEqual([
      'netsuite.customer_payment.post',
      'netsuite.deposit.post',
    ]);
    // NetSuite is back. Replay in business order: payment first, then deposit.
    await s.container.jobs.replay(dlq.find((d) => d.topic === 'netsuite.customer_payment.post')!.id);
    await s.container.jobs.replay(dlq.find((d) => d.topic === 'netsuite.deposit.post')!.id);
    expect(s.netsuite.countTransactions('Deposit')).toBe(1);
  });

  it('refuses to post a settlement whose arithmetic does not add up', async () => {
    const s = setup();
    const paid = await payAsCustomer(s, TOKENS.acme, ['INV-2001']);
    const evt = {
      id: 'evt_bad_settlement',
      version: '2026-01',
      created: '2026-11-21T00:00:00Z',
      type: 'settlement.paid',
      data: {
        settlementId: 'po_bad',
        date: '2026-11-21',
        currency: 'USD',
        gross: '500.00',
        fees: '14.80',
        net: '490.00',
        payments: [
          { sessionId: paid.providerRef, intentId: paid.id, gross: '500.00', fee: '14.80', net: '490.00' },
        ],
      },
    };
    const raw = JSON.stringify(evt);
    await request(s.app)
      .post('/webhooks/payment-provider')
      .set('Content-Type', 'application/json')
      .set(
        'X-Signature',
        signPayload(WEBHOOK_SECRET, raw, Math.floor(new Date('2026-11-20T09:00:00Z').getTime() / 1000)),
      )
      .send(raw);
    await s.settle();
    const [settlement] = (await request(s.app).get('/api/v1/settlements').set(auth(TOKENS.ar))).body.items;
    expect(settlement.status).toBe('MISMATCH');
    expect(s.netsuite.countTransactions('Deposit')).toBe(0);
  });
});

describe('collections', () => {
  it('produces an aging report from NetSuite open invoices', async () => {
    const s = setup();
    const r = await request(s.app).get('/api/v1/ar/aging?asOf=2026-11-20').set(auth(TOKENS.ar));
    expect(r.body.totals.USD).toEqual({
      CURRENT: '1200.00',
      '1-30': '650.00',
      '31-60': '860.00',
      '61-90': '3400.00',
      '90+': '0.00',
      TOTAL: '6110.00',
    });
  });

  it('sends reminders and escalations once, skips disputed invoices, and keeps an audit trail', async () => {
    const s = setup();
    const run = await request(s.app)
      .post('/api/v1/ar/collections/run')
      .set(auth(TOKENS.ar))
      .send({ asOf: '2026-11-20' });
    expect(run.body).toMatchObject({
      evaluated: 5,
      reminders: 2,
      escalations: 1,
      skippedDisputed: 1,
      unchanged: 1,
    });
    const sent = (s.container.notifier as unknown as { sent: { to: string; template: string }[] }).sent;
    expect(sent.map((m) => [m.to, m.template])).toEqual(
      expect.arrayContaining([
        ['ap@acme-retail.example', 'nsd-friendly-reminder'],
        ['ar-manager@northstar.example', 'nsd-escalation-ar-manager'],
      ]),
    );
    expect((await s.netsuite.getInvoice('INV-2003'))!.collectionStage).toBe('ESCALATED');

    // Running again the same day: idempotent, so nobody gets a second email.
    const again = await request(s.app)
      .post('/api/v1/ar/collections/run')
      .set(auth(TOKENS.ar))
      .send({ asOf: '2026-11-20' });
    expect(again.body).toMatchObject({ reminders: 0, escalations: 0 });
    expect(sent).toHaveLength(3);

    // Dispute: recorded in the communication trail and pauses reminders.
    await request(s.app)
      .post('/api/v1/invoices/INV-2005/dispute')
      .set(auth(TOKENS.ar))
      .send({ disputed: true, note: 'Customer says goods not received' });
    const trail = await request(s.app)
      .get('/api/v1/ar/collections/actions?invoice=INV-2005')
      .set(auth(TOKENS.ar));
    expect(trail.body.items.map((a: { type: string }) => a.type)).toEqual(['REMINDER', 'DISPUTE_OPENED']);
    expect((await s.netsuite.getInvoice('INV-2005'))!.disputed).toBe(true);
  });
});
