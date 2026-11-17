/**
 * Storage "ports": the interfaces the application uses to persist integration metadata.
 *
 * WHY interfaces (ports) and not direct database calls: application services depend only on these
 * interfaces. In tests and the demo we plug in an in-memory implementation, and in deployed
 * environments a PostgreSQL one. The business code is identical in both cases. This is the
 * "ports and adapters" (hexagonal) architecture.
 *
 * Reminder (ADR-0001): this store holds INTEGRATION METADATA, never the general ledger.
 */

/** Every stored entity has a string id that is unique within its collection. */
export interface Entity {
  id: string;
}

export interface Repository<T extends Entity> {
  get(id: string): Promise<T | undefined>;
  /** Inserts a new entity. Throws DuplicateKeyError if the id already exists (used for dedupe). */
  insert(entity: T): Promise<void>;
  /** Replaces an existing entity, or creates it. */
  upsert(entity: T): Promise<void>;
  delete(id: string): Promise<void>;
  /**
   * Lists entities whose INDEXED fields equal the given values (see collections.ts).
   * Only indexed fields can be filtered, so the same query is efficient in PostgreSQL.
   */
  list(
    filter?: Partial<Record<string, string | number | boolean>>,
    options?: { limit?: number },
  ): Promise<T[]>;
}

export interface Store {
  repo<T extends Entity>(collection: CollectionName): Repository<T>;
  /**
   * Runs `fn` atomically: either every write inside it is saved, or none are.
   * WHY: the outbox pattern saves a business change AND the message announcing it together. If only
   * one of the two were saved, the systems would drift apart.
   */
  transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R>;
  /** Liveness check for the readiness endpoint. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

/** All collections, each with the fields that can be filtered (and are indexed in PostgreSQL). */
export const COLLECTIONS = {
  integration_jobs: ['type', 'status', 'correlationId'],
  idempotency_records: ['operation', 'status'],
  webhook_receipts: ['provider', 'status'],
  audit_events: ['entityType', 'entityId', 'correlationId', 'action'],
  provider_references: ['entityType', 'entityId', 'provider'],
  outbox_messages: ['status', 'topic'],
  dead_letters: ['status', 'topic'],
  payment_batches: ['status', 'rail', 'currency', 'batchRef'],
  payment_instructions: ['batchId', 'status', 'counterpartyExternalId'],
  payment_intents: ['customerExternalId', 'status', 'providerRef'],
  settlements: ['provider', 'status'],
  bank_files: ['direction', 'status', 'checksum'],
  bank_lines: ['fileId', 'status', 'reference'],
  recon_matches: ['bankLineId', 'status'],
  collection_actions: ['invoiceExternalId', 'customerExternalId', 'stage'],
} as const;

export type CollectionName = keyof typeof COLLECTIONS;
