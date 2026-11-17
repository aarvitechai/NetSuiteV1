/**
 * Loads SuiteQL files from netsuite/suiteql/ and binds :named parameters safely.
 *
 * WHY: SuiteTalk's REST SuiteQL endpoint takes a plain query string and has no bind variables. If we
 * glued user input into that string ("... WHERE tranid = '" + input + "'"), an attacker could inject
 * SQL. bindSuiteQL only accepts values whose type we can render safely:
 *   - numbers: must be finite and are rendered as digits;
 *   - dates: must match YYYY-MM-DD exactly;
 *   - strings: single quotes are doubled (the SQL escape rule), and values are length-limited.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export type SuiteQLParam = number | string | { date: string };

const QUERY_DIR = resolve(__dirname, '../../../../netsuite/suiteql');

export class SuiteQLBindError extends Error {}

/** Reads `netsuite/suiteql/<name>.sql`. Only simple names are allowed (no "../" path tricks). */
export function loadSuiteQL(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) throw new SuiteQLBindError(`Invalid query name "${name}"`);
  return readFileSync(resolve(QUERY_DIR, `${name}.sql`), 'utf8');
}

function render(value: SuiteQLParam): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SuiteQLBindError('Number parameter must be finite');
    return String(value);
  }
  if (typeof value === 'object' && 'date' in value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value.date)) throw new SuiteQLBindError('Date must be YYYY-MM-DD');
    return `'${value.date}'`;
  }
  if (typeof value === 'string') {
    if (value.length > 300) throw new SuiteQLBindError('String parameter too long');
    return `'${value.replace(/'/g, "''")}'`;
  }
  throw new SuiteQLBindError('Unsupported parameter type');
}

/**
 * Replaces :name placeholders with safely rendered values.
 * Throws if a placeholder has no value, so a query never runs with a missing filter
 * (which could otherwise return far more data than intended).
 */
export function bindSuiteQL(sql: string, params: Record<string, SuiteQLParam> = {}): string {
  // Strip "-- comment" lines first so placeholders mentioned in comments are not treated as required.
  const body = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return body.replace(/(?<!:):([a-z_][a-z0-9_]*)/gi, (_match, name: string) => {
    if (!(name in params)) throw new SuiteQLBindError(`Missing SuiteQL parameter :${name}`);
    return render(params[name]!);
  });
}
