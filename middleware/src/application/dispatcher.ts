/**
 * Dispatcher: how services hand off follow-up work such as "post this vendor payment to NetSuite".
 * Implemented as a TRANSACTIONAL OUTBOX.
 *
 * THE PROBLEM IT SOLVES ("dual write"):
 *   1. we save "instruction = Settled" in our database, then
 *   2. we call NetSuite to create the Vendor Payment.
 *   If the process crashes between 1 and 2, the payment is settled but never posted. Nobody notices
 *   until month-end.
 *
 * THE OUTBOX PATTERN:
 *   - Inside the SAME database transaction as the business change, we also insert an outbox message
 *     ("please post vendor payment PI-123"). Both are saved, or neither is.
 *   - After commit, the messages are delivered (flush). If we crash before delivering, the message is
 *     still in the table, and the next flush or the background worker delivers it.
 *   - Delivery runs the job through JobRunner (retries + DLQ). Handlers are idempotent, so delivering
 *     a message twice after a crash is harmless ("at-least-once delivery + idempotent consumers").
 *
 * MODES (config DISPATCH_MODE):
 *   inline – flush() delivers right after each operation (simple; API responses reflect the result).
 *   worker – flush() does nothing; a background OutboxWorker drains the table every few seconds.
 *            Long-running work then never slows down API requests.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Logger } from 'pino';
import type { JobRunner } from './jobs';
import type { Store } from './ports/store';
import { correlationId, currentActor, runWithContext } from '../shared/context';
import { newId, type Clock } from '../shared/util';

export interface Dispatcher {
  /** Records follow-up work. Pass `tx` to make it atomic with the caller's transaction. */
  dispatch(topic: string, payload: unknown, opts?: { sourceRef?: string; tx?: Store }): Promise<void>;
  /** Delivers pending messages now (inline mode). Call it after the business transaction commits. */
  flush(): Promise<void>;
}

export interface OutboxMessage {
  id: string;
  topic: string;
  payload: unknown;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'FAILED';
  correlationId: string;
  actor: string;
  sourceRef?: string;
  createdAt: string;
  deliveredAt?: string;
  jobId?: string;
}

/**
 * Marks code that runs INSIDE a drain (a job being delivered). If that job calls flush() itself, we
 * must not wait for the drain (it would wait for itself, a deadlock). The running drain's loop
 * delivers the new messages anyway.
 */
const insideDrain = new AsyncLocalStorage<boolean>();

export class OutboxDispatcher implements Dispatcher {
  /** Serialises deliveries in this process, so two flushes never deliver the same message twice. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly store: Store,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    private readonly logger: Logger,
    private readonly mode: 'inline' | 'worker' = 'inline',
  ) {}

  private repo(store: Store = this.store) {
    return store.repo<OutboxMessage>('outbox_messages');
  }

  async dispatch(
    topic: string,
    payload: unknown,
    opts: { sourceRef?: string; tx?: Store } = {},
  ): Promise<void> {
    await this.repo(opts.tx).insert({
      id: newId('OBX'),
      topic,
      payload,
      status: 'PENDING',
      // Keep the trace: the worker will run the job under the same correlation ID and actor.
      correlationId: correlationId(),
      actor: currentActor(),
      sourceRef: opts.sourceRef,
      createdAt: this.clock.now().toISOString(),
    });
  }

  async flush(): Promise<void> {
    if (this.mode !== 'inline' || insideDrain.getStore()) return;
    await this.drain();
  }

  /** Delivers every PENDING message (oldest first). Used by flush() and by the background worker. */
  drain(): Promise<number> {
    const run = async () => {
      let delivered = 0;
      // Loop until empty: a delivered job may itself enqueue new messages (e.g. deposit after payment).
      for (;;) {
        const pending = (await this.repo().list({ status: 'PENDING' })).sort((a, b) =>
          a.createdAt.localeCompare(b.createdAt),
        );
        if (!pending.length) return delivered;
        for (const msg of pending) {
          // Claim: PENDING → IN_PROGRESS before running. With several worker PROCESSES, use a DB lease
          // instead (PostgreSQL: SELECT … FOR UPDATE SKIP LOCKED). See docs/architecture/reliability.md.
          await this.repo().upsert({ ...msg, status: 'IN_PROGRESS' });
          const job = await insideDrain.run(true, () =>
            runWithContext({ correlationId: msg.correlationId, actor: msg.actor }, () =>
              this.jobs.run(msg.topic, msg.payload, { sourceRef: msg.sourceRef }),
            ),
          );
          await this.repo().upsert({
            ...msg,
            status: job.status === 'SUCCEEDED' ? 'DONE' : 'FAILED',
            deliveredAt: this.clock.now().toISOString(),
            jobId: job.id,
          });
          delivered++;
        }
      }
    };
    const result = this.chain.then(run, run);
    this.chain = result.catch((e) => this.logger.error({ err: e }, 'outbox drain failed'));
    return result;
  }

  /** Queue health for monitoring: how many messages wait, and how old the oldest one is. */
  async stats(): Promise<{
    pending: number;
    inProgress: number;
    failed: number;
    oldestPendingAgeSeconds: number;
  }> {
    const [pending, inProgress, failed] = await Promise.all([
      this.repo().list({ status: 'PENDING' }),
      this.repo().list({ status: 'IN_PROGRESS' }),
      this.repo().list({ status: 'FAILED' }),
    ]);
    const oldest = pending.map((m) => m.createdAt).sort()[0];
    return {
      pending: pending.length,
      inProgress: inProgress.length,
      failed: failed.length,
      oldestPendingAgeSeconds: oldest
        ? Math.max(0, Math.round((this.clock.now().getTime() - Date.parse(oldest)) / 1000))
        : 0,
    };
  }

  /**
   * Crash recovery: messages left IN_PROGRESS by a process that died are put back to PENDING.
   * Safe, because handlers are idempotent. Called once at start-up.
   */
  async recoverStuck(): Promise<number> {
    const stuck = await this.repo().list({ status: 'IN_PROGRESS' });
    for (const m of stuck) await this.repo().upsert({ ...m, status: 'PENDING' });
    return stuck.length;
  }
}

/** Background worker for DISPATCH_MODE=worker: drains the outbox on a timer. */
export class OutboxWorker {
  private timer?: NodeJS.Timeout;
  constructor(
    private readonly outbox: OutboxDispatcher,
    private readonly intervalMs = 2000,
  ) {}

  start(): void {
    // unref(): the timer alone never keeps the process alive (graceful shutdown still works).
    this.timer = setInterval(() => void this.outbox.drain(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }
}
