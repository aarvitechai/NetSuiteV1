/**
 * Payment lifecycle state machine.
 *
 * WHY: A payment passes through many hands: an AP clerk, an approver, the middleware, the bank, and
 * reconciliation. If any code could set any status, a payment might jump from "Draft" straight to
 * "Settled", or come back to life after it was reversed. By listing the ONLY allowed moves in one table,
 * every status change is explicit, testable and auditable.
 *
 * Diagram and business meaning: docs/business-processes/payment-lifecycle.md
 */

export const PAYMENT_STATES = [
  'Draft', // created, not yet checked
  'Validated', // passed automatic checks (amount, vendor, duplicates…)
  'Approved', // a second person (checker) approved it — maker-checker control
  'Submitted', // sent to the bank/provider; we do NOT yet know if they accepted it
  'Accepted', // bank/provider acknowledged and accepted the instruction (money not moved yet)
  'Settled', // money actually moved
  'Failed', // rejected before money moved (validation, bank rejection) — terminal
  'Returned', // money moved but came back (e.g. ACH return R01 "insufficient funds")
  'Reversed', // the accounting effect in NetSuite was reversed after a return — terminal
  'Reconciled', // matched to a bank statement line — the normal end state
] as const;

export type PaymentState = (typeof PAYMENT_STATES)[number];

/**
 * Allowed transitions: from → [to, to, …].
 * Anything not in this table is forbidden.
 */
const TRANSITIONS: Record<PaymentState, readonly PaymentState[]> = {
  Draft: ['Validated', 'Failed'],
  // A checker can reject an instruction, which sends it back to Draft for correction.
  Validated: ['Approved', 'Draft', 'Failed'],
  Approved: ['Submitted'],
  Submitted: ['Accepted', 'Failed'],
  Accepted: ['Settled', 'Failed', 'Returned'],
  Settled: ['Reconciled', 'Returned'],
  // ACH returns can arrive days AFTER a payment was reconciled, so Reconciled → Returned is allowed.
  Reconciled: ['Returned'],
  Returned: ['Reversed'],
  Failed: [],
  Reversed: [],
};

export class InvalidTransitionError extends Error {
  constructor(
    readonly from: PaymentState,
    readonly to: PaymentState,
  ) {
    super(`Illegal payment state transition ${from} → ${to}`);
  }
}

export function canTransition(from: PaymentState, to: PaymentState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws if the move is not allowed. Call this before saving any status change. */
export function assertTransition(from: PaymentState, to: PaymentState): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/** One entry of a payment's history. Stored so that auditors can see who changed what, and when. */
export interface StateChange {
  from: PaymentState;
  to: PaymentState;
  at: string; // ISO 8601
  actor: string;
  reason?: string;
}

/** Applies a transition and returns the history entry to store. Pure function, so it is easy to test. */
export function transition(
  current: PaymentState,
  next: PaymentState,
  actor: string,
  reason?: string,
  now: Date = new Date(),
): StateChange {
  assertTransition(current, next);
  return { from: current, to: next, at: now.toISOString(), actor, reason };
}
