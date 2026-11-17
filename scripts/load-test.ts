/**
 * Load test: pushes high-volume synthetic batches through the REAL middleware code, in-process.
 *
 *   npm run loadtest -- --vendors 500 --billsPerVendor 10 --payments 300
 *
 * WHAT IT MEASURES, stage by stage:
 *   throughput (items/s), latency, NetSuite API calls (the scarce resource in production), outbox queue
 *   age, and memory.
 *
 * WHAT IT DOES NOT MEASURE: real NetSuite latency or governance. NetSuite is the in-memory mock here,
 * so timings show MIDDLEWARE overhead only. The API-call counts are what to compare with your account's
 * concurrency and request limits (see docs/performance/report.md).
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pino from 'pino';
import { MockNetSuiteAdapter } from '../middleware/src/adapters/netsuite/mock-netsuite';
import { createContainer } from '../middleware/src/container';
import { loadConfig } from '../middleware/src/shared/config';
import { runWithContext } from '../middleware/src/shared/context';
import { fixedClock } from '../middleware/src/shared/util';
import { BankSimulator } from '../simulators/bank/bank-simulator';

const arg = (name: string, def: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) : def;
};
const VENDORS = arg('vendors', 300);
const BILLS_PER_VENDOR = arg('billsPerVendor', 10);
const PAYMENTS = arg('payments', 200);

interface StageResult {
  stage: string;
  items: number;
  ms: number;
  perSecond: number;
  netsuiteCalls: number;
}

async function main() {
  const clock = fixedClock('2026-11-20T09:00:00Z');
  const netsuite = new MockNetSuiteAdapter({ seed: false });
  const config = loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEBHOOK_SIGNING_SECRET: 'load-test-secret-0123456789abcdef',
    API_TOKENS: 'lt:ops:loadtest',
    SFTP_ROOT: join(tmpdir(), `nsd-loadtest-${Date.now()}`),
  });
  const c = createContainer(config, {
    logger: pino({ level: 'silent' }),
    clock,
    netsuite,
    sleep: async () => undefined,
  });
  const bank = new BankSimulator(c.files);
  const results: StageResult[] = [];

  // Synthetic data: vendors, each with several approved bills due before the window ends.
  for (let v = 0; v < VENDORS; v++) {
    const id = `VEND-LT${String(v).padStart(5, '0')}`;
    await netsuite.upsertVendor({
      externalId: id,
      companyName: `Load Vendor ${v}`,
      currency: 'USD',
      isInactive: false,
      paymentRail: 'ACH',
      bankToken: `tok_bank_lt${v}`,
      routingNumber: '110000000',
    });
    for (let b = 0; b < BILLS_PER_VENDOR; b++) {
      netsuite.addBill({
        externalId: `BILL-LT${v}-${b}`,
        vendorExternalId: id,
        tranId: `INV-${v}-${b}`,
        tranDate: '2026-10-01',
        dueDate: '2026-11-19',
        currency: 'USD',
        total: `${100 + b}.25`,
        amountRemaining: `${100 + b}.25`,
        approvalStatus: 'APPROVED',
        onHold: false,
        paymentInProgress: false,
      });
    }
  }
  for (let p = 0; p < PAYMENTS; p++) {
    await netsuite.upsertCustomer({
      externalId: `CUST-LT${p}`,
      companyName: `Load Customer ${p}`,
      currency: 'USD',
      email: `c${p}@example.test`,
    });
    netsuite.addInvoice({
      externalId: `INV-LT${p}`,
      customerExternalId: `CUST-LT${p}`,
      tranId: `NS-LT${p}`,
      tranDate: '2026-10-01',
      dueDate: '2026-10-31',
      currency: 'USD',
      total: '250.00',
      amountRemaining: '250.00',
      disputed: false,
      collectionStage: 'NONE',
    });
  }

  async function stage<T>(name: string, items: number, fn: () => Promise<T>): Promise<T> {
    const calls = netsuite.calls.length;
    const t0 = performance.now();
    const out = await fn();
    const ms = performance.now() - t0;
    results.push({
      stage: name,
      items,
      ms: Math.round(ms),
      perSecond: Math.round((items / ms) * 1000),
      netsuiteCalls: netsuite.calls.length - calls,
    });
    return out;
  }

  const as = <T>(actor: string, fn: () => Promise<T>) =>
    runWithContext({ correlationId: `loadtest-${actor}`, actor }, fn);
  const totalBills = VENDORS * BILLS_PER_VENDOR;

  await stage('AP proposal (eligibility rules)', totalBills, () =>
    c.ap.propose({ currency: 'USD', rail: 'ACH', windowDays: 7 }),
  );
  const batch = await stage('AP create batch', totalBills, () =>
    as('ap_maker:alice', () => c.ap.createBatch({ currency: 'USD', rail: 'ACH', windowDays: 7 })),
  );
  await stage('AP approve (re-check + hash)', totalBills, () =>
    as('ap_checker:bob', () => c.ap.approve(batch.id, 'bob')),
  );
  await stage('AP submit (flag bills + NACHA + SFTP)', VENDORS, () =>
    as('ops:o', () => c.ap.submit(batch.id)),
  );
  await bank.pickUp();
  await stage('Bank ACK processing', VENDORS, () => c.bankInbound.poll());
  await bank.settle('2026-11-23');
  await stage('Settlement → NetSuite Vendor Payments (outbox)', VENDORS, () => c.bankInbound.poll());

  // AR: online payments with signed webhooks, processed through inbox + outbox.
  c.provider.setDeliver(async (raw, sig) => {
    await c.webhooks.receive(raw, sig);
  });
  const webhookLatencies: number[] = [];
  await stage('AR payments (intent + checkout + webhook + posting)', PAYMENTS, async () => {
    for (let p = 0; p < PAYMENTS; p++) {
      const intent = await as(`customer:CUST-LT${p}`, () =>
        c.ar.createIntent({ customerExternalId: `CUST-LT${p}`, invoiceExternalIds: [`INV-LT${p}`] }),
      );
      const t = performance.now();
      await c.provider.completeCheckout(intent.providerRef, 'tok_visa_ok');
      await c.webhooks.drain();
      webhookLatencies.push(performance.now() - t);
    }
  });
  const payout = await c.provider.settle('2026-11-23');
  await c.webhooks.drain();

  await bank.statement('2026-11-23', {
    extra: [
      {
        amount: (payout!.data as { net: string }).net,
        reference: (payout!.data as { settlementId: string }).settlementId,
        description: 'PAYOUT',
      },
    ],
  });
  const recon = await stage('Reconciliation (statement import + matching)', VENDORS + 1, () =>
    c.bankInbound.poll(),
  );

  const outbox = await c.dispatcher.stats();
  const dlq = await c.jobs.listDeadLetters();
  const p = (q: number) => {
    const s = [...webhookLatencies].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]! * 10) / 10;
  };
  const summary = {
    parameters: { vendors: VENDORS, billsPerVendor: BILLS_PER_VENDOR, bills: totalBills, payments: PAYMENTS },
    stages: results,
    webhookLatencyMs: { p50: p(0.5), p95: p(0.95), p99: p(0.99) },
    outboxAfterRun: outbox,
    deadLetters: dlq.length,
    vendorPaymentsPosted: netsuite.countTransactions('VendPymt'),
    customerPaymentsPosted: netsuite.countTransactions('CustPymt'),
    reconciliation: (recon[0] as { result?: unknown } | undefined)?.result,
    totalNetSuiteCalls: netsuite.calls.length,
    heapUsedMb: Math.round(process.memoryUsage().heapUsed / 1e6),
    node: process.version,
  };

  console.log(JSON.stringify(summary, null, 2));
  const out = resolve(__dirname, '../docs/performance');
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, 'last-run.json'), JSON.stringify(summary, null, 2) + '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
