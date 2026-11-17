/**
 * NetSuiteRestAdapter: talks to a REAL NetSuite account through SuiteTalk REST Web Services.
 *
 * ⚠️ Written against the documented SuiteTalk REST API, but NOT yet executed against a live account
 * (no sandbox was available). Verify each call in your sandbox. Field names in particular depend on
 * the enabled features (see KNOWN_LIMITATIONS.md).
 *
 * KEY TECHNIQUES
 *  - Upsert by external ID:  PUT /services/rest/record/v1/vendor/eid:VEND-ACMESUP
 *    One call that creates the record or updates it. No internal-ID lookup is needed.
 *  - Reads via SuiteQL:      POST /services/rest/query/v1/suiteql   (header Prefer: transient)
 *    Paged with ?limit=&offset=. The response includes hasMore.
 *  - Creates are idempotent: we look the record up by externalId first. If a concurrent call created
 *    it in between, NetSuite rejects the duplicate externalId and we look it up again.
 *  - Every response is classified as transient or permanent (errors.ts) for the retry logic.
 *
 * SECURITY: authentication is TBA (OAuth 1.0a, oauth1.ts). The credentials come from config, which
 * reads environment variables or the secret manager, and they are never logged.
 */
import type {
  CreateCustomerPaymentInput,
  CreateCustomerRefundInput,
  CreateDepositInput,
  CreateVendorPaymentInput,
  NetSuitePort,
  NsTransactionSummary,
  ReconciliationRecordInput,
  UpsertResult,
} from '../../application/ports/netsuite';
import type { Customer, IntegrationStatus, Invoice, Vendor, VendorBill } from '../../domain/types';
import { NotFoundError } from '../../shared/errors';
import { classifyNetSuiteResponse, classifyNetworkError, NetSuiteBusinessError } from './errors';
import { accountHost, buildAuthorizationHeader, type TbaCredentials } from './oauth1';
import { bindSuiteQL, loadSuiteQL, type SuiteQLParam } from './suiteql';

/** fetch is injectable so tests can simulate NetSuite responses without network access. */
export type FetchFn = (url: string, init: RequestInit) => Promise<Response>;

const PAGE_SIZE = 1000; // SuiteQL maximum page size
const TIMEOUT_MS = 30_000;

export class NetSuiteRestAdapter implements NetSuitePort {
  readonly kind = 'rest' as const;
  private readonly baseUrl: string;
  /** Small cache of externalId → internalId (these never change once assigned). */
  private readonly idCache = new Map<string, string>();

  constructor(
    private readonly creds: TbaCredentials,
    private readonly fetchFn: FetchFn = fetch,
  ) {
    this.baseUrl = `https://${accountHost(creds.accountId)}.suitetalk.api.netsuite.com/services/rest`;
  }

  // ------------------------------------------------------------------ HTTP core

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<{ status: number; data: T; headers: Headers }> {
    const url = `${this.baseUrl}${path}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: buildAuthorizationHeader(method, url, this.creds),
          'Content-Type': 'application/json',
          Accept: 'application/json',
          ...extraHeaders,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      throw classifyNetworkError(e);
    }
    const text = await res.text();
    const data = text ? (JSON.parse(text) as T) : (undefined as T);
    if (!res.ok) throw classifyNetSuiteResponse(res.status, data, res.headers.get('retry-after'));
    return { status: res.status, data, headers: res.headers };
  }

  /** Runs a SuiteQL file from netsuite/suiteql/ (or an inline query) and follows paging. */
  async suiteql<T = Record<string, unknown>>(
    nameOrQuery: string,
    params: Record<string, SuiteQLParam> = {},
    maxRows = 10_000,
  ): Promise<T[]> {
    const q = /^[a-z0-9_]+$/.test(nameOrQuery) ? loadSuiteQL(nameOrQuery) : nameOrQuery;
    const query = bindSuiteQL(q, params);
    const rows: T[] = [];
    for (let offset = 0; offset < maxRows; offset += PAGE_SIZE) {
      const { data } = await this.request<{ items: T[]; hasMore: boolean }>(
        'POST',
        `/query/v1/suiteql?limit=${PAGE_SIZE}&offset=${offset}`,
        { q: query },
        { Prefer: 'transient' }, // required by the SuiteQL endpoint
      );
      rows.push(...data.items);
      if (!data.hasMore) break;
    }
    return rows;
  }

  /** Finds an internal ID by external ID with SuiteQL (cached). */
  private async internalIdOf(table: string, externalId: string): Promise<string | undefined> {
    const key = `${table}:${externalId}`;
    if (this.idCache.has(key)) return this.idCache.get(key);
    // table names are fixed strings from our own code, never user input.
    const rows = await this.suiteql<{ id: string }>(`SELECT id FROM ${table} WHERE externalid = :eid`, {
      eid: externalId,
    });
    const id = rows[0]?.id;
    if (id) this.idCache.set(key, String(id));
    return id ? String(id) : undefined;
  }

  private async requireId(table: string, externalId: string): Promise<string> {
    const id = await this.internalIdOf(table, externalId);
    if (!id) throw new NotFoundError(`${table} ${externalId}`);
    return id;
  }

  /** Extracts the new record's ID from the Location header of a 204 create response. */
  private static idFromLocation(headers: Headers): string {
    return headers.get('location')?.split('/').pop() ?? '';
  }

  /**
   * Generic idempotent create: return the existing record if the externalId is known, otherwise POST.
   * If the POST fails because a concurrent request already created it, look it up again.
   */
  private async createOnce(
    table: string,
    recordPath: string,
    externalId: string,
    // Built lazily: when the record already exists we skip the extra ID lookups entirely.
    buildBody: () => Promise<Record<string, unknown>>,
  ): Promise<UpsertResult> {
    const existing = await this.internalIdOf(table, externalId);
    if (existing) return { internalId: existing, externalId, created: false };
    try {
      const { headers } = await this.request('POST', `/record/v1/${recordPath}`, {
        ...(await buildBody()),
        externalId,
      });
      const internalId = NetSuiteRestAdapter.idFromLocation(headers);
      this.idCache.set(`${table}:${externalId}`, internalId);
      return { internalId, externalId, created: true };
    } catch (e) {
      if (e instanceof NetSuiteBusinessError && /duplicate|already exists|unique/i.test(e.message)) {
        const id = await this.requireId(table, externalId);
        return { internalId: id, externalId, created: false };
      }
      throw e;
    }
  }

  private async upsertByExternalId(
    recordPath: string,
    externalId: string,
    body: Record<string, unknown>,
    table: string,
  ): Promise<UpsertResult> {
    const before = await this.internalIdOf(table, externalId);
    await this.request('PUT', `/record/v1/${recordPath}/eid:${encodeURIComponent(externalId)}`, body);
    const internalId = before ?? (await this.requireId(table, externalId));
    return { internalId, externalId, created: !before };
  }

  // ------------------------------------------------------------------ NetSuitePort

  async ping(): Promise<void> {
    await this.suiteql('SELECT 1 AS ok FROM DUAL', {}, 1);
  }

  upsertVendor(v: Vendor): Promise<UpsertResult> {
    return this.upsertByExternalId(
      'vendor',
      v.externalId,
      {
        companyName: v.companyName,
        isInactive: v.isInactive,
        currency: { refName: v.currency },
        custentity_nsd_pay_method: v.paymentRail,
        custentity_nsd_bank_token: v.bankToken,
        custentity_nsd_ext_id_src: 'MIDDLEWARE',
      },
      'vendor',
    );
  }

  upsertCustomer(c: Customer): Promise<UpsertResult> {
    return this.upsertByExternalId(
      'customer',
      c.externalId,
      {
        companyName: c.companyName,
        email: c.email,
        currency: { refName: c.currency },
        custentity_nsd_ext_id_src: 'MIDDLEWARE',
      },
      'customer',
    );
  }

  async getVendor(externalId: string): Promise<Vendor | undefined> {
    const rows = await this.suiteql<Record<string, string>>(
      `SELECT id, externalid, companyname, BUILTIN.DF(currency) AS currency, isinactive,
              custentity_nsd_pay_method AS rail, custentity_nsd_bank_token AS token
       FROM vendor WHERE externalid = :eid`,
      { eid: externalId },
    );
    const r = rows[0];
    return r && this.toVendor(r);
  }

  private toVendor(r: Record<string, string>): Vendor {
    return {
      externalId: r.externalid!,
      internalId: String(r.id),
      companyName: r.companyname!,
      currency: r.currency!,
      isInactive: r.isinactive === 'T',
      paymentRail: (r.rail as Vendor['paymentRail']) || 'ACH',
      bankToken: r.token ?? '',
    };
  }

  async getCustomer(externalId: string): Promise<Customer | undefined> {
    const rows = await this.suiteql<Record<string, string>>(
      `SELECT id, externalid, companyname, email, BUILTIN.DF(currency) AS currency FROM customer WHERE externalid = :eid`,
      { eid: externalId },
    );
    const r = rows[0];
    return (
      r && {
        externalId: r.externalid!,
        internalId: String(r.id),
        companyName: r.companyname!,
        email: r.email ?? '',
        currency: r.currency!,
      }
    );
  }

  async listVendors(): Promise<Vendor[]> {
    const rows = await this.suiteql<Record<string, string>>(
      `SELECT id, externalid, companyname, BUILTIN.DF(currency) AS currency, isinactive,
              custentity_nsd_pay_method AS rail, custentity_nsd_bank_token AS token
       FROM vendor WHERE externalid IS NOT NULL`,
    );
    return rows.map((r) => this.toVendor(r));
  }

  async listCustomers(): Promise<Customer[]> {
    const rows = await this.suiteql<Record<string, string>>(
      `SELECT id, externalid, companyname, email, BUILTIN.DF(currency) AS currency FROM customer WHERE externalid IS NOT NULL`,
    );
    return rows.map((r) => ({
      externalId: r.externalid!,
      internalId: String(r.id),
      companyName: r.companyname!,
      email: r.email ?? '',
      currency: r.currency!,
    }));
  }

  private static toBill(r: Record<string, string>): VendorBill {
    return {
      externalId: r.externalid!,
      internalId: String(r.id),
      vendorExternalId: r.vendor_eid!,
      tranId: r.tranid!,
      tranDate: r.trandate!,
      dueDate: r.duedate!,
      currency: r.currency!,
      total: r.total!,
      amountRemaining: r.remaining!,
      approvalStatus:
        r.approvalstatus === '2' ? 'APPROVED' : r.approvalstatus === '3' ? 'REJECTED' : 'PENDING',
      onHold: r.hold === 'T',
      paymentInProgress: r.inprogress === 'T',
      paymentBatchRef: r.batchref || undefined,
    };
  }

  private static readonly BILL_SELECT = `
    SELECT t.id, t.externalid, v.externalid AS vendor_eid, t.tranid,
           TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, TO_CHAR(t.duedate, 'YYYY-MM-DD') AS duedate,
           BUILTIN.DF(t.currency) AS currency, t.foreigntotal AS total, t.foreignamountremaining AS remaining,
           t.approvalstatus, t.custbody_nsd_pay_hold AS hold, t.custbody_nsd_pay_in_progress AS inprogress,
           t.custbody_nsd_pay_batch_ref AS batchref
    FROM transaction t JOIN vendor v ON v.id = t.entity
    WHERE t.type = 'VendBill'`;

  async listOpenVendorBills(): Promise<VendorBill[]> {
    const rows = await this.suiteql<Record<string, string>>(
      `${NetSuiteRestAdapter.BILL_SELECT} AND t.foreignamountremaining > 0`,
    );
    return rows.map(NetSuiteRestAdapter.toBill);
  }

  async getVendorBill(externalId: string): Promise<VendorBill | undefined> {
    const rows = await this.suiteql<Record<string, string>>(
      `${NetSuiteRestAdapter.BILL_SELECT} AND t.externalid = :eid`,
      { eid: externalId },
    );
    return rows[0] && NetSuiteRestAdapter.toBill(rows[0]);
  }

  async setBillPaymentFlags(ids: string[], flags: { inProgress: boolean; batchRef?: string }): Promise<void> {
    for (const eid of ids) {
      await this.request('PATCH', `/record/v1/vendorBill/eid:${encodeURIComponent(eid)}`, {
        custbody_nsd_pay_in_progress: flags.inProgress,
        ...(flags.batchRef !== undefined ? { custbody_nsd_pay_batch_ref: flags.batchRef } : {}),
      });
    }
  }

  /** Resolves each application's document to its internal ID and builds the "apply" sublist lines. */
  private applyLines(applications: { docExternalId: string; amount: string }[]) {
    return Promise.all(
      applications.map(async (a) => ({
        doc: { id: await this.requireId('transaction', a.docExternalId) },
        apply: true,
        // Amounts become JSON numbers ONLY here, at the API boundary, because NetSuite expects numbers.
        amount: Number(a.amount),
      })),
    );
  }

  createVendorPayment(input: CreateVendorPaymentInput): Promise<UpsertResult> {
    return this.createOnce('transaction', 'vendorPayment', input.externalId, async () => ({
      entity: { id: await this.requireId('vendor', input.vendorExternalId) },
      tranDate: input.tranDate,
      currency: { refName: input.currency },
      memo: input.memo ?? `Batch ${input.batchRef}`,
      custbody_nsd_ext_pay_ref: input.externalId,
      custbody_nsd_provider_ref: input.providerRef,
      custbody_nsd_pay_batch_ref: input.batchRef,
      apply: { items: await this.applyLines(input.applications) },
    }));
  }

  async voidVendorPayment(externalId: string, reason: string): Promise<void> {
    // Voiding via REST is account-configuration dependent (reversing journals vs direct void).
    // Here we mark the integration status and leave the void to the AP team via the documented runbook.
    await this.updateIntegrationStatus('vendorPayment', externalId, 'ERROR', {
      errorDetail: `VOID REQUIRED: ${reason}`,
    });
  }

  async listOpenInvoices(customerExternalId?: string): Promise<Invoice[]> {
    const rows = await this.suiteql<Record<string, string>>(
      `SELECT t.id, t.externalid, c.externalid AS cust_eid, t.tranid,
              TO_CHAR(t.trandate, 'YYYY-MM-DD') AS trandate, TO_CHAR(t.duedate, 'YYYY-MM-DD') AS duedate,
              BUILTIN.DF(t.currency) AS currency, t.foreigntotal AS total, t.foreignamountremaining AS remaining,
              t.custbody_nsd_dispute AS disputed, t.custbody_nsd_collection_stage AS stage
       FROM transaction t JOIN customer c ON c.id = t.entity
       WHERE t.type = 'CustInvc' AND t.foreignamountremaining > 0
       ${customerExternalId ? 'AND c.externalid = :cust' : ''}`,
      customerExternalId ? { cust: customerExternalId } : {},
    );
    return rows.map((r) => ({
      externalId: r.externalid!,
      internalId: String(r.id),
      customerExternalId: r.cust_eid!,
      tranId: r.tranid!,
      tranDate: r.trandate!,
      dueDate: r.duedate!,
      currency: r.currency!,
      total: r.total!,
      amountRemaining: r.remaining!,
      disputed: r.disputed === 'T',
      collectionStage: (r.stage as Invoice['collectionStage']) || 'NONE',
    }));
  }

  async getInvoice(externalId: string): Promise<Invoice | undefined> {
    return (await this.listOpenInvoices()).find((i) => i.externalId === externalId);
  }

  async setInvoiceCollectionStage(externalId: string, stage: Invoice['collectionStage']): Promise<void> {
    await this.request('PATCH', `/record/v1/invoice/eid:${encodeURIComponent(externalId)}`, {
      custbody_nsd_collection_stage: stage,
    });
  }

  async setInvoiceDispute(externalId: string, disputed: boolean): Promise<void> {
    await this.request('PATCH', `/record/v1/invoice/eid:${encodeURIComponent(externalId)}`, {
      custbody_nsd_dispute: disputed,
    });
  }

  createCustomerPayment(input: CreateCustomerPaymentInput): Promise<UpsertResult> {
    return this.createOnce('transaction', 'customerPayment', input.externalId, async () => ({
      customer: { id: await this.requireId('customer', input.customerExternalId) },
      tranDate: input.tranDate,
      currency: { refName: input.currency },
      payment: Number(input.amount),
      undepFunds: true, // goes to Undeposited Funds until the settlement Deposit
      custbody_nsd_provider_ref: input.providerRef,
      apply: { items: await this.applyLines(input.applications) },
    }));
  }

  createDeposit(input: CreateDepositInput): Promise<UpsertResult> {
    return this.createOnce('transaction', 'deposit', input.externalId, async () => ({
      tranDate: input.tranDate,
      currency: { refName: input.currency },
      custbody_nsd_provider_ref: input.providerRef,
      payment: {
        items: await Promise.all(
          input.paymentExternalIds.map(async (e) => ({
            id: { id: await this.requireId('transaction', e) },
            deposit: true,
          })),
        ),
      },
      // Provider fee as a "cash back" line so the deposit total equals the NET amount the bank receives.
      cashBack: { items: [{ amount: Number(input.fees), memo: 'Payment provider fees' }] },
    }));
  }

  createCustomerRefund(input: CreateCustomerRefundInput): Promise<UpsertResult> {
    return this.createOnce('transaction', 'customerRefund', input.externalId, async () => ({
      customer: { id: await this.requireId('customer', input.customerExternalId) },
      tranDate: input.tranDate,
      currency: { refName: input.currency },
      custbody_nsd_provider_ref: input.providerRef,
      memo: `Refund of ${input.paymentExternalId}`,
    }));
  }

  async listTransactions(fromDate: string, toDate: string): Promise<NsTransactionSummary[]> {
    const rows = await this.suiteql<Record<string, string>>('settlement_matching', {
      from_date: { date: fromDate },
      to_date: { date: toDate },
    });
    return rows.map((r) => ({
      externalId: r.externalid!,
      internalId: String(r.id),
      type: r.type as NsTransactionSummary['type'],
      tranDate: String(r.trandate).slice(0, 10),
      amount: String(r.amount),
      currency: r.currency!,
      providerRef: r.provider_ref || undefined,
    }));
  }

  recordReconciliation(input: ReconciliationRecordInput): Promise<UpsertResult> {
    // Custom records are addressed by their script ID in REST, and in SuiteQL by the same name.
    return this.createOnce(
      'customrecord_nsd_recon_match',
      'customrecord_nsd_recon_match',
      input.matchId,
      async () => ({
        name: `${input.rule} ${input.bankLineRef}`.slice(0, 300),
        custrecord_nsd_rm_bank_line_ref: input.bankLineRef,
        custrecord_nsd_rm_txn_ref: input.txnExternalIds.join(',').slice(0, 300),
        custrecord_nsd_rm_rule: input.rule,
        custrecord_nsd_rm_confidence: Math.round(input.confidence * 100),
        custrecord_nsd_rm_status: 'APPROVED',
        custrecord_nsd_rm_reviewer: input.reviewer,
        custrecord_nsd_rm_amount: Number(input.amount),
      }),
    );
  }

  async updateIntegrationStatus(
    recordType: string,
    externalId: string,
    status: IntegrationStatus,
    detail: { correlationId?: string; errorDetail?: string; providerRef?: string } = {},
  ): Promise<void> {
    await this.request('PATCH', `/record/v1/${recordType}/eid:${encodeURIComponent(externalId)}`, {
      custbody_nsd_int_status: status,
      ...(detail.correlationId ? { custbody_nsd_correlation_id: detail.correlationId } : {}),
      ...(detail.errorDetail ? { custbody_nsd_error_detail: detail.errorDetail.slice(0, 3900) } : {}),
      ...(detail.providerRef ? { custbody_nsd_provider_ref: detail.providerRef } : {}),
    });
  }
}
