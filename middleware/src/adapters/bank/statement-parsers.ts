/**
 * Bank statement parsers: CSV and ISO 20022 camt.053 (XML) → our ParsedStatement.
 *
 * CSV format (our bank's simplified export):
 *   date,description,amount,currency,reference,bank_ref
 *   2026-11-23,"ACH DEBIT VENDOR PAY",-1250.00,USD,110000000000001,BNK00000001
 *
 * camt.053 ("Bank to Customer Statement") is the ISO 20022 XML standard most banks offer. We read:
 *   Stmt/Acct/Id                         account
 *   Stmt/Bal (OPBD, CLBD)                opening and closing booked balance
 *   Stmt/Ntry/Amt[@Ccy], CdtDbtInd       amount and direction (CRDT = in, DBIT = out)
 *   Stmt/Ntry/BookgDt/Dt                 booking date
 *   Stmt/Ntry/AcctSvcrRef                the bank's reference
 *   Ntry/NtryDtls/TxDtls/Refs/EndToEndId the reference WE sent with the payment
 *   Ntry/NtryDtls/TxDtls/RmtInf/Ustrd    free-text description
 *
 * SAFETY
 *  - Amounts are kept as STRINGS (parseTagValue: false). Otherwise the XML parser would turn "0.10"
 *    into a float.
 *  - XML with a DOCTYPE or ENTITY declaration is rejected. Such documents can be used for "billion
 *    laughs" (memory exhaustion) or XXE (reading local files). A bank statement never needs them.
 *  - Integrity check: opening balance + Σ entries must equal the closing balance, or the file is
 *    refused. This catches truncated or corrupted files.
 */
import Decimal from 'decimal.js';
import { XMLParser } from 'fast-xml-parser';

export interface ParsedLine {
  lineNo: number;
  date: string;
  amount: string; // signed (bank perspective)
  currency: string;
  reference?: string;
  bankRef?: string;
  description: string;
}

export interface ParsedStatement {
  format: 'CSV' | 'CAMT053';
  account?: string;
  statementId?: string;
  openingBalance?: string;
  closingBalance?: string;
  lines: ParsedLine[];
}

export class StatementParseError extends Error {
  constructor(message: string) {
    super(`FILE_PARSE_ERROR: ${message}`);
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const AMOUNT = /^-?\d+(\.\d{1,2})?$/;

/** Minimal RFC 4180 CSV line splitter (handles "quoted, fields" and doubled "" quotes). */
export function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

export function parseCsvStatement(content: string): ParsedStatement {
  const rows = content.replace(/\r\n/g, '\n').trim().split('\n');
  const header = splitCsvLine(rows[0] ?? '').map((h) => h.trim().toLowerCase());
  const need = ['date', 'description', 'amount', 'currency', 'reference', 'bank_ref'];
  const missing = need.filter((h) => !header.includes(h));
  if (missing.length) throw new StatementParseError(`CSV header missing ${missing.join(', ')}`);
  const col = (cells: string[], name: string) => (cells[header.indexOf(name)] ?? '').trim();

  const lines = rows
    .slice(1)
    .filter((r) => r.trim())
    .map((row, i) => {
      const cells = splitCsvLine(row);
      const line: ParsedLine = {
        lineNo: i + 1,
        date: col(cells, 'date'),
        amount: col(cells, 'amount'),
        currency: col(cells, 'currency'),
        reference: col(cells, 'reference') || undefined,
        bankRef: col(cells, 'bank_ref') || undefined,
        description: col(cells, 'description'),
      };
      if (!DATE.test(line.date)) throw new StatementParseError(`line ${i + 1}: bad date "${line.date}"`);
      if (!AMOUNT.test(line.amount))
        throw new StatementParseError(`line ${i + 1}: bad amount "${line.amount}"`);
      if (!/^[A-Z]{3}$/.test(line.currency)) throw new StatementParseError(`line ${i + 1}: bad currency`);
      return line;
    });
  return { format: 'CSV', lines };
}

type XmlNode = Record<string, unknown>;
const arr = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v: unknown): string | undefined =>
  v === undefined || v === null
    ? undefined
    : typeof v === 'object'
      ? String((v as XmlNode)['#text'] ?? '')
      : String(v);

export function parseCamt053(xml: string): ParsedStatement {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml))
    throw new StatementParseError('DOCTYPE/ENTITY declarations are not allowed');
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    parseTagValue: false, // keep "1250.00" as a string: money must never become a float
    parseAttributeValue: false,
    removeNSPrefix: true,
    isArray: (name) => ['Ntry', 'Bal', 'TxDtls', 'Stmt'].includes(name),
  });
  let doc: XmlNode;
  try {
    doc = parser.parse(xml) as XmlNode;
  } catch (e) {
    throw new StatementParseError(`invalid XML: ${(e as Error).message}`);
  }
  const stmt = arr(((doc.Document as XmlNode)?.BkToCstmrStmt as XmlNode)?.Stmt as XmlNode[])[0];
  if (!stmt) throw new StatementParseError('not a camt.053 document (Document/BkToCstmrStmt/Stmt missing)');

  const balance = (code: string) => {
    const b = arr(stmt.Bal as XmlNode[]).find(
      (x) => text(((x.Tp as XmlNode)?.CdOrPrtry as XmlNode)?.Cd) === code,
    );
    if (!b) return undefined;
    const amt = new Decimal(text(b.Amt) ?? '0');
    return (text(b.CdtDbtInd) === 'DBIT' ? amt.negated() : amt).toFixed(2);
  };

  const lines = arr(stmt.Ntry as XmlNode[]).map((n, i) => {
    const amtNode = n.Amt as XmlNode;
    const raw = text(amtNode);
    if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) throw new StatementParseError(`entry ${i + 1}: bad amount`);
    const dir = text(n.CdtDbtInd);
    if (dir !== 'CRDT' && dir !== 'DBIT')
      throw new StatementParseError(`entry ${i + 1}: CdtDbtInd must be CRDT or DBIT`);
    const tx = arr(((n.NtryDtls as XmlNode)?.TxDtls as XmlNode[]) ?? [])[0];
    const date = text((n.BookgDt as XmlNode)?.Dt) ?? '';
    if (!DATE.test(date)) throw new StatementParseError(`entry ${i + 1}: bad booking date`);
    return {
      lineNo: i + 1,
      date,
      amount: (dir === 'DBIT' ? new Decimal(raw).negated() : new Decimal(raw)).toFixed(2),
      currency: String(amtNode['@_Ccy'] ?? ''),
      reference: text(((tx?.Refs as XmlNode) ?? {}).EndToEndId) || undefined,
      bankRef: text(n.AcctSvcrRef) || undefined,
      description: text(((tx?.RmtInf as XmlNode) ?? {}).Ustrd) ?? text(n.AddtlNtryInf) ?? '',
    } satisfies ParsedLine;
  });

  const parsed: ParsedStatement = {
    format: 'CAMT053',
    statementId: text(stmt.Id),
    account:
      text(((stmt.Acct as XmlNode)?.Id as XmlNode)?.IBAN) ??
      text((((stmt.Acct as XmlNode)?.Id as XmlNode)?.Othr as XmlNode)?.Id),
    openingBalance: balance('OPBD'),
    closingBalance: balance('CLBD'),
    lines,
  };
  // Integrity: opening + Σ entries must equal closing.
  if (parsed.openingBalance !== undefined && parsed.closingBalance !== undefined) {
    const computed = lines.reduce((s, l) => s.plus(l.amount), new Decimal(parsed.openingBalance));
    if (!computed.equals(parsed.closingBalance)) {
      throw new StatementParseError(
        `balance check failed: opening ${parsed.openingBalance} + entries = ${computed.toFixed(2)}, closing says ${parsed.closingBalance}`,
      );
    }
  }
  return parsed;
}

export function parseStatement(name: string, content: string): ParsedStatement {
  if (name.toLowerCase().endsWith('.xml')) return parseCamt053(content);
  if (name.toLowerCase().endsWith('.csv')) return parseCsvStatement(content);
  throw new StatementParseError(`unsupported statement file ${name}`);
}
