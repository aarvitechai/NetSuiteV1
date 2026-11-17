import { describe, expect, it } from 'vitest';
import { matchLines, type BankLine, type Candidate } from '../../src/domain/reconciliation';

const line = (id: string, amount: string, extra: Partial<BankLine> = {}): BankLine => ({
  id,
  fileId: 'F',
  lineNo: 1,
  date: '2026-11-23',
  amount,
  currency: 'USD',
  description: id,
  status: 'UNMATCHED',
  ...extra,
});
const cand = (key: string, amount: string, extra: Partial<Candidate> = {}): Candidate => ({
  key,
  nsExternalId: key,
  nsInternalId: '1',
  type: 'VendPymt',
  date: '2026-11-23',
  amount,
  currency: 'USD',
  refs: [key],
  ...extra,
});

describe('reconciliation matching rules', () => {
  it('EXACT_REF: reference and amount match → confidence 1.0', () => {
    const r = matchLines([line('L1', '-100.00', { reference: 'PI-1' })], [cand('PI-1', '-100.00')]);
    expect(r.matches).toEqual([
      { bankLineIds: ['L1'], candidateKeys: ['PI-1'], rule: 'EXACT_REF', confidence: 1, amount: '-100.00' },
    ]);
  });

  it('GROUP_REF (one-to-many): one batch debit = sum of payments in the batch', () => {
    const r = matchLines(
      [line('L1', '-1730.50', { reference: 'PB1' })],
      [cand('PI-1', '-1250.00', { groupRef: 'PB1' }), cand('PI-2', '-480.50', { groupRef: 'PB1' })],
    );
    expect(r.matches[0]).toMatchObject({
      rule: 'GROUP_REF',
      candidateKeys: ['PI-1', 'PI-2'],
      confidence: 0.95,
    });
  });

  it('SPLIT_REF (many-to-one): two bank credits with one reference = one deposit', () => {
    const r = matchLines(
      [line('L1', '1000.00', { reference: 'po_1' }), line('L2', '500.00', { reference: 'po_1' })],
      [cand('po_1', '1500.00', { type: 'Deposit' })],
    );
    expect(r.matches[0]).toMatchObject({ rule: 'SPLIT_REF', bankLineIds: ['L1', 'L2'], confidence: 0.9 });
  });

  it('AMOUNT_DATE: no reference, single candidate within ±3 days → suggested (0.8)', () => {
    const r = matchLines(
      [line('L1', '-50.00')],
      [cand('RF-1', '-50.00', { date: '2026-11-21', type: 'CustRfnd' })],
    );
    expect(r.matches[0]).toMatchObject({ rule: 'AMOUNT_DATE', confidence: 0.8 });
  });

  it('AMBIGUOUS: two candidates with the same amount → exception, never a guess', () => {
    const r = matchLines([line('L1', '-50.00')], [cand('A', '-50.00'), cand('B', '-50.00')]);
    expect(r.exceptions[0]).toMatchObject({ code: 'RECON_AMBIGUOUS', candidateKeys: ['A', 'B'] });
  });

  it('REF_AMOUNT_MISMATCH: right reference, wrong amount (e.g. a fee was deducted)', () => {
    const r = matchLines(
      [line('L1', '3780.00', { reference: 'po_1' })],
      [cand('po_1', '3786.30', { type: 'Deposit' })],
    );
    expect(r.exceptions[0]!.code).toBe('RECON_AMOUNT_MISMATCH');
  });

  it('UNMATCHED: nothing similar (e.g. a bank service fee)', () => {
    const r = matchLines([line('L1', '-25.00', { description: 'SERVICE FEE' })], []);
    expect(r.exceptions[0]!.code).toBe('RECON_UNMATCHED');
  });

  it('never matches one transaction to two lines', () => {
    const r = matchLines(
      [line('L1', '-100.00', { reference: 'PI-1' }), line('L2', '-100.00', { reference: 'PI-1' })],
      [cand('PI-1', '-100.00')],
    );
    expect(r.matches).toHaveLength(1);
    expect(r.exceptions).toHaveLength(1);
  });

  it('is deterministic regardless of input order', () => {
    const lines = [line('L2', '-50.00', { date: '2026-11-24' }), line('L1', '-50.00')];
    const c = [cand('A', '-50.00')];
    expect(matchLines(lines, c)).toEqual(matchLines([...lines].reverse(), c));
  });
});
