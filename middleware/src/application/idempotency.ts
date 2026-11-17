/**
 * Idempotency service: makes "do X" requests safe to repeat.
 *
 * THE PROBLEM: a client sends "create payment batch", the network drops the response, and the client
 * retries. Without protection we would create TWO batches and pay vendors twice.
 *
 * THE SOLUTION (the same pattern Stripe and most payment APIs use):
 *   1. The client sends a unique Idempotency-Key header with each logical operation.
 *   2. The first time we see the key, we store it as IN_PROGRESS (an insert with a unique key, which is
 *      atomic), run the operation, and store the response.
 *   3. If the same key arrives again:
 *        - same payload, completed   → return the STORED response (nothing runs twice);
 *        - same payload, in progress → 409 "still processing, retry later";
 *        - DIFFERENT payload         → 409 IDEMPOTENCY_CONFLICT (the client has a bug).
 *   4. Transient failures (5xx) delete the record so the client can retry. Permanent 4xx results are
 *      stored, because retrying them would give the same answer anyway.
 */
import type { Store } from './ports/store';
import { AppError, ConflictError, DuplicateKeyError } from '../shared/errors';
import { hashPayload, type Clock } from '../shared/util';

export interface IdempotencyRecord {
  id: string; // `${operation}:${key}`
  operation: string;
  key: string;
  payloadHash: string;
  status: 'IN_PROGRESS' | 'COMPLETED';
  response?: { status: number; body: unknown };
  createdAt: string;
  expiresAt: string;
}

export interface IdempotentResult<T> {
  status: number;
  body: T;
  /** True when this response was replayed from storage (the operation did not run again). */
  replayed: boolean;
}

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, see data dictionary retention table

export class IdempotencyService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  private repo() {
    return this.store.repo<IdempotencyRecord>('idempotency_records');
  }

  async execute<T>(
    operation: string,
    key: string,
    payload: unknown,
    fn: () => Promise<{ status: number; body: T }>,
  ): Promise<IdempotentResult<T>> {
    const id = `${operation}:${key}`;
    const payloadHash = hashPayload(payload);
    const now = this.clock.now();
    const record: IdempotencyRecord = {
      id,
      operation,
      key,
      payloadHash,
      status: 'IN_PROGRESS',
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
    };

    try {
      await this.repo().insert(record);
    } catch (e) {
      if (!(e instanceof DuplicateKeyError)) throw e;
      const existing = (await this.repo().get(id))!;
      if (existing.expiresAt < now.toISOString()) {
        // Expired keys are treated as new. Delete and start over.
        await this.repo().delete(id);
        return this.execute(operation, key, payload, fn);
      }
      if (existing.payloadHash !== payloadHash) {
        throw new ConflictError(
          'IDEMPOTENCY_CONFLICT',
          'Idempotency-Key was already used with a different request body',
        );
      }
      if (existing.status === 'IN_PROGRESS') {
        throw new ConflictError(
          'IDEMPOTENCY_IN_PROGRESS',
          'A request with this Idempotency-Key is still being processed',
        );
      }
      return { ...(existing.response as { status: number; body: T }), replayed: true };
    }

    try {
      const response = await fn();
      await this.repo().upsert({ ...record, status: 'COMPLETED', response });
      return { ...response, replayed: false };
    } catch (e) {
      if (e instanceof AppError && e.httpStatus < 500 && !e.transient) {
        // Permanent client error: remember it, so a retry gets the same answer without re-running.
        const response = { status: e.httpStatus, body: { error: { code: e.code, message: e.message } } };
        await this.repo().upsert({ ...record, status: 'COMPLETED', response });
      } else {
        // Transient or unknown failure: forget the key so the client may safely retry.
        await this.repo().delete(id);
      }
      throw e;
    }
  }
}
