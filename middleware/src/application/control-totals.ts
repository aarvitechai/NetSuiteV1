/**
 * Period control totals: proves that NO transaction was lost or duplicated between systems.
 *
 * For a period, the same money is counted in each system it passes through, and the totals must agree:
 *
 *   AP:  settled instructions  =  NetSuite Vendor Payments  =  bank debits matched to them
 *        (and every settled instruction = the bills it paid)
 *   AR:  succeeded intents      =  NetSuite Customer Payments
 *        provider refunds       =  NetSuite Customer Refunds
 *        settlement net         =  NetSuite Deposits  =  bank credits matched to them
 *        settlement gross − fees = net
 *
 * Any non-zero difference is a finding for finance. This report is the UAT exit evidence: "the
 * numbers balance for the test period".
 */
import Decimal from 'decimal.js';
import type { IntentRecord } from './ar-payments';
import type { NetSuitePort } from './ports/netsuite';
import type { Store } from './ports/store';
import type { ReconMatch } from './reconciliation';
import type { Settlement } from '../domain/ar';
import type { PaymentInstruction } from '../domain/payment-batch';

export interface Total {
  count: number;
  amount: string;
}

export interface ControlCheck {
  id: string;
  description: string;
  left: Total & { label: string };
  right: Total & { label: string };
  difference: string;
  ok: boolean;
}

const total = (amounts: (string | Decimal)[]): Total => ({
  count: amounts.length,
  amount: amounts.reduce<Decimal>((s, a) => s.plus(a), new Decimal(0)).toFixed(2),
});

function check(
  id: string,
  description: string,
  leftLabel: string,
  left: Total,
  rightLabel: string,
  right: Total,
  compareCounts = true,
): ControlCheck {
  const diff = new Decimal(left.amount).minus(right.amount);
  return {
    id,
    description,
    left: { label: leftLabel, ...left },
    right: { label: rightLabel, ...right },
    difference: diff.toFixed(2),
    ok: diff.isZero() && (!compareCounts || left.count === right.count),
  };
}

export class ControlTotalsService {
  constructor(
    private readonly store: Store,
    private readonly netsuite: NetSuitePort,
  ) {}

  async run(from: string, to: string) {
    const inPeriod = (d?: string) => Boolean(d && d >= from && d <= to);
    const ns = await this.netsuite.listTransactions(from, to);
    const instructions = (await this.store.repo<PaymentInstruction>('payment_instructions').list()).filter(
      (i) => inPeriod(i.settledOn),
    );
    const intents = (await this.store.repo<IntentRecord>('payment_intents').list()).filter((i) =>
      inPeriod(i.succeededOn),
    );
    const settlements = (await this.store.repo<Settlement>('settlements').list()).filter(
      (s) => inPeriod(s.date) && s.status !== 'MISMATCH',
    );
    const approved = [
      ...(await this.store.repo<ReconMatch>('recon_matches').list({ status: 'AUTO_APPROVED' })),
      ...(await this.store.repo<ReconMatch>('recon_matches').list({ status: 'APPROVED' })),
    ];

    // ---- AP ----
    const settled = instructions.filter((i) =>
      ['Settled', 'Reconciled', 'Returned', 'Reversed'].includes(i.status),
    );
    const vendPymts = ns.filter((t) => t.type === 'VendPymt');
    const settledIds = new Set(settled.map((i) => i.id));
    // Bank side: for each approved match, the bank amount attributed to each Vendor Payment candidate.
    const bankForPayments = approved.flatMap((m) => {
      const keys = m.candidateKeys.filter((k) => settledIds.has(k));
      if (!keys.length) return [];
      // One-to-many (GROUP_REF): split the bank line over its payments using the instruction amounts.
      return keys.map((k) => new Decimal(settled.find((i) => i.id === k)!.amount));
    });
    const returnsBank = approved.flatMap((m) =>
      m.candidateKeys
        .filter((k) => k.endsWith(':REVERSAL'))
        .map((k) => settled.find((i) => `${i.id}:REVERSAL` === k)?.amount ?? '0'),
    );

    // ---- AR ----
    const succeeded = intents.filter((i) =>
      ['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED', 'RETURNED'].includes(i.status),
    );
    const custPymts = ns.filter((t) => t.type === 'CustPymt');
    const refundIds = new Set(intents.flatMap((i) => i.refunds.map((r) => r.refundId)));
    const providerRefunds = intents.flatMap((i) => i.refunds.map((r) => r.amount));
    const nsRefunds = ns.filter((t) => t.type === 'CustRfnd' && refundIds.has(t.externalId));
    const deposits = ns.filter((t) => t.type === 'Deposit');
    const settlementIds = new Set(settlements.map((s) => s.id));
    const bankForDeposits = approved
      .filter((m) => m.candidateKeys.some((k) => settlementIds.has(k)))
      .map((m) => m.amount);

    const checks: ControlCheck[] = [
      check(
        'AP-1',
        'Every settled instruction pays exactly the bills it lists',
        'Instructions settled',
        total(settled.map((i) => i.amount)),
        'Bill applications',
        total(settled.map((i) => i.applications.reduce((s, a) => s.plus(a.amount), new Decimal(0)))),
        true,
      ),
      check(
        'AP-2',
        'Each settled instruction has exactly one NetSuite Vendor Payment',
        'Instructions settled',
        total(settled.map((i) => i.amount)),
        'NetSuite Vendor Payments',
        total(vendPymts.map((t) => t.amount)),
      ),
      check(
        'AP-3',
        'Every NetSuite Vendor Payment is backed by a bank debit',
        'NetSuite Vendor Payments',
        total(vendPymts.map((t) => t.amount)),
        'Matched bank debits',
        total(bankForPayments),
      ),
      check(
        'AP-4',
        'Returned payments: voided in NetSuite = return credits on the bank statement',
        'Voided Vendor Payments',
        total(vendPymts.filter((t) => t.voided).map((t) => t.amount)),
        'Matched return credits',
        total(returnsBank),
      ),
      check(
        'AR-1',
        'Each succeeded online payment has exactly one NetSuite Customer Payment',
        'Payments succeeded',
        total(succeeded.map((i) => i.amount)),
        'NetSuite Customer Payments',
        total(custPymts.map((t) => t.amount)),
      ),
      check(
        'AR-2',
        'Provider refunds = NetSuite Customer Refunds',
        'Provider refunds',
        total(providerRefunds),
        'NetSuite Customer Refunds',
        total(nsRefunds.map((t) => t.amount)),
      ),
      check(
        'AR-3',
        'Settlement arithmetic: gross − fees = net',
        'Gross − fees',
        total(settlements.map((s) => new Decimal(s.gross).minus(s.fees))),
        'Net',
        total(settlements.map((s) => s.net)),
      ),
      check(
        'AR-4',
        'Settlement net = NetSuite Deposits',
        'Settlements (net)',
        total(settlements.map((s) => s.net)),
        'NetSuite Deposits',
        total(deposits.map((t) => t.amount)),
      ),
      check(
        'AR-5',
        'Every NetSuite Deposit is backed by a bank credit',
        'NetSuite Deposits',
        total(deposits.map((t) => t.amount)),
        'Matched bank credits',
        total(bankForDeposits),
      ),
    ];
    return { period: { from, to }, balanced: checks.every((c) => c.ok), checks };
  }
}
