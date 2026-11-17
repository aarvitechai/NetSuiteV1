/**
 * Failure-injection tests for the transactional outbox.
 *
 * We simulate a "crash after commit" by running in DISPATCH_MODE=worker: services commit their state
 * change plus outbox message, but nothing is delivered until the worker drains. That is exactly what a
 * restarted process sees after dying at the worst possible moment.
 */
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { BankSimulator } from '../../../simulators/bank/bank-simulator';
import { auth, makeTestContext, TOKENS } from '../helpers';

let n = 0;
const key = () => `obx-${++n}-${Date.now()}`;

describe('transactional outbox', () => {
  it('a settlement committed just before a crash is still posted to NetSuite after restart', async () => {
    const { app, container, netsuite } = makeTestContext({}, { DISPATCH_MODE: 'worker' });
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
    await request(app).post('/api/v1/bank/inbound/poll').set(auth(TOKENS.ops));
    await bank.settle('2026-11-23');
    await request(app).post('/api/v1/bank/inbound/poll').set(auth(TOKENS.ops));

    // "Crash": the state says Settled, but the follow-up work has not run yet.
    expect(netsuite.countTransactions('VendPymt')).toBe(0);
    const stats = await container.dispatcher.stats();
    expect(stats.pending).toBe(2);

    // A message left IN_PROGRESS by a dead process is recovered at start-up.
    const repo = container.store.repo<{ id: string; status: string }>('outbox_messages');
    const [first] = await repo.list({ status: 'PENDING' });
    await repo.upsert({ ...first!, status: 'IN_PROGRESS' });
    expect(await container.dispatcher.recoverStuck()).toBe(1);

    // "Restart": the worker drains the outbox. Nothing was lost, and nothing is duplicated.
    expect(await container.dispatcher.drain()).toBe(2);
    expect(netsuite.countTransactions('VendPymt')).toBe(2);
    expect(await container.dispatcher.drain()).toBe(0);
    expect((await container.dispatcher.stats()).pending).toBe(0);
  });

  it('a rolled-back transaction leaves no outbox message behind (no phantom work)', async () => {
    const { container } = makeTestContext();
    await expect(
      container.store.transaction(async (tx) => {
        await container.dispatcher.dispatch(
          'netsuite.bills.flag',
          { billIds: ['BILL-1001'], inProgress: true, batchRef: 'X' },
          { tx },
        );
        throw new Error('business rule failed after enqueue');
      }),
    ).rejects.toThrow();
    expect((await container.dispatcher.stats()).pending).toBe(0);
  });

  it('webhooks accepted while the worker is down are processed later, exactly once', async () => {
    const { app, container, netsuite } = makeTestContext({}, { DISPATCH_MODE: 'worker' });
    container.provider.setDeliver(async (raw, signature) => {
      await request(app)
        .post('/webhooks/payment-provider')
        .set('Content-Type', 'application/json')
        .set('X-Signature', signature)
        .send(raw);
    });
    const intent = (
      await request(app)
        .post('/api/v1/payment-intents')
        .set(auth(TOKENS.acme))
        .set('Idempotency-Key', key())
        .send({ invoiceExternalIds: ['INV-2001'] })
    ).body;
    await container.provider.completeCheckout(intent.providerRef, 'tok_visa_ok');
    const evt = container.provider.events.at(-1)!;
    await container.provider.redeliver(evt.event.id); // the provider retries too
    expect(netsuite.countTransactions('CustPymt')).toBe(0);

    await container.dispatcher.drain();
    expect(netsuite.countTransactions('CustPymt')).toBe(1);
    expect((await container.ar.getIntent(intent.id)).status).toBe('SUCCEEDED');
  });
});
