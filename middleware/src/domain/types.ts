/**
 * Internal domain models.
 *
 * WHY separate internal models: NetSuite, the bank and the payment provider each have their own data
 * shapes. If those shapes leaked everywhere, a NetSuite API change would ripple through the whole
 * codebase. Adapters translate external shapes INTO these stable models, and the rest of the code
 * only knows these.
 *
 * Amounts are decimal STRINGS ("1250.00") when stored or transported. Use domain/money.ts to do maths.
 */

export type Currency = string; // ISO 4217
export type IsoDate = string; // YYYY-MM-DD
export type DecimalString = string;

export type PaymentRail = 'ACH' | 'WIRE' | 'VCARD';

export interface Vendor {
  externalId: string;
  internalId?: string;
  companyName: string;
  currency: Currency;
  isInactive: boolean;
  paymentRail: PaymentRail;
  /** Token that refers to bank details held by the provider vault. Never the real account number. */
  bankToken: string;
  routingNumber?: string;
  accountLast4?: string;
}

export interface Customer {
  externalId: string;
  internalId?: string;
  companyName: string;
  currency: Currency;
  email: string;
}

export type ApprovalStatus = 'APPROVED' | 'PENDING' | 'REJECTED';

export interface VendorBill {
  externalId: string;
  internalId?: string;
  vendorExternalId: string;
  /** The vendor's own invoice number. Used for duplicate detection. */
  tranId: string;
  tranDate: IsoDate;
  dueDate: IsoDate;
  currency: Currency;
  total: DecimalString;
  amountRemaining: DecimalString;
  approvalStatus: ApprovalStatus;
  onHold: boolean;
  paymentInProgress: boolean;
  paymentBatchRef?: string;
}

export type CollectionStage = 'NONE' | 'REMINDER_1' | 'REMINDER_2' | 'ESCALATED';

export interface Invoice {
  externalId: string;
  internalId?: string;
  customerExternalId: string;
  tranId: string;
  tranDate: IsoDate;
  dueDate: IsoDate;
  currency: Currency;
  total: DecimalString;
  amountRemaining: DecimalString;
  disputed: boolean;
  collectionStage: CollectionStage;
}

/** One application of a payment to a document (bill or invoice). */
export interface PaymentApplication {
  docExternalId: string;
  amount: DecimalString;
}

export type IntegrationStatus = 'PENDING' | 'SYNCED' | 'ERROR';
