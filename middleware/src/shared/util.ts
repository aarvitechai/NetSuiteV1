/**
 * Small, dependency-free helpers used across the middleware.
 */
import { createHash, randomUUID } from 'node:crypto';

/** Prefixed unique ID, e.g. newId('PB') → "PB-3f2a…". The prefix makes IDs recognisable in logs. */
export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/**
 * JSON.stringify with object keys sorted.
 * WHY: {a:1,b:2} and {b:2,a:1} are the same payload, but plain JSON.stringify gives different strings
 * (and different hashes). Idempotency checks compare payload hashes, so key order must not matter.
 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`;
}

export function hashPayload(value: unknown): string {
  return sha256(stableStringify(value));
}

/**
 * Source of "now".
 * WHY: business rules depend on today's date ("is this bill due?"). Injecting a clock lets tests pin
 * the date (2026-11-20 for our seed data) instead of breaking when the real calendar moves on.
 */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export function fixedClock(iso: string): Clock & { set(iso: string): void; advance(ms: number): void } {
  let current = new Date(iso);
  return {
    now: () => new Date(current),
    set: (v) => (current = new Date(v)),
    advance: (ms) => (current = new Date(current.getTime() + ms)),
  };
}

/** YYYY-MM-DD for a Date (UTC). */
export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
