/**
 * ⚠️ BANK SIMULATOR: plays the role of Northstar's bank on the other side of the SFTP folder.
 *
 * What a real bank does, and what this simulator imitates:
 *   1. pickUp(): picks up payment files from `outbound/`, validates them (for NACHA: structure and
 *      control totals), and writes an ACKNOWLEDGEMENT to `inbound/`, accepting or rejecting the file
 *      and each entry.
 *   2. settle(): a day or two later, reports each accepted entry as SETTLED, or RETURNED with an ACH
 *      return code such as R01 (insufficient funds) or R03 (no account).
 *   3. statement(): writes an end-of-day bank statement (CSV or camt.053 XML) with the money that actually
 *      moved. Used by reconciliation (Phase 10).
 *
 * Behaviour is configurable, so tests and demos can trigger every failure path on purpose.
 */
import { validateNacha } from '../../middleware/src/adapters/bank/nacha';
import type { AckFile, StatusFile } from '../../middleware/src/adapters/bank/payment-files';
import type { FileTransport } from '../../middleware/src/infrastructure/files/file-transport';

export interface BankBehaviour {
  /** Reject the whole file (for example simulating a bad file header). */
  rejectFile?: boolean;
  /** Payee IDs (vendor externalIds) whose entries are rejected at acknowledgement time. */
  rejectPayees?: string[];
  /** Payee IDs whose payments settle, then come back with the given return code. */
  returnPayees?: Record<string, string>;
}

export interface ReceivedEntry {
  batchRef: string;
  ref: string; // trace number (ACH) or instruction ID (wire/vcard)
  payee: string;
  amount: string; // decimal string
  currency: string;
  status: 'ACCEPTED' | 'REJECTED' | 'SETTLED' | 'RETURNED';
  returnCode?: string;
  bankRef?: string;
  settledOn?: string;
}

export class BankSimulator {
  /** Everything the "bank" knows about, in memory. */
  readonly entries: ReceivedEntry[] = [];
  private seq = 1;

  constructor(
    private readonly files: FileTransport,
    public behaviour: BankBehaviour = {},
  ) {}

  private batchRefFromName(name: string): string {
    return name.replace(/^NSD_/, '').split('.')[0]!;
  }

  /** Step 1: take outbound files, validate them, and write ACK files. Returns the ACKs written. */
  async pickUp(): Promise<AckFile[]> {
    const acks: AckFile[] = [];
    for (const name of await this.files.list('outbound')) {
      const content = await this.files.get('outbound', name);
      await this.files.move('outbound', name, 'bank/received');
      const batchRef = this.batchRefFromName(name);
      const parsed = this.parse(name, content);

      const fileRejected = this.behaviour.rejectFile || parsed.errors.length > 0;
      const ack: AckFile = {
        type: 'ACK',
        fileName: name,
        batchRef,
        status: fileRejected ? 'REJECTED' : 'ACCEPTED',
        reason: fileRejected ? parsed.errors.join('; ') || 'File rejected by bank (simulated)' : undefined,
        entries: parsed.entries.map((e) => {
          const rejected = fileRejected || (this.behaviour.rejectPayees ?? []).includes(e.payee);
          this.entries.push({
            batchRef,
            ref: e.ref,
            payee: e.payee,
            amount: e.amount,
            currency: e.currency,
            status: rejected ? 'REJECTED' : 'ACCEPTED',
          });
          return {
            ref: e.ref,
            status: rejected ? 'REJECTED' : 'ACCEPTED',
            reason: rejected ? 'R03 No account/unable to locate (simulated)' : undefined,
          };
        }),
      };
      await this.files.put('inbound', `ACK_${batchRef}.json`, JSON.stringify(ack, null, 2));
      acks.push(ack);
    }
    return acks;
  }

  private parse(
    name: string,
    content: string,
  ): { errors: string[]; entries: { ref: string; payee: string; amount: string; currency: string }[] } {
    if (name.endsWith('.ach')) {
      const { errors, parsed } = validateNacha(content);
      return {
        errors,
        entries: (parsed?.entries ?? []).map((e) => ({
          ref: e.traceNumber,
          payee: e.individualId,
          amount: (Number(e.amountCents) / 100).toFixed(2),
          currency: 'USD',
        })),
      };
    }
    if (name.endsWith('.wire.csv')) {
      const [, ...rows] = content.trim().split('\n');
      return {
        errors: [],
        entries: rows
          .map((r) => r.split(','))
          .map((c) => ({ ref: c[1]!, payee: c[2]!, amount: c[5]!, currency: c[6]! })),
      };
    }
    if (name.endsWith('.vcard.jsonl')) {
      return {
        errors: [],
        entries: content
          .trim()
          .split('\n')
          .map(
            (l) =>
              JSON.parse(l) as { instructionId: string; vendorId: string; amount: string; currency: string },
          )
          .map((j) => ({ ref: j.instructionId, payee: j.vendorId, amount: j.amount, currency: j.currency })),
      };
    }
    return { errors: [`unsupported file type ${name}`], entries: [] };
  }

  private async writeStatus(
    kind: string,
    date: string,
    groups: Map<string, ReceivedEntry[]>,
    toEvent: (e: ReceivedEntry) => StatusFile['events'][number],
  ) {
    const out: StatusFile[] = [];
    for (const [batchRef, entries] of groups) {
      const file: StatusFile = { type: 'PAYMENT_STATUS', batchRef, events: entries.map(toEvent) };
      await this.files.put('inbound', `${kind}_${batchRef}_${date}.json`, JSON.stringify(file, null, 2));
      out.push(file);
    }
    return out;
  }

  private group(entries: ReceivedEntry[]): Map<string, ReceivedEntry[]> {
    const m = new Map<string, ReceivedEntry[]>();
    for (const e of entries) m.set(e.batchRef, [...(m.get(e.batchRef) ?? []), e]);
    return m;
  }

  /** Step 2: money moves. Every accepted entry is SETTLED, and a PAYMENT_STATUS file is written per batch. */
  async settle(effectiveDate: string): Promise<StatusFile[]> {
    const accepted = this.entries.filter((x) => x.status === 'ACCEPTED');
    for (const e of accepted) {
      e.status = 'SETTLED';
      e.bankRef = `BNK${String(this.seq++).padStart(8, '0')}`;
      e.settledOn = effectiveDate;
    }
    return this.writeStatus('STATUS', effectiveDate, this.group(accepted), (e) => ({
      ref: e.ref,
      status: 'SETTLED',
      effectiveDate,
      bankRef: e.bankRef!,
    }));
  }

  /** Entries already reported on a statement (each money movement is reported exactly once). */
  private statemented = new Set<string>();
  private balance = '100000.00';

  /**
   * Step 3: end-of-day bank statement, written to inbound/ as CSV or camt.053 XML. It contains:
   *   - one DEBIT per settled payment (or, with aggregateAch, ONE debit per batch, which exercises one-to-many);
   *   - one CREDIT per returned payment (the money came back);
   *   - any extra lines (provider payouts, bank fees…) passed in by the caller.
   */
  async statement(
    date: string,
    opts: {
      format?: 'csv' | 'camt053';
      aggregateAch?: boolean;
      extra?: {
        amount: string;
        currency?: string;
        reference?: string;
        bankRef?: string;
        description: string;
      }[];
    } = {},
  ): Promise<{ name: string; content: string }> {
    type Line = {
      amount: string;
      currency: string;
      reference?: string;
      bankRef: string;
      description: string;
    };
    const out: Line[] = [];
    const settled = this.entries.filter(
      (e) => (e.status === 'SETTLED' || e.status === 'RETURNED') && !this.statemented.has(`${e.ref}:debit`),
    );
    if (opts.aggregateAch) {
      for (const [batchRef, group] of this.group(settled)) {
        const total = group.reduce((s, e) => s + Math.round(Number(e.amount) * 100), 0);
        out.push({
          amount: (-total / 100).toFixed(2),
          currency: group[0]!.currency,
          reference: batchRef,
          bankRef: `BNKB${batchRef.slice(-8)}`,
          description: `ACH BATCH ${batchRef}`,
        });
      }
    } else {
      for (const e of settled)
        out.push({
          amount: `-${e.amount}`,
          currency: e.currency,
          reference: e.ref,
          bankRef: e.bankRef!,
          description: `ACH CREDIT ${e.payee}`,
        });
    }
    settled.forEach((e) => this.statemented.add(`${e.ref}:debit`));
    for (const e of this.entries.filter(
      (x) => x.status === 'RETURNED' && !this.statemented.has(`${x.ref}:return`),
    )) {
      out.push({
        amount: e.amount,
        currency: e.currency,
        reference: e.ref,
        bankRef: `${e.bankRef}R`,
        description: `ACH RETURN ${e.returnCode} ${e.payee}`,
      });
      this.statemented.add(`${e.ref}:return`);
    }
    let seq = 1;
    for (const x of opts.extra ?? [])
      out.push({
        amount: x.amount,
        currency: x.currency ?? 'USD',
        reference: x.reference,
        bankRef: x.bankRef ?? `BNKX${date.replace(/-/g, '')}${seq++}`,
        description: x.description,
      });

    const opening = this.balance;
    const closing = out.reduce(
      (s, l) => s + Math.round(Number(l.amount) * 100),
      Math.round(Number(opening) * 100),
    );
    this.balance = (closing / 100).toFixed(2);

    const csvCell = (v: string) => (/[",]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    if ((opts.format ?? 'csv') === 'csv') {
      const content =
        [
          'date,description,amount,currency,reference,bank_ref',
          ...out.map((l) =>
            [date, l.description, l.amount, l.currency, l.reference ?? '', l.bankRef].map(csvCell).join(','),
          ),
        ].join('\n') + '\n';
      const name = `STMT_${date}.csv`;
      await this.files.put('inbound', name, content);
      return { name, content };
    }
    const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const bal = (code: string, amount: string) =>
      `<Bal><Tp><CdOrPrtry><Cd>${code}</Cd></CdOrPrtry></Tp><Amt Ccy="USD">${Math.abs(Number(amount)).toFixed(2)}</Amt><CdtDbtInd>${Number(amount) < 0 ? 'DBIT' : 'CRDT'}</CdtDbtInd><Dt><Dt>${date}</Dt></Dt></Bal>`;
    const entries = out
      .map(
        (l) =>
          `<Ntry><Amt Ccy="${l.currency}">${Math.abs(Number(l.amount)).toFixed(2)}</Amt><CdtDbtInd>${l.amount.startsWith('-') ? 'DBIT' : 'CRDT'}</CdtDbtInd><Sts><Cd>BOOK</Cd></Sts><BookgDt><Dt>${date}</Dt></BookgDt><ValDt><Dt>${date}</Dt></ValDt><AcctSvcrRef>${esc(l.bankRef)}</AcctSvcrRef><NtryDtls><TxDtls>${l.reference ? `<Refs><EndToEndId>${esc(l.reference)}</EndToEndId></Refs>` : ''}<RmtInf><Ustrd>${esc(l.description)}</Ustrd></RmtInf></TxDtls></NtryDtls></Ntry>`,
      )
      .join('');
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:camt.053.001.08"><BkToCstmrStmt><GrpHdr><MsgId>SIM-${date}</MsgId><CreDtTm>${date}T23:59:00Z</CreDtTm></GrpHdr><Stmt><Id>STMT-${date}</Id><Acct><Id><Othr><Id>NSD-OPERATING-001</Id></Othr></Id><Ccy>USD</Ccy></Acct>${bal('OPBD', opening)}${bal('CLBD', this.balance)}${entries}</Stmt></BkToCstmrStmt></Document>
`;
    const name = `STMT_${date}.xml`;
    await this.files.put('inbound', name, content);
    return { name, content };
  }

  /**
   * Step 2b: some settled ACH payments come back days later (behaviour.returnPayees), for example
   * R01 insufficient funds or R03 no account. This exercises the reversal path in NetSuite.
   */
  async sendReturns(returnDate: string): Promise<StatusFile[]> {
    const codes = this.behaviour.returnPayees ?? {};
    const returning = this.entries.filter((e) => e.status === 'SETTLED' && codes[e.payee]);
    for (const e of returning) {
      e.status = 'RETURNED';
      e.returnCode = codes[e.payee];
    }
    return this.writeStatus('RETURN', returnDate, this.group(returning), (e) => ({
      ref: e.ref,
      status: 'RETURNED',
      returnCode: e.returnCode,
      effectiveDate: returnDate,
      bankRef: e.bankRef!,
    }));
  }
}
