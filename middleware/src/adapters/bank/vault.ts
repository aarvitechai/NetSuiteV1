/**
 * Bank details vault.
 *
 * WHY A VAULT: vendor bank account numbers are highly sensitive (they are the target of payment-fraud
 * attacks). The middleware and NetSuite store only a TOKEN, such as "tok_bank_acmesup". The real
 * account number is fetched from the vault at the moment a payment file is built. It is kept only in
 * memory, written only into the bank file, and never into our database or logs.
 *
 * In production the vault is the payment provider's or bank's tokenisation service, or a dedicated
 * secrets vault. SimulatedVault derives fake but well-formed numbers from the token.
 */
import { createHash } from 'node:crypto';
import { BusinessRuleError } from '../../shared/errors';

export interface BankAccountDetails {
  routingNumber: string;
  accountNumber: string;
}

export interface BankVault {
  resolve(token: string, routingHint?: string): Promise<BankAccountDetails>;
}

/** ⚠️ SIMULATOR: returns synthetic account numbers. Tokens starting with "tok_invalid" fail on purpose (for tests). */
export class SimulatedVault implements BankVault {
  async resolve(token: string, routingHint?: string): Promise<BankAccountDetails> {
    if (!token.startsWith('tok_') || token.startsWith('tok_invalid')) {
      throw new BusinessRuleError('BANK_TOKEN_INVALID', 'Bank account token could not be resolved');
    }
    // 12 deterministic digits derived from the token, so the same token always gives the same fake account.
    const digits = BigInt(`0x${createHash('sha256').update(token).digest('hex').slice(0, 15)}`)
      .toString()
      .slice(0, 12)
      .padStart(12, '0');
    return { routingNumber: routingHint || '110000000', accountNumber: digits };
  }
}
