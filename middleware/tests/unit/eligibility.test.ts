import { describe, expect, it } from 'vitest';
import { MockNetSuiteAdapter } from '../../src/adapters/netsuite/mock-netsuite';
import { evaluateBills, findDuplicateBills } from '../../src/domain/eligibility';

describe('AP eligibility rules (seed data, as of 2026-11-20, USD ACH, 7-day window)', async () => {
  const ns = new MockNetSuiteAdapter();
  const bills = await ns.listOpenVendorBills();
  const vendors = new Map((await ns.listVendors()).map((v) => [v.externalId, v]));
  const decisions = evaluateBills(bills, vendors, {
    asOf: '2026-11-20',
    windowDays: 7,
    currency: 'USD',
    rail: 'ACH',
    alreadyProposed: new Set(),
  });
  const reasonsOf = (id: string) => decisions.find((d) => d.bill.externalId === id)!.reasons;

  it('selects exactly the two eligible bills', () => {
    expect(
      decisions
        .filter((d) => d.eligible)
        .map((d) => d.bill.externalId)
        .sort(),
    ).toEqual(['BILL-1001', 'BILL-1002']);
  });

  it.each([
    ['BILL-1003', 'ON_HOLD'],
    ['BILL-1004', 'DUPLICATE_BILL'],
    ['BILL-1005', 'NOT_DUE'],
    ['BILL-1006', 'NOT_APPROVED'],
    ['BILL-1007', 'VENDOR_INACTIVE'],
    ['BILL-1008', 'CURRENCY_MISMATCH'],
    ['BILL-1009', 'RAIL_MISMATCH'],
  ])('%s is excluded because %s', (id, reason) => {
    expect(reasonsOf(id)).toContain(reason);
  });

  it('never includes fully paid bills (they are not open)', () => {
    expect(bills.find((b) => b.externalId === 'BILL-1010')).toBeUndefined();
  });

  it('excludes bills already in an open batch', () => {
    const d = evaluateBills(bills, vendors, {
      asOf: '2026-11-20',
      windowDays: 7,
      currency: 'USD',
      rail: 'ACH',
      alreadyProposed: new Set(['BILL-1001']),
    });
    expect(d.find((x) => x.bill.externalId === 'BILL-1001')!.reasons).toContain('ALREADY_PROPOSED');
  });

  it('keeps the earliest of duplicate invoice numbers (case-insensitive)', () => {
    const dupes = findDuplicateBills([
      { ...bills[0]!, externalId: 'B', tranDate: '2026-02-01', tranId: 'x-1' },
      { ...bills[0]!, externalId: 'A', tranDate: '2026-01-01', tranId: 'X-1' },
    ]);
    expect([...dupes]).toEqual(['B']);
  });
});
