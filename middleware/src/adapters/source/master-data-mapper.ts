/**
 * Maps master data from the upstream "procurement / CRM" system into our domain models.
 *
 * WHY a mapping layer: upstream systems name things differently (vendor_code vs externalId, "ACTIVE"
 * vs isInactive=false). Making the mapping explicit, validated and tested lets us:
 *   - reject bad records at the door with a clear message (instead of a confusing NetSuite error later);
 *   - document the mapping in one place (docs/api-contracts/field-mapping.md);
 *   - change one side without touching the other.
 */
import { z } from 'zod';
import type { Customer, Vendor } from '../../domain/types';

const ExternalId = z.string().regex(/^[A-Z0-9][A-Z0-9_-]{1,63}$/, 'must be 2-64 chars: A-Z, 0-9, _ or -');
const CurrencyCode = z.string().regex(/^[A-Z]{3}$/, 'must be an ISO 4217 code');

/** Vendor record as the upstream procurement system sends it. */
export const SourceVendorSchema = z.object({
  vendor_code: ExternalId,
  legal_name: z.string().trim().min(1).max(83), // NetSuite companyName max length is 83
  ccy: CurrencyCode,
  status: z.enum(['ACTIVE', 'INACTIVE']),
  pay_method: z.enum(['ACH', 'WIRE', 'VCARD']),
  // Upstream sends a vault token, never raw account numbers. A raw number would fail this pattern.
  bank_ref: z.string().regex(/^tok_[A-Za-z0-9_]{3,60}$/, 'must be a vault token (tok_...)'),
  routing_number: z
    .string()
    .regex(/^\d{9}$/)
    .optional(),
});
export type SourceVendor = z.infer<typeof SourceVendorSchema>;

export const SourceCustomerSchema = z.object({
  customer_code: ExternalId,
  name: z.string().trim().min(1).max(83),
  ccy: CurrencyCode,
  billing_email: z.string().email(),
});
export type SourceCustomer = z.infer<typeof SourceCustomerSchema>;

export function mapVendor(src: SourceVendor): Vendor {
  return {
    externalId: src.vendor_code,
    companyName: src.legal_name,
    currency: src.ccy,
    isInactive: src.status === 'INACTIVE',
    paymentRail: src.pay_method,
    bankToken: src.bank_ref,
    routingNumber: src.routing_number,
  };
}

export function mapCustomer(src: SourceCustomer): Customer {
  return {
    externalId: src.customer_code,
    companyName: src.name,
    currency: src.ccy,
    email: src.billing_email.toLowerCase(),
  };
}

export interface MappingFailure {
  index: number;
  sourceRef: string;
  errors: { path: string; message: string }[];
}

/** Validates and maps a batch. Good records are mapped, and bad ones are reported (they never block the good ones). */
export function mapBatch<S, D>(
  rows: unknown[],
  schema: z.ZodType<S>,
  map: (s: S) => D,
  refOf: (row: unknown) => string,
): { ok: { index: number; record: D }[]; failed: MappingFailure[] } {
  const ok: { index: number; record: D }[] = [];
  const failed: MappingFailure[] = [];
  rows.forEach((row, index) => {
    const r = schema.safeParse(row);
    if (r.success) ok.push({ index, record: map(r.data) });
    else
      failed.push({
        index,
        sourceRef: refOf(row),
        errors: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
  });
  return { ok, failed };
}
