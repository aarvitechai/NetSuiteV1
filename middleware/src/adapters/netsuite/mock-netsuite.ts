/**
 * MockNetSuiteAdapter: an IN-MEMORY SIMULATOR of NetSuite.
 *
 * ⚠️ THIS IS NOT NETSUITE. It imitates the behaviours our integration depends on, so the platform
 * can be built and tested without a NetSuite licence:
 *   - records addressed by externalId, with a unique externalId per record type;
 *   - applying payments reduces amountRemaining on bills and invoices, and voiding restores it;
 *   - closed accounting periods reject postings (a business error);
 *   - fault injection: 429 rate limits, 5xx outages and business errors, to test retries and the DLQ.
 *
 * Anything that passes against this mock must still be verified in a real sandbox (KNOWN_LIMITATIONS.md).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import type {
  CreateCustomerPaymentInput,
  CreateCustomerRefundInput,
  CreateDepositInput,
  CreateVendorPaymentInput,
  NetSuitePort,
  NsTransactionSummary,
  UpsertResult,
} from '../../application/ports/netsuite';
import type { Customer, IntegrationStatus, Invoice, Vendor, VendorBill } from '../../domain/types';
import { TransientError } from '../../shared/errors';
import { NetSuiteBusinessError } from './errors';

const SEED_DIR = resolve(__dirname, '../../../../test-data/netsuite');

type FaultKind = 'rate_limit' | 'unavailable' | 'business';
interface Fault {
  operation: string | '*';
  kind: FaultKind;
  remaining: number;
}

interface StoredTxn extends NsTransactionSummary {
  applications: { docExternalId: string; amount: string }[];
  integrationStatus?: IntegrationStatus;
  detail?: Record<string, string | undefined>;
}

function readSeed<T>(file: string): T[] {
  const rows = JSON.parse(readFileSync(resolve(SEED_DIR, file), 'utf8')) as Record<string, unknown>[];
  // Drop documentation fields that start with "_" (e.g. "_note").
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !k.startsWith('_'))) as T);
}

export class MockNetSuiteAdapter implements NetSuitePort {
  readonly kind = 'mock' as const;

  private vendors = new Map<string, Vendor>();
  private customers = new Map<string, Customer>();
  private bills = new Map<string, VendorBill>();
  private invoices = new Map<string, Invoice>();
  private txns = new Map<string, StoredTxn>(); // key = `${type}:${externalId}`
  private faults: Fault[] = [];
  private nextId = 1000;
  /** Periods (YYYY-MM) that are closed for posting. */
  readonly closedPeriods = new Set<string>();
  /** Every call, for tests that need to count NetSuite calls (e.g. "no duplicate create"). */
  readonly calls: string[] = [];

  constructor(options: { seed?: boolean } = { seed: true }) {
    if (options.seed !== false) this.loadSeed();
  }

  loadSeed(): void {
    for (const v of readSeed<Vendor>('vendors.json'))
      this.vendors.set(v.externalId, { ...v, internalId: this.id() });
    for (const c of readSeed<Customer>('customers.json'))
      this.customers.set(c.externalId, { ...c, internalId: this.id() });
    for (const b of readSeed<VendorBill>('vendor-bills.json'))
      this.bills.set(b.externalId, { ...b, internalId: this.id(), paymentInProgress: false });
    for (const i of readSeed<Invoice>('invoices.json'))
      this.invoices.set(i.externalId, { ...i, internalId: this.id(), collectionStage: 'NONE' });
  }

  // ---------------- test helpers (not part of NetSuitePort) ----------------

  /** Makes the next `times` calls of `operation` ('*' = any) fail with the given kind. */
  injectFault(kind: FaultKind, times = 1, operation: string | '*' = '*'): void {
    this.faults.push({ operation, kind, remaining: times });
  }

  addBill(bill: VendorBill): void {
    this.bills.set(bill.externalId, { ...bill, internalId: this.id() });
  }

  addInvoice(inv: Invoice): void {
    this.invoices.set(inv.externalId, { ...inv, internalId: this.id() });
  }

  getTransaction(type: NsTransactionSummary['type'], externalId: string): StoredTxn | undefined {
    const t = this.txns.get(`${type}:${externalId}`);
    return t && structuredClone(t);
  }

  countTransactions(type?: NsTransactionSummary['type']): number {
    return [...this.txns.values()].filter((t) => !type || t.type === type).length;
  }

  // ---------------- internals ----------------

  private id(): string {
    return String(this.nextId++);
  }

  /** Called at the start of every operation: records the call and throws an injected fault if one matches. */
  private enter(operation: string): void {
    this.calls.push(operation);
    const fault = this.faults.find(
      (f) => f.remaining > 0 && (f.operation === '*' || f.operation === operation),
    );
    if (!fault) return;
    fault.remaining--;
    if (fault.kind === 'rate_limit')
      throw new TransientError('NETSUITE_RATE_LIMITED', 'Simulated 429 Too Many Requests', 10);
    if (fault.kind === 'unavailable')
      throw new TransientError('NETSUITE_UNAVAILABLE', 'Simulated 503 Service Unavailable');
    throw new NetSuiteBusinessError('Simulated business error (INVALID_FLD_VALUE)');
  }

  private assertOpenPeriod(date: string): void {
    if (this.closedPeriods.has(date.slice(0, 7))) {
      throw new NetSuiteBusinessError(
        `The accounting period ${date.slice(0, 7)} is closed (simulated PERIOD_CLOSED)`,
      );
    }
  }

  /** Shared create-once logic: the core of the idempotency contract. */
  private createOnce(type: StoredTxn['type'], externalId: string, build: () => StoredTxn): UpsertResult {
    const key = `${type}:${externalId}`;
    const existing = this.txns.get(key);
    if (existing) return { internalId: existing.internalId, externalId, created: false };
    const txn = build();
    this.txns.set(key, txn);
    return { internalId: txn.internalId, externalId, created: true };
  }

  private applyTo(
    map: Map<string, VendorBill | Invoice>,
    applications: { docExternalId: string; amount: string }[],
    sign: 1 | -1,
  ) {
    // Validate everything first, then apply. NetSuite also saves a transaction all-or-nothing.
    for (const a of applications) {
      const doc = map.get(a.docExternalId);
      if (!doc) throw new NetSuiteBusinessError(`Document ${a.docExternalId} not found`);
      if (sign === 1 && new Decimal(a.amount).greaterThan(doc.amountRemaining)) {
        throw new NetSuiteBusinessError(
          `Payment ${a.amount} exceeds amount remaining ${doc.amountRemaining} on ${a.docExternalId}`,
        );
      }
    }
    for (const a of applications) {
      const doc = map.get(a.docExternalId)!;
      doc.amountRemaining = new Decimal(doc.amountRemaining)
        .minus(new Decimal(a.amount).times(sign))
        .toFixed(2);
    }
  }

  // ---------------- NetSuitePort ----------------

  async ping(): Promise<void> {
    this.enter('ping');
  }

  async upsertVendor(vendor: Vendor): Promise<UpsertResult> {
    this.enter('upsertVendor');
    const existing = this.vendors.get(vendor.externalId);
    const internalId = existing?.internalId ?? this.id();
    this.vendors.set(vendor.externalId, { ...vendor, internalId });
    return { internalId, externalId: vendor.externalId, created: !existing };
  }

  async upsertCustomer(customer: Customer): Promise<UpsertResult> {
    this.enter('upsertCustomer');
    const existing = this.customers.get(customer.externalId);
    const internalId = existing?.internalId ?? this.id();
    this.customers.set(customer.externalId, { ...customer, internalId });
    return { internalId, externalId: customer.externalId, created: !existing };
  }

  async getVendor(externalId: string) {
    this.enter('getVendor');
    const v = this.vendors.get(externalId);
    return v && { ...v };
  }

  async getCustomer(externalId: string) {
    this.enter('getCustomer');
    const c = this.customers.get(externalId);
    return c && { ...c };
  }

  async listVendors() {
    this.enter('listVendors');
    return [...this.vendors.values()].map((v) => ({ ...v }));
  }

  async listCustomers() {
    this.enter('listCustomers');
    return [...this.customers.values()].map((c) => ({ ...c }));
  }

  async listOpenVendorBills() {
    this.enter('listOpenVendorBills');
    return [...this.bills.values()]
      .filter((b) => new Decimal(b.amountRemaining).greaterThan(0))
      .map((b) => ({ ...b }));
  }

  async getVendorBill(externalId: string) {
    this.enter('getVendorBill');
    const b = this.bills.get(externalId);
    return b && { ...b };
  }

  async setBillPaymentFlags(ids: string[], flags: { inProgress: boolean; batchRef?: string }) {
    this.enter('setBillPaymentFlags');
    for (const id of ids) {
      const b = this.bills.get(id);
      if (!b) throw new NetSuiteBusinessError(`Vendor bill ${id} not found`);
      b.paymentInProgress = flags.inProgress;
      if (flags.batchRef !== undefined) b.paymentBatchRef = flags.batchRef;
    }
  }

  async createVendorPayment(input: CreateVendorPaymentInput): Promise<UpsertResult> {
    this.enter('createVendorPayment');
    this.assertOpenPeriod(input.tranDate);
    return this.createOnce('VendPymt', input.externalId, () => {
      this.applyTo(this.bills, input.applications, 1);
      const amount = input.applications.reduce((s, a) => s.plus(a.amount), new Decimal(0)).toFixed(2);
      return {
        type: 'VendPymt',
        externalId: input.externalId,
        internalId: this.id(),
        tranDate: input.tranDate,
        amount,
        currency: input.currency,
        providerRef: input.providerRef,
        applications: input.applications,
      };
    });
  }

  async voidVendorPayment(externalId: string, _reason: string): Promise<void> {
    this.enter('voidVendorPayment');
    const t = this.txns.get(`VendPymt:${externalId}`);
    if (!t) throw new NetSuiteBusinessError(`Vendor payment ${externalId} not found`);
    if (t.voided) return; // voiding twice is a no-op (idempotent)
    this.applyTo(this.bills, t.applications, -1);
    t.voided = true;
  }

  async listOpenInvoices(customerExternalId?: string) {
    this.enter('listOpenInvoices');
    return [...this.invoices.values()]
      .filter((i) => new Decimal(i.amountRemaining).greaterThan(0))
      .filter((i) => !customerExternalId || i.customerExternalId === customerExternalId)
      .map((i) => ({ ...i }));
  }

  async getInvoice(externalId: string) {
    this.enter('getInvoice');
    const i = this.invoices.get(externalId);
    return i && { ...i };
  }

  async setInvoiceCollectionStage(externalId: string, stage: Invoice['collectionStage']) {
    this.enter('setInvoiceCollectionStage');
    const i = this.invoices.get(externalId);
    if (!i) throw new NetSuiteBusinessError(`Invoice ${externalId} not found`);
    i.collectionStage = stage;
  }

  async createCustomerPayment(input: CreateCustomerPaymentInput): Promise<UpsertResult> {
    this.enter('createCustomerPayment');
    this.assertOpenPeriod(input.tranDate);
    return this.createOnce('CustPymt', input.externalId, () => {
      this.applyTo(this.invoices, input.applications, 1);
      return {
        type: 'CustPymt',
        externalId: input.externalId,
        internalId: this.id(),
        tranDate: input.tranDate,
        amount: input.amount,
        currency: input.currency,
        providerRef: input.providerRef,
        applications: input.applications,
      };
    });
  }

  async createDeposit(input: CreateDepositInput): Promise<UpsertResult> {
    this.enter('createDeposit');
    this.assertOpenPeriod(input.tranDate);
    return this.createOnce('Deposit', input.externalId, () => ({
      type: 'Deposit',
      externalId: input.externalId,
      internalId: this.id(),
      tranDate: input.tranDate,
      amount: input.net, // the bank sees the NET amount
      currency: input.currency,
      providerRef: input.providerRef,
      applications: [],
    }));
  }

  async createCustomerRefund(input: CreateCustomerRefundInput): Promise<UpsertResult> {
    this.enter('createCustomerRefund');
    this.assertOpenPeriod(input.tranDate);
    return this.createOnce('CustRfnd', input.externalId, () => {
      // A refund re-opens the invoices it was paid against (simplified: proportional to the first one).
      const pay = this.txns.get(`CustPymt:${input.paymentExternalId}`);
      const first = pay?.applications[0];
      if (first)
        this.applyTo(this.invoices, [{ docExternalId: first.docExternalId, amount: input.amount }], -1);
      return {
        type: 'CustRfnd',
        externalId: input.externalId,
        internalId: this.id(),
        tranDate: input.tranDate,
        amount: input.amount,
        currency: input.currency,
        providerRef: input.providerRef,
        applications: [],
      };
    });
  }

  async listTransactions(fromDate: string, toDate: string): Promise<NsTransactionSummary[]> {
    this.enter('listTransactions');
    return [...this.txns.values()]
      .filter((t) => t.tranDate >= fromDate && t.tranDate <= toDate)
      .map(({ applications: _a, integrationStatus: _s, detail: _d, ...summary }) => ({ ...summary }));
  }

  async updateIntegrationStatus(
    recordType: string,
    externalId: string,
    status: IntegrationStatus,
    detail?: { correlationId?: string; errorDetail?: string; providerRef?: string },
  ): Promise<void> {
    this.enter('updateIntegrationStatus');
    const t = [...this.txns.values()].find((x) => x.externalId === externalId);
    if (t) {
      t.integrationStatus = status;
      t.detail = { ...detail };
    }
    void recordType;
  }
}
