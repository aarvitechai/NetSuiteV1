/**
 * Contract tests for the Store interface.
 *
 * The same test suite runs against every implementation:
 *   - MemoryStore: always.
 *   - PgStore: only when TEST_DATABASE_URL is set (CI provides a PostgreSQL service; locally, run
 *     `docker compose up -d db`).
 * WHY a shared contract suite: it proves the implementations are interchangeable. Code that passes
 * against memory will behave the same against PostgreSQL.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COLLECTIONS, type Store } from '../../src/application/ports/store';
import { migrate } from '../../src/infrastructure/db/migrate';
import { PgStore } from '../../src/infrastructure/db/pg-store';
import { MemoryStore } from '../../src/infrastructure/memory/memory-store';
import { DuplicateKeyError } from '../../src/shared/errors';

type Job = { id: string; type: string; status: string; attempts: number };

function contract(name: string, make: () => Promise<Store>, cleanup?: (s: Store) => Promise<void>) {
  describe(`Store contract: ${name}`, () => {
    let store: Store;
    beforeAll(async () => {
      store = await make();
    });
    afterAll(async () => {
      if (cleanup) await cleanup(store);
      await store.close();
    });

    it('inserts, gets and rejects duplicate ids', async () => {
      const repo = store.repo<Job>('integration_jobs');
      await repo.insert({ id: 'j1', type: 'SYNC', status: 'PENDING', attempts: 0 });
      expect(await repo.get('j1')).toMatchObject({ status: 'PENDING' });
      await expect(
        repo.insert({ id: 'j1', type: 'SYNC', status: 'PENDING', attempts: 0 }),
      ).rejects.toBeInstanceOf(DuplicateKeyError);
    });

    it('filters on indexed fields only', async () => {
      const repo = store.repo<Job>('integration_jobs');
      await repo.upsert({ id: 'j2', type: 'SYNC', status: 'FAILED', attempts: 3 });
      expect((await repo.list({ status: 'FAILED' })).map((j) => j.id)).toEqual(['j2']);
      await expect(repo.list({ attempts: 3 })).rejects.toThrow(/not filterable/);
    });

    it('rolls back every write when a transaction fails', async () => {
      await expect(
        store.transaction(async (tx) => {
          await tx
            .repo<Job>('integration_jobs')
            .insert({ id: 'j3', type: 'SYNC', status: 'PENDING', attempts: 0 });
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await store.repo<Job>('integration_jobs').get('j3')).toBeUndefined();
    });

    it('supports nested transactions without deadlocking', async () => {
      await store.transaction(async (tx) =>
        tx.transaction(async (inner) =>
          inner.repo<Job>('integration_jobs').upsert({ id: 'j4', type: 'X', status: 'OK', attempts: 0 }),
        ),
      );
      expect(await store.repo<Job>('integration_jobs').get('j4')).toBeDefined();
    });

    it('returns copies, not live references', async () => {
      const repo = store.repo<Job>('integration_jobs');
      const j = (await repo.get('j2'))!;
      j.status = 'CHANGED';
      expect((await repo.get('j2'))!.status).toBe('FAILED');
    });
  });
}

contract('memory', async () => new MemoryStore());

const pgUrl = process.env.TEST_DATABASE_URL;
if (pgUrl) {
  contract(
    'postgres',
    async () => {
      const s = PgStore.fromUrl(pgUrl);
      await s.exec(`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`);
      await migrate(pgUrl);
      return s;
    },
    async (s) => (s as PgStore).exec('TRUNCATE integration_jobs'),
  );
} else {
  describe.skip('Store contract: postgres (set TEST_DATABASE_URL to run)', () => {
    it('skipped', () => undefined);
  });
}

describe('migration 001', () => {
  it('creates a table and the indexes for every collection', () => {
    const sql = readFileSync(
      resolve(__dirname, '../../src/infrastructure/db/migrations/001_init.sql'),
      'utf8',
    );
    for (const [table, fields] of Object.entries(COLLECTIONS)) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table} (`);
      for (const f of fields) expect(sql).toContain(`ON ${table} ((data->>'${f}'))`);
    }
  });
});
