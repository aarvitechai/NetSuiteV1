import { describe, expect, it } from 'vitest';
import {
  buildNachaFile,
  isValidRoutingNumber,
  sanitize,
  validateNacha,
  type NachaFileInput,
} from '../../src/adapters/bank/nacha';
import { nextBusinessDay } from '../../src/adapters/bank/payment-files';

const input: NachaFileInput = {
  immediateDestination: '110000000',
  immediateDestinationName: 'Test Bank',
  immediateOrigin: '1234567890',
  immediateOriginName: 'Northstar Dist',
  companyName: 'Northstar Dist',
  companyId: '1234567890',
  originatingDfi: '110000000',
  entryDescription: 'VENDOR PAY',
  effectiveDate: '2026-11-23',
  createdAt: new Date('2026-11-20T09:05:00Z'),
  entries: [
    {
      routingNumber: '110000000',
      accountNumber: '000123456789',
      amountCents: '125000',
      individualId: 'VEND-ACMESUP',
      individualName: 'Acme Supplies LLC',
      traceSequence: 1,
    },
    {
      routingNumber: '021000021',
      accountNumber: '987654321',
      amountCents: '48050',
      individualId: 'VEND-BOLTCO',
      individualName: 'Bolt & Co Fasteners',
      traceSequence: 2,
    },
  ],
};

describe('NACHA file', () => {
  const file = buildNachaFile(input);
  const lines = file.trimEnd().split('\n');

  it('has 94-character records padded to a block of 10', () => {
    expect(lines.every((l) => l.length === 94)).toBe(true);
    expect(lines).toHaveLength(10);
    expect(lines.slice(6).every((l) => /^9{94}$/.test(l))).toBe(true);
  });

  it('has records in the order 1,5,6,6,8,9', () => {
    expect(lines.slice(0, 6).map((l) => l[0])).toEqual(['1', '5', '6', '6', '8', '9']);
  });

  it('puts fields at the right positions', () => {
    const entry = lines[2]!;
    expect(entry.slice(1, 3)).toBe('22'); // checking credit
    expect(entry.slice(3, 12)).toBe('110000000');
    expect(entry.slice(29, 39)).toBe('0000125000'); // $1,250.00 in cents
    expect(entry.slice(79, 94)).toBe('110000000000001'); // ODFI (8) + sequence (7)
    expect(lines[1]!.slice(50, 53)).toBe('CCD');
    expect(lines[1]!.slice(69, 75)).toBe('261123'); // effective date YYMMDD
  });

  it('passes validation, with correct control totals', () => {
    const { errors, parsed } = validateNacha(file);
    expect(errors).toEqual([]);
    expect(parsed!.totalCreditCents).toBe('173050');
    expect(parsed!.entries.map((e) => e.individualId)).toEqual(['VEND-ACMESUP', 'VEND-BOLTCO']);
    expect(lines[4]!.slice(10, 20)).toBe('0013100002'); // entry hash = 11000000 + 02100002
  });

  it('detects tampering (changed amount breaks the control total)', () => {
    const tampered = file.replace('0000125000', '0000925000');
    expect(validateNacha(tampered).errors).toContain('batch control credit total mismatch');
  });

  it('rejects invalid routing numbers and empty files', () => {
    expect(isValidRoutingNumber('110000000')).toBe(true);
    expect(isValidRoutingNumber('110000001')).toBe(false);
    expect(() =>
      buildNachaFile({ ...input, entries: [{ ...input.entries[0]!, routingNumber: '123456789' }] }),
    ).toThrow(/routing/);
    expect(() => buildNachaFile({ ...input, entries: [] })).toThrow();
  });

  it('sanitises names to the NACHA character set', () => {
    // Accents are folded (ü → U); the en-dash is non-ASCII, so it is dropped.
    expect(sanitize('Müller & Söhne – GmbH')).toBe('MULLER & SOHNE  GMBH');
  });

  it('computes the next business day', () => {
    expect(nextBusinessDay('2026-11-20')).toBe('2026-11-23'); // Friday → Monday
    expect(nextBusinessDay('2026-11-23')).toBe('2026-11-24');
  });
});
