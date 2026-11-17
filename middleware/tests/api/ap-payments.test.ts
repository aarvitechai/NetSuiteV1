/**
 * Phase 7 end-to-end: bill eligibility → batch (maker) → approval (checker) → NACHA file → SFTP →
 * bank ACK → settlement → NetSuite Vendor Payment, plus every failure path from the plan:
 * duplicate bill, rejected payment, returned ACH, timeout, partial batch failure, tampering.
 */
import type { Express } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BankSimulator } from '../../../simulators/bank/bank-simulator';
import { auth, makeTestContext, pollBank, TOKENS } from '../helpers';

let keySeq = 0;
const key = () => `test-key-${++keySeq}-${Date.now()}`;

async function createBatch(app: Express, body: object = { currency: 'USD', rail: 'ACH', windowDays: 7 }) {
  const r = await request(app)
    .post('/api/v1/payment-batches')
    .set(auth(TOKENS.maker))
    .set('Idempotency-Key', key())
    .send(body);
  return r;
}

async function approvedAndSubmitted(app: Express) {
  const created = await createBatch(app);
  expect(created.status).toBe(201);
  const id = created.body.id as string;
  expect(
    (await request(app).post(`/api/v1/payment-batches/${id}/approve`).set(auth(TOKENS.checker))).status,
  ).toBe(200);
  const submitted = await request(app)
    .post(`/api/v1/payment-batches/${id}/submit`)
    .set(auth(TOKENS.ops))
    .set('Idempotency-Key', key());
  expect(submitted.status).toBe(200);
  return submitted.body;
}

const poll = pollBank;

describe('AP payment proposal', () => {
  it('groups eligible bills per vendor and explains every exclusion', async () => {
    const { app } = makeTestContext();
    const r = await request(app)
      .get('/api/v1/ap/proposal?currency=USD&rail=ACH&windowDays=7')
      .set(auth(TOKENS.maker));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe('1730.50');
    expect(
      r.body.vendors.map((v: { vendorExternalId: string; amount: string }) => [v.vendorExternalId, v.amount]),
    ).toEqual([
      ['VEND-ACMESUP', '1250.00'],
      ['VEND-BOLTCO', '480.50'],
    ]);
    expect(r.body.excluded.find((e: { externalId: string }) => e.externalId === 'BILL-1004').reasons).toEqual(
      ['DUPLICATE_BILL'],
    );
  });
});

describe('AP happy path: bill → batch → approval → file → ACK → settlement → NetSuite', () => {
  it('runs the whole lifecycle', async () => {
    const { app, container, netsuite } = makeTestContext();
    const bank = new BankSimulator(container.files);

    // Maker creates the batch.
    const created = await createBatch(app);
    expect(created.body).toMatchObject({
      status: 'PENDING_APPROVAL',
      total: '1730.50',
      itemCount: 2,
      makerId: 'ap_maker:alice',
    });
    const id = created.body.id;
    expect(created.body.instructions.every((i: { status: string }) => i.status === 'Validated')).toBe(true);

    // The same bills cannot go into a second batch.
    const second = await createBatch(app);
    expect(second.status).toBe(422);
    expect(second.body.error.code).toBe('NO_ELIGIBLE_BILLS');

    // Maker-checker: the maker (even holding a checker token) cannot approve. A maker role cannot call approve at all.
    expect(
      (await request(app).post(`/api/v1/payment-batches/${id}/approve`).set(auth(TOKENS.maker))).status,
    ).toBe(403);
    const self = await request(app)
      .post(`/api/v1/payment-batches/${id}/approve`)
      .set(auth(TOKENS.aliceChecker));
    expect(self.status).toBe(403);
    expect(self.body.error.code).toBe('MAKER_CHECKER_VIOLATION');

    // Checker approves.
    const approved = await request(app)
      .post(`/api/v1/payment-batches/${id}/approve`)
      .set(auth(TOKENS.checker));
    expect(approved.body).toMatchObject({ status: 'APPROVED', checkerId: 'ap_checker:bob' });
    expect(approved.body.approvedHash).toMatch(/^[0-9a-f]{64}$/);

    // Submit: bills flagged in NetSuite, NACHA file archived and placed in outbound/.
    const submitted = await request(app)
      .post(`/api/v1/payment-batches/${id}/submit`)
      .set(auth(TOKENS.ops))
      .set('Idempotency-Key', key());
    expect(submitted.body.status).toBe('SUBMITTED');
    expect(submitted.body.file.name).toMatch(/^NSD_PB\d{8}[A-Z0-9]{6}\.ach$/);
    expect((await netsuite.getVendorBill('BILL-1001'))!.paymentInProgress).toBe(true);
    expect(await container.files.list('outbound')).toEqual([submitted.body.file.name]);
    expect(await container.files.list('archive/outbound')).toEqual([submitted.body.file.name]);

    // Bank picks up and acknowledges. Accepted is NOT paid: still no NetSuite payment.
    const [ack] = await bank.pickUp();
    expect(ack!.status).toBe('ACCEPTED');
    expect((await poll(app)).body.results[0]).toMatchObject({ status: 'PROCESSED', fileType: 'ACK' });
    const afterAck = await request(app).get(`/api/v1/payment-batches/${id}`).set(auth(TOKENS.ops));
    expect(afterAck.body.status).toBe('ACKNOWLEDGED');
    expect(afterAck.body.instructions.map((i: { status: string }) => i.status)).toEqual([
      'Accepted',
      'Accepted',
    ]);
    expect(netsuite.countTransactions('VendPymt')).toBe(0);

    // Money moves: settlement → NetSuite Vendor Payments are created, and bills are paid.
    await bank.settle('2026-11-23');
    await poll(app);
    const done = await request(app).get(`/api/v1/payment-batches/${id}`).set(auth(TOKENS.ops));
    expect(done.body.status).toBe('COMPLETED');
    expect(
      done.body.instructions.every(
        (i: { status: string; netsuitePaymentId?: string }) => i.status === 'Settled' && i.netsuitePaymentId,
      ),
    ).toBe(true);
    expect(netsuite.countTransactions('VendPymt')).toBe(2);
    expect((await netsuite.getVendorBill('BILL-1001'))!.amountRemaining).toBe('0.00');

    // The bank resends the same status file: detected as a duplicate, so no second payment.
    const resend = (await container.files.list('archive/inbound')).find((n) => n.startsWith('STATUS_'))!;
    await container.files.put(
      'inbound',
      `RESEND_${resend}`,
      await container.files.get('archive/inbound', resend),
    );
    expect((await poll(app)).body.results[0].status).toBe('DUPLICATE');
    expect(netsuite.countTransactions('VendPymt')).toBe(2);

    // Full audit trail for the batch.
    const trail = await request(app)
      .get(`/api/v1/audit?entityType=payment_batch&entityId=${id}`)
      .set(auth(TOKENS.ops));
    expect(trail.body.items.map((e: { action: string }) => e.action)).toEqual([
      'PAYMENT_BATCH_CREATED',
      'PAYMENT_BATCH_APPROVAL_DENIED',
      'PAYMENT_BATCH_APPROVED',
      'PAYMENT_BATCH_SUBMITTED',
      'BANK_ACK_PROCESSED',
      'BANK_STATUS_PROCESSED',
    ]);
  });
});

describe('AP failure scenarios', () => {
  it('returned ACH (R01) after settlement: voids the NetSuite payment and reopens the bill', async () => {
    const { app, container, netsuite } = makeTestContext();
    const bank = new BankSimulator(container.files, { returnPayees: { 'VEND-BOLTCO': 'R01' } });
    const batch = await approvedAndSubmitted(app);
    await bank.pickUp();
    await poll(app);
    await bank.settle('2026-11-23');
    await poll(app);
    expect((await netsuite.getVendorBill('BILL-1002'))!.amountRemaining).toBe('0.00');

    await bank.sendReturns('2026-11-25');
    await poll(app);
    const view = (await request(app).get(`/api/v1/payment-batches/${batch.id}`).set(auth(TOKENS.ops))).body;
    const bolt = view.instructions.find(
      (i: { counterpartyExternalId: string }) => i.counterpartyExternalId === 'VEND-BOLTCO',
    );
    expect(bolt).toMatchObject({ status: 'Reversed', returnCode: 'R01' });
    const bill = (await netsuite.getVendorBill('BILL-1002'))!;
    expect(bill.amountRemaining).toBe('480.50'); // reopened
    expect(bill.paymentInProgress).toBe(false); // can be paid again
    expect(netsuite.getTransaction('VendPymt', bolt.id)!.voided).toBe(true);
  });

  it('partial batch failure: one entry rejected by the bank, the other proceeds', async () => {
    const { app, container, netsuite } = makeTestContext();
    const bank = new BankSimulator(container.files, { rejectPayees: ['VEND-BOLTCO'] });
    const batch = await approvedAndSubmitted(app);
    await bank.pickUp();
    await poll(app);
    const view = (await request(app).get(`/api/v1/payment-batches/${batch.id}`).set(auth(TOKENS.ops))).body;
    expect(view.status).toBe('ACKNOWLEDGED');
    const statuses = Object.fromEntries(
      view.instructions.map((i: { counterpartyExternalId: string; status: string }) => [
        i.counterpartyExternalId,
        i.status,
      ]),
    );
    expect(statuses).toEqual({ 'VEND-ACMESUP': 'Accepted', 'VEND-BOLTCO': 'Failed' });
    expect((await netsuite.getVendorBill('BILL-1002'))!.paymentInProgress).toBe(false); // released

    await bank.settle('2026-11-23');
    await poll(app);
    expect(netsuite.countTransactions('VendPymt')).toBe(1);
    expect(
      (await request(app).get(`/api/v1/payment-batches/${batch.id}`).set(auth(TOKENS.ops))).body.status,
    ).toBe('COMPLETED');
  });

  it('whole file rejected: batch FAILED and every bill released', async () => {
    const { app, container, netsuite } = makeTestContext();
    const bank = new BankSimulator(container.files, { rejectFile: true });
    const batch = await approvedAndSubmitted(app);
    await bank.pickUp();
    await poll(app);
    expect(
      (await request(app).get(`/api/v1/payment-batches/${batch.id}`).set(auth(TOKENS.ops))).body.status,
    ).toBe('FAILED');
    expect((await netsuite.getVendorBill('BILL-1001'))!.paymentInProgress).toBe(false);
    // The bills can be proposed again.
    expect(
      (await request(app).get('/api/v1/ap/proposal?currency=USD&rail=ACH').set(auth(TOKENS.maker))).body
        .total,
    ).toBe('1730.50');
  });

  it('NetSuite timeout during submit: nothing is sent; a later retry succeeds', async () => {
    const { app, container, netsuite } = makeTestContext();
    const created = await createBatch(app);
    await request(app).post(`/api/v1/payment-batches/${created.body.id}/approve`).set(auth(TOKENS.checker));
    netsuite.injectFault('unavailable', 4, 'setBillPaymentFlags');
    const fail = await request(app)
      .post(`/api/v1/payment-batches/${created.body.id}/submit`)
      .set(auth(TOKENS.ops))
      .set('Idempotency-Key', key());
    expect(fail.status).toBe(422);
    expect(fail.body.error.code).toBe('NETSUITE_FLAG_FAILED');
    expect(await container.files.list('outbound')).toEqual([]);

    const retry = await request(app)
      .post(`/api/v1/payment-batches/${created.body.id}/submit`)
      .set(auth(TOKENS.ops))
      .set('Idempotency-Key', key());
    expect(retry.body.status).toBe('SUBMITTED');
  });

  it('refuses approval when a bill changed after batch creation (put on hold)', async () => {
    const { app, netsuite } = makeTestContext();
    const created = await createBatch(app);
    netsuite.patchBill('BILL-1002', { onHold: true });
    const r = await request(app)
      .post(`/api/v1/payment-batches/${created.body.id}/approve`)
      .set(auth(TOKENS.checker));
    expect(r.status).toBe(422);
    expect(r.body.error.details.problems).toEqual([{ billId: 'BILL-1002', reasons: ['ON_HOLD'] }]);
  });

  it('detects tampering after approval and refuses to send', async () => {
    const { app, container } = makeTestContext();
    const created = await createBatch(app);
    await request(app).post(`/api/v1/payment-batches/${created.body.id}/approve`).set(auth(TOKENS.checker));
    const repo = container.store.repo<{ id: string; amount: string }>('payment_instructions');
    const inst = (await repo.get(created.body.instructions[0].id))!;
    await repo.upsert({ ...inst, amount: '99999.00' });
    const r = await request(app)
      .post(`/api/v1/payment-batches/${created.body.id}/submit`)
      .set(auth(TOKENS.ops))
      .set('Idempotency-Key', key());
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('BATCH_MODIFIED_AFTER_APPROVAL');
  });

  it('checker rejection sends instructions back to Draft and frees the bills', async () => {
    const { app } = makeTestContext();
    const created = await createBatch(app);
    const r = await request(app)
      .post(`/api/v1/payment-batches/${created.body.id}/reject`)
      .set(auth(TOKENS.checker))
      .send({ reason: 'Wrong payment date' });
    expect(r.body.status).toBe('REJECTED');
    expect(r.body.instructions.every((i: { status: string }) => i.status === 'Draft')).toBe(true);
    expect((await createBatch(app)).status).toBe(201);
  });

  it('rejects client-chosen bills that are not eligible (never trusts the client)', async () => {
    const { app } = makeTestContext();
    const r = await createBatch(app, {
      currency: 'USD',
      rail: 'ACH',
      billExternalIds: ['BILL-1001', 'BILL-1003'],
    });
    expect(r.status).toBe(422);
    expect(r.body.error.details.bills).toEqual([{ externalId: 'BILL-1003', reasons: ['ON_HOLD'] }]);
  });

  it('quarantines unreadable inbound files', async () => {
    const { app, container } = makeTestContext();
    await container.files.put('inbound', 'garbage.json', '{not json');
    expect((await poll(app)).body.results[0].status).toBe('QUARANTINED');
    expect(await container.files.list('quarantine')).toEqual(['garbage.json']);
  });
});

describe('other payment rails', () => {
  it('builds a wire file for EUR and a virtual-card file', async () => {
    const { app, container } = makeTestContext();
    const bank = new BankSimulator(container.files);
    for (const [currency, rail, ext] of [
      ['EUR', 'WIRE', '.wire.csv'],
      ['USD', 'VCARD', '.vcard.jsonl'],
    ] as const) {
      const created = await createBatch(app, { currency, rail, windowDays: 7 });
      expect(created.status).toBe(201);
      await request(app).post(`/api/v1/payment-batches/${created.body.id}/approve`).set(auth(TOKENS.checker));
      const s = await request(app)
        .post(`/api/v1/payment-batches/${created.body.id}/submit`)
        .set(auth(TOKENS.ops))
        .set('Idempotency-Key', key());
      expect(s.body.file.name.endsWith(ext)).toBe(true);
    }
    const acks = await bank.pickUp();
    expect(acks.map((a) => a.status)).toEqual(['ACCEPTED', 'ACCEPTED']);
    await poll(app);
    await bank.settle('2026-11-23');
    await poll(app);
    expect(container.netsuite.kind).toBe('mock');
    const batches = (await request(app).get('/api/v1/payment-batches?status=COMPLETED').set(auth(TOKENS.ops)))
      .body.items;
    expect(batches).toHaveLength(2);
  });
});
