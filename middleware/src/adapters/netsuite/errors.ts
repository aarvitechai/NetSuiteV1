/**
 * Translates NetSuite HTTP responses into our error types.
 *
 * WHY this matters: the retry logic only retries TransientError. Classifying correctly decides
 * between two outcomes:
 *   - "wait and try again": 429 rate limit, 5xx, timeouts, connection resets;
 *   - "stop, a human must fix this": 400 business errors such as a closed period or an invalid field,
 *     and 401/403 configuration errors.
 * Retrying a 400 forever wastes NetSuite's concurrency limit. Not retrying a 503 loses work.
 */
import { AppError, TransientError } from '../../shared/errors';

export class NetSuiteBusinessError extends AppError {
  constructor(message: string, details?: unknown) {
    super('NETSUITE_BUSINESS_ERROR', message, 422, false, details);
  }
}

export class NetSuiteAuthError extends AppError {
  constructor(message: string) {
    // 502: from OUR caller's point of view, an upstream dependency is misconfigured.
    super('NETSUITE_AUTH_FAILED', message, 502, false);
  }
}

/** Parses a Retry-After header ("120" seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | null | undefined, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * NetSuite REST errors look like:
 *   { "type": "...", "title": "Bad Request", "status": 400,
 *     "o:errorDetails": [{ "detail": "Invalid field value...", "o:errorCode": "INVALID_VALUE" }] }
 */
export function classifyNetSuiteResponse(
  status: number,
  body: unknown,
  retryAfter?: string | null,
): AppError {
  const details = (body as { 'o:errorDetails'?: { detail?: string; 'o:errorCode'?: string }[] })?.[
    'o:errorDetails'
  ];
  const message = details?.map((d) => d.detail).join('; ') || `NetSuite HTTP ${status}`;
  const code = details?.[0]?.['o:errorCode'];

  if (status === 429 || code === 'CONCURRENCY_LIMIT_EXCEEDED') {
    return new TransientError('NETSUITE_RATE_LIMITED', message, parseRetryAfter(retryAfter));
  }
  if (status >= 500) return new TransientError('NETSUITE_UNAVAILABLE', message, parseRetryAfter(retryAfter));
  if (status === 401 || status === 403) return new NetSuiteAuthError(message);
  return new NetSuiteBusinessError(message, { status, code });
}

/** Network-level failures (no HTTP response at all) are always transient. */
export function classifyNetworkError(err: unknown): AppError {
  const e = err as { name?: string; code?: string; message?: string };
  const msg = e?.message ?? 'network error';
  if (e?.name === 'AbortError' || e?.name === 'TimeoutError')
    return new TransientError('NETSUITE_TIMEOUT', msg);
  return new TransientError('NETSUITE_UNAVAILABLE', msg);
}
