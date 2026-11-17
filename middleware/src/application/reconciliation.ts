/**
 * Reconciliation service: bank statement lines ↔ NetSuite transactions.
 *
 * FLOW
 *   importStatement()  parse → integrity check → store lines (duplicate lines skipped) → match
 *   match outcome:
 *     confidence ≥ 0.95  → AUTO_APPROVED, finalized immediately
 *     0.8 – 0.95         → SUGGESTED, waiting for a finance user to approve or reject
 *     no safe match      → EXCEPTION (queue), resolved by manualMatch() or by rematch() later
 *   finalize (approved): payment instructions Settled → Reconciled, settlements RECONCILED, NetSuite
 *                        custom record customrecord_nsd_recon_match created, audit event written.
 *
 * Settlement versus reconciliation:
 *   settlement     = the provider or bank says money moved;
 *   reconciliation = WE have proven, from the bank statement, that it really did, and exactly how much.
 */
import Decimal from 'decimal.js';
import type { AuditService } from './audit';
import type { Dispatcher } from './dispatcher';
import type { JobRunner } from './jobs';
import type { NetSuitePort } from './ports/netsuite';
import type { Store } from './ports/store';
import { parseStatement } from '../adapters/bank/statement-parsers';
import type { Settlement } from '../domain/ar';
import type { PaymentInstruction } from '../domain/payment-batch';
import { transition } from '../domain/payment-state';
import {
  AUTO_APPROVE_CONFIDENCE,
  matchLines,
  type BankLine,
  type Candidate,
  type ExceptionCode,
  type MatchRule,
} from '../domain/reconciliation';
import { currentActor } from '../shared/context';
import { BusinessRuleError, ConflictError, DuplicateKeyError, NotFoundError } from '../shared/errors';
import { newId, sha256, type Clock } from '../shared/util';

export const TOPIC_RECORD_RECONCILIATION = 'netsuite.reconciliation.record';

export interface ReconMatch {
  id: string;
  bankLineId: string; // first line (indexed)
  bankLineIds: string[];
  candidateKeys: string[];
  nsExternalIds: string[];
  rule: MatchRule | 'EXCEPTION';
  confidence: number;
  amount: string;
  status: 'AUTO_APPROVED' | 'SUGGESTED' | 'APPROVED' | 'REJECTED' | 'EXCEPTION' | 'RESOLVED';
  exceptionCode?: ExceptionCode | 'RECON_REJECTED';
  detail?: string;
  reviewer?: string;
  reason?: string;
  createdAt: string;
  decidedAt?: string;
}

const ACTIVE_MATCH: ReconMatch['status'][] = ['AUTO_APPROVED', 'SUGGESTED', 'APPROVED'];
const shiftDays = (iso: string, n: number) =>
  new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export class ReconciliationService {
  constructor(
    private readonly store: Store,
    private readonly netsuite: NetSuitePort,
    private readonly audit: AuditService,
    private readonly jobs: JobRunner,
    private readonly dispatcher: Dispatcher,
    private readonly clock: Clock,
  ) {
    jobs.register(TOPIC_RECORD_RECONCILIATION, (p) =>
      this.recordInNetSuite((p as { matchId: string }).matchId),
    );
  }

  private lines() {
    return this.store.repo<BankLine>('bank_lines');
  }
  private matches() {
    return this.store.repo<ReconMatch>('recon_matches');
  }

  // ------------------------------------------------------------------ import

  async importStatement(name: string, content: string, fileId: string) {
    const parsed = parseStatement(name, content); // throws on bad files, which are then quarantined by the caller
    const fileTag = sha256(content).slice(0, 12);
    const fresh: BankLine[] = [];
    let duplicates = 0;
    for (const p of parsed.lines) {
      // The bank's own transaction reference identifies a line across files. If the same transaction
      // shows up in a second statement, it is a duplicate and must not be reconciled twice.
      const identity = p.bankRef ? `bank:${p.bankRef}` : `file:${fileTag}:${p.lineNo}`;
      const line: BankLine = {
        id: `BL-${sha256(identity).slice(0, 24)}`,
        fileId,
        lineNo: p.lineNo,
        date: p.date,
        amount: p.amount,
        currency: p.currency,
        reference: p.reference,
        bankRef: p.bankRef,
        description: p.description,
        status: 'UNMATCHED',
      };
      try {
        await this.lines().insert(line);
        fresh.push(line);
      } catch (e) {
        if (!(e instanceof DuplicateKeyError)) throw e;
        duplicates++;
      }
    }
    const result = await this.reconcile(fresh);
    return {
      format: parsed.format,
      statementId: parsed.statementId,
      lines: parsed.lines.length,
      duplicates,
      ...result,
    };
  }

  /** Re-runs matching for every line still in the exception queue (e.g. after late NetSuite postings). */
  async rematch() {
    const open = await this.lines().list({ status: 'EXCEPTION' });
    for (const ex of await this.matches().list({ status: 'EXCEPTION' })) {
      if (open.some((l) => l.id === ex.bankLineId))
        await this.matches().upsert({
          ...ex,
          status: 'RESOLVED',
          reason: 'superseded by rematch',
          decidedAt: this.clock.now().toISOString(),
        });
    }
    return this.reconcile(open);
  }

  // ------------------------------------------------------------------ candidates

  private async usedCandidateKeys(): Promise<Set<string>> {
    const used = new Set<string>();
    for (const status of ACTIVE_MATCH)
      for (const m of await this.matches().list({ status })) m.candidateKeys.forEach((k) => used.add(k));
    return used;
  }

  /** Builds matching candidates from NetSuite transactions, enriched with middleware references. */
  async candidates(fromDate: string, toDate: string): Promise<Candidate[]> {
    const used = await this.usedCandidateKeys();
    const txns = await this.netsuite.listTransactions(shiftDays(fromDate, -7), shiftDays(toDate, 7));
    const instructions = this.store.repo<PaymentInstruction>('payment_instructions');
    const out: Candidate[] = [];
    for (const t of txns) {
      if (t.type === 'CustPymt') continue; // in Undeposited Funds, so it reaches the bank inside a Deposit
      const base = {
        nsExternalId: t.externalId,
        nsInternalId: t.internalId,
        date: t.tranDate,
        currency: t.currency,
      };
      const refs = [t.externalId, t.providerRef].filter((x): x is string => Boolean(x));
      if (t.type === 'VendPymt') {
        const pi = await instructions.get(t.externalId);
        if (pi?.traceNumber) refs.push(pi.traceNumber);
        if (pi?.bankRef) refs.push(pi.bankRef);
        out.push({
          ...base,
          key: t.externalId,
          type: 'VendPymt',
          amount: new Decimal(t.amount).negated().toFixed(2),
          refs,
          groupRef: pi?.batchRef,
        });
        // A voided (returned) payment comes back to the bank as a CREDIT. It gets its own candidate.
        if (t.voided)
          out.push({
            ...base,
            key: `${t.externalId}:REVERSAL`,
            type: 'VendPymtReversal',
            amount: new Decimal(t.amount).toFixed(2),
            refs,
          });
      } else if (t.type === 'Deposit') {
        out.push({
          ...base,
          key: t.externalId,
          type: 'Deposit',
          amount: new Decimal(t.amount).toFixed(2),
          refs,
        });
      } else {
        out.push({
          ...base,
          key: t.externalId,
          type: 'CustRfnd',
          amount: new Decimal(t.amount).negated().toFixed(2),
          refs,
        });
      }
    }
    return out.filter((c) => !used.has(c.key));
  }

  // ------------------------------------------------------------------ matching

  private async reconcile(lines: BankLine[]) {
    if (!lines.length) return { autoMatched: 0, suggested: 0, exceptions: 0 };
    const dates = lines.map((l) => l.date).sort();
    const candidates = await this.candidates(dates[0]!, dates[dates.length - 1]!);
    const byKey = new Map(candidates.map((c) => [c.key, c]));
    const { matches, exceptions } = matchLines(lines, candidates);
    const now = this.clock.now().toISOString();
    let autoMatched = 0;
    let suggested = 0;

    for (const m of matches) {
      const auto = m.confidence >= AUTO_APPROVE_CONFIDENCE;
      const match: ReconMatch = {
        id: newId('RM'),
        bankLineId: m.bankLineIds[0]!,
        bankLineIds: m.bankLineIds,
        candidateKeys: m.candidateKeys,
        nsExternalIds: m.candidateKeys.map((k) => byKey.get(k)!.nsExternalId),
        rule: m.rule,
        confidence: m.confidence,
        amount: m.amount,
        status: auto ? 'AUTO_APPROVED' : 'SUGGESTED',
        reviewer: auto ? 'system' : undefined,
        createdAt: now,
      };
      await this.matches().insert(match);
      await this.setLineStatus(m.bankLineIds, auto ? 'MATCHED' : 'SUGGESTED');
      if (auto) {
        autoMatched++;
        await this.finalize(match, byKey);
      } else suggested++;
    }
    for (const x of exceptions) {
      await this.matches().insert({
        id: newId('RM'),
        bankLineId: x.bankLineId,
        bankLineIds: [x.bankLineId],
        candidateKeys: x.candidateKeys,
        nsExternalIds: x.candidateKeys.map((k) => byKey.get(k)?.nsExternalId ?? k),
        rule: 'EXCEPTION',
        confidence: 0,
        amount: lines.find((l) => l.id === x.bankLineId)!.amount,
        status: 'EXCEPTION',
        exceptionCode: x.code,
        detail: x.detail,
        createdAt: now,
      });
      await this.setLineStatus([x.bankLineId], 'EXCEPTION');
    }
    await this.audit.record({
      action: 'RECONCILIATION_RUN',
      entityType: 'reconciliation',
      entityId: newId('RUN'),
      outcome: exceptions.length ? 'FAILURE' : 'SUCCESS',
      source: 'reconciliation',
      details: { lines: lines.length, autoMatched, suggested, exceptions: exceptions.length },
    });
    await this.dispatcher.flush(); // deliver the NetSuite reconciliation records
    return { autoMatched, suggested, exceptions: exceptions.length };
  }

  private async setLineStatus(ids: string[], status: BankLine['status']) {
    for (const id of ids) {
      const l = await this.lines().get(id);
      if (l) await this.lines().upsert({ ...l, status });
    }
  }

  /** Applies an approved match: middleware states → Reconciled, then a NetSuite custom record and an audit event. */
  private async finalize(match: ReconMatch, byKey?: Map<string, Candidate>) {
    const instructions = this.store.repo<PaymentInstruction>('payment_instructions');
    for (const key of match.candidateKeys) {
      const type = byKey?.get(key)?.type ?? (key.endsWith(':REVERSAL') ? 'VendPymtReversal' : undefined);
      const pi = await instructions.get(key);
      if (pi && pi.status === 'Settled' && type !== 'VendPymtReversal') {
        pi.history.push(
          transition(
            'Settled',
            'Reconciled',
            currentActor(),
            `bank line ${match.bankLineId}`,
            this.clock.now(),
          ),
        );
        pi.status = 'Reconciled';
        await instructions.upsert(pi);
      }
      const settlement = await this.store
        .repo<Settlement & { reconciledBy?: string }>('settlements')
        .get(key);
      if (settlement)
        await this.store
          .repo<Settlement & { reconciledBy?: string }>('settlements')
          .upsert({ ...settlement, reconciledBy: match.id });
    }
    await this.audit.record({
      action: 'RECONCILIATION_APPROVED',
      entityType: 'recon_match',
      entityId: match.id,
      outcome: 'SUCCESS',
      source: 'reconciliation',
      details: {
        rule: match.rule,
        confidence: match.confidence,
        reviewer: match.reviewer,
        txns: match.nsExternalIds,
      },
    });
    await this.dispatcher.dispatch(
      TOPIC_RECORD_RECONCILIATION,
      { matchId: match.id },
      { sourceRef: match.id },
    );
  }

  private async recordInNetSuite(matchId: string) {
    const m = await this.matches().get(matchId);
    if (!m) throw new NotFoundError(`Match ${matchId}`);
    return this.netsuite.recordReconciliation({
      matchId: m.id,
      bankLineRef: m.bankLineIds.join(','),
      txnExternalIds: m.nsExternalIds,
      rule: m.rule,
      confidence: m.confidence,
      amount: m.amount,
      reviewer: m.reviewer ?? 'unknown',
    });
  }

  // ------------------------------------------------------------------ human decisions

  async approve(id: string): Promise<ReconMatch> {
    const m = await this.matches().get(id);
    if (!m) throw new NotFoundError(`Match ${id}`);
    if (m.status !== 'SUGGESTED') throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Match is ${m.status}`);
    const updated: ReconMatch = {
      ...m,
      status: 'APPROVED',
      reviewer: currentActor(),
      decidedAt: this.clock.now().toISOString(),
    };
    await this.matches().upsert(updated);
    await this.setLineStatus(m.bankLineIds, 'MATCHED');
    await this.finalize(updated);
    await this.dispatcher.flush();
    return updated;
  }

  async reject(id: string, reason: string): Promise<ReconMatch> {
    const m = await this.matches().get(id);
    if (!m) throw new NotFoundError(`Match ${id}`);
    if (m.status !== 'SUGGESTED') throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Match is ${m.status}`);
    const updated: ReconMatch = {
      ...m,
      status: 'REJECTED',
      reviewer: currentActor(),
      reason,
      decidedAt: this.clock.now().toISOString(),
    };
    await this.matches().upsert(updated);
    // The line goes back to the exception queue for a manual decision.
    await this.matches().insert({
      ...m,
      id: newId('RM'),
      status: 'EXCEPTION',
      rule: 'EXCEPTION',
      confidence: 0,
      candidateKeys: [],
      exceptionCode: 'RECON_REJECTED',
      detail: `Suggestion rejected: ${reason}`,
      createdAt: this.clock.now().toISOString(),
    });
    await this.setLineStatus(m.bankLineIds, 'EXCEPTION');
    await this.audit.record({
      action: 'RECONCILIATION_REJECTED',
      entityType: 'recon_match',
      entityId: id,
      outcome: 'REJECTED',
      details: { reason },
    });
    return updated;
  }

  /** A finance user matches lines to transactions by hand. The amounts must balance exactly. */
  async manualMatch(input: {
    bankLineIds: string[];
    nsExternalIds: string[];
    reason: string;
  }): Promise<ReconMatch> {
    const lines = await Promise.all(input.bankLineIds.map((id) => this.lines().get(id)));
    if (lines.some((l) => !l)) throw new NotFoundError('Bank line');
    if (lines.some((l) => l!.status === 'MATCHED'))
      throw new ConflictError('LINE_ALREADY_MATCHED', 'A selected bank line is already matched');
    const dates = lines.map((l) => l!.date).sort();
    const candidates = await this.candidates(dates[0]!, dates[dates.length - 1]!);
    const chosen = input.nsExternalIds.map((ext) =>
      candidates.find((c) => c.key === ext || c.nsExternalId === ext),
    );
    if (chosen.some((c) => !c))
      throw new BusinessRuleError(
        'CANDIDATE_NOT_AVAILABLE',
        'A selected transaction was not found or is already reconciled',
      );
    const lineSum = lines.reduce((s, l) => s.plus(l!.amount), new Decimal(0));
    const txnSum = chosen.reduce((s, c) => s.plus(c!.amount), new Decimal(0));
    if (!lineSum.equals(txnSum)) {
      throw new BusinessRuleError(
        'RECON_AMOUNT_MISMATCH',
        `Bank lines total ${lineSum.toFixed(2)} but transactions total ${txnSum.toFixed(2)}`,
      );
    }
    const now = this.clock.now().toISOString();
    const match: ReconMatch = {
      id: newId('RM'),
      bankLineId: input.bankLineIds[0]!,
      bankLineIds: input.bankLineIds,
      candidateKeys: chosen.map((c) => c!.key),
      nsExternalIds: chosen.map((c) => c!.nsExternalId),
      rule: 'MANUAL',
      confidence: 1,
      amount: lineSum.toFixed(2),
      status: 'APPROVED',
      reviewer: currentActor(),
      reason: input.reason,
      createdAt: now,
      decidedAt: now,
    };
    await this.matches().insert(match);
    for (const ex of await this.matches().list({ status: 'EXCEPTION' })) {
      if (input.bankLineIds.includes(ex.bankLineId))
        await this.matches().upsert({
          ...ex,
          status: 'RESOLVED',
          reason: `manual match ${match.id}`,
          decidedAt: now,
        });
    }
    await this.setLineStatus(input.bankLineIds, 'MATCHED');
    await this.finalize(match, new Map(chosen.map((c) => [c!.key, c!])));
    await this.dispatcher.flush();
    return match;
  }

  // ------------------------------------------------------------------ queries and report

  listLines(status?: BankLine['status']) {
    return this.lines().list(status ? { status } : {});
  }

  listMatches(status?: ReconMatch['status']) {
    return this.matches().list(status ? { status } : {});
  }

  /** Reconciliation report: proves which bank lines and NetSuite transactions are reconciled for a period. */
  async report(from: string, to: string) {
    const lines = (await this.lines().list()).filter((l) => l.date >= from && l.date <= to);
    const sum = (ls: BankLine[]) => ls.reduce((s, l) => s.plus(l.amount), new Decimal(0)).toFixed(2);
    const by = (st: BankLine['status']) => lines.filter((l) => l.status === st);
    const openCandidates = (await this.candidates(from, to)).filter((c) => c.date >= from && c.date <= to);
    const exceptions = (await this.matches().list({ status: 'EXCEPTION' })).filter((e) =>
      lines.some((l) => l.id === e.bankLineId),
    );
    return {
      period: { from, to },
      bankLines: {
        total: { count: lines.length, amount: sum(lines) },
        matched: { count: by('MATCHED').length, amount: sum(by('MATCHED')) },
        suggested: { count: by('SUGGESTED').length, amount: sum(by('SUGGESTED')) },
        exceptions: { count: by('EXCEPTION').length, amount: sum(by('EXCEPTION')) },
      },
      exceptionQueue: exceptions.map((e) => ({
        matchId: e.id,
        bankLineId: e.bankLineId,
        code: e.exceptionCode,
        detail: e.detail,
        amount: e.amount,
      })),
      unreconciledNetSuiteTransactions: openCandidates.map((c) => ({
        externalId: c.nsExternalId,
        type: c.type,
        date: c.date,
        amount: c.amount,
      })),
      fullyReconciled:
        by('EXCEPTION').length === 0 && by('SUGGESTED').length === 0 && openCandidates.length === 0,
    };
  }
}
