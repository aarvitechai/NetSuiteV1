/**
 * Builds the outbound payment file for a batch, by payment rail, and defines the bank's response formats.
 *
 *  ACH   → NACHA fixed-width file (nacha.ts)
 *  WIRE  → CSV instruction file (a simplified stand-in for formats like ISO 20022 pain.001)
 *  VCARD → JSON lines for the virtual-card provider (a card number is issued per payment by the provider)
 *
 * Bank responses (ACK and STATUS) are simplified JSON documents defined by the schemas below. Real banks
 * use NACHA return files, ISO 20022 pain.002/camt.054 or proprietary formats. The adapter's job is to
 * translate whatever the bank sends into these internal shapes.
 */
import { z } from 'zod';
import type { PaymentBatch, PaymentInstruction } from '../../domain/payment-batch';
import { money, toMinorUnits } from '../../domain/money';
import type { Vendor } from '../../domain/types';
import { buildNachaFile, type NachaEntry } from './nacha';
import type { BankVault } from './vault';

export interface CompanyProfile {
  companyName: string;
  companyId: string;
  originRouting: string;
}

/** Next business day (Mon–Fri). ACH effective dates must be banking days. Holidays are ignored in this learning version. */
export function nextBusinessDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

export interface BuiltFile {
  name: string;
  content: string;
  /** Trace numbers assigned per instruction (ACH only). */
  traceNumbers: Record<string, string>;
}

const csv = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export async function buildPaymentFile(
  batch: PaymentBatch,
  instructions: PaymentInstruction[],
  vendors: Map<string, Vendor>,
  vault: BankVault,
  company: CompanyProfile,
  now: Date,
): Promise<BuiltFile> {
  const sorted = [...instructions].sort((a, b) => a.id.localeCompare(b.id));
  const effectiveDate = nextBusinessDay(now.toISOString().slice(0, 10));

  if (batch.rail === 'ACH') {
    const traceNumbers: Record<string, string> = {};
    const entries: NachaEntry[] = [];
    let seq = 1;
    for (const i of sorted) {
      const vendor = vendors.get(i.counterpartyExternalId);
      const acct = await vault.resolve(vendor?.bankToken ?? '', vendor?.routingNumber);
      const traceSequence = seq++;
      traceNumbers[i.id] = company.originRouting.slice(0, 8) + String(traceSequence).padStart(7, '0');
      entries.push({
        routingNumber: acct.routingNumber,
        accountNumber: acct.accountNumber,
        amountCents: toMinorUnits(money(i.amount, i.currency)),
        individualId: i.counterpartyExternalId,
        individualName: i.counterpartyName,
        traceSequence,
      });
    }
    const content = buildNachaFile({
      immediateDestination: company.originRouting,
      immediateDestinationName: 'NORTHSTAR TEST BANK',
      immediateOrigin: company.companyId,
      immediateOriginName: company.companyName,
      companyName: company.companyName,
      companyId: company.companyId,
      originatingDfi: company.originRouting,
      entryDescription: 'VENDOR PAY',
      effectiveDate,
      createdAt: now,
      referenceCode: batch.batchRef.slice(-8),
      entries,
    });
    return { name: `NSD_${batch.batchRef}.ach`, content, traceNumbers };
  }

  if (batch.rail === 'WIRE') {
    const header =
      'batch_ref,instruction_id,beneficiary_id,beneficiary_name,bank_token,amount,currency,value_date';
    const rows = sorted.map((i) => {
      const v = vendors.get(i.counterpartyExternalId);
      return [
        batch.batchRef,
        i.id,
        i.counterpartyExternalId,
        i.counterpartyName,
        v?.bankToken ?? '',
        i.amount,
        i.currency,
        effectiveDate,
      ]
        .map(csv)
        .join(',');
    });
    return {
      name: `NSD_${batch.batchRef}.wire.csv`,
      content: [header, ...rows].join('\n') + '\n',
      traceNumbers: {},
    };
  }

  // VCARD: the provider issues a single-use card per instruction and emails it to the vendor.
  const lines = sorted.map((i) =>
    JSON.stringify({
      batchRef: batch.batchRef,
      instructionId: i.id,
      vendorId: i.counterpartyExternalId,
      amount: i.amount,
      currency: i.currency,
      invoices: i.applications.map((a) => a.docExternalId),
    }),
  );
  return { name: `NSD_${batch.batchRef}.vcard.jsonl`, content: lines.join('\n') + '\n', traceNumbers: {} };
}

// ---------------- bank response formats ----------------

export const AckFileSchema = z.object({
  type: z.literal('ACK'),
  fileName: z.string(),
  batchRef: z.string(),
  status: z.enum(['ACCEPTED', 'REJECTED']),
  reason: z.string().optional(),
  entries: z.array(
    z.object({
      /** For ACH the trace number. For wire and vcard, our instruction ID. */
      ref: z.string(),
      status: z.enum(['ACCEPTED', 'REJECTED']),
      reason: z.string().optional(),
    }),
  ),
});
export type AckFile = z.infer<typeof AckFileSchema>;

export const StatusFileSchema = z.object({
  type: z.literal('PAYMENT_STATUS'),
  batchRef: z.string(),
  events: z.array(
    z.object({
      ref: z.string(),
      status: z.enum(['SETTLED', 'RETURNED']),
      returnCode: z.string().optional(),
      effectiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      bankRef: z.string(),
    }),
  ),
});
export type StatusFile = z.infer<typeof StatusFileSchema>;
