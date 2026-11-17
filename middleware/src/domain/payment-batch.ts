/**
 * Payment batches and payment instructions (AP).
 *
 *  PaymentBatch       – a group of payments sent to the bank together (one file, one rail, one currency).
 *  PaymentInstruction – one payment to ONE vendor inside a batch. It may pay several bills.
 *
 * Batch lifecycle (batch-level status):
 *   PENDING_APPROVAL → APPROVED → SUBMITTED → ACKNOWLEDGED → COMPLETED
 *            ↘ REJECTED            ↘ FAILED (bank rejected the whole file)
 *
 * Instruction lifecycle: uses the PaymentState machine (domain/payment-state.ts).
 *
 * IMMUTABILITY: on approval we compute a content hash of the batch (who gets paid, how much, for which
 * bills). Before submitting, the hash is recomputed. If anything changed after approval (a bug, or
 * tampering), submission is refused. "Approved" must mean "exactly THIS was approved".
 */
import type { PaymentState, StateChange } from './payment-state';
import type { DecimalString, PaymentApplication, PaymentRail } from './types';
import { hashPayload } from '../shared/util';

export type BatchStatus =
  'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'SUBMITTED' | 'ACKNOWLEDGED' | 'COMPLETED' | 'FAILED';

const BATCH_TRANSITIONS: Record<BatchStatus, readonly BatchStatus[]> = {
  PENDING_APPROVAL: ['APPROVED', 'REJECTED'],
  APPROVED: ['SUBMITTED'],
  SUBMITTED: ['ACKNOWLEDGED', 'FAILED'],
  ACKNOWLEDGED: ['COMPLETED'],
  REJECTED: [],
  COMPLETED: [],
  FAILED: [],
};

export function canMoveBatch(from: BatchStatus, to: BatchStatus): boolean {
  return BATCH_TRANSITIONS[from].includes(to);
}

export interface PaymentBatch {
  id: string;
  /** Short human-friendly reference printed in files and NetSuite. Never changes. */
  batchRef: string;
  rail: PaymentRail;
  currency: string;
  status: BatchStatus;
  total: DecimalString;
  itemCount: number;
  instructionIds: string[];
  makerId: string;
  checkerId?: string;
  createdAt: string;
  approvedAt?: string;
  submittedAt?: string;
  rejectionReason?: string;
  /** Hash of the approved content (see contentHash). */
  approvedHash?: string;
  /** Outbound file details, set on submit. */
  file?: { name: string; sha256: string; bankFileId: string; transmitted?: boolean };
  history: { from: BatchStatus | null; to: BatchStatus; at: string; actor: string; reason?: string }[];
}

export interface PaymentInstruction {
  id: string; // also the NetSuite Vendor Payment externalId → no duplicate payments on retry
  batchId: string;
  batchRef: string;
  counterpartyExternalId: string; // vendor
  counterpartyName: string;
  rail: PaymentRail;
  currency: string;
  amount: DecimalString;
  applications: PaymentApplication[]; // which bills, how much each
  status: PaymentState;
  history: StateChange[];
  /** NACHA trace number (ODFI routing 8 digits + 7-digit sequence), used to match bank responses. */
  traceNumber?: string;
  bankRef?: string;
  returnCode?: string;
  settledOn?: string;
  netsuitePaymentId?: string;
  failureReason?: string;
}

/** The fields that define "what was approved". Status and history are excluded, because they change legitimately. */
export function contentHash(batch: PaymentBatch, instructions: PaymentInstruction[]): string {
  return hashPayload({
    batchRef: batch.batchRef,
    rail: batch.rail,
    currency: batch.currency,
    total: batch.total,
    instructions: [...instructions]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((i) => ({
        id: i.id,
        to: i.counterpartyExternalId,
        amount: i.amount,
        applications: i.applications,
      })),
  });
}

/** Common ACH return reason codes (subset). Used in messages and runbooks. */
export const ACH_RETURN_CODES: Record<string, string> = {
  R01: 'Insufficient funds',
  R02: 'Account closed',
  R03: 'No account / unable to locate account',
  R04: 'Invalid account number',
  R16: 'Account frozen',
  R29: 'Corporate customer advises not authorized',
};
