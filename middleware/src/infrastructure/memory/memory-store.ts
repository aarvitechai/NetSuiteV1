/**
 * In-memory Store, used by tests, the demo and local development (STORAGE_MODE=memory).
 *
 * Data is lost when the process stops. That is fine for learning, and it is why PostgreSQL exists
 * for deployed environments.
 *
 * Entities are deep-copied on the way in and out (structuredClone). WHY: without copying, a caller
 * could change an object after saving it and silently change the "stored" data. The PostgreSQL store
 * cannot behave that way, so the two would behave differently.
 *
 * TRANSACTIONS use an UNDO LOG: before a write inside a transaction changes a key, we remember that
 * key's previous value. On failure the remembered values are restored in reverse order. The cost is
 * proportional to what the transaction CHANGED.
 * (An earlier version deep-copied the WHOLE store per transaction. The load test showed that grows
 * with data volume, and limited AR payments to about 10/s. See docs/performance/report.md.)
 */
import { DuplicateKeyError } from '../../shared/errors';
import {
  COLLECTIONS,
  type CollectionName,
  type Entity,
  type Repository,
  type Store,
} from '../../application/ports/store';

type Data = Map<CollectionName, Map<string, unknown>>;
type UndoLog = (() => void)[];

class MemoryRepository<T extends Entity> implements Repository<T> {
  constructor(
    private readonly data: Data,
    private readonly name: CollectionName,
    /** Present only for repositories handed out INSIDE a transaction. */
    private readonly undo?: UndoLog,
  ) {}

  private table(): Map<string, unknown> {
    let t = this.data.get(this.name);
    if (!t) this.data.set(this.name, (t = new Map()));
    return t;
  }

  /** Remembers how to restore `id` to its current state, if we are inside a transaction. */
  private remember(id: string): void {
    if (!this.undo) return;
    const table = this.table();
    const had = table.has(id);
    const previous = table.get(id); // stored values are never mutated in place, so no copy is needed
    this.undo.push(() => (had ? table.set(id, previous) : table.delete(id)));
  }

  async get(id: string): Promise<T | undefined> {
    const v = this.table().get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async insert(entity: T): Promise<void> {
    if (this.table().has(entity.id)) throw new DuplicateKeyError(this.name, entity.id);
    this.remember(entity.id);
    this.table().set(entity.id, structuredClone(entity));
  }

  async upsert(entity: T): Promise<void> {
    this.remember(entity.id);
    this.table().set(entity.id, structuredClone(entity));
  }

  async delete(id: string): Promise<void> {
    this.remember(id);
    this.table().delete(id);
  }

  async list(
    filter: Partial<Record<string, string | number | boolean>> = {},
    options: { limit?: number } = {},
  ): Promise<T[]> {
    const allowed = COLLECTIONS[this.name] as readonly string[];
    const entries = Object.entries(filter);
    for (const [key] of entries) {
      // Same rule as PostgreSQL: only indexed fields can be filtered.
      if (!allowed.includes(key)) throw new Error(`Field "${key}" is not filterable on ${this.name}`);
    }
    const out: T[] = [];
    for (const v of this.table().values()) {
      const e = v as Record<string, unknown>;
      if (entries.every(([k, val]) => e[k] === val)) out.push(structuredClone(v) as T);
      if (options.limit && out.length >= options.limit) break;
    }
    return out;
  }
}

export class MemoryStore implements Store {
  private data: Data = new Map();
  /** Serialises transactions so that two concurrent ones cannot interleave their changes. */
  private txChain: Promise<unknown> = Promise.resolve();

  repo<T extends Entity>(collection: CollectionName): Repository<T> {
    return new MemoryRepository<T>(this.data, collection);
  }

  async transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R> {
    const run = async () => {
      const undo: UndoLog = [];
      // Inside a transaction, a nested transaction() simply joins the outer one (no savepoints).
      // Without this, the inner call would wait forever for the outer one to finish.
      const txView: Store = {
        repo: <T extends Entity>(c: CollectionName) => new MemoryRepository<T>(this.data, c, undo),
        transaction: (inner) => inner(txView),
        ping: () => this.ping(),
        close: () => this.close(),
      };
      try {
        return await fn(txView);
      } catch (err) {
        // Roll back: undo every change made through this transaction, newest first.
        for (let i = undo.length - 1; i >= 0; i--) undo[i]!();
        throw err;
      }
    };
    const result = this.txChain.then(run, run);
    this.txChain = result.catch(() => undefined);
    return result;
  }

  async ping(): Promise<void> {}
  async close(): Promise<void> {}
}
