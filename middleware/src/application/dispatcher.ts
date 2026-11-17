/**
 * Dispatcher: how services hand off follow-up work such as "post this vendor payment to NetSuite".
 *
 * WHY an interface: services only say WHAT should happen (topic + payload). The dispatcher decides
 * HOW and WHEN:
 *   - DirectDispatcher (default) runs the job right away, with retries and the DLQ. It is simple, and
 *     the API response already reflects the result.
 *   - OutboxDispatcher (Phase 11) saves the message in the same database transaction as the state change,
 *     and a worker delivers it. Nothing is lost if the process crashes between the two steps.
 * Swapping one for the other requires no change to business code.
 */
import type { JobRunner } from './jobs';
import type { Store } from './ports/store';

export interface Dispatcher {
  /** `tx` lets an outbox implementation write inside the caller's transaction. */
  dispatch(topic: string, payload: unknown, opts?: { sourceRef?: string; tx?: Store }): Promise<void>;
}

export class DirectDispatcher implements Dispatcher {
  constructor(private readonly jobs: JobRunner) {}

  async dispatch(topic: string, payload: unknown, opts: { sourceRef?: string } = {}): Promise<void> {
    // Failures never throw here: they are retried and then dead-lettered inside JobRunner.run.
    await this.jobs.run(topic, payload, { sourceRef: opts.sourceRef });
  }
}
