/**
 * Phase 12, end to end: one complete accounting period across AP, AR, the bank and NetSuite.
 * This is the automated version of UAT script UAT-10 (docs/testing/uat-scripts.md).
 *
 * Story (synthetic, period 2026-11-20 → 2026-11-25):
 *   AP  – Pay Acme Supplies 1,250.00 and Bolt & Co 480.50 by ACH. Bolt's payment comes back (R01).
 *   AR  – Acme Retail pays 500.00 and Globex 3,400.00 online. 50.00 is refunded to Acme.
 *         The provider pays out the net amount after fees.
 *   Bank – The statement shows every movement. Reconciliation matches everything.
 *   Exit criterion: every control total balances (no transaction lost or duplicated).
 */
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BankSimulator } from '../../../simulators/bank/bank-simulator';
import { auth, makeTestContext, TOKENS } from '../helpers';

let n = 0;
const key = () => `e2e-${++n}-${Date.now()}`;
const poll = (app: Express) => request(app).post('/api/v1/bank/inbound/poll').set(auth(TOKENS.ops));

describe('period close: AP + AR + bank + NetSuite balance', () => {
  it('runs the full period and proves the control totals balance', async () => {
    const { app, container, netsuite } = makeTestContext();
    const bank = new BankSimulator(container.files, { returnPayees: { 'VEND-BOLTCO': 'R01' } });
    container.provider.setDeliver(async (raw, signature) => {
      await request(app)
        .post('/webhooks/payment-provider')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(raw);
    });

    // ---------------- AP ----------------
    const batch = (
      await request(app)
        .post('/api/v1/payment-batches')
        .set(auth(TOKENS.maker))
        .set('Idempotency-Key', key())
        .send({ currency: 'USD', rail: 'ACH' })
    ).body;
    expect(batch.total).toBe('1730.50');
    await request(app).post(`/api/v1/payment-batches/${batch.id}/approve`).set(auth(TOKENS.checker));
    await request(app)
      .post(`/api/v1/payment-batches/${batch.id}/submit`)
      .set(auth(TOKENS.ops))
      .set('Idempotency-Key', key());
    await bank.pickUp();
    await poll(app);
    await bank.settle('2026-11-23');
    await poll(app);
    await bank.sendReturns('2026-11-24');
    await poll(app);

    // ---------------- AR ----------------
    const intents: { id: string; providerRef: string }[] = [];
    for (const [token, inv] of [
      [TOKENS.acme, 'INV-2001'],
      [TOKENS.globex, 'INV-2003'],
    ] as const) {
      const intent = (
        await request(app)
          .post('/api/v1/payment-intents')
          .set(auth(token))
          .set('Idempotency-Key', key())
          .send({ invoiceExternalIds: [inv] })
      ).body;
      await container.provider.completeCheckout(intent.providerRef, 'tok_visa_ok');
      intents.push(intent);
    }
    await container.webhooks.drain();
    await request(app)
      .post(`/api/v1/payment-intents/${intents[0]!.id}/refunds`)
      .set(auth(TOKENS.ar))
      .set('Idempotency-Key', key())
      .send({ amount: '50.00', reason: 'damaged item' });
    await container.webhooks.drain();
    const payout = await container.provider.settle('2026-11-24');
    await container.webhooks.drain();
    const settlement = payout!.data as { settlementId: string; net: string; fees: string };
    expect(settlement).toMatchObject({ net: '3786.30', fees: '113.70' });
    const refundId = (await container.ar.getIntent(intents[0]!.id)).refunds[0]!.refundId;

    // ---------------- Bank statement + reconciliation ----------------
    await bank.statement('2026-11-24', {
      format: 'camt053',
      extra: [
        { amount: settlement.net, reference: settlement.settlementId, description: 'SIMPAY PAYOUT' },
        { amount: '-50.00', reference: refundId, description: 'CARD REFUND' },
      ],
    });
    const rec = (await poll(app)).body.results[0].result;
    expect(rec).toMatchObject({ format: 'CAMT053', lines: 5, autoMatched: 5, suggested: 0, exceptions: 0 });

    // ---------------- Exit criterion: control totals ----------------
    const ct = (
      await request(app)
        .get('/api/v1/reconciliation/control-totals?from=2026-11-20&to=2026-11-25')
        .set(auth(TOKENS.finance))
    ).body;
    const summary = Object.fromEntries(
      ct.checks.map((c: { id: string; left: { amount: string }; right: { amount: string }; ok: boolean }) => [
        c.id,
        [c.left.amount, c.right.amount, c.ok],
      ]),
    );
    expect(summary).toEqual({
      'AP-1': ['1730.50', '1730.50', true],
      'AP-2': ['1730.50', '1730.50', true],
      'AP-3': ['1730.50', '1730.50', true],
      'AP-4': ['480.50', '480.50', true],
      'AR-1': ['3900.00', '3900.00', true],
      'AR-2': ['50.00', '50.00', true],
      'AR-3': ['3786.30', '3786.30', true],
      'AR-4': ['3786.30', '3786.30', true],
      'AR-5': ['3786.30', '3786.30', true],
    });
    expect(ct.balanced).toBe(true);

    // Reconciliation report for the period: nothing open.
    const report = (
      await request(app)
        .get('/api/v1/reconciliation/report?from=2026-11-20&to=2026-11-25')
        .set(auth(TOKENS.finance))
    ).body;
    expect(report.fullyReconciled).toBe(true);

    // NetSuite state at period end.
    expect((await netsuite.getVendorBill('BILL-1001'))!.amountRemaining).toBe('0.00'); // paid
    expect((await netsuite.getVendorBill('BILL-1002'))!.amountRemaining).toBe('480.50'); // reopened by the return
    expect((await netsuite.getInvoice('INV-2001'))!.amountRemaining).toBe('50.00'); // refunded part re-opened
    expect((await netsuite.getInvoice('INV-2003'))!.amountRemaining).toBe('0.00');
    expect(netsuite.reconRecords.size).toBe(5);
    expect((await container.jobs.listDeadLetters()).length).toBe(0);
  });

  it('detects an imbalance: a Vendor Payment posted without a bank debit breaks AP-3', async () => {
    const { app, container, netsuite } = makeTestContext();
    const bank = new BankSimulator(container.files);
    const batch = (
      await request(app)
        .post('/api/v1/payment-batches')
        .set(auth(TOKENS.maker))
        .set('Idempotency-Key', key())
        .send({ currency: 'USD', rail: 'ACH' })
    ).body;
    await request(app).post(`/api/v1/payment-batches/${batch.id}/approve`).set(auth(TOKENS.checker));
    await request(app)
      .post(`/api/v1/payment-batches/${batch.id}/submit`)
      .set(auth(TOKENS.ops))
      .set('Idempotency-Key', key());
    await bank.pickUp();
    await poll(app);
    await bank.settle('2026-11-23');
    await poll(app);
    // No bank statement imported yet: NetSuite has the payments, the bank side does not.
    const ct = (
      await request(app)
        .get('/api/v1/reconciliation/control-totals?from=2026-11-20&to=2026-11-25')
        .set(auth(TOKENS.finance))
    ).body;
    const ap3 = ct.checks.find((c: { id: string }) => c.id === 'AP-3');
    expect(ap3).toMatchObject({ ok: false, difference: '1730.50' });
    expect(ct.balanced).toBe(false);
    void netsuite;
  });
});
