/**
 * Bank reconciliation matching engine (pure functions, no I/O).
 *
 * THE QUESTION: for each line on the bank statement, which NetSuite transaction(s) does it represent?
 *
 * SIGN CONVENTION: amounts are from the BANK's point of view. A debit (money out) is negative, and a
 * credit (money in) is positive. Candidates from NetSuite are converted to the same convention:
 *   Vendor Payment −, Customer Refund −, Deposit +, reversal of a returned Vendor Payment +.
 * Customer Payments are NOT candidates. They sit in Undeposited Funds and reach the bank inside a Deposit.
 *
 * RULES, in priority order (deterministic: the same input always gives the same result):
 *   EXACT_REF      1.00  reference matches AND the amount is equal                 → auto-approved
 *   GROUP_REF      0.95  reference = batch ref AND Σ(group) equals the line         → auto-approved (one-to-many)
 *   SPLIT_REF      0.90  several lines with one reference sum to one candidate      → suggested (many-to-one)
 *   AMOUNT_DATE    0.80  no reference, exactly ONE candidate with the same amount
 *                        within ±3 days                                            → suggested (a human approves)
 *   REF_AMOUNT_MISMATCH  the reference matches but the amount differs (fees? partial?) → exception
 *   AMBIGUOUS            more than one amount/date candidate                        → exception
 *   UNMATCHED            nothing found                                              → exception
 *
 * WHY confidence thresholds: a wrong automatic match hides a real problem (fraud, an error). Only
 * matches that are certain are auto-approved. Everything else needs a human decision, which is recorded
 * in the audit trail.
 */
import Decimal from 'decimal.js';

export interface BankLine {
  id: string;
  fileId: string;
  lineNo: number;
  date: string; // booking date YYYY-MM-DD
  amount: string; // signed decimal string (bank perspective)
  currency: string;
  reference?: string; // end-to-end reference / our reference, if the bank carried it
  bankRef?: string; // the bank's own transaction id
  description: string;
  status: 'UNMATCHED' | 'MATCHED' | 'SUGGESTED' | 'EXCEPTION';
}

export interface Candidate {
  key: string; // unique: NetSuite externalId (or externalId:REVERSAL)
  nsExternalId: string;
  nsInternalId: string;
  type: 'VendPymt' | 'Deposit' | 'CustRfnd' | 'VendPymtReversal';
  date: string;
  amount: string; // signed, bank perspective
  currency: string;
  refs: string[]; // every reference this transaction is known by (externalId, bank ref, trace no…)
  groupRef?: string; // e.g. the payment batch reference (for one-to-many)
}

export type MatchRule = 'EXACT_REF' | 'GROUP_REF' | 'SPLIT_REF' | 'AMOUNT_DATE' | 'MANUAL';
export type ExceptionCode = 'RECON_UNMATCHED' | 'RECON_AMOUNT_MISMATCH' | 'RECON_AMBIGUOUS';

export interface MatchProposal {
  bankLineIds: string[];
  candidateKeys: string[];
  rule: MatchRule;
  confidence: number;
  amount: string;
}

export interface ExceptionProposal {
  bankLineId: string;
  code: ExceptionCode;
  detail: string;
  candidateKeys: string[];
}

export const AUTO_APPROVE_CONFIDENCE = 0.95;
const DATE_WINDOW_DAYS = 3;

const eq = (a: string, b: string) => new Decimal(a).equals(b);
const days = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000;

export function matchLines(
  lines: BankLine[],
  candidates: Candidate[],
): { matches: MatchProposal[]; exceptions: ExceptionProposal[] } {
  const usedCandidates = new Set<string>();
  const usedLines = new Set<string>();
  const matches: MatchProposal[] = [];
  const exceptions: ExceptionProposal[] = [];
  const free = () => candidates.filter((c) => !usedCandidates.has(c.key));
  const refsOf = (l: BankLine) => [l.reference, l.bankRef].filter((r): r is string => Boolean(r));
  const take = (m: MatchProposal) => {
    matches.push(m);
    m.bankLineIds.forEach((id) => usedLines.add(id));
    m.candidateKeys.forEach((k) => usedCandidates.add(k));
  };

  // Sorted processing order → deterministic results.
  const ordered = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));

  // Pass 1: EXACT_REF and GROUP_REF (one-to-many).
  for (const l of ordered) {
    const refs = refsOf(l);
    if (!refs.length) continue;
    const exact = free().find(
      (c) => c.currency === l.currency && c.refs.some((r) => refs.includes(r)) && eq(c.amount, l.amount),
    );
    if (exact) {
      take({
        bankLineIds: [l.id],
        candidateKeys: [exact.key],
        rule: 'EXACT_REF',
        confidence: 1,
        amount: l.amount,
      });
      continue;
    }
    const group = free().filter((c) => c.currency === l.currency && c.groupRef && refs.includes(c.groupRef));
    if (
      group.length > 1 &&
      eq(group.reduce((s, c) => s.plus(c.amount), new Decimal(0)).toFixed(2), l.amount)
    ) {
      take({
        bankLineIds: [l.id],
        candidateKeys: group.map((c) => c.key),
        rule: 'GROUP_REF',
        confidence: 0.95,
        amount: l.amount,
      });
    }
  }

  // Pass 2: SPLIT_REF (many-to-one): several unmatched lines sharing a reference sum to one candidate.
  const byRef = new Map<string, BankLine[]>();
  for (const l of ordered.filter((x) => !usedLines.has(x.id) && x.reference))
    byRef.set(l.reference!, [...(byRef.get(l.reference!) ?? []), l]);
  for (const [ref, group] of byRef) {
    if (group.length < 2) continue;
    const total = group.reduce((s, l) => s.plus(l.amount), new Decimal(0)).toFixed(2);
    const c = free().find(
      (x) => x.refs.includes(ref) && eq(x.amount, total) && x.currency === group[0]!.currency,
    );
    if (c)
      take({
        bankLineIds: group.map((l) => l.id),
        candidateKeys: [c.key],
        rule: 'SPLIT_REF',
        confidence: 0.9,
        amount: total,
      });
  }

  // Pass 3: lines that are still open → reference mismatch, amount+date, or exception.
  for (const l of ordered.filter((x) => !usedLines.has(x.id))) {
    const refs = refsOf(l);
    const refHit = free().filter(
      (c) => c.refs.some((r) => refs.includes(r)) || (c.groupRef && refs.includes(c.groupRef)),
    );
    if (refHit.length) {
      exceptions.push({
        bankLineId: l.id,
        code: 'RECON_AMOUNT_MISMATCH',
        detail: `Reference matches ${refHit.map((c) => c.nsExternalId).join(', ')} but amount ${l.amount} ≠ ${refHit.map((c) => c.amount).join(' / ')}`,
        candidateKeys: refHit.map((c) => c.key),
      });
      continue;
    }
    const byAmount = free().filter(
      (c) => c.currency === l.currency && eq(c.amount, l.amount) && days(c.date, l.date) <= DATE_WINDOW_DAYS,
    );
    if (byAmount.length === 1) {
      take({
        bankLineIds: [l.id],
        candidateKeys: [byAmount[0]!.key],
        rule: 'AMOUNT_DATE',
        confidence: 0.8,
        amount: l.amount,
      });
    } else if (byAmount.length > 1) {
      exceptions.push({
        bankLineId: l.id,
        code: 'RECON_AMBIGUOUS',
        detail: `${byAmount.length} transactions have amount ${l.amount} near ${l.date}`,
        candidateKeys: byAmount.map((c) => c.key),
      });
    } else {
      exceptions.push({
        bankLineId: l.id,
        code: 'RECON_UNMATCHED',
        detail: `No NetSuite transaction found for ${l.amount} ${l.currency} on ${l.date} (${l.description})`,
        candidateKeys: [],
      });
    }
  }
  return { matches, exceptions };
}
