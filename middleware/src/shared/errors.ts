/**
 * Application error types.
 *
 * WHY: callers (HTTP clients, the retry logic, the DLQ) need to know two things about every error:
 *   1. WHAT went wrong: a stable `code` from docs/business-processes/exception-catalogue.md.
 *   2. Whether TRYING AGAIN can help: `transient`.
 *      - Transient: 429 rate limit, 5xx, timeouts. These are retried with backoff.
 *      - Permanent: validation and business-rule failures. Retrying would fail the same way forever,
 *        and might even cause harm, so they go straight to a human (DLQ or error response).
 */

export class AppError extends Error {
  constructor(
    /** Stable machine-readable code, e.g. "DUPLICATE_BILL". */
    readonly code: string,
    message: string,
    /** HTTP status to use when this error reaches the API boundary. */
    readonly httpStatus = 500,
    /** True when retrying the same operation later might succeed. */
    readonly transient = false,
    /** Extra safe-to-show details (never secrets). */
    readonly details?: unknown,
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super('VALIDATION_FAILED', message, 400, false, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Missing or invalid credentials') {
    super('UNAUTHORIZED', message, 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You are not allowed to perform this action', code = 'FORBIDDEN') {
    super(code, message, 403);
  }
}

export class NotFoundError extends AppError {
  constructor(what: string) {
    super('NOT_FOUND', `${what} not found`, 404);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 409, false, details);
  }
}

/** A business rule refused the operation (422 = "understood, but cannot be processed"). */
export class BusinessRuleError extends AppError {
  constructor(code: string, message: string, details?: unknown) {
    super(code, message, 422, false, details);
  }
}

/** A dependency (NetSuite, bank, provider) failed in a way that may succeed later. */
export class TransientError extends AppError {
  constructor(
    code: string,
    message: string,
    /** Server-suggested wait time, from a Retry-After header. */
    readonly retryAfterMs?: number,
  ) {
    super(code, message, 503, true);
  }
}

/** Duplicate insert into a store (unique key already exists). Used by idempotency and inbox logic. */
export class DuplicateKeyError extends AppError {
  constructor(collection: string, id: string) {
    super('DUPLICATE_KEY', `${collection}/${id} already exists`, 409);
  }
}

export function isTransient(err: unknown): boolean {
  return err instanceof AppError && err.transient;
}
