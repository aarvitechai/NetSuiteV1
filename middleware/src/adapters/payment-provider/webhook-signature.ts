/**
 * Webhook signatures (HMAC-SHA256 with a timestamp), the same scheme most payment providers use.
 *
 * Header:  X-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, "<t>.<raw body>")>
 *
 * WHY EACH PART
 *  - HMAC with a shared secret: only the real provider (who knows the secret) can produce a valid
 *    signature. Anyone can POST to our public webhook URL, so unsigned requests must be ignored.
 *  - Sign the RAW body bytes: if we parsed and re-serialised the JSON first, whitespace or key order
 *    could change and the signature would not match.
 *  - The timestamp is inside the signature, and old timestamps are rejected (5-minute tolerance):
 *    an attacker who captured a real webhook cannot replay it next week.
 *  - Constant-time comparison: prevents timing attacks on the signature check.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const SIGNATURE_HEADER = 'x-signature';
export const TOLERANCE_SECONDS = 300;

export function signPayload(secret: string, rawBody: string, timestampSec: number): string {
  const sig = createHmac('sha256', secret).update(`${timestampSec}.${rawBody}`).digest('hex');
  return `t=${timestampSec},v1=${sig}`;
}

export type VerifyResult =
  { ok: true } | { ok: false; reason: 'MISSING' | 'MALFORMED' | 'EXPIRED' | 'MISMATCH' };

export function verifySignature(
  secret: string,
  rawBody: string,
  header: string | undefined,
  nowSec: number,
): VerifyResult {
  if (!header) return { ok: false, reason: 'MISSING' };
  const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]));
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isInteger(t) || !v1 || !/^[0-9a-f]{64}$/.test(v1)) return { ok: false, reason: 'MALFORMED' };
  if (Math.abs(nowSec - t) > TOLERANCE_SECONDS) return { ok: false, reason: 'EXPIRED' };
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  const given = Buffer.from(v1, 'hex');
  return expected.length === given.length && timingSafeEqual(expected, given)
    ? { ok: true }
    : { ok: false, reason: 'MISMATCH' };
}
