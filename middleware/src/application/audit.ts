/**
 * Audit trail: an append-only record of who did what, when, and with what result.
 *
 * WHY: finance and auditors must be able to answer questions like "who approved batch PB-17, and
 * when?" or "why was this payment reversed?". Logs are not enough. They rotate, they are noisy, and
 * they are not structured per business entity. Audit events are business records: they are kept for
 * years and never updated (the PostgreSQL table has a trigger that blocks UPDATE and DELETE).
 *
 * WHAT NOT TO STORE: secrets, card data, full bank account numbers. `details` holds references and
 * amounts only.
 */
import type { Store } from './ports/store';
import { correlationId, currentActor } from '../shared/context';
import { newId, type Clock } from '../shared/util';

export interface AuditEvent {
  id: string;
  at: string;
  actor: string;
  action: string; // e.g. "PAYMENT_BATCH_APPROVED"
  entityType: string; // e.g. "payment_batch"
  entityId: string;
  correlationId: string;
  outcome: 'SUCCESS' | 'FAILURE' | 'REJECTED';
  source: string; // which component recorded it: "api", "worker:outbox", "webhook"
  details?: Record<string, unknown>;
}

export class AuditService {
  constructor(
    private readonly store: Store,
    private readonly clock: Clock,
  ) {}

  async record(
    e: Omit<AuditEvent, 'id' | 'at' | 'actor' | 'correlationId' | 'source'> & {
      actor?: string;
      source?: string;
    },
    tx: Store = this.store,
  ): Promise<AuditEvent> {
    const event: AuditEvent = {
      id: newId('AUD'),
      at: this.clock.now().toISOString(),
      actor: e.actor ?? currentActor(),
      correlationId: correlationId(),
      source: e.source ?? 'api',
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      outcome: e.outcome,
      details: e.details,
    };
    // insert (never upsert): audit events are immutable.
    await tx.repo<AuditEvent>('audit_events').insert(event);
    return event;
  }

  async forEntity(entityType: string, entityId: string): Promise<AuditEvent[]> {
    const events = await this.store.repo<AuditEvent>('audit_events').list({ entityType, entityId });
    return events.sort((a, b) => a.at.localeCompare(b.at));
  }

  async byCorrelation(id: string): Promise<AuditEvent[]> {
    return this.store.repo<AuditEvent>('audit_events').list({ correlationId: id });
  }
}
