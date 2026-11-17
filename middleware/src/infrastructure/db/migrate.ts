/**
 * Minimal migration runner: applies every migrations/NNN_*.sql file once, in order.
 *
 * WHY: a database schema must evolve in a controlled, repeatable way, identical in dev, staging and
 * production. Each file is applied inside a transaction and recorded in schema_migrations, so
 * re-running is safe (already-applied files are skipped).
 *
 * Usage: DATABASE_URL=postgres://... npm run db:migrate
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import pg from 'pg';

const DIR = resolve(__dirname, 'migrations');

export async function migrate(
  databaseUrl: string,
  log: (msg: string) => void = () => undefined,
): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())',
    );
    const done = new Set(
      (await client.query('SELECT version FROM schema_migrations')).rows.map((r) => r.version as string),
    );
    for (const file of readdirSync(DIR)
      .filter((f) => /^\d{3}_.+\.sql$/.test(f))
      .sort()) {
      if (done.has(file)) continue;
      await client.query('BEGIN');
      try {
        await client.query(readFileSync(resolve(DIR, file), 'utf8'));
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
        log(`applied ${file}`);
      } catch (e) {
        await client.query('ROLLBACK');
        // `cause` keeps the original database error (and its stack) attached for debugging.
        throw new Error(`Migration ${file} failed: ${(e as Error).message}`, { cause: e });
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

// Run directly from the command line (not when imported by tests).
if (require.main === module) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }
  migrate(url, (m) => console.warn(m)).then(
    (applied) => console.warn(applied.length ? `Done (${applied.length} applied)` : 'Already up to date'),
    (e) => {
      console.error(e);
      process.exit(1);
    },
  );
}
