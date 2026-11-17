/**
 * PostgreSQL Store (STORAGE_MODE=postgres).
 *
 * DESIGN: each collection is a table with three things:
 *   - id TEXT PRIMARY KEY
 *   - data JSONB (the whole entity)
 *   - created_at / updated_at timestamps
 * Filterable fields get *expression indexes* on data->>'field' (see migrations/001_init.sql).
 *
 * WHY JSONB instead of one column per field: integration metadata changes shape often (a new provider
 * field, for example). JSONB lets entities evolve without a migration for every new optional field,
 * while the indexed fields stay fast to query. The primary key still enforces uniqueness, and that is
 * what idempotency and webhook deduplication rely on.
 *
 * SECURITY: every value goes through a $1, $2 parameter, never through string concatenation. Table and
 * field names come only from the fixed COLLECTIONS list, never from user input.
 */
import pg from 'pg';
import { DuplicateKeyError } from '../../shared/errors';
import {
  COLLECTIONS,
  type CollectionName,
  type Entity,
  type Repository,
  type Store,
} from '../../application/ports/store';

type Queryable = pg.Pool | pg.PoolClient;

/** PostgreSQL error code for unique_violation. */
const UNIQUE_VIOLATION = '23505';

class PgRepository<T extends Entity> implements Repository<T> {
  constructor(
    private readonly db: Queryable,
    private readonly table: CollectionName,
  ) {}

  async get(id: string): Promise<T | undefined> {
    const r = await this.db.query(`SELECT data FROM ${this.table} WHERE id = $1`, [id]);
    return r.rows[0]?.data as T | undefined;
  }

  async insert(entity: T): Promise<void> {
    try {
      await this.db.query(`INSERT INTO ${this.table} (id, data) VALUES ($1, $2)`, [entity.id, entity]);
    } catch (e) {
      if ((e as { code?: string }).code === UNIQUE_VIOLATION)
        throw new DuplicateKeyError(this.table, entity.id);
      throw e;
    }
  }

  async upsert(entity: T): Promise<void> {
    await this.db.query(
      `INSERT INTO ${this.table} (id, data) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
      [entity.id, entity],
    );
  }

  async delete(id: string): Promise<void> {
    await this.db.query(`DELETE FROM ${this.table} WHERE id = $1`, [id]);
  }

  async list(
    filter: Partial<Record<string, string | number | boolean>> = {},
    options: { limit?: number } = {},
  ): Promise<T[]> {
    const allowed = COLLECTIONS[this.table] as readonly string[];
    const clauses: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(filter)) {
      if (!allowed.includes(key)) throw new Error(`Field "${key}" is not filterable on ${this.table}`);
      values.push(String(value));
      // JSONB ->> returns text, so values are compared as text (true → 'true', 5 → '5').
      clauses.push(`data->>'${key}' = $${values.length}`);
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = options.limit ? `LIMIT ${Math.floor(options.limit)}` : '';
    const r = await this.db.query(
      `SELECT data FROM ${this.table} ${where} ORDER BY created_at, id ${limit}`,
      values,
    );
    return r.rows.map((row) => row.data as T);
  }
}

export class PgStore implements Store {
  constructor(
    private readonly db: Queryable,
    private readonly ownsPool = true,
  ) {}

  static fromUrl(url: string): PgStore {
    return new PgStore(new pg.Pool({ connectionString: url, max: 10 }));
  }

  repo<T extends Entity>(collection: CollectionName): Repository<T> {
    return new PgRepository<T>(this.db, collection);
  }

  async transaction<R>(fn: (tx: Store) => Promise<R>): Promise<R> {
    // Already inside a transaction (db is a client, not a pool): join it.
    if (!(this.db instanceof pg.Pool)) return fn(this);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(new PgStore(client, false));
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }

  async close(): Promise<void> {
    if (this.ownsPool && this.db instanceof pg.Pool) await this.db.end();
  }

  /** Runs raw SQL (used only by the migration runner). */
  async exec(sql: string): Promise<void> {
    await this.db.query(sql);
  }
}
