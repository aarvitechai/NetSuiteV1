/**
 * NetSuitePort: everything the application needs from NetSuite, expressed in our domain language.
 *
 * WHY an interface: the application must not care whether it talks to:
 *   - MockNetSuiteAdapter (in-memory simulator: tests, demo, no licence needed),
 *   - NetSuiteRestAdapter (SuiteTalk REST, the default for a real account), or
 *   - NetSuiteSoapAdapter (SuiteTalk SOAP, for operations REST does not cover).
 *
 * IDEMPOTENCY CONTRACT: every create* method takes an externalId. Calling it twice with the same
 * externalId must NOT create two records. The second call returns the existing record with
 * created=false. This is what makes retries safe (no duplicate financial transactions).
 */
import type {
  Customer,
  DecimalString,
  IntegrationStatus,
  Invoice,
  IsoDate,
  PaymentApplication,
  Vendor,
  VendorBill,
} from '../../domain/types';

export interface UpsertResult {
  internalId: string;
  externalId: string;
  created: boolean;
}

export interface CreateVendorPaymentInput {
  externalId: string; // = payment instruction id
  vendorExternalId: string;
  currency: string;
  tranDate: IsoDate;
  applications: PaymentApplication[];
  providerRef?: string;
  batchRef: string;
  memo?: string;
}

export interface CreateCustomerPaymentInput {
  externalId: string; // = payment intent id
  customerExternalId: string;
  currency: string;
  tranDate: IsoDate;
  amount: DecimalString;
  applications: PaymentApplication[];
  providerRef: string;
}

export interface CreateDepositInput {
  externalId: string; // = settlement id
  currency: string;
  tranDate: IsoDate;
  /** Customer payments included in this deposit (their externalIds). */
  paymentExternalIds: string[];
  gross: DecimalString;
  fees: DecimalString;
  net: DecimalString;
  providerRef: string;
}

export interface CreateCustomerRefundInput {
  externalId: string;
  customerExternalId: string;
  currency: string;
  tranDate: IsoDate;
  amount: DecimalString;
  paymentExternalId: string;
  providerRef: string;
}

/** A NetSuite transaction as needed for reconciliation matching. */
export interface NsTransactionSummary {
  externalId: string;
  internalId: string;
  type: 'VendPymt' | 'CustPymt' | 'Deposit' | 'CustRfnd';
  tranDate: IsoDate;
  amount: DecimalString;
  currency: string;
  providerRef?: string;
  voided?: boolean;
}

export interface NetSuitePort {
  readonly kind: 'mock' | 'rest' | 'soap';

  // ---- master data ----
  upsertVendor(vendor: Vendor): Promise<UpsertResult>;
  upsertCustomer(customer: Customer): Promise<UpsertResult>;
  getVendor(externalId: string): Promise<Vendor | undefined>;
  getCustomer(externalId: string): Promise<Customer | undefined>;
  listVendors(): Promise<Vendor[]>;
  listCustomers(): Promise<Customer[]>;

  // ---- AP ----
  listOpenVendorBills(): Promise<VendorBill[]>;
  getVendorBill(externalId: string): Promise<VendorBill | undefined>;
  /** Sets/clears "payment in progress" + batch reference on bills (prevents double proposals). */
  setBillPaymentFlags(
    billExternalIds: string[],
    flags: { inProgress: boolean; batchRef?: string },
  ): Promise<void>;
  createVendorPayment(input: CreateVendorPaymentInput): Promise<UpsertResult>;
  voidVendorPayment(externalId: string, reason: string): Promise<void>;

  // ---- AR ----
  listOpenInvoices(customerExternalId?: string): Promise<Invoice[]>;
  getInvoice(externalId: string): Promise<Invoice | undefined>;
  setInvoiceCollectionStage(externalId: string, stage: Invoice['collectionStage']): Promise<void>;
  /** Marks an invoice as disputed (pauses collections) or clears the dispute. */
  setInvoiceDispute(externalId: string, disputed: boolean): Promise<void>;
  createCustomerPayment(input: CreateCustomerPaymentInput): Promise<UpsertResult>;
  createDeposit(input: CreateDepositInput): Promise<UpsertResult>;
  createCustomerRefund(input: CreateCustomerRefundInput): Promise<UpsertResult>;

  // ---- reconciliation / ops ----
  listTransactions(fromDate: IsoDate, toDate: IsoDate): Promise<NsTransactionSummary[]>;
  updateIntegrationStatus(
    recordType: string,
    externalId: string,
    status: IntegrationStatus,
    detail?: { correlationId?: string; errorDetail?: string; providerRef?: string },
  ): Promise<void>;
  ping(): Promise<void>;
}
