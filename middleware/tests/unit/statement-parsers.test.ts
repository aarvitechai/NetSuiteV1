import { describe, expect, it } from 'vitest';
import {
  parseCamt053,
  parseCsvStatement,
  splitCsvLine,
  StatementParseError,
} from '../../src/adapters/bank/statement-parsers';

const camt = (entries: string, open = '1000.00', close = '750.00') => `<?xml version="1.0"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><Stmt><Id>S1</Id>
<Acct><Id><Othr><Id>ACC-1</Id></Othr></Id></Acct>
<Bal><Tp><CdOrPrtry><Cd>OPBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">${open}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
<Bal><Tp><CdOrPrtry><Cd>CLBD</Cd></CdOrPrtry></Tp><Amt Ccy="USD">${close}</Amt><CdtDbtInd>CRDT</CdtDbtInd></Bal>
${entries}</Stmt></BkToCstmrStmt></Document>`;

const ntry = (amt: string, dir: 'CRDT' | 'DBIT', ref?: string) =>
  `<Ntry><Amt Ccy="USD">${amt}</Amt><CdtDbtInd>${dir}</CdtDbtInd><BookgDt><Dt>2026-11-23</Dt></BookgDt><AcctSvcrRef>B-${amt}</AcctSvcrRef><NtryDtls><TxDtls>${ref ? `<Refs><EndToEndId>${ref}</EndToEndId></Refs>` : ''}<RmtInf><Ustrd>desc ${amt}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`;

describe('CSV statements', () => {
  it('parses quoted fields and keeps amounts as strings', () => {
    expect(splitCsvLine('a,"b, c","d ""q"""')).toEqual(['a', 'b, c', 'd "q"']);
    const s = parseCsvStatement(
      'date,description,amount,currency,reference,bank_ref\n2026-11-23,"PAYOUT, SIMPAY",3786.30,USD,po_1,BNK1\n2026-11-23,FEE,-25.00,USD,,BNK2\n',
    );
    expect(s.lines).toEqual([
      {
        lineNo: 1,
        date: '2026-11-23',
        description: 'PAYOUT, SIMPAY',
        amount: '3786.30',
        currency: 'USD',
        reference: 'po_1',
        bankRef: 'BNK1',
      },
      {
        lineNo: 2,
        date: '2026-11-23',
        description: 'FEE',
        amount: '-25.00',
        currency: 'USD',
        reference: undefined,
        bankRef: 'BNK2',
      },
    ]);
  });

  it('rejects bad headers and values', () => {
    expect(() => parseCsvStatement('foo,bar\n1,2')).toThrow(StatementParseError);
    expect(() =>
      parseCsvStatement('date,description,amount,currency,reference,bank_ref\n23/11/2026,x,1,USD,,'),
    ).toThrow(/bad date/);
    expect(() =>
      parseCsvStatement('date,description,amount,currency,reference,bank_ref\n2026-11-23,x,1.234,USD,,'),
    ).toThrow(/bad amount/);
  });
});

describe('camt.053 statements', () => {
  it('parses entries, signs debits negative, reads references and balances', () => {
    const s = parseCamt053(camt(ntry('250.00', 'DBIT', 'TRACE1')));
    expect(s).toMatchObject({
      format: 'CAMT053',
      statementId: 'S1',
      account: 'ACC-1',
      openingBalance: '1000.00',
      closingBalance: '750.00',
    });
    expect(s.lines[0]).toMatchObject({
      amount: '-250.00',
      currency: 'USD',
      reference: 'TRACE1',
      bankRef: 'B-250.00',
      description: 'desc 250.00',
    });
  });

  it('keeps decimal precision exactly (no float conversion)', () => {
    const s = parseCamt053(camt(ntry('0.10', 'CRDT') + ntry('0.20', 'CRDT'), '0.00', '0.30'));
    expect(s.lines.map((l) => l.amount)).toEqual(['0.10', '0.20']);
  });

  it('rejects a statement whose balances do not add up (truncated/corrupted file)', () => {
    expect(() => parseCamt053(camt(ntry('250.00', 'DBIT'), '1000.00', '700.00'))).toThrow(
      /balance check failed/,
    );
  });

  it('rejects DOCTYPE/ENTITY (XXE and billion-laughs protection)', () => {
    const evil = `<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><Document></Document>`;
    expect(() => parseCamt053(evil)).toThrow(/DOCTYPE/);
  });

  it('rejects documents that are not camt.053', () => {
    expect(() => parseCamt053('<Document><Other/></Document>')).toThrow(/not a camt.053/);
  });
});
