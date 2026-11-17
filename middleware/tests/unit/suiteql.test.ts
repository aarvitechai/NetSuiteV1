import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { bindSuiteQL, loadSuiteQL, SuiteQLBindError } from '../../src/adapters/netsuite/suiteql';

const DIR = resolve(__dirname, '../../../netsuite/suiteql');

describe('bindSuiteQL', () => {
  it('binds dates, numbers and escaped strings', () => {
    const sql = bindSuiteQL('SELECT id FROM t WHERE d <= :d AND n = :n AND s = :s', {
      d: { date: '2026-11-20' },
      n: 5,
      s: "O'Brien",
    });
    expect(sql).toBe("SELECT id FROM t WHERE d <= '2026-11-20' AND n = 5 AND s = 'O''Brien'");
  });

  it('neutralises an injection attempt', () => {
    const sql = bindSuiteQL('SELECT id FROM t WHERE s = :s', { s: "x' OR '1'='1" });
    expect(sql).toBe("SELECT id FROM t WHERE s = 'x'' OR ''1''=''1'");
  });

  it('rejects malformed dates and missing params', () => {
    expect(() => bindSuiteQL('WHERE d = :d', { d: { date: '20/11/2026' } })).toThrow(SuiteQLBindError);
    expect(() => bindSuiteQL('WHERE d = :d')).toThrow(/Missing SuiteQL parameter :d/);
  });

  it('refuses path traversal in query names', () => {
    expect(() => loadSuiteQL('../secrets')).toThrow(SuiteQLBindError);
  });
});

describe('SuiteQL library conventions', () => {
  const files = readdirSync(DIR).filter((f) => f.endsWith('.sql'));

  it.each(files)('%s has a header, no SELECT *, and binds cleanly', (file) => {
    const sql = readFileSync(resolve(DIR, file), 'utf8');
    expect(sql).toMatch(/^-- name: /);
    expect(sql).toMatch(/^-- purpose: /m);
    expect(sql).not.toMatch(/select\s+\*/i);
    // Every placeholder must be bindable with dummy values.
    const names = [...sql.matchAll(/(?<!:):([a-z_]+)/g)].map((m) => m[1]!);
    const params = Object.fromEntries(
      names.map((n) => [n, n.includes('date') || n === 'due_by' ? { date: '2026-01-01' } : 'x']),
    );
    expect(() => bindSuiteQL(loadSuiteQL(file.replace('.sql', '')), params)).not.toThrow();
  });
});
