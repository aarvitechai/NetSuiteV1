/**
 * Accounts Receivable domain: payment intents, aging buckets and collection stages.
 *
 * PAYMENT INTENT = "this customer intends to pay these invoices, this much". It tracks the online
 * payment through the provider's lifecycle:
 *
 *   REQUIRES_PAYMENT ──checkout──▶ AUTHORIZED ──capture──▶ SUCCEEDED ──refund──▶ PARTIALLY_REFUNDED / REFUNDED
 *        │                             │                       │
 *        └──decline──▶ FAILED          └──void──▶ CANCELED     └──chargeback──▶ RETURNED
 *
 * With automatic capture, the provider goes straight from REQUIRES_PAYMENT to SUCCEEDED.
 *
 * ACCOUNTING HAPPENS ONLY AT: SUCCEEDED (Customer Payment), REFUNDED (Customer Refund), RETURNED
 * (reversal) and provider SETTLEMENT (Deposit, with fees booked separately). An authorization is only
 * a promise of money, so it is not posted.
 */
import Decimal from 'decimal.js';
import type { CollectionStage, DecimalString, Invoice, PaymentApplication } from './types';

export type IntentStatus =
  | 'REQUIRES_PAYMENT'
  | 'AUTHORIZED'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELED'
  | 'PARTIALLY_REFUNDED'
  | 'REFUNDED'
  | 'RETURNED';

const INTENT_TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  REQUIRES_PAYMENT: ['AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELED'],
  AUTHORIZED: ['SUCCEEDED', 'CANCELED', 'FAILED'],
  SUCCEEDED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'RETURNED'],
  PARTIALLY_REFUNDED: ['PARTIALLY_REFUNDED', 'REFUNDED', 'RETURNED'],
  FAILED: [],
  CANCELED: [],
  REFUNDED: [],
  RETURNED: [],
};

export function canMoveIntent(from: IntentStatus, to: IntentStatus): boolean {
  return INTENT_TRANSITIONS[from].includes(to);
}

export interface PaymentIntent {
  id: string; // also the NetSuite Customer Payment externalId
  customerExternalId: string;
  currency: string;
  amount: DecimalString;
  applications: PaymentApplication[];
  status: IntentStatus;
  captureMode: 'automatic' | 'manual';
  /** Provider references: we store references, NEVER card data. */
  providerRef: string; // checkout session / payment id at the provider
  checkoutUrl: string;
  refundedAmount: DecimalString;
  netsuitePaymentId?: string;
  failureReason?: string;
  createdAt: string;
  createdBy: string;
  history: { from: IntentStatus | null; to: IntentStatus; at: string; eventId?: string; actor: string }[];
}

export interface Settlement {
  id: string; // provider settlement/payout id
  provider: string;
  status: 'RECEIVED' | 'POSTED' | 'MISMATCH';
  date: string;
  currency: string;
  gross: DecimalString;
  fees: DecimalString;
  net: DecimalString;
  payments: {
    intentId: string;
    providerPaymentId: string;
    gross: DecimalString;
    fee: DecimalString;
    net: DecimalString;
  }[];
  netsuiteDepositId?: string;
  /** The reconciliation match that proved this payout reached the bank. */
  reconciledBy?: string;
  error?: string;
}

/**
 * Applies a payment amount to invoices, oldest due date first.
 * WHY oldest first: it is the usual default policy, and it reduces the most-overdue (riskiest)
 * balances first.
 */
export function allocateOldestFirst(amount: DecimalString, invoices: Invoice[]): PaymentApplication[] {
  let left = new Decimal(amount);
  const out: PaymentApplication[] = [];
  for (const inv of [...invoices].sort(
    (a, b) => a.dueDate.localeCompare(b.dueDate) || a.externalId.localeCompare(b.externalId),
  )) {
    if (left.lte(0)) break;
    const take = Decimal.min(left, inv.amountRemaining);
    if (take.gt(0)) out.push({ docExternalId: inv.externalId, amount: take.toFixed(2) });
    left = left.minus(take);
  }
  return out;
}

export type AgingBucket = 'CURRENT' | '1-30' | '31-60' | '61-90' | '90+';

export function daysPastDue(dueDate: string, asOf: string): number {
  return Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000);
}

export function agingBucket(days: number): AgingBucket {
  if (days <= 0) return 'CURRENT';
  if (days <= 30) return '1-30';
  if (days <= 60) return '31-60';
  if (days <= 90) return '61-90';
  return '90+';
}

/**
 * Collection stage. It MUST match nsd_rules.collectionStage in NetSuite (a test checks this), because
 * the Map/Reduce and the middleware must never disagree about an invoice's stage.
 */
export function collectionStage(days: number, disputed: boolean): CollectionStage {
  if (disputed || days < 1) return 'NONE';
  if (days < 30) return 'REMINDER_1';
  if (days < 60) return 'REMINDER_2';
  return 'ESCALATED';
}

/** Rank used to never move a stage BACKWARDS automatically (e.g. after a partial payment). */
export const STAGE_RANK: Record<CollectionStage, number> = {
  NONE: 0,
  REMINDER_1: 1,
  REMINDER_2: 2,
  ESCALATED: 3,
};
