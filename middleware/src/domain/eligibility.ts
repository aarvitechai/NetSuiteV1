/**
 * AP payment eligibility rules: which vendor bills may be paid in this payment run?
 *
 * Pure functions with no I/O, so every rule is easy to unit test and to explain to finance.
 *
 * WHY EACH RULE EXISTS
 *  NOT_APPROVED        – only approved bills are a confirmed liability (SuiteFlow approval, Phase 4).
 *  NOTHING_TO_PAY      – fully paid bills have amountRemaining = 0.
 *  ON_HOLD             – AP put the bill on hold (dispute, missing goods receipt…).
 *  IN_PROGRESS         – already inside a submitted batch. Paying again would be a DOUBLE PAYMENT.
 *  ALREADY_PROPOSED    – inside another open batch in the middleware (second line of defence).
 *  VENDOR_INACTIVE     – the vendor was deactivated. Their bank details may no longer be valid.
 *  VENDOR_UNKNOWN      – there is no vendor master, so we have nowhere to send the money.
 *  NOT_DUE             – due later than the payment window. Paying early hurts cash flow.
 *  CURRENCY_MISMATCH   – one batch = one currency (one file, one bank account).
 *  RAIL_MISMATCH       – the vendor is paid by a different method (ACH vs wire vs virtual card).
 *  DUPLICATE_BILL      – the same vendor invoice number appears on another bill. Only the earliest is kept.
 */
import Decimal from 'decimal.js';
import type { PaymentRail, Vendor, VendorBill } from './types';

export type IneligibleReason =
  | 'NOT_APPROVED'
  | 'NOTHING_TO_PAY'
  | 'ON_HOLD'
  | 'IN_PROGRESS'
  | 'ALREADY_PROPOSED'
  | 'VENDOR_INACTIVE'
  | 'VENDOR_UNKNOWN'
  | 'NOT_DUE'
  | 'CURRENCY_MISMATCH'
  | 'RAIL_MISMATCH'
  | 'DUPLICATE_BILL';

export interface EligibilityCriteria {
  asOf: string; // YYYY-MM-DD
  windowDays: number; // pay bills due on or before asOf + windowDays
  currency: string;
  rail: PaymentRail;
  /** Bill IDs already in non-terminal batches in the middleware. */
  alreadyProposed: Set<string>;
}

export interface BillDecision {
  bill: VendorBill;
  eligible: boolean;
  reasons: IneligibleReason[];
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Finds bills that share vendor + invoice number with an EARLIER bill.
 * Deterministic order (tranDate, then externalId) means the same bill always wins.
 */
export function findDuplicateBills(bills: VendorBill[]): Set<string> {
  const seen = new Map<string, string>();
  const duplicates = new Set<string>();
  const ordered = [...bills].sort(
    (a, b) => a.tranDate.localeCompare(b.tranDate) || a.externalId.localeCompare(b.externalId),
  );
  for (const b of ordered) {
    const key = `${b.vendorExternalId}|${b.tranId.trim().toUpperCase()}`;
    if (seen.has(key)) duplicates.add(b.externalId);
    else seen.set(key, b.externalId);
  }
  return duplicates;
}

export function evaluateBills(
  bills: VendorBill[],
  vendors: Map<string, Vendor>,
  c: EligibilityCriteria,
): BillDecision[] {
  const dueBy = addDays(c.asOf, c.windowDays);
  const duplicates = findDuplicateBills(bills);

  return bills.map((bill) => {
    const reasons: IneligibleReason[] = [];
    const vendor = vendors.get(bill.vendorExternalId);
    if (bill.approvalStatus !== 'APPROVED') reasons.push('NOT_APPROVED');
    if (!new Decimal(bill.amountRemaining).greaterThan(0)) reasons.push('NOTHING_TO_PAY');
    if (bill.onHold) reasons.push('ON_HOLD');
    if (bill.paymentInProgress) reasons.push('IN_PROGRESS');
    if (c.alreadyProposed.has(bill.externalId)) reasons.push('ALREADY_PROPOSED');
    if (!vendor) reasons.push('VENDOR_UNKNOWN');
    else {
      if (vendor.isInactive) reasons.push('VENDOR_INACTIVE');
      if (vendor.paymentRail !== c.rail) reasons.push('RAIL_MISMATCH');
    }
    if (bill.dueDate > dueBy) reasons.push('NOT_DUE');
    if (bill.currency !== c.currency) reasons.push('CURRENCY_MISMATCH');
    if (duplicates.has(bill.externalId)) reasons.push('DUPLICATE_BILL');
    return { bill, eligible: reasons.length === 0, reasons };
  });
}
