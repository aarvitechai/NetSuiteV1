/**
 * Money helpers.
 *
 * WHY: In JavaScript, 0.1 + 0.2 === 0.30000000000000004. Binary floating-point numbers cannot
 * represent most decimal fractions exactly, and in finance a 1-cent error breaks reconciliation.
 * So money is ALWAYS handled with decimal.js, and it travels between systems as a string
 * such as "1250.00".
 *
 * A Money value is also always paired with its currency. Adding USD to EUR is a bug, so we refuse to do it.
 */
import Decimal from 'decimal.js';

/** How many decimal places ("minor units") each currency has. ISO 4217. Default is 2. */
const MINOR_UNITS: Record<string, number> = { JPY: 0, KRW: 0, BHD: 3, KWD: 3 };

export function minorUnitsFor(currency: string): number {
  return MINOR_UNITS[currency] ?? 2;
}

export interface Money {
  /** Exact decimal value. Never convert to a JS number for arithmetic. */
  readonly amount: Decimal;
  /** ISO 4217 three-letter currency code, for example "USD". */
  readonly currency: string;
}

export class MoneyError extends Error {}

/**
 * Creates Money from a string (preferred) or a Decimal.
 * Numbers are intentionally NOT accepted, so a float can never sneak in through this API.
 */
export function money(amount: string | Decimal, currency: string): Money {
  if (!/^[A-Z]{3}$/.test(currency)) throw new MoneyError(`Invalid currency code "${currency}"`);
  let value: Decimal;
  try {
    value = new Decimal(amount);
  } catch {
    throw new MoneyError(`Invalid amount "${String(amount)}"`);
  }
  if (!value.isFinite()) throw new MoneyError(`Invalid amount "${String(amount)}"`);
  // Reject amounts that have more decimals than the currency allows (e.g. "10.001" USD).
  // Silently rounding would hide upstream data problems.
  if (value.decimalPlaces() > minorUnitsFor(currency)) {
    throw new MoneyError(`Amount ${value.toString()} has too many decimals for ${currency}`);
  }
  return { amount: value, currency };
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount.plus(b.amount), currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amount: a.amount.minus(b.amount), currency: a.currency };
}

/** Sums a list. An empty list needs to know its currency, so it is passed explicitly. */
export function sum(items: Money[], currency: string): Money {
  return items.reduce((acc, m) => add(acc, m), money('0', currency));
}

export function equals(a: Money, b: Money): boolean {
  return a.currency === b.currency && a.amount.equals(b.amount);
}

export function isPositive(m: Money): boolean {
  return m.amount.greaterThan(0);
}

/**
 * Converts to the smallest unit as an integer string ("12.34" USD → "1234").
 * Bank files (NACHA) and most payment APIs use minor units to avoid decimals entirely.
 */
export function toMinorUnits(m: Money): string {
  return m.amount.times(new Decimal(10).pow(minorUnitsFor(m.currency))).toFixed(0);
}

/** Formats with the currency's fixed number of decimals: "12.3" → "12.30". Used in APIs and files. */
export function format(m: Money): string {
  return m.amount.toFixed(minorUnitsFor(m.currency));
}

/** JSON-friendly representation used in API responses. */
export function toJSON(m: Money): { amount: string; currency: string } {
  return { amount: format(m), currency: m.currency };
}
