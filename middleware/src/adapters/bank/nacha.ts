/**
 * NACHA (ACH) file generator and validator.
 *
 * ⚠️ LEARNING IMPLEMENTATION. It follows the published NACHA record layout for a CCD credit file, but
 * every bank adds its own rules (immediate origin value, cut-off times, file ID rules, prenotes…).
 * Always validate against YOUR bank's specification and their test-file service. Never send real files
 * from this project.
 *
 * FILE STRUCTURE: fixed-width text, every line exactly 94 characters:
 *   1  File Header
 *     5  Batch Header      (one per batch: company, SEC code, effective date)
 *       6  Entry Detail    (one per payment: bank, account, amount, payee)
 *     8  Batch Control     (counts, hash and totals for the batch)
 *   9  File Control        (counts, hash and totals for the file)
 *   9999…                  (lines of nines pad the file to a multiple of 10 lines = full "blocks")
 *
 * WHY CONTROL TOTALS: the bank recomputes counts, the entry hash and the dollar totals. If a line was
 * lost or corrupted in transit, the totals no longer match and the bank rejects the file instead of
 * paying the wrong amounts.
 */
import Decimal from 'decimal.js';

export const RECORD_LENGTH = 94;

export interface NachaEntry {
  routingNumber: string; // receiving bank, 9 digits
  accountNumber: string; // receiving account (from the vault, never stored by us)
  amountCents: string; // integer string, e.g. "125000"
  individualId: string; // our reference for the payee (vendor externalId)
  individualName: string;
  traceSequence: number; // 1..9999999 within the file
  /** 22 = checking credit (deposit). We only send credits (paying vendors). */
  transactionCode?: '22' | '32';
}

export interface NachaFileInput {
  immediateDestination: string; // the bank's routing number (9 digits)
  immediateDestinationName: string;
  immediateOrigin: string; // usually the company ID (10 chars)
  immediateOriginName: string;
  companyName: string;
  companyId: string; // 10 chars
  originatingDfi: string; // our bank's routing number (9 digits); its first 8 digits are used
  entryDescription: string; // e.g. "VENDOR PAY"
  effectiveDate: string; // YYYY-MM-DD
  createdAt: Date;
  fileIdModifier?: string; // A-Z, 0-9: distinguishes several files sent on the same day
  batchNumber?: number;
  referenceCode?: string;
  entries: NachaEntry[];
}

/** Only uppercase letters, digits and a few symbols are safe in NACHA alphanumeric fields. */
export function sanitize(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[^\x20-\x7E]/g, '') // drop accents and non-ASCII
    .toUpperCase()
    .replace(/[^A-Z0-9 &.,/'()-]/g, ' ');
}

const alpha = (v: string, len: number) => sanitize(v).slice(0, len).padEnd(len, ' ');
const num = (v: string | number, len: number) => {
  const s = String(v);
  if (!/^\d+$/.test(s)) throw new Error(`NACHA numeric field must be digits, got "${s}"`);
  if (s.length > len) throw new Error(`NACHA numeric value ${s} does not fit in ${len} digits`);
  return s.padStart(len, '0');
};
const yymmdd = (iso: string) => iso.slice(2, 4) + iso.slice(5, 7) + iso.slice(8, 10);

/**
 * ABA routing number check digit: weights 3,7,1 repeating, and the sum must be a multiple of 10.
 * WHY validate: a mistyped routing number is the most common cause of ACH rejects. Catching it before
 * sending saves a day of delay.
 */
export function isValidRoutingNumber(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  const sum = routing.split('').reduce((s, d, i) => s + Number(d) * w[i]!, 0);
  return sum % 10 === 0;
}

/** Entry hash: the sum of the 8-digit receiving DFI IDs, keeping only the last 10 digits. */
function entryHash(entries: NachaEntry[]): string {
  const total = entries.reduce((s, e) => s + BigInt(e.routingNumber.slice(0, 8)), 0n);
  return total.toString().slice(-10).padStart(10, '0');
}

export function buildNachaFile(input: NachaFileInput): string {
  if (!input.entries.length) throw new Error('A NACHA file needs at least one entry');
  for (const e of input.entries) {
    if (!isValidRoutingNumber(e.routingNumber))
      throw new Error(`Invalid routing number for ${e.individualId}`);
    if (!/^\d{1,17}$/.test(e.accountNumber)) throw new Error(`Invalid account number for ${e.individualId}`);
  }
  const odfi8 = input.originatingDfi.slice(0, 8);
  const batchNo = input.batchNumber ?? 1;
  const created = input.createdAt.toISOString();
  const serviceClass = '220'; // 220 = credits only

  const lines: string[] = [];

  // 1 — File Header
  lines.push(
    '1' +
      '01' + // priority code
      ' ' +
      num(input.immediateDestination, 9) +
      alpha(input.immediateOrigin, 10) +
      yymmdd(created) +
      created.slice(11, 13) +
      created.slice(14, 16) + // HHMM
      alpha(input.fileIdModifier ?? 'A', 1) +
      '094' + // record size
      '10' + // blocking factor
      '1' + // format code
      alpha(input.immediateDestinationName, 23) +
      alpha(input.immediateOriginName, 23) +
      alpha(input.referenceCode ?? '', 8),
  );

  // 5 — Batch Header
  lines.push(
    '5' +
      serviceClass +
      alpha(input.companyName, 16) +
      alpha('', 20) + // company discretionary data
      alpha(input.companyId, 10) +
      'CCD' + // SEC code: Corporate Credit or Debit (business-to-business)
      alpha(input.entryDescription, 10) +
      alpha('', 6) + // company descriptive date
      yymmdd(input.effectiveDate) +
      '   ' + // settlement date: filled in by the bank
      '1' + // originator status code
      num(odfi8, 8) +
      num(batchNo, 7),
  );

  // 6 — Entry Detail records
  let totalCredit = new Decimal(0);
  for (const e of input.entries) {
    totalCredit = totalCredit.plus(e.amountCents);
    lines.push(
      '6' +
        (e.transactionCode ?? '22') +
        num(e.routingNumber.slice(0, 8), 8) +
        e.routingNumber[8] + // check digit
        alpha(e.accountNumber, 17) +
        num(e.amountCents, 10) +
        alpha(e.individualId, 15) +
        alpha(e.individualName, 22) +
        '  ' + // discretionary data
        '0' + // no addenda record
        num(odfi8, 8) +
        num(e.traceSequence, 7),
    );
  }

  const count = input.entries.length;
  const hash = entryHash(input.entries);
  const credit = num(totalCredit.toFixed(0), 12);

  // 8 — Batch Control
  lines.push(
    '8' +
      serviceClass +
      num(count, 6) +
      hash +
      num(0, 12) +
      credit +
      alpha(input.companyId, 10) +
      ' '.repeat(19) +
      ' '.repeat(6) +
      num(odfi8, 8) +
      num(batchNo, 7),
  );

  // 9 — File Control. Block count = number of 10-line blocks after padding.
  const recordCount = lines.length + 1;
  const blocks = Math.ceil(recordCount / 10);
  lines.push('9' + num(1, 6) + num(blocks, 6) + num(count, 8) + hash + num(0, 12) + credit + ' '.repeat(39));

  // Padding with lines of 9s to complete the last block.
  while (lines.length % 10 !== 0) lines.push('9'.repeat(RECORD_LENGTH));

  for (const l of lines)
    if (l.length !== RECORD_LENGTH) throw new Error(`Internal error: record length ${l.length}`);
  return lines.join('\n') + '\n';
}

export interface ParsedNacha {
  entries: {
    traceNumber: string;
    routing: string;
    amountCents: string;
    individualId: string;
    name: string;
  }[];
  totalCreditCents: string;
  effectiveDate: string;
}

/**
 * Validates structure and control totals: what the bank checks first. Returns the problems found
 * (an empty list means the file is valid) plus the parsed entries. The bank simulator uses this.
 */
export function validateNacha(content: string): { errors: string[]; parsed?: ParsedNacha } {
  const errors: string[] = [];
  const lines = content.split('\n').filter((l) => l.length > 0);
  lines.forEach((l, i) => {
    if (l.length !== RECORD_LENGTH) errors.push(`line ${i + 1}: length ${l.length}, expected 94`);
  });
  if (lines.length % 10 !== 0) errors.push('file is not padded to a multiple of 10 records');
  if (lines[0]?.[0] !== '1') errors.push('first record must be a File Header (1)');

  const entries = lines.filter((l) => l[0] === '6');
  const batchControl = lines.find((l) => l[0] === '8');
  const fileControl = lines.find((l) => l[0] === '9' && !/^9+$/.test(l));
  const batchHeader = lines.find((l) => l[0] === '5');
  if (!batchHeader || !batchControl || !fileControl) {
    errors.push('missing batch header, batch control or file control record');
    return { errors };
  }

  const sumCents = entries.reduce((s, l) => s + BigInt(l.slice(29, 39)), 0n);
  const hash = entries
    .reduce((s, l) => s + BigInt(l.slice(3, 11)), 0n)
    .toString()
    .slice(-10)
    .padStart(10, '0');
  if (Number(batchControl.slice(4, 10)) !== entries.length) errors.push('batch control entry count mismatch');
  if (batchControl.slice(10, 20) !== hash) errors.push('batch control entry hash mismatch');
  if (BigInt(batchControl.slice(32, 44)) !== sumCents) errors.push('batch control credit total mismatch');
  if (Number(fileControl.slice(13, 21)) !== entries.length) errors.push('file control entry count mismatch');
  if (BigInt(fileControl.slice(43, 55)) !== sumCents) errors.push('file control credit total mismatch');
  if (Number(fileControl.slice(7, 13)) !== lines.length / 10)
    errors.push('file control block count mismatch');
  for (const l of entries) {
    if (!isValidRoutingNumber(l.slice(3, 12)))
      errors.push(`entry ${l.slice(79, 94)}: invalid routing check digit`);
  }

  const eff = batchHeader.slice(69, 75);
  return {
    errors,
    parsed: {
      entries: entries.map((l) => ({
        traceNumber: l.slice(79, 94),
        routing: l.slice(3, 12),
        amountCents: String(Number(l.slice(29, 39))),
        individualId: l.slice(39, 54).trim(),
        name: l.slice(54, 76).trim(),
      })),
      totalCreditCents: sumCents.toString(),
      effectiveDate: `20${eff.slice(0, 2)}-${eff.slice(2, 4)}-${eff.slice(4, 6)}`,
    },
  };
}
