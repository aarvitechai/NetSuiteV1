/**
 * Contract tests for the upstream → domain mapping (docs/api-contracts/field-mapping.md).
 * If someone changes the mapping, these tests show exactly which contract broke.
 */
import { describe, expect, it } from 'vitest';
import {
  mapBatch,
  mapCustomer,
  mapVendor,
  SourceCustomerSchema,
  SourceVendorSchema,
} from '../../src/adapters/source/master-data-mapper';

const goodVendor = {
  vendor_code: 'VEND-NEWCO',
  legal_name: '  NewCo Industrial  ',
  ccy: 'USD',
  status: 'ACTIVE',
  pay_method: 'ACH',
  bank_ref: 'tok_bank_newco',
  routing_number: '110000000',
};

describe('vendor mapping contract', () => {
  it('maps every field per the spec', () => {
    expect(mapVendor(SourceVendorSchema.parse(goodVendor))).toEqual({
      externalId: 'VEND-NEWCO',
      companyName: 'NewCo Industrial', // trimmed
      currency: 'USD',
      isInactive: false,
      paymentRail: 'ACH',
      bankToken: 'tok_bank_newco',
      routingNumber: '110000000',
    });
  });

  it('INACTIVE status maps to isInactive=true', () => {
    expect(mapVendor(SourceVendorSchema.parse({ ...goodVendor, status: 'INACTIVE' })).isInactive).toBe(true);
  });

  it('refuses a raw bank account number in bank_ref', () => {
    const r = SourceVendorSchema.safeParse({ ...goodVendor, bank_ref: '000123456789' });
    expect(r.success).toBe(false);
  });

  it.each([
    ['lowercase code', { vendor_code: 'vend-x' }],
    ['bad currency', { ccy: 'US' }],
    ['unknown rail', { pay_method: 'CHEQUE' }],
    ['name too long', { legal_name: 'x'.repeat(84) }],
  ])('rejects %s', (_label, patch) => {
    expect(SourceVendorSchema.safeParse({ ...goodVendor, ...patch }).success).toBe(false);
  });
});

describe('customer mapping contract', () => {
  it('lower-cases the email', () => {
    const c = mapCustomer(
      SourceCustomerSchema.parse({
        customer_code: 'CUST-NEW',
        name: 'New',
        ccy: 'USD',
        billing_email: 'AP@New.Example',
      }),
    );
    expect(c.email).toBe('ap@new.example');
  });
});

describe('mapBatch', () => {
  it('separates valid and invalid rows without losing either', () => {
    const r = mapBatch([goodVendor, { vendor_code: 'BAD' }, null], SourceVendorSchema, mapVendor, (x) =>
      String((x as { vendor_code?: string })?.vendor_code ?? 'unknown'),
    );
    expect(r.ok.map((o) => o.index)).toEqual([0]);
    expect(r.failed.map((f) => [f.index, f.sourceRef])).toEqual([
      [1, 'BAD'],
      [2, 'unknown'],
    ]);
  });
});
