/**
 * Narrated end-to-end demo: `npm run demo`
 *
 * It follows the plan's "Final Portfolio Demonstration" (plan.md §13) and drives the REAL HTTP API
 * in-process (supertest), with the bank and payment-provider simulators. Everything is synthetic.
 * Read the output top to bottom as the talk track. docs/portfolio/demo-script.md has speaker notes.
 */
import request from 'supertest';
import pino from 'pino';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockNetSuiteAdapter } from '../middleware/src/adapters/netsuite/mock-netsuite';
import { createApp } from '../middleware/src/app';
import { createContainer } from '../middleware/src/container';
import { loadConfig } from '../middleware/src/shared/config';
import { fixedClock } from '../middleware/src/shared/util';
import { BankSimulator } from '../simulators/bank/bank-simulator';

const T = {
  maker: 'demo-maker',
  checker: 'demo-checker',
  ops: 'demo-ops',
  ar: 'demo-ar',
  finance: 'demo-finance',
  acme: 'demo-acme',
};

const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
let step = 0;
const section = (title: string) => console.log(`\n${bold(`━━ ${++step}. ${title} ━━`)}`);
const say = (s: string) => console.log(`   ${s}`);
const note = (s: string) => console.log(dim(`   ↳ ${s}`));
let k = 0;
const key = () => `demo-${++k}-${Date.now()}`;

async function main() {
  const clock = fixedClock('2026-11-20T09:00:00Z');
  const netsuite = new MockNetSuiteAdapter();
  const config = loadConfig({
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    WEBHOOK_SIGNING_SECRET: 'demo-webhook-secret-0123456789abcdef',
    SFTP_ROOT: join(tmpdir(), `nsd-demo-${Date.now()}`),
    API_TOKENS: `${T.maker}:ap_maker:alice,${T.checker}:ap_checker:bob,${T.ops}:ops:olivia,${T.ar}:ar_clerk:carol,${T.finance}:finance:fiona,${T.acme}:customer:CUST-ACME`,
  });
  const c = createContainer(config, {
    logger: pino({ level: 'silent' }),
    clock,
    netsuite,
    sleep: async () => undefined,
  });
  const app = createApp(c);
  const api = (token: string) => ({
    get: (p: string) => request(app).get(p).set('Authorization', `Bearer ${token}`),
    post: (p: string, body: object = {}, idem = false) => {
      const r = request(app).post(p).set('Authorization', `Bearer ${token}`);
      if (idem) r.set('Idempotency-Key', key());
      return r.send(body);
    },
  });
  c.provider.setDeliver(async (raw, sig) => {
    await request(app)
      .post('/webhooks/payment-provider')
      .set('Content-Type', 'application/json')
      .set('X-Signature', sig)
      .send(raw);
  });
  const bank = new BankSimulator(c.files, { returnPayees: { 'VEND-BOLTCO': 'R01' } });
  const poll = () => api(T.ops).post('/api/v1/bank/inbound/poll');

  console.log(
    bold('\nNorthstar Distribution: AP/AR & Banking Payments Integration Platform (DEMO, synthetic data)'),
  );
  console.log(
    dim('NetSuite = in-memory simulator · bank and payment provider = simulators · see KNOWN_LIMITATIONS.md'),
  );

  section('Architecture: NetSuite is the accounting system of record');
  say('Middleware orchestrates (adapters, retries, webhooks, files). NetSuite owns the GL (ADR-0001).');
  say(`Readiness: ${JSON.stringify((await request(app).get('/ready')).body.checks)}`);

  section('AP: approved bill → eligibility → payment batch (maker) → approval (checker)');
  const proposal = (await api(T.maker).get('/api/v1/ap/proposal?currency=USD&rail=ACH')).body;
  say(
    `Eligible: ${proposal.vendors.map((v: { vendorName: string; amount: string }) => `${v.vendorName} ${v.amount}`).join(', ')}  (total ${proposal.total})`,
  );
  for (const e of proposal.excluded) say(dim(`excluded ${e.externalId}: ${e.reasons.join(', ')}`));
  const batch = (await api(T.maker).post('/api/v1/payment-batches', { currency: 'USD', rail: 'ACH' }, true))
    .body;
  say(`Batch ${batch.batchRef} created by ${batch.makerId}: ${batch.status}`);
  const self = await api(T.maker).post(`/api/v1/payment-batches/${batch.id}/approve`);
  note(`Maker trying to approve own batch → HTTP ${self.status} (segregation of duties)`);
  const approved = (await api(T.checker).post(`/api/v1/payment-batches/${batch.id}/approve`)).body;
  say(`Approved by ${approved.checkerId}; content hash frozen ${approved.approvedHash.slice(0, 16)}…`);

  section('Generate a NACHA file and submit it to the bank (SFTP simulator)');
  const submitted = (await api(T.ops).post(`/api/v1/payment-batches/${batch.id}/submit`, {}, true)).body;
  const file = await c.files.get('archive/outbound', submitted.file.name);
  say(`File ${submitted.file.name}  sha256 ${submitted.file.sha256.slice(0, 16)}…`);
  // Mask the DFI account number (positions 13–29 of each "6" entry record) before printing.
  const mask = (l: string) =>
    l.startsWith('6') ? `${l.slice(0, 12)}${'*'.repeat(13)}${l.slice(25, 29)}${l.slice(29)}` : l;
  file
    .split('\n')
    .slice(0, 6)
    .forEach((l) => say(dim(mask(l))));
  note('Account numbers come from the vault token and live only inside the file (masked here)');

  section('Bank acknowledgement and settlement → NetSuite Vendor Payments');
  await bank.pickUp();
  await poll();
  say(`After ACK: NetSuite vendor payments = ${netsuite.countTransactions('VendPymt')} (accepted ≠ paid)`);
  await bank.settle('2026-11-23');
  await poll();
  say(
    `After settlement: NetSuite vendor payments = ${netsuite.countTransactions('VendPymt')}; BILL-1001 remaining = ${(await netsuite.getVendorBill('BILL-1001'))!.amountRemaining}`,
  );
  await bank.sendReturns('2026-11-24');
  await poll();
  say(
    `ACH return R01 for Bolt & Co → payment voided, BILL-1002 reopened at ${(await netsuite.getVendorBill('BILL-1002'))!.amountRemaining}`,
  );

  section('AR: customer views an invoice in the portal and pays online (hosted checkout)');
  const stmt = (await api(T.acme).get('/api/v1/portal/statement')).body;
  say(
    `Acme sees open balance ${stmt.openBalance[0].amount}; invoices ${stmt.invoices.map((i: { number: string; state: string }) => `${i.number} (${i.state})`).join(', ')}`,
  );
  const intent = (
    await api(T.acme).post('/api/v1/payment-intents', { invoiceExternalIds: ['INV-2001'] }, true)
  ).body;
  say(`Payment intent ${intent.id.slice(0, 13)}… → redirect to ${intent.checkoutUrl}`);
  await c.provider.completeCheckout(intent.providerRef, 'tok_visa_ok');
  await c.webhooks.drain();
  const after = (await api(T.acme).get('/api/v1/portal/statement')).body;
  say(`Signed webhook processed → portal status: "${after.payments[0].status}"`);

  section('Replay a duplicate webhook: no duplicate payment');
  const evt = c.provider.events.find((e) => e.event.type === 'payment.succeeded')!;
  await c.provider.redeliver(evt.event.id);
  await c.webhooks.drain();
  say(
    `Customer payments in NetSuite after duplicate delivery: ${netsuite.countTransactions('CustPymt')} (inbox keyed by event id)`,
  );

  section('Import a bank statement: automatic matches plus an exception');
  const payout = await c.provider.settle('2026-11-24');
  await c.webhooks.drain();
  const s = payout!.data as { settlementId: string; net: string; fees: string };
  say(`Provider payout: net ${s.net} after fees ${s.fees} → NetSuite Deposit (fees booked separately)`);
  await bank.statement('2026-11-24', {
    format: 'camt053',
    extra: [
      { amount: s.net, reference: s.settlementId, description: 'SIMPAY PAYOUT' },
      { amount: '-25.00', description: 'MONTHLY SERVICE FEE' },
    ],
  });
  const rec = (await poll()).body.results[0].result;
  say(`camt.053: ${rec.lines} lines → ${rec.autoMatched} auto-matched, ${rec.exceptions} exception(s)`);
  const ex = (await api(T.finance).get('/api/v1/reconciliation/matches?status=EXCEPTION')).body.items[0];
  note(`Exception queue: ${ex.exceptionCode}: ${ex.detail}`);

  section('Audit trail, correlation IDs, monitoring');
  const trail = (await api(T.ops).get(`/api/v1/audit?entityType=payment_batch&entityId=${batch.id}`)).body
    .items;
  say(`Batch audit trail: ${trail.map((e: { action: string }) => e.action).join(' → ')}`);
  const dash = (await api(T.ops).get('/api/v1/ops/dashboard')).body;
  say(
    `Dashboard: outbox pending ${dash.outbox.pending}, DLQ open ${dash.deadLetters.open}, recon exceptions ${dash.reconciliation.exceptions}`,
  );
  const ct = (await api(T.finance).get('/api/v1/reconciliation/control-totals?from=2026-11-20&to=2026-11-25'))
    .body;
  say(
    `Control totals: ${ct.checks.filter((x: { ok: boolean }) => x.ok).length}/${ct.checks.length} checks balanced`,
  );

  section('Incident scenario: NetSuite outage → dead-letter queue → replay');
  netsuite.injectFault('unavailable', 4, 'upsertVendor');
  const sync = (
    await api(T.ops).post(
      '/api/v1/sync/vendors',
      {
        records: [
          {
            vendor_code: 'VEND-NEW',
            legal_name: 'New Vendor',
            ccy: 'USD',
            status: 'ACTIVE',
            pay_method: 'ACH',
            bank_ref: 'tok_bank_new',
          },
        ],
      },
      true,
    )
  ).body;
  say(`Vendor sync during outage: ${sync.items[0].outcome} (${sync.items[0].error}) after 4 bounded retries`);
  const dl = (await api(T.ops).get('/api/v1/dead-letters')).body.items[0];
  say(`Dead letter ${dl.id.slice(0, 12)}… topic ${dl.topic}, correlation ${dl.correlationId}`);
  const replay = (await api(T.ops).post(`/api/v1/dead-letters/${dl.id}/replay`)).body;
  say(`NetSuite back → replay: job ${replay.job.status}; runbook docs/runbooks/integration-incidents.md`);

  console.log(
    `\n${bold('Demo complete.')} Everything above ran against simulators. See KNOWN_LIMITATIONS.md for what needs a real sandbox.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
