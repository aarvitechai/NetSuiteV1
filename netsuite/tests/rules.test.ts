import { describe, expect, it } from 'vitest';
import { loadSuiteScript } from './harness/amd-loader';

type Rules = {
  approvalRoute(amount: number): string;
  daysBetween(a: Date, b: Date): number;
  validateVendorBill(b: Record<string, unknown>): string[];
  changedLockedFields(o: Record<string, unknown>, n: Record<string, unknown>): string[];
  collectionStage(days: number, disputed: boolean): string;
  redact(t: unknown): string;
};

const rules = loadSuiteScript<Rules>('lib/nsd_rules.js');

describe('nsd_rules', () => {
  it('validates a good bill', () => {
    expect(
      rules.validateVendorBill({
        tranId: 'INV-1',
        total: 10,
        tranDate: new Date(2026, 0, 1),
        dueDate: new Date(2026, 0, 31),
      }),
    ).toEqual([]);
  });

  it('reports every problem with a bad bill', () => {
    const errs = rules.validateVendorBill({
      tranId: ' ',
      total: 0,
      tranDate: new Date(2026, 0, 31),
      dueDate: new Date(2026, 0, 1),
    });
    expect(errs).toHaveLength(3);
  });

  it('detects changes to locked fields only', () => {
    const old = { entity: 1, currency: 1, usertotal: 100, tranid: 'A', memo: 'x' };
    expect(rules.changedLockedFields(old, { ...old, memo: 'y' })).toEqual([]);
    expect(rules.changedLockedFields(old, { ...old, usertotal: 101 })).toEqual(['usertotal']);
  });

  it.each([
    [0, false, 'NONE'],
    [1, false, 'REMINDER_1'],
    [29, false, 'REMINDER_1'],
    [30, false, 'REMINDER_2'],
    [60, false, 'ESCALATED'],
    [90, true, 'NONE'],
  ])('collection stage for %i days overdue (disputed=%s) is %s', (days, disputed, stage) => {
    expect(rules.collectionStage(days, disputed)).toBe(stage);
  });

  it.each([
    [999.99, 'AP_SUPERVISOR'],
    [1000, 'CONTROLLER'],
    [10000, 'CONTROLLER'],
    [10000.01, 'CFO'],
  ])('routes a %d bill to %s', (amount, route) => {
    expect(rules.approvalRoute(amount)).toBe(route);
  });

  it('counts days across a DST change correctly', () => {
    expect(rules.daysBetween(new Date(2026, 2, 1), new Date(2026, 3, 1))).toBe(31);
  });

  it('redacts card numbers and secrets', () => {
    const out = rules.redact('card 4111111111111111 failed; Authorization: Bearer abc123');
    expect(out).not.toContain('4111111111111111');
    expect(out).not.toContain('abc123');
  });
});
