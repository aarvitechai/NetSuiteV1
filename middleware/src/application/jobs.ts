/**
 * Integration jobs, message handlers and the dead-letter queue (DLQ).
 *
 * CONCEPTS
 *  - A *topic* names a kind of work, e.g. "netsuite.vendor.upsert".
 *  - A *handler* does that work for one payload. Handlers MUST be idempotent (safe to run twice),
 *    which in this project means every NetSuite create uses an externalId.
 *  - An *integration job* records one execution: status, attempts, correlation ID, result or error.
 *  - The *dead-letter queue* holds work that could not be completed:
 *      - a permanent error (bad data), or
 *      - retries exhausted (a long outage).
 *    Nothing is silently dropped. A human can REPLAY it after fixing the cause, or DISCARD it
 *    with a reason.
 *
 * RETRY VS REPLAY
 *  - Retry  = automatic, immediate, a few attempts, for short transient blips.
 *  - Replay = manual (or scheduled), later, after a human fixed the cause, using the SAME payload and
 *    correlation ID. Because handlers are idempotent, replaying something that partly succeeded
 *    does not create duplicates.
 */
import type { Logger } from 'pino';
import type { AuditService } from './audit';
import type { Store } from './ports/store';
import { RetriesExhaustedError, withRetry, type RetryDeps, type RetryPolicy } from './retry';
import { correlationId as currentCorrelationId, currentActor, runWithContext } from '../shared/context';
import { AppError, ConflictError, NotFoundError } from '../shared/errors';
import { newId, type Clock } from '../shared/util';

export type Handler = (payload: unknown) => Promise<unknown>;

export interface IntegrationJob {
  id: string;
  type: string; // = topic
  status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  attempts: number;
  correlationId: string;
  sourceRef?: string;
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: { code: string; message: string };
  replayOf?: string;
}

export interface DeadLetter {
  id: string;
  topic: string;
  payload: unknown;
  status: 'OPEN' | 'REPLAYED' | 'DISCARDED';
  correlationId: string;
  sourceRef?: string;
  error: { code: string; message: string; transient: boolean };
  attempts: number;
  createdAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
  resolution?: string;
  replayJobId?: string;
}

export function errorSummary(err: unknown): { code: string; message: string; transient: boolean } {
  const root = err instanceof RetriesExhaustedError ? err.lastError : err;
  if (root instanceof AppError) return { code: root.code, message: root.message, transient: root.transient };
  return { code: 'INTERNAL_ERROR', message: (root as Error)?.message ?? String(root), transient: false };
}

export class JobRunner {
  private readonly handlers = new Map<string, Handler>();

  constructor(
    private readonly store: Store,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly retryPolicy: RetryPolicy,
    private readonly retryDeps: RetryDeps,
  ) {}

  /** Registers the handler for a topic (done once, at start-up, in the container). */
  register(topic: string, handler: Handler): void {
    this.handlers.set(topic, handler);
  }

  hasHandler(topic: string): boolean {
    return this.handlers.has(topic);
  }

  /**
   * Runs one unit of work with retries. On final failure the work goes to the DLQ.
   * Returns the job record. It never throws for handler failures, so a batch can continue with the next item.
   */
  async run(
    topic: string,
    payload: unknown,
    opts: { sourceRef?: string; replayOf?: string } = {},
  ): Promise<IntegrationJob> {
    const handler = this.handlers.get(topic);
    if (!handler) throw new Error(`No handler registered for topic ${topic}`);
    const jobs = this.store.repo<IntegrationJob>('integration_jobs');
    const job: IntegrationJob = {
      id: newId('JOB'),
      type: topic,
      status: 'RUNNING',
      attempts: 0,
      correlationId: currentCorrelationId(),
      sourceRef: opts.sourceRef,
      replayOf: opts.replayOf,
      startedAt: this.clock.now().toISOString(),
    };
    await jobs.insert(job);

    try {
      job.result = await withRetry(
        async (attempt) => {
          job.attempts = attempt;
          return handler(payload);
        },
        this.retryPolicy,
        {
          ...this.retryDeps,
          onRetry: ({ attempt, delayMs, error }) =>
            this.logger.warn(
              { topic, attempt, delayMs, code: errorSummary(error).code },
              'transient failure, retrying',
            ),
        },
      );
      job.status = 'SUCCEEDED';
    } catch (err) {
      job.status = 'FAILED';
      const summary = errorSummary(err);
      job.error = { code: summary.code, message: summary.message };
      await this.deadLetter(topic, payload, err, job);
    }
    job.finishedAt = this.clock.now().toISOString();
    await jobs.upsert(job);
    return job;
  }

  private async deadLetter(
    topic: string,
    payload: unknown,
    err: unknown,
    job: IntegrationJob,
  ): Promise<void> {
    const dl: DeadLetter = {
      id: newId('DLQ'),
      topic,
      payload,
      status: 'OPEN',
      correlationId: job.correlationId,
      sourceRef: job.sourceRef,
      error: errorSummary(err),
      attempts: job.attempts,
      createdAt: this.clock.now().toISOString(),
    };
    await this.store.repo<DeadLetter>('dead_letters').insert(dl);
    this.logger.error({ topic, deadLetterId: dl.id, code: dl.error.code }, 'moved to dead-letter queue');
    await this.audit.record({
      action: 'DEAD_LETTERED',
      entityType: 'dead_letter',
      entityId: dl.id,
      outcome: 'FAILURE',
      source: 'jobs',
      details: { topic, sourceRef: job.sourceRef, code: dl.error.code },
    });
  }

  // ---------------- DLQ operations (used by the ops API) ----------------

  listDeadLetters(status: DeadLetter['status'] = 'OPEN'): Promise<DeadLetter[]> {
    return this.store.repo<DeadLetter>('dead_letters').list({ status });
  }

  /**
   * Replays a dead letter with its ORIGINAL payload and correlation ID, so the whole story stays
   * traceable under one ID. If the replay fails again, a NEW dead letter is created (the old one
   * stays REPLAYED, with a pointer to the failed job).
   */
  async replay(id: string): Promise<{ deadLetter: DeadLetter; job: IntegrationJob }> {
    const repo = this.store.repo<DeadLetter>('dead_letters');
    const dl = await repo.get(id);
    if (!dl) throw new NotFoundError(`Dead letter ${id}`);
    if (dl.status !== 'OPEN') throw new ConflictError('DEAD_LETTER_NOT_OPEN', `Dead letter is ${dl.status}`);

    const actor = currentActor();
    // Everything below runs under the ORIGINAL correlation ID, so the failure, the replay and its audit
    // event can all be found with one search.
    return runWithContext({ correlationId: dl.correlationId, actor: `replay:${actor}` }, async () => {
      const job = await this.run(dl.topic, dl.payload, { sourceRef: dl.sourceRef, replayOf: dl.id });
      const updated: DeadLetter = {
        ...dl,
        status: 'REPLAYED',
        resolvedAt: this.clock.now().toISOString(),
        resolvedBy: actor,
        replayJobId: job.id,
        resolution:
          job.status === 'SUCCEEDED' ? 'replay succeeded' : 'replay failed (new dead letter created)',
      };
      await repo.upsert(updated);
      await this.audit.record({
        action: 'DEAD_LETTER_REPLAYED',
        entityType: 'dead_letter',
        entityId: dl.id,
        outcome: job.status === 'SUCCEEDED' ? 'SUCCESS' : 'FAILURE',
        details: { jobId: job.id },
      });
      return { deadLetter: updated, job };
    });
  }

  async discard(id: string, reason: string): Promise<DeadLetter> {
    const repo = this.store.repo<DeadLetter>('dead_letters');
    const dl = await repo.get(id);
    if (!dl) throw new NotFoundError(`Dead letter ${id}`);
    if (dl.status !== 'OPEN') throw new ConflictError('DEAD_LETTER_NOT_OPEN', `Dead letter is ${dl.status}`);
    const updated: DeadLetter = {
      ...dl,
      status: 'DISCARDED',
      resolvedAt: this.clock.now().toISOString(),
      resolvedBy: currentActor(),
      resolution: reason,
    };
    await repo.upsert(updated);
    await this.audit.record({
      action: 'DEAD_LETTER_DISCARDED',
      entityType: 'dead_letter',
      entityId: id,
      outcome: 'SUCCESS',
      details: { reason },
    });
    return updated;
  }

  getJob(id: string): Promise<IntegrationJob | undefined> {
    return this.store.repo<IntegrationJob>('integration_jobs').get(id);
  }
}
