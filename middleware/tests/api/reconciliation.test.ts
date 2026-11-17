/**
 * Phase 10 end-to-end: real AP and AR flows produce NetSuite transactions, the bank simulator produces
 * a statement, and reconciliation matches it. Covers the plan's test data: exact match, partial match,
 * duplicate, fee deduction, return, and unmatched transaction.
 */
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BankSimulator, type BankBehaviour } from '../../../simulators/bank/bank-simulator';
import { auth, deliverWebhooks, makeTestContext, pollBank, TOKENS } from '../helpers';

let k = 0;
const key = () => `recon-${++k}-${Date.now()}`;
const poll = pollBank;

/** Runs the AP flow up to settlement, and optionally the AR flow up to provider settlement. */
async function world(opts: { behaviour?: BankBehaviour; withAr?: boolean } = {}) {
  const ctx = makeTestContext();
  const { app, container } = ctx;
  const bank = new BankSimulator(container.files, opts.behaviour);
  deliverWebhooks(app, container);

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

  let settlementId: string | undefined;
  if (opts.withAr) {
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
    }
    const evt = await container.provider.settle('2026-11-23');
    await container.webhooks.drain();
    settlementId = (evt!.data as { settlementId: string }).settlementId; // net 3786.30
  }
  return { ...ctx, bank, batch, settlementId };
}

const lines = async (app: Express, status?: string) =>
  (
    await request(app)
      .get(`/api/v1/reconciliation/lines${status ? `?status=${status}` : ''}`)
      .set(auth(TOKENS.finance))
  ).body.items as { id: string; status: string; amount: string; description: string }[];
const matches = async (app: Express, status?: string) =>
  (
    await request(app)
      .get(`/api/v1/reconciliation/matches${status ? `?status=${status}` : ''}`)
      .set(auth(TOKENS.finance))
  ).body.items as {
    id: string;
    rule: string;
    status: string;
    exceptionCode?: string;
    nsExternalIds: string[];
  }[];

describe('reconciliation: camt.053 statement with AP, AR, a fee and a duplicate', () => {
  it('auto-matches exact references, routes the unknown fee to exceptions, and skips duplicates', async () => {
    const { app, container, bank, batch, settlementId, netsuite } = await world({ withAr: true });
    await bank.statement('2026-11-23', {
      format: 'camt053',
      extra: [
        { amount: '3786.30', reference: settlementId, description: 'SIMPAY PAYOUT', bankRef: 'BNKPAYOUT1' },
        { amount: '-25.00', description: 'MONTHLY SERVICE FEE' },
      ],
    });
    const result = (await poll(app)).body.results[0];
    expect(result).toMatchObject({
      status: 'PROCESSED',
      fileType: 'STATEMENT',
      result: { format: 'CAMT053', lines: 4, autoMatched: 3, suggested: 0, exceptions: 1 },
    });

    // AP instructions are now Reconciled (state machine Settled → Reconciled).
    const view = (await request(app).get(`/api/v1/payment-batches/${batch.id}`).set(auth(TOKENS.ops))).body;
    expect(view.instructions.map((i: { status: string }) => i.status)).toEqual(['Reconciled', 'Reconciled']);
    // Approved matches are recorded in NetSuite (customrecord_nsd_recon_match).
    expect(netsuite.reconRecords.size).toBe(3);

    const [ex] = await matches(app, 'EXCEPTION');
    expect(ex).toMatchObject({ exceptionCode: 'RECON_UNMATCHED' });

    // The same payout line arrives again in a CSV export: a duplicate, not reconciled twice.
    const dup = await request(app)
      .post('/api/v1/reconciliation/statements')
      .set(auth(TOKENS.finance))
      .send({
        fileName: 'export-2026-11-23.csv',
        content: `date,description,amount,currency,reference,bank_ref\n2026-11-23,SIMPAY PAYOUT,3786.30,USD,${settlementId},BNKPAYOUT1\n`,
      });
    expect(dup.body.result).toMatchObject({ lines: 1, duplicates: 1, autoMatched: 0 });

    // Report: the fee is the only open item.
    const report = (
      await request(app)
        .get('/api/v1/reconciliation/report?from=2026-11-23&to=2026-11-23')
        .set(auth(TOKENS.finance))
    ).body;
    expect(report.bankLines).toMatchObject({
      total: { count: 4 },
      matched: { count: 3, amount: '2055.80' },
      exceptions: { count: 1, amount: '-25.00' },
    });
    expect(report.unreconciledNetSuiteTransactions).toEqual([]);
    expect(report.fullyReconciled).toBe(false);
    void container;
  });
});

describe('reconciliation: one-to-many, mismatch, suggestions and manual matches', () => {
  it('one bank debit for a whole ACH batch matches all its payments (GROUP_REF)', async () => {
    const { app, bank } = await world();
    await bank.statement('2026-11-23', { aggregateAch: true });
    expect((await poll(app)).body.results[0].result).toMatchObject({
      lines: 1,
      autoMatched: 1,
      exceptions: 0,
    });
    const [m] = await matches(app, 'AUTO_APPROVED');
    expect(m!.rule).toBe('GROUP_REF');
    expect(m!.nsExternalIds).toHaveLength(2);
  });

  it('fee deducted from a payout (reference matches, amount differs) → amount-mismatch exception; manual match must balance', async () => {
    const { app, bank, settlementId } = await world({ withAr: true });
    await bank.statement('2026-11-23', {
      extra: [{ amount: '3780.00', reference: settlementId, description: 'PAYOUT LESS FEE' }],
    });
    await poll(app);
    const exceptions = await matches(app, 'EXCEPTION');
    expect(exceptions.map((e) => e.exceptionCode)).toEqual(['RECON_AMOUNT_MISMATCH']);
    const line = (await lines(app, 'EXCEPTION'))[0]!;
    const manual = await request(app)
      .post('/api/v1/reconciliation/manual-match')
      .set(auth(TOKENS.finance))
      .send({ bankLineIds: [line.id], nsExternalIds: [settlementId], reason: 'Force match' });
    expect(manual.status).toBe(422);
    expect(manual.body.error.code).toBe('RECON_AMOUNT_MISMATCH');
  });

  it('a no-reference line is only SUGGESTED; finance approves, or rejects and matches manually', async () => {
    const { app, bank, container } = await world({ withAr: true });
    // A refund of 50.00 posts a Customer Refund in NetSuite. The bank line carries no reference.
    const intent = (
      await container.store
        .repo<{ id: string; customerExternalId: string }>('payment_intents')
        .list({ customerExternalId: 'CUST-ACME' })
    )[0]!;
    await request(app)
      .post(`/api/v1/payment-intents/${intent.id}/refunds`)
      .set(auth(TOKENS.ar))
      .set('Idempotency-Key', key())
      .send({ amount: '50.00', reason: 'damaged' });
    await container.webhooks.drain();
    await bank.statement('2026-11-23', { extra: [{ amount: '-50.00', description: 'CARD REFUND' }] });
    expect((await poll(app)).body.results[0].result).toMatchObject({ suggested: 1 });

    const [s] = await matches(app, 'SUGGESTED');
    expect(s!.rule).toBe('AMOUNT_DATE');
    // Only finance may decide.
    expect(
      (await request(app).post(`/api/v1/reconciliation/matches/${s!.id}/approve`).set(auth(TOKENS.ops)))
        .status,
    ).toBe(403);
    const rejected = await request(app)
      .post(`/api/v1/reconciliation/matches/${s!.id}/reject`)
      .set(auth(TOKENS.finance))
      .send({ reason: 'Need to confirm with AR' });
    expect(rejected.body.status).toBe('REJECTED');
    expect((await matches(app, 'EXCEPTION')).map((e) => e.exceptionCode)).toContain('RECON_REJECTED');

    const line = (await lines(app, 'EXCEPTION')).find((l) => l.amount === '-50.00')!;
    const refundId = (await container.ar.getIntent(intent.id)).refunds[0]!.refundId;
    const manual = await request(app)
      .post('/api/v1/reconciliation/manual-match')
      .set(auth(TOKENS.finance))
      .send({ bankLineIds: [line.id], nsExternalIds: [refundId], reason: 'Confirmed with AR: card refund' });
    expect(manual.body).toMatchObject({ rule: 'MANUAL', status: 'APPROVED', reviewer: 'finance:fiona' });
  });
});

describe('reconciliation: returns, late postings and quarantine replay', () => {
  it('an ACH return: the original debit and the return credit both reconcile', async () => {
    const { app, bank } = await world({ behaviour: { returnPayees: { 'VEND-BOLTCO': 'R01' } } });
    await bank.sendReturns('2026-11-23');
    await poll(app);
    await bank.statement('2026-11-23');
    expect((await poll(app)).body.results[0].result).toMatchObject({
      lines: 3,
      autoMatched: 3,
      exceptions: 0,
    });
    expect((await matches(app, 'AUTO_APPROVED')).some((m) => m.nsExternalIds.length === 1)).toBe(true);
  });

  it('statement arrives before NetSuite has the deposit → exception; after replaying the DLQ, rematch resolves it', async () => {
    const ctx = makeTestContext();
    const { app, container, netsuite } = ctx;
    deliverWebhooks(app, container);
    const intent = (
      await request(app)
        .post('/api/v1/payment-intents')
        .set(auth(TOKENS.acme))
        .set('Idempotency-Key', key())
        .send({ invoiceExternalIds: ['INV-2001'] })
    ).body;
    await container.provider.completeCheckout(intent.providerRef, 'tok_visa_ok');
    netsuite.injectFault('unavailable', 4, 'createDeposit');
    const evt = await container.provider.settle('2026-11-23');
    await container.webhooks.drain();
    const settlementId = (evt!.data as { settlementId: string }).settlementId;

    await new BankSimulator(container.files).statement('2026-11-23', {
      extra: [{ amount: '485.20', reference: settlementId, description: 'SIMPAY PAYOUT' }],
    });
    expect((await poll(app)).body.results[0].result).toMatchObject({ exceptions: 1 });

    const dl = (await container.jobs.listDeadLetters()).find((d) => d.topic === 'netsuite.deposit.post')!;
    await request(app).post(`/api/v1/dead-letters/${dl.id}/replay`).set(auth(TOKENS.ops));
    const rematch = await request(app).post('/api/v1/reconciliation/rematch').set(auth(TOKENS.finance));
    expect(rematch.body).toMatchObject({ autoMatched: 1, exceptions: 0 });
  });

  it('quarantines a broken statement and processes it after ops fixes and replays it', async () => {
    const { app, container } = makeTestContext();
    await container.files.put('inbound', 'STMT_bad.csv', 'not,a,statement\n');
    expect((await poll(app)).body.results[0].status).toBe('QUARANTINED');
    expect(
      (await request(app).get('/api/v1/bank/files/quarantine').set(auth(TOKENS.ops))).body.items,
    ).toEqual(['STMT_bad.csv']);

    // Ops obtains a corrected file from the bank and puts it in place, then replays it.
    await container.files.put(
      'quarantine',
      'STMT_bad.csv',
      'date,description,amount,currency,reference,bank_ref\n2026-11-23,INTEREST,1.23,USD,,BNKINT1\n',
    );
    const replay = await request(app)
      .post('/api/v1/bank/files/quarantine/STMT_bad.csv/replay')
      .set(auth(TOKENS.ops));
    expect(replay.body).toMatchObject({ status: 'PROCESSED', fileType: 'STATEMENT' });
    // Path traversal attempts are refused as invalid input.
    expect(
      (await request(app).post('/api/v1/bank/files/quarantine/..%2Fsecret/replay').set(auth(TOKENS.ops)))
        .status,
    ).toBe(400);
  });
});
