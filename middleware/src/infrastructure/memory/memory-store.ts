/**
 * In-memory Store, used by tests, the demo and local development (STORAGE_MODE=memory).
 *
 * Data is lost when the process stops. That is fine for learning, and it is why PostgreSQL exists
 * for deployed environments.
 *
 * Entities are deep-copied on the way in and out (structuredClone). WHY: without copying, a caller
 * could change an object after saving it and silently change the "stored" data. The PostgreSQL store
 * cannot behave that way, so the two would behave differently.
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

class MemoryRepository<T extends Entity> implements Repository<T> {
  constructor(
    private readonly data: Data,
    private readonly name: CollectionName,
  ) {}

  private table(): Map<string, unknown> {
    let t = this.data.get(this.name);
    if (!t) this.data.set(this.name, (t = new Map()));
    return t;
  }

  async get(id: string): Promise<T | undefined> {
    const v = this.table().get(id);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async insert(entity: T): Promise<void> {
    if (this.table().has(entity.id)) throw new DuplicateKeyError(this.name, entity.id);
    this.table().set(entity.id, structuredClone(entity));
  }

  async upsert(entity: T): Promise<void> {
    this.table().set(entity.id, structuredClone(entity));
  }

  async delete(id: string): Promise<void> {
    this.table().delete(id);
  }

  async list(
    filter: Partial<Record<string, string | number | boolean>> = {},
    options: { limit?: number } = {},
  ): Promise<T[]> {
    const allowed = COLLECTIONS[this.name] as readonly string[];
    for (const key of Object.keys(filter)) {
      // Same rule as PostgreSQL: only indexed fields can be filtered.
      if (!allowed.includes(key)) throw new Error(`Field "${key}" is not filterable on ${this.name}`);
    }
    const out: T[] = [];
    for (const v of this.table().values()) {
      const e = v as Record<string, unknown>;
      if (Object.entries(filter).every(([k, val]) => e[k] === val)) out.push(structuredClone(v) as T);
      if (options.limit && out.length >= options.limit) break;
    }
    return out;
  }
}

export class MemoryStore implements Store {
  private data: Data = new Map();
  /** Serialises transactions so that two concurrent ones cannot overwrite each other's snapshot. */
  private txChain: Promise<unknown> = Promise.resolve();

  repo<T extends Entity>(collection: CollectionName): Repository<T> {
    return new MemoryRepository<T>(this.data, collection);
  }

  async transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R> {
    // Inside a transaction, a nested transaction() simply joins the outer one (like a DB savepoint-less
    // nested call). Without this, the inner call would wait forever for the outer one to finish.
    const txView: Store = {
      repo: (c) => this.repo(c),
      transaction: (inner) => inner(txView),
      ping: () => this.ping(),
      close: () => this.close(),
    };
    const run = async () => {
      // Snapshot everything; on failure restore it. This gives all-or-nothing behaviour, like a DB rollback.
      const snapshot = structuredClone(this.data);
      try {
        return await fn(txView);
      } catch (err) {
        this.data.clear();
        for (const [k, v] of snapshot) this.data.set(k, v);
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
