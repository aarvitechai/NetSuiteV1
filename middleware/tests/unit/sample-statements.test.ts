/** The committed sample files must always parse. They double as documentation of the formats. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStatement } from '../../src/adapters/bank/statement-parsers';

const dir = resolve(__dirname, '../../../test-data/bank');

describe('sample bank statements', () => {
  it('CSV sample parses into 6 lines', () => {
    expect(
      parseStatement('s.csv', readFileSync(resolve(dir, 'statement-sample.csv'), 'utf8')).lines,
    ).toHaveLength(6);
  });
  it('camt.053 sample parses and passes the balance check', () => {
    const s = parseStatement('s.xml', readFileSync(resolve(dir, 'camt053-sample.xml'), 'utf8'));
    expect(s).toMatchObject({ openingBalance: '100000.00', closingBalance: '102030.80' });
    expect(s.lines.map((l) => l.amount)).toEqual(['-1250.00', '-480.50', '3786.30', '-25.00']);
  });
});
