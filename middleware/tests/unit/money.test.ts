import { describe, expect, it } from 'vitest';
import { add, equals, format, money, MoneyError, sum, toMinorUnits } from '../../src/domain/money';

describe('money', () => {
  it('adds without floating-point error (0.10 + 0.20 = 0.30 exactly)', () => {
    const total = add(money('0.10', 'USD'), money('0.20', 'USD'));
    expect(format(total)).toBe('0.30');
    expect(equals(total, money('0.30', 'USD'))).toBe(true);
  });

  it('refuses to mix currencies', () => {
    expect(() => add(money('1', 'USD'), money('1', 'EUR'))).toThrow(MoneyError);
  });

  it('rejects more decimals than the currency allows', () => {
    expect(() => money('10.001', 'USD')).toThrow(/too many decimals/);
    expect(() => money('10.5', 'JPY')).toThrow(/too many decimals/);
    expect(() => money('1.234', 'KWD')).not.toThrow();
  });

  it('rejects invalid input', () => {
    expect(() => money('abc', 'USD')).toThrow(MoneyError);
    expect(() => money('1', 'usd')).toThrow(/currency/);
  });

  it('converts to minor units for bank files', () => {
    expect(toMinorUnits(money('1250.5', 'USD'))).toBe('125050');
    expect(toMinorUnits(money('500', 'JPY'))).toBe('500');
  });

  it('sums lists, including an empty list', () => {
    const s = sum([money('100.00', 'USD'), money('23.45', 'USD')], 'USD');
    expect(format(s)).toBe('123.45');
    expect(format(sum([], 'USD'))).toBe('0.00');
  });
});
