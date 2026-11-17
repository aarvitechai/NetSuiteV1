/**
 * Request context (correlation ID and actor) that follows async code automatically.
 *
 * WHY: one business flow, such as "pay vendor bill", produces many log lines across many functions
 * and async callbacks. Passing a correlationId parameter through every function is noisy and easy to
 * forget. Node's AsyncLocalStorage keeps a value "attached" to the current async call chain, so the
 * logger can always find the current correlation ID by itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export interface RequestContext {
  correlationId: string;
  /** Who is acting: a user subject, or a system name like "worker:outbox". */
  actor: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with the given context. Everything awaited inside it sees the same context. */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The current correlation ID, or a fresh one if we are outside any flow (for example at start-up). */
export function correlationId(): string {
  return storage.getStore()?.correlationId ?? newCorrelationId();
}

export function currentActor(): string {
  return storage.getStore()?.actor ?? 'system';
}

export function newCorrelationId(): string {
  return `corr-${randomUUID()}`;
}

/** Correlation IDs come from callers, so we accept only safe characters and a sane length. */
export function isValidCorrelationId(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,100}$/.test(value);
}
