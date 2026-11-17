/**
 * Bounded retries with exponential backoff and "full jitter".
 *
 * WHY EACH PART MATTERS
 *  - Retry ONLY transient errors (429, 5xx, timeouts). Retrying a validation error just fails again
 *    and wastes NetSuite's limited concurrency.
 *  - EXPONENTIAL backoff (200ms, 400ms, 800ms…): gives an overloaded system time to recover instead of
 *    hammering it.
 *  - JITTER (a random wait between 0 and the backoff): without it, 100 workers that failed together
 *    retry together, and cause the same overload again ("thundering herd").
 *  - BOUNDED attempts: after N tries we stop and hand the work to the dead-letter queue. Infinite
 *    retries hide outages and pile up work.
 *  - Retry-After: if the server tells us how long to wait, we respect it.
 */
import { isTransient, TransientError } from '../shared/errors';

export interface RetryPolicy {
  maxAttempts: number; // total attempts including the first one
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = { maxAttempts: 4, baseDelayMs: 200, maxDelayMs: 5_000 };

export interface RetryDeps {
  sleep: (ms: number) => Promise<void>;
  random?: () => number; // injectable for deterministic tests
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

/** Delay before retry number `attempt` (1-based): random between 0 and min(max, base·2^(attempt-1)). */
export function backoffDelay(
  attempt: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const cap = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * cap);
}

export class RetriesExhaustedError extends Error {
  constructor(
    readonly attempts: number,
    readonly lastError: unknown,
  ) {
    super(`Gave up after ${attempts} attempts: ${(lastError as Error)?.message ?? String(lastError)}`, {
      cause: lastError,
    });
  }
}

/**
 * Runs `fn`, retrying transient failures. Permanent failures are rethrown immediately (unchanged).
 * If every attempt fails transiently, throws RetriesExhaustedError (with the last error attached).
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: RetryPolicy,
  deps: RetryDeps,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      if (!isTransient(err)) throw err; // permanent: retrying cannot help
      lastError = err;
      if (attempt === policy.maxAttempts) break;
      const suggested = err instanceof TransientError ? err.retryAfterMs : undefined;
      const delayMs = Math.min(policy.maxDelayMs, suggested ?? backoffDelay(attempt, policy, deps.random));
      deps.onRetry?.({ attempt, delayMs, error: err });
      await deps.sleep(delayMs);
    }
  }
  throw new RetriesExhaustedError(policy.maxAttempts, lastError);
}
