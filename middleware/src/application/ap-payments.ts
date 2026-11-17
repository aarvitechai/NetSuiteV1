/**
 * Accounts Payable payment service: from approved bills to settled, posted vendor payments.
 *
 *   propose()  → which bills are eligible (read-only, nothing changes)
 *   createBatch() [maker]   → batch PENDING_APPROVAL, one instruction per vendor (Validated)
 *   approve()     [checker] → maker ≠ checker. Eligibility is re-checked and the content hash frozen (APPROVED)
 *   reject()      [checker] → REJECTED, instructions back to Draft
 *   submit()                → bills flagged "in progress" in NetSuite, file built, archived and sent (SUBMITTED)
 *   handleAck()             → bank accepted or rejected the file / entries (Accepted / Failed)
 *   handleStatus()          → SETTLED: create the NetSuite Vendor Payment. RETURNED: reverse it and release the bills.
 *
 * GOLDEN RULE (ADR-0001, accounting matrix A2): a NetSuite Vendor Payment is created ONLY when the bank
 * confirms SETTLEMENT. "Submitted" or "accepted" money may still fail to move.
 */
import Decimal from 'decimal.js';
import type { Logger } from 'pino';
import type { AuditService } from './audit';
import type { Dispatcher } from './dispatcher';
import type { JobRunner } from './jobs';
import type { NetSuitePort } from './ports/netsuite';
import type { Store } from './ports/store';
import { evaluateBills, type BillDecision } from '../domain/eligibility';
import { add, format, money, sum } from '../domain/money';
import {
  canMoveBatch,
  contentHash,
  ACH_RETURN_CODES,
  type BatchStatus,
  type PaymentBatch,
  type PaymentInstruction,
} from '../domain/payment-batch';
import { transition, type PaymentState } from '../domain/payment-state';
import type { PaymentRail, Vendor } from '../domain/types';
import {
  buildPaymentFile,
  type AckFile,
  type CompanyProfile,
  type StatusFile,
} from '../adapters/bank/payment-files';
import type { BankVault } from '../adapters/bank/vault';
import type { BankFileRecord } from '../domain/bank-file';
import type { FileTransport } from '../infrastructure/files/file-transport';
import { currentActor } from '../shared/context';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError } from '../shared/errors';
import { isoDate, newId, sha256, type Clock } from '../shared/util';

export const TOPIC_FLAG_BILLS = 'netsuite.bills.flag';
export const TOPIC_POST_VENDOR_PAYMENT = 'netsuite.vendor_payment.post';
export const TOPIC_REVERSE_VENDOR_PAYMENT = 'netsuite.vendor_payment.reverse';

/** Instruction states in which the bills are "taken": they must not be proposed for another batch. */
const LIVE_INSTRUCTION_STATES: PaymentState[] = ['Validated', 'Approved', 'Submitted', 'Accepted', 'Settled'];
const FINAL_INSTRUCTION_STATES: PaymentState[] = ['Settled', 'Reconciled', 'Failed', 'Reversed'];

export interface ProposalCriteria {
  currency: string;
  rail: PaymentRail;
  windowDays: number;
}

export interface Proposal {
  asOf: string;
  criteria: ProposalCriteria;
  total: string;
  vendors: {
    vendorExternalId: string;
    vendorName: string;
    amount: string;
    bills: { externalId: string; tranId: string; dueDate: string; amount: string }[];
  }[];
  excluded: { externalId: string; tranId: string; reasons: string[] }[];
}

export interface BatchView extends PaymentBatch {
  instructions: PaymentInstruction[];
}

export interface ApDeps {
  store: Store;
  netsuite: NetSuitePort;
  audit: AuditService;
  jobs: JobRunner;
  dispatcher: Dispatcher;
  vault: BankVault;
  files: FileTransport;
  clock: Clock;
  logger: Logger;
  company: CompanyProfile;
}

export class ApPaymentService {
  constructor(private readonly d: ApDeps) {
    // Follow-up work handlers. Each is idempotent, so the DLQ can replay it safely.
    d.jobs.register(TOPIC_FLAG_BILLS, async (p) => {
      const { billIds, inProgress, batchRef } = p as {
        billIds: string[];
        inProgress: boolean;
        batchRef: string;
      };
      await d.netsuite.setBillPaymentFlags(billIds, { inProgress, batchRef });
    });
    d.jobs.register(TOPIC_POST_VENDOR_PAYMENT, (p) =>
      this.postVendorPayment((p as { instructionId: string }).instructionId),
    );
    d.jobs.register(TOPIC_REVERSE_VENDOR_PAYMENT, (p) =>
      this.reverseVendorPayment((p as { instructionId: string }).instructionId),
    );
  }

  private batches() {
    return this.d.store.repo<PaymentBatch>('payment_batches');
  }
  private instructions(store: Store = this.d.store) {
    return store.repo<PaymentInstruction>('payment_instructions');
  }

  // ------------------------------------------------------------------ proposal

  /**
   * Bill IDs already inside a live payment instruction: the middleware's own double-payment guard.
   * One indexed query per live status, so the cost does not grow with the number of batches.
   */
  private async billsInOpenBatches(): Promise<Set<string>> {
    const ids = new Set<string>();
    for (const status of LIVE_INSTRUCTION_STATES) {
      for (const i of await this.instructions().list({ status })) {
        i.applications.forEach((a) => ids.add(a.docExternalId));
      }
    }
    return ids;
  }

  /**
   * Saves a batch, its instructions, one audit event and any follow-up messages in ONE transaction,
   * then delivers the follow-ups. Every batch state change goes through here, so the rule
   * "state + audit + follow-up work are atomic" (outbox pattern) is enforced in a single place.
   */
  private async saveBatch(
    batch: PaymentBatch,
    instructions: PaymentInstruction[],
    audit: { action: string; outcome?: 'SUCCESS' | 'FAILURE'; details?: Record<string, unknown> },
    opts: {
      isNew?: boolean;
      bankFile?: BankFileRecord;
      followUps?: { topic: string; payload: unknown; sourceRef: string }[];
    } = {},
  ): Promise<void> {
    await this.d.store.transaction(async (tx) => {
      const batches = tx.repo<PaymentBatch>('payment_batches');
      const items = this.instructions(tx);
      if (opts.isNew) {
        await batches.insert(batch);
        for (const i of instructions) await items.insert(i);
      } else {
        await batches.upsert(batch);
        for (const i of instructions) await items.upsert(i);
      }
      if (opts.bankFile) await tx.repo<BankFileRecord>('bank_files').insert(opts.bankFile);
      await this.d.audit.record(
        {
          action: audit.action,
          entityType: 'payment_batch',
          entityId: batch.id,
          outcome: audit.outcome ?? 'SUCCESS',
          details: audit.details,
        },
        tx,
      );
      for (const f of opts.followUps ?? []) {
        await this.d.dispatcher.dispatch(f.topic, f.payload, { sourceRef: f.sourceRef, tx });
      }
    });
    if (opts.followUps?.length) await this.d.dispatcher.flush();
  }

  private async evaluate(
    criteria: ProposalCriteria,
  ): Promise<{ decisions: BillDecision[]; vendors: Map<string, Vendor> }> {
    const [bills, vendorList, alreadyProposed] = await Promise.all([
      this.d.netsuite.listOpenVendorBills(),
      this.d.netsuite.listVendors(),
      this.billsInOpenBatches(),
    ]);
    const vendors = new Map(vendorList.map((v) => [v.externalId, v]));
    const decisions = evaluateBills(bills, vendors, {
      ...criteria,
      asOf: isoDate(this.d.clock.now()),
      alreadyProposed,
    });
    return { decisions, vendors };
  }

  async propose(criteria: ProposalCriteria): Promise<Proposal> {
    const { decisions, vendors } = await this.evaluate(criteria);
    const eligible = decisions.filter((x) => x.eligible);
    const byVendor = new Map<string, BillDecision[]>();
    for (const e of eligible)
      byVendor.set(e.bill.vendorExternalId, [...(byVendor.get(e.bill.vendorExternalId) ?? []), e]);

    const vendorGroups = [...byVendor.entries()].map(([vendorId, items]) => ({
      vendorExternalId: vendorId,
      vendorName: vendors.get(vendorId)?.companyName ?? vendorId,
      amount: format(
        sum(
          items.map((i) => money(i.bill.amountRemaining, i.bill.currency)),
          criteria.currency,
        ),
      ),
      bills: items.map((i) => ({
        externalId: i.bill.externalId,
        tranId: i.bill.tranId,
        dueDate: i.bill.dueDate,
        amount: i.bill.amountRemaining,
      })),
    }));
    return {
      asOf: isoDate(this.d.clock.now()),
      criteria,
      total: format(
        sum(
          vendorGroups.map((g) => money(g.amount, criteria.currency)),
          criteria.currency,
        ),
      ),
      vendors: vendorGroups,
      excluded: decisions
        .filter((x) => !x.eligible)
        .map((x) => ({ externalId: x.bill.externalId, tranId: x.bill.tranId, reasons: x.reasons })),
    };
  }

  // ------------------------------------------------------------------ maker: create batch

  async createBatch(criteria: ProposalCriteria & { billExternalIds?: string[] }): Promise<BatchView> {
    // NEVER trust the client's bill list: eligibility is recomputed on the server.
    const proposal = await this.propose(criteria);
    let groups = proposal.vendors;
    if (criteria.billExternalIds?.length) {
      const wanted = new Set(criteria.billExternalIds);
      const eligibleIds = new Set(groups.flatMap((g) => g.bills.map((b) => b.externalId)));
      const notEligible = [...wanted].filter((id) => !eligibleIds.has(id));
      if (notEligible.length) {
        throw new BusinessRuleError(
          'BILL_NOT_ELIGIBLE',
          'Some requested bills are not eligible for payment',
          {
            bills: notEligible.map((id) => ({
              externalId: id,
              reasons: proposal.excluded.find((e) => e.externalId === id)?.reasons ?? ['NOT_OPEN'],
            })),
          },
        );
      }
      groups = groups
        .map((g) => ({ ...g, bills: g.bills.filter((b) => wanted.has(b.externalId)) }))
        .filter((g) => g.bills.length)
        .map((g) => ({
          ...g,
          amount: format(
            sum(
              g.bills.map((b) => money(b.amount, criteria.currency)),
              criteria.currency,
            ),
          ),
        }));
    }
    if (!groups.length)
      throw new BusinessRuleError('NO_ELIGIBLE_BILLS', 'No eligible bills for these criteria');

    const now = this.d.clock.now();
    const maker = currentActor();
    const batchId = newId('PB');
    const batchRef = `PB${isoDate(now).replace(/-/g, '')}${batchId.slice(3, 9).toUpperCase()}`;

    const instructions: PaymentInstruction[] = groups.map((g) => {
      const draft: PaymentInstruction = {
        id: newId('PI'),
        batchId,
        batchRef,
        counterpartyExternalId: g.vendorExternalId,
        counterpartyName: g.vendorName,
        rail: criteria.rail,
        currency: criteria.currency,
        amount: g.amount,
        applications: g.bills.map((b) => ({ docExternalId: b.externalId, amount: b.amount })),
        status: 'Draft',
        history: [],
      };
      // Draft → Validated: the eligibility rules above are the validation.
      draft.history.push(transition('Draft', 'Validated', maker, 'eligibility rules passed', now));
      draft.status = 'Validated';
      return draft;
    });

    const total = instructions.reduce(
      (acc, i) => add(acc, money(i.amount, i.currency)),
      money('0', criteria.currency),
    );
    const batch: PaymentBatch = {
      id: batchId,
      batchRef,
      rail: criteria.rail,
      currency: criteria.currency,
      status: 'PENDING_APPROVAL',
      total: format(total),
      itemCount: instructions.length,
      instructionIds: instructions.map((i) => i.id),
      makerId: maker,
      createdAt: now.toISOString(),
      history: [{ from: null, to: 'PENDING_APPROVAL', at: now.toISOString(), actor: maker }],
    };

    await this.saveBatch(
      batch,
      instructions,
      {
        action: 'PAYMENT_BATCH_CREATED',
        details: { batchRef, total: batch.total, currency: batch.currency, items: batch.itemCount },
      },
      { isNew: true },
    );
    return { ...batch, instructions };
  }

  // ------------------------------------------------------------------ reads

  async getBatch(id: string): Promise<BatchView> {
    const batch = await this.batches().get(id);
    if (!batch) throw new NotFoundError(`Payment batch ${id}`);
    const instructions = await this.instructions().list({ batchId: id });
    return { ...batch, instructions: instructions.sort((a, b) => a.id.localeCompare(b.id)) };
  }

  listBatches(status?: BatchStatus): Promise<PaymentBatch[]> {
    return this.batches().list(status ? { status } : {});
  }

  // ------------------------------------------------------------------ helpers

  private moveBatch(batch: PaymentBatch, to: BatchStatus, reason?: string): void {
    if (!canMoveBatch(batch.status, to)) {
      throw new ConflictError(
        'ILLEGAL_STATE_TRANSITION',
        `Batch ${batch.batchRef} cannot move from ${batch.status} to ${to}`,
      );
    }
    batch.history.push({
      from: batch.status,
      to,
      at: this.d.clock.now().toISOString(),
      actor: currentActor(),
      reason,
    });
    batch.status = to;
  }

  private moveInstruction(i: PaymentInstruction, to: PaymentState, reason?: string): void {
    i.history.push(transition(i.status, to, currentActor(), reason, this.d.clock.now()));
    i.status = to;
  }

  // ------------------------------------------------------------------ checker: approve / reject

  async approve(id: string, checkerSubject: string): Promise<BatchView> {
    const view = await this.getBatch(id);
    const { instructions, ...batch } = view;

    // Maker-checker: the person who built the batch may not approve it. Subjects are compared,
    // because one person could hold two different tokens.
    if (batch.makerId.split(':').pop() === checkerSubject) {
      await this.d.audit.record({
        action: 'PAYMENT_BATCH_APPROVAL_DENIED',
        entityType: 'payment_batch',
        entityId: id,
        outcome: 'REJECTED',
        details: { reason: 'maker cannot approve own batch' },
      });
      throw new ForbiddenError(
        'The maker of a batch cannot approve it (maker-checker control)',
        'MAKER_CHECKER_VIOLATION',
      );
    }
    if (batch.status !== 'PENDING_APPROVAL')
      throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Batch is ${batch.status}`);

    // Bills may have changed since the batch was created (put on hold, paid elsewhere…). Re-check them.
    // The due-date window is irrelevant here (NOT_DUE is ignored below: due dates were checked at creation).
    const { decisions } = await this.evaluate({ currency: batch.currency, rail: batch.rail, windowDays: 0 });
    const byId = new Map(decisions.map((x) => [x.bill.externalId, x]));
    const problems = instructions
      .flatMap((i) => i.applications)
      .map((app) => {
        const decision = byId.get(app.docExternalId);
        if (!decision) return { billId: app.docExternalId, reasons: ['NOT_OPEN'] };
        // ALREADY_PROPOSED is expected (the bill is in THIS batch). Due dates were checked at creation.
        const reasons: string[] = decision.reasons.filter((r) => r !== 'ALREADY_PROPOSED' && r !== 'NOT_DUE');
        // The bill may have been partly paid elsewhere since the batch was created.
        if (new Decimal(decision.bill.amountRemaining).lessThan(app.amount)) reasons.push('AMOUNT_CHANGED');
        return { billId: app.docExternalId, reasons };
      })
      .filter((p) => p.reasons.length);
    if (problems.length) {
      throw new BusinessRuleError(
        'BILL_NOT_ELIGIBLE',
        'Bills in this batch are no longer eligible; reject the batch and create a new one',
        { problems },
      );
    }

    const now = this.d.clock.now().toISOString();
    this.moveBatch(batch, 'APPROVED');
    batch.checkerId = currentActor();
    batch.approvedAt = now;
    instructions.forEach((i) => this.moveInstruction(i, 'Approved', `approved by ${batch.checkerId}`));
    batch.approvedHash = contentHash(batch, instructions);

    await this.saveBatch(batch, instructions, {
      action: 'PAYMENT_BATCH_APPROVED',
      details: { batchRef: batch.batchRef, hash: batch.approvedHash },
    });
    return { ...batch, instructions };
  }

  async reject(id: string, checkerSubject: string, reason: string): Promise<BatchView> {
    const { instructions, ...batch } = await this.getBatch(id);
    if (batch.makerId.split(':').pop() === checkerSubject) {
      throw new ForbiddenError(
        'The maker of a batch cannot reject it either; ask a checker',
        'MAKER_CHECKER_VIOLATION',
      );
    }
    this.moveBatch(batch, 'REJECTED', reason);
    batch.rejectionReason = reason;
    instructions.forEach((i) => this.moveInstruction(i, 'Draft', `batch rejected: ${reason}`));
    await this.saveBatch(batch, instructions, { action: 'PAYMENT_BATCH_REJECTED', details: { reason } });
    return { ...batch, instructions };
  }

  // ------------------------------------------------------------------ submit (build + send file)

  async submit(id: string): Promise<BatchView> {
    const { instructions, ...batch } = await this.getBatch(id);

    // Retry after a crash between "saved as SUBMITTED" and "file delivered": resend the ARCHIVED bytes.
    // The file is byte-for-byte identical, so the bank's duplicate-file check protects against double payment.
    if (batch.status === 'SUBMITTED' && batch.file && !batch.file.transmitted) {
      await this.transmit(batch);
      return this.getBatch(id);
    }
    if (batch.status !== 'APPROVED')
      throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Batch is ${batch.status}, expected APPROVED`);
    if (contentHash(batch, instructions) !== batch.approvedHash) {
      await this.d.audit.record({
        action: 'PAYMENT_BATCH_TAMPER_DETECTED',
        entityType: 'payment_batch',
        entityId: id,
        outcome: 'FAILURE',
      });
      throw new ConflictError(
        'BATCH_MODIFIED_AFTER_APPROVAL',
        'Batch content changed after approval; submission refused',
      );
    }

    // 1. Flag bills in NetSuite FIRST, so that no one else can propose them while the money is moving.
    const billIds = instructions.flatMap((i) => i.applications.map((a) => a.docExternalId));
    const flagJob = await this.d.jobs.run(
      TOPIC_FLAG_BILLS,
      { billIds, inProgress: true, batchRef: batch.batchRef },
      { sourceRef: batch.batchRef },
    );
    if (flagJob.status !== 'SUCCEEDED') {
      throw new BusinessRuleError(
        'NETSUITE_FLAG_FAILED',
        'Could not mark bills as in progress in NetSuite; batch not sent (see DLQ)',
        { jobId: flagJob.id },
      );
    }

    // 2. Build the file. Account numbers come from the vault and exist only in this file.
    const vendors = new Map((await this.d.netsuite.listVendors()).map((v) => [v.externalId, v]));
    const built = await buildPaymentFile(
      batch,
      instructions,
      vendors,
      this.d.vault,
      this.d.company,
      this.d.clock.now(),
    );
    const checksum = sha256(built.content);

    // 3. Archive first (evidence plus a source for retransmission), then record everything atomically.
    await this.d.files.put('archive/outbound', built.name, built.content);
    const bankFileId = newId('BF');
    this.moveBatch(batch, 'SUBMITTED');
    batch.submittedAt = this.d.clock.now().toISOString();
    batch.file = { name: built.name, sha256: checksum, bankFileId };
    for (const i of instructions) {
      i.traceNumber = built.traceNumbers[i.id];
      this.moveInstruction(i, 'Submitted', `file ${built.name}`);
    }
    await this.saveBatch(
      batch,
      instructions,
      { action: 'PAYMENT_BATCH_SUBMITTED', details: { file: built.name, sha256: checksum } },
      {
        bankFile: {
          id: bankFileId,
          direction: 'OUTBOUND',
          status: 'CREATED',
          name: built.name,
          checksum,
          batchRef: batch.batchRef,
          createdAt: batch.submittedAt,
        },
      },
    );

    // 4. Deliver to the bank.
    await this.transmit(batch);
    return this.getBatch(id);
  }

  private async transmit(batch: PaymentBatch): Promise<void> {
    const file = batch.file!;
    const content = await this.d.files.get('archive/outbound', file.name);
    if (sha256(content) !== file.sha256)
      throw new ConflictError('FILE_CHECKSUM_MISMATCH', 'Archived file does not match recorded checksum');
    await this.d.files.put('outbound', file.name, content);
    await this.batches().upsert({ ...batch, file: { ...file, transmitted: true } });
    await this.d.store.repo<BankFileRecord>('bank_files').upsert({
      id: file.bankFileId,
      direction: 'OUTBOUND',
      status: 'TRANSMITTED',
      name: file.name,
      checksum: file.sha256,
      batchRef: batch.batchRef,
    });
  }

  // ------------------------------------------------------------------ bank responses

  /** Direct indexed lookup (batchRef is indexed; see migrations/002_batch_ref_index.sql). */
  private async findBatchByRef(batchRef: string): Promise<BatchView> {
    const [b] = await this.batches().list({ batchRef }, { limit: 1 });
    if (!b) throw new NotFoundError(`Batch with reference ${batchRef}`);
    return this.getBatch(b.id);
  }

  private matchRef(i: PaymentInstruction, ref: string): boolean {
    return i.traceNumber === ref || i.id === ref;
  }

  /** Bank acknowledgement: the file was (not) accepted, and so was each entry. No money has moved yet. */
  async handleAck(ack: AckFile): Promise<{ accepted: number; rejected: number }> {
    const { instructions, ...batch } = await this.findBatchByRef(ack.batchRef);
    if (batch.status !== 'SUBMITTED') return { accepted: 0, rejected: 0 }; // already processed: ignore (idempotent)

    const released: string[] = [];
    let accepted = 0;
    let rejected = 0;
    for (const i of instructions) {
      const entry = ack.entries.find((e) => this.matchRef(i, e.ref));
      const ok = ack.status === 'ACCEPTED' && entry?.status !== 'REJECTED';
      if (ok) {
        this.moveInstruction(i, 'Accepted', 'bank acknowledgement');
        accepted++;
      } else {
        i.failureReason = entry?.reason ?? ack.reason ?? 'rejected by bank';
        this.moveInstruction(i, 'Failed', i.failureReason);
        released.push(...i.applications.map((a) => a.docExternalId));
        rejected++;
      }
    }
    this.moveBatch(
      batch,
      accepted ? 'ACKNOWLEDGED' : 'FAILED',
      ack.status === 'REJECTED' ? ack.reason : undefined,
    );

    // Rejected payments never moved money: release their bills so they can be paid in a later batch.
    const followUps = released.length
      ? [
          {
            topic: TOPIC_FLAG_BILLS,
            payload: { billIds: released, inProgress: false, batchRef: '' },
            sourceRef: batch.batchRef,
          },
        ]
      : [];
    await this.saveBatch(
      batch,
      instructions,
      {
        action: 'BANK_ACK_PROCESSED',
        outcome: rejected ? 'FAILURE' : 'SUCCESS',
        details: { fileStatus: ack.status, accepted, rejected },
      },
      { followUps },
    );
    return { accepted, rejected };
  }

  /** Settlement and return events: the moment accounting happens. */
  async handleStatus(file: StatusFile): Promise<{ settled: number; returned: number; ignored: number }> {
    const { instructions, ...batch } = await this.findBatchByRef(file.batchRef);
    const toPost: string[] = [];
    const toReverse: string[] = [];
    let ignored = 0;

    for (const ev of file.events) {
      const i = instructions.find((x) => this.matchRef(x, ev.ref));
      if (!i) {
        ignored++;
        continue;
      }
      if (ev.status === 'SETTLED') {
        if (i.status !== 'Accepted') {
          ignored++; // duplicate or out-of-order event: idempotent no-op
          continue;
        }
        i.bankRef = ev.bankRef;
        i.settledOn = ev.effectiveDate;
        this.moveInstruction(i, 'Settled', `bank ref ${ev.bankRef}`);
        toPost.push(i.id);
      } else {
        if (!['Accepted', 'Settled', 'Reconciled'].includes(i.status)) {
          ignored++;
          continue;
        }
        i.returnCode = ev.returnCode;
        this.moveInstruction(
          i,
          'Returned',
          `${ev.returnCode ?? ''} ${ACH_RETURN_CODES[ev.returnCode ?? ''] ?? ''}`.trim(),
        );
        toReverse.push(i.id);
      }
    }

    if (
      instructions.every((i) => FINAL_INSTRUCTION_STATES.includes(i.status) || toReverse.includes(i.id)) &&
      batch.status === 'ACKNOWLEDGED'
    ) {
      this.moveBatch(batch, 'COMPLETED');
    }
    // Outbox: "Settled" and "post the Vendor Payment" are saved together, atomically.
    const followUps = [
      ...toPost.map((id) => ({
        topic: TOPIC_POST_VENDOR_PAYMENT,
        payload: { instructionId: id },
        sourceRef: id,
      })),
      ...toReverse.map((id) => ({
        topic: TOPIC_REVERSE_VENDOR_PAYMENT,
        payload: { instructionId: id },
        sourceRef: id,
      })),
    ];
    await this.saveBatch(
      batch,
      instructions,
      {
        action: 'BANK_STATUS_PROCESSED',
        details: { settled: toPost.length, returned: toReverse.length, ignored },
      },
      { followUps },
    );
    return { settled: toPost.length, returned: toReverse.length, ignored };
  }

  // ------------------------------------------------------------------ NetSuite postings (job handlers)

  /** Creates the NetSuite Vendor Payment for a SETTLED instruction. Idempotent: externalId = instruction id. */
  private async postVendorPayment(instructionId: string): Promise<{ internalId: string }> {
    const repo = this.instructions();
    const i = await repo.get(instructionId);
    if (!i) throw new NotFoundError(`Instruction ${instructionId}`);
    if (i.netsuitePaymentId) return { internalId: i.netsuitePaymentId };
    if (!['Settled', 'Reconciled'].includes(i.status))
      throw new BusinessRuleError(
        'NOT_SETTLED',
        `Instruction is ${i.status}; only settled payments are posted`,
      );

    const r = await this.d.netsuite.createVendorPayment({
      externalId: i.id,
      vendorExternalId: i.counterpartyExternalId,
      currency: i.currency,
      tranDate: i.settledOn!,
      applications: i.applications,
      providerRef: i.bankRef,
      batchRef: i.batchRef,
    });
    await repo.upsert({ ...i, netsuitePaymentId: r.internalId });
    await this.d.audit.record({
      action: 'NETSUITE_VENDOR_PAYMENT_CREATED',
      entityType: 'payment_instruction',
      entityId: i.id,
      outcome: 'SUCCESS',
      source: 'jobs',
      details: { internalId: r.internalId, created: r.created, amount: i.amount },
    });
    return { internalId: r.internalId };
  }

  /** Undoes a RETURNED payment: void it in NetSuite (if it was posted), reopen the bills, mark it Reversed. */
  private async reverseVendorPayment(instructionId: string): Promise<void> {
    const repo = this.instructions();
    const i = await repo.get(instructionId);
    if (!i) throw new NotFoundError(`Instruction ${instructionId}`);
    if (i.status === 'Reversed') return;
    if (i.netsuitePaymentId)
      await this.d.netsuite.voidVendorPayment(i.id, `ACH return ${i.returnCode ?? ''}`.trim());
    await this.d.netsuite.setBillPaymentFlags(
      i.applications.map((a) => a.docExternalId),
      { inProgress: false, batchRef: '' },
    );
    this.moveInstruction(i, 'Reversed', `return ${i.returnCode ?? ''}`.trim());
    await repo.upsert(i);
    await this.d.audit.record({
      action: 'VENDOR_PAYMENT_REVERSED',
      entityType: 'payment_instruction',
      entityId: i.id,
      outcome: 'SUCCESS',
      source: 'jobs',
      details: { returnCode: i.returnCode, voided: Boolean(i.netsuitePaymentId) },
    });
  }
}
