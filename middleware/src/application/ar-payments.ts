/**
 * Accounts Receivable payment service: online customer payments, refunds, chargebacks and settlements.
 *
 *  createIntent()  customer or AR clerk → validates invoice ownership → hosted checkout session at the provider
 *  capture()/void() AR clerk (manual-capture mode only)
 *  refund()        AR clerk → provider refund. The webhook confirms it, and THEN NetSuite is updated.
 *  handleEvent()   called for each verified webhook (see webhooks.ts). Every branch is idempotent.
 *
 * NetSuite postings (job handlers, so they get retries and the DLQ):
 *  netsuite.customer_payment.post   on payment.succeeded  → Customer Payment (to Undeposited Funds)
 *  netsuite.customer_refund.post    on refund.succeeded   → Customer Refund
 *  netsuite.customer_payment.return on payment.returned   → reversal (Customer Refund "-RET"; POLICY TO REVIEW)
 *  netsuite.deposit.post            on settlement.paid    → Deposit of NET amount with the fees as a separate line
 */
import Decimal from 'decimal.js';
import type { AuditService } from './audit';
import type { Dispatcher } from './dispatcher';
import type { JobRunner } from './jobs';
import type { NetSuitePort } from './ports/netsuite';
import type { PaymentProviderPort, WebhookEvent } from './ports/payment-provider';
import type { Store } from './ports/store';
import {
  allocateOldestFirst,
  canMoveIntent,
  type IntentStatus,
  type PaymentIntent,
  type Settlement,
} from '../domain/ar';
import { currentActor } from '../shared/context';
import { BusinessRuleError, ConflictError, NotFoundError, TransientError } from '../shared/errors';
import { isoDate, newId, type Clock } from '../shared/util';

export const TOPIC_POST_CUSTOMER_PAYMENT = 'netsuite.customer_payment.post';
export const TOPIC_POST_CUSTOMER_REFUND = 'netsuite.customer_refund.post';
export const TOPIC_RETURN_CUSTOMER_PAYMENT = 'netsuite.customer_payment.return';
export const TOPIC_POST_DEPOSIT = 'netsuite.deposit.post';

export interface IntentRecord extends PaymentIntent {
  succeededOn?: string;
  refunds: { refundId: string; amount: string; netsuiteRefundId?: string }[];
}

export interface ArDeps {
  store: Store;
  netsuite: NetSuitePort;
  provider: PaymentProviderPort;
  audit: AuditService;
  jobs: JobRunner;
  dispatcher: Dispatcher;
  clock: Clock;
}

export class ArPaymentService {
  constructor(private readonly d: ArDeps) {
    d.jobs.register(TOPIC_POST_CUSTOMER_PAYMENT, (p) =>
      this.postCustomerPayment((p as { intentId: string }).intentId),
    );
    d.jobs.register(TOPIC_POST_CUSTOMER_REFUND, (p) =>
      this.postRefund(p as { intentId: string; refundId: string }),
    );
    d.jobs.register(TOPIC_RETURN_CUSTOMER_PAYMENT, (p) =>
      this.postReturn((p as { intentId: string }).intentId),
    );
    d.jobs.register(TOPIC_POST_DEPOSIT, (p) =>
      this.postDeposit((p as { settlementId: string }).settlementId),
    );
  }

  private intents() {
    return this.d.store.repo<IntentRecord>('payment_intents');
  }
  private settlements() {
    return this.d.store.repo<Settlement>('settlements');
  }

  async getIntent(id: string): Promise<IntentRecord> {
    const i = await this.intents().get(id);
    if (!i) throw new NotFoundError(`Payment intent ${id}`);
    return i;
  }

  listIntents(customerExternalId: string): Promise<IntentRecord[]> {
    return this.intents().list({ customerExternalId });
  }

  private move(i: IntentRecord, to: IntentStatus, eventId?: string): boolean {
    if (i.status === to && to !== 'PARTIALLY_REFUNDED') return false; // duplicate event: nothing to do
    if (!canMoveIntent(i.status, to)) {
      throw new ConflictError(
        'ILLEGAL_STATE_TRANSITION',
        `Payment intent ${i.id} cannot move ${i.status} → ${to}`,
      );
    }
    i.history.push({
      from: i.status,
      to,
      at: this.d.clock.now().toISOString(),
      eventId,
      actor: currentActor(),
    });
    i.status = to;
    return true;
  }

  // ------------------------------------------------------------------ create intent

  async createIntent(input: {
    customerExternalId: string;
    invoiceExternalIds: string[];
    amount?: string;
    captureMode?: 'automatic' | 'manual';
  }): Promise<IntentRecord> {
    // Authorization happens HERE, on the server: only this customer's OPEN invoices can be paid.
    const open = await this.d.netsuite.listOpenInvoices(input.customerExternalId);
    const selected = open.filter((i) => input.invoiceExternalIds.includes(i.externalId));
    const missing = input.invoiceExternalIds.filter((id) => !selected.some((s) => s.externalId === id));
    if (missing.length) throw new NotFoundError(`Open invoice(s) ${missing.join(', ')}`); // 404: do not reveal other customers' invoices

    const currencies = new Set(selected.map((s) => s.currency));
    if (currencies.size !== 1)
      throw new BusinessRuleError('MIXED_CURRENCIES', 'All invoices in one payment must share a currency');
    const currency = [...currencies][0]!;
    const due = selected.reduce((s, i) => s.plus(i.amountRemaining), new Decimal(0));
    const amount = new Decimal(input.amount ?? due);
    if (amount.lte(0) || amount.gt(due))
      throw new BusinessRuleError('INVALID_AMOUNT', `Amount must be between 0.01 and ${due.toFixed(2)}`);

    // Prevent two simultaneous online payments for the same invoice (a double-payment risk).
    const busy = (await this.intents().list({ customerExternalId: input.customerExternalId })).filter(
      (x) =>
        ['REQUIRES_PAYMENT', 'AUTHORIZED'].includes(x.status) &&
        x.applications.some((a) => input.invoiceExternalIds.includes(a.docExternalId)),
    );
    if (busy.length)
      throw new ConflictError(
        'PAYMENT_ALREADY_IN_PROGRESS',
        `Invoice already has an open payment (${busy[0]!.id})`,
      );

    const id = newId('PAYI');
    const captureMode = input.captureMode ?? 'automatic';
    const session = await this.d.provider.createCheckoutSession({
      intentId: id,
      amount: amount.toFixed(2),
      currency,
      customerRef: input.customerExternalId,
      captureMode,
      idempotencyKey: id, // our id doubles as the provider idempotency key
    });
    const now = this.d.clock.now().toISOString();
    const intent: IntentRecord = {
      id,
      customerExternalId: input.customerExternalId,
      currency,
      amount: amount.toFixed(2),
      applications: allocateOldestFirst(amount.toFixed(2), selected),
      status: 'REQUIRES_PAYMENT',
      captureMode,
      providerRef: session.sessionId,
      checkoutUrl: session.checkoutUrl,
      refundedAmount: '0.00',
      refunds: [],
      createdAt: now,
      createdBy: currentActor(),
      history: [{ from: null, to: 'REQUIRES_PAYMENT', at: now, actor: currentActor() }],
    };
    await this.intents().insert(intent);
    await this.d.audit.record({
      action: 'PAYMENT_INTENT_CREATED',
      entityType: 'payment_intent',
      entityId: id,
      outcome: 'SUCCESS',
      details: { amount: intent.amount, currency, invoices: input.invoiceExternalIds },
    });
    return intent;
  }

  // ------------------------------------------------------------------ clerk actions

  async capture(id: string): Promise<IntentRecord> {
    const i = await this.getIntent(id);
    if (i.status !== 'AUTHORIZED')
      throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Intent is ${i.status}, expected AUTHORIZED`);
    await this.d.provider.capture(i.providerRef, `capture-${i.id}`);
    return this.getIntent(id);
  }

  async void(id: string): Promise<IntentRecord> {
    const i = await this.getIntent(id);
    if (i.status !== 'AUTHORIZED')
      throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Intent is ${i.status}, expected AUTHORIZED`);
    await this.d.provider.void(i.providerRef, `void-${i.id}`);
    return this.getIntent(id);
  }

  async refund(
    id: string,
    amount: string,
    reason: string,
    requestKey: string,
  ): Promise<{ refundId: string }> {
    const i = await this.getIntent(id);
    if (!['SUCCEEDED', 'PARTIALLY_REFUNDED'].includes(i.status))
      throw new ConflictError('ILLEGAL_STATE_TRANSITION', `Cannot refund a ${i.status} payment`);
    const refundable = new Decimal(i.amount).minus(i.refundedAmount);
    if (new Decimal(amount).lte(0) || new Decimal(amount).gt(refundable)) {
      throw new BusinessRuleError(
        'REFUND_EXCEEDS_PAYMENT',
        `Refund must be between 0.01 and ${refundable.toFixed(2)}`,
      );
    }
    const r = await this.d.provider.refund(i.providerRef, amount, `refund-${i.id}-${requestKey}`);
    await this.d.audit.record({
      action: 'REFUND_REQUESTED',
      entityType: 'payment_intent',
      entityId: id,
      outcome: 'SUCCESS',
      details: { amount, reason, refundId: r.refundId },
    });
    return r;
  }

  // ------------------------------------------------------------------ webhook events

  /** Applies one verified provider event. Safe to call more than once for the same event. */
  async handleEvent(e: WebhookEvent): Promise<string> {
    if (e.type === 'settlement.paid') return this.handleSettlement(e);

    const intent = await this.getIntent(e.data.intentId);
    if (intent.providerRef !== e.data.sessionId)
      throw new BusinessRuleError('PROVIDER_REF_MISMATCH', 'Event session does not match the intent');
    const amountMatches = (amount: string, currency: string) =>
      new Decimal(amount).equals(intent.amount) && currency === intent.currency;
    let follow: { topic: string; payload: unknown } | undefined;

    switch (e.type) {
      case 'payment.authorized':
        if (!amountMatches(e.data.amount, e.data.currency))
          throw new BusinessRuleError('AMOUNT_MISMATCH', 'Authorized amount differs from intent');
        if (!this.move(intent, 'AUTHORIZED', e.id)) return 'duplicate';
        break;
      case 'payment.succeeded':
        if (!amountMatches(e.data.amount, e.data.currency))
          throw new BusinessRuleError('AMOUNT_MISMATCH', 'Captured amount differs from intent');
        if (!this.move(intent, 'SUCCEEDED', e.id)) return 'duplicate';
        intent.succeededOn = isoDate(new Date(e.created));
        follow = { topic: TOPIC_POST_CUSTOMER_PAYMENT, payload: { intentId: intent.id } };
        break;
      case 'payment.failed':
        if (!this.move(intent, 'FAILED', e.id)) return 'duplicate';
        intent.failureReason = e.data.reason;
        break;
      case 'payment.voided':
        if (!this.move(intent, 'CANCELED', e.id)) return 'duplicate';
        break;
      case 'refund.succeeded': {
        if (intent.refunds.some((r) => r.refundId === e.data.refundId)) return 'duplicate';
        intent.refunds.push({ refundId: e.data.refundId, amount: e.data.amount });
        intent.refundedAmount = new Decimal(intent.refundedAmount).plus(e.data.amount).toFixed(2);
        this.move(
          intent,
          new Decimal(intent.refundedAmount).gte(intent.amount) ? 'REFUNDED' : 'PARTIALLY_REFUNDED',
          e.id,
        );
        follow = {
          topic: TOPIC_POST_CUSTOMER_REFUND,
          payload: { intentId: intent.id, refundId: e.data.refundId },
        };
        break;
      }
      case 'payment.returned':
        if (!this.move(intent, 'RETURNED', e.id)) return 'duplicate';
        intent.failureReason = `chargeback: ${e.data.reasonCode}`;
        follow = { topic: TOPIC_RETURN_CUSTOMER_PAYMENT, payload: { intentId: intent.id } };
        break;
    }

    await this.intents().upsert(intent);
    await this.d.audit.record({
      action: `PROVIDER_${e.type.toUpperCase().replace('.', '_')}`,
      entityType: 'payment_intent',
      entityId: intent.id,
      outcome: 'SUCCESS',
      source: 'webhook',
      details: { eventId: e.id, status: intent.status },
    });
    if (follow) await this.d.dispatcher.dispatch(follow.topic, follow.payload, { sourceRef: intent.id });
    return intent.status;
  }

  private async handleSettlement(e: Extract<WebhookEvent, { type: 'settlement.paid' }>): Promise<string> {
    const d = e.data;
    if (await this.settlements().get(d.settlementId)) return 'duplicate';

    // Verify the provider's arithmetic before booking anything: gross − fees must equal net, per line and in total.
    const lineErrors = d.payments
      .filter((p) => !new Decimal(p.gross).minus(p.fee).equals(p.net))
      .map((p) => p.intentId);
    const totalsOk =
      new Decimal(d.gross).minus(d.fees).equals(d.net) &&
      d.payments.reduce((s, p) => s.plus(p.net), new Decimal(0)).equals(d.net) &&
      d.payments.reduce((s, p) => s.plus(p.fee), new Decimal(0)).equals(d.fees);
    const settlement: Settlement = {
      id: d.settlementId,
      provider: this.d.provider.name,
      status: lineErrors.length || !totalsOk ? 'MISMATCH' : 'RECEIVED',
      date: d.date,
      currency: d.currency,
      gross: d.gross,
      fees: d.fees,
      net: d.net,
      payments: d.payments.map((p) => ({
        intentId: p.intentId,
        providerPaymentId: p.sessionId,
        gross: p.gross,
        fee: p.fee,
        net: p.net,
      })),
      error:
        lineErrors.length || !totalsOk
          ? `Settlement arithmetic mismatch (${lineErrors.join(', ') || 'totals'})`
          : undefined,
    };
    await this.settlements().insert(settlement);
    await this.d.audit.record({
      action: 'SETTLEMENT_RECEIVED',
      entityType: 'settlement',
      entityId: settlement.id,
      outcome: settlement.status === 'MISMATCH' ? 'FAILURE' : 'SUCCESS',
      source: 'webhook',
      details: { gross: d.gross, fees: d.fees, net: d.net, count: d.payments.length },
    });
    // A mismatch goes to finance as an exception. We never post numbers we do not trust.
    if (settlement.status === 'RECEIVED')
      await this.d.dispatcher.dispatch(
        TOPIC_POST_DEPOSIT,
        { settlementId: settlement.id },
        { sourceRef: settlement.id },
      );
    return settlement.status;
  }

  listSettlements(): Promise<Settlement[]> {
    return this.settlements().list();
  }

  // ------------------------------------------------------------------ NetSuite postings

  private async postCustomerPayment(intentId: string): Promise<{ internalId: string }> {
    const i = await this.getIntent(intentId);
    if (i.netsuitePaymentId) return { internalId: i.netsuitePaymentId };
    const r = await this.d.netsuite.createCustomerPayment({
      externalId: i.id,
      customerExternalId: i.customerExternalId,
      currency: i.currency,
      tranDate: i.succeededOn ?? isoDate(this.d.clock.now()),
      amount: i.amount,
      applications: i.applications,
      providerRef: i.providerRef,
    });
    await this.intents().upsert({ ...(await this.getIntent(intentId)), netsuitePaymentId: r.internalId });
    await this.d.audit.record({
      action: 'NETSUITE_CUSTOMER_PAYMENT_CREATED',
      entityType: 'payment_intent',
      entityId: i.id,
      outcome: 'SUCCESS',
      source: 'jobs',
      details: { internalId: r.internalId, created: r.created },
    });
    return { internalId: r.internalId };
  }

  private async postRefund(p: { intentId: string; refundId: string }): Promise<void> {
    const i = await this.getIntent(p.intentId);
    const refund = i.refunds.find((r) => r.refundId === p.refundId);
    if (!refund || refund.netsuiteRefundId) return;
    // The original payment must exist in NetSuite before it can be refunded there.
    if (!i.netsuitePaymentId)
      throw new TransientError('PAYMENT_NOT_POSTED_YET', 'Customer payment not yet in NetSuite');
    const r = await this.d.netsuite.createCustomerRefund({
      externalId: refund.refundId,
      customerExternalId: i.customerExternalId,
      currency: i.currency,
      tranDate: isoDate(this.d.clock.now()),
      amount: refund.amount,
      paymentExternalId: i.id,
      providerRef: refund.refundId,
    });
    refund.netsuiteRefundId = r.internalId;
    await this.intents().upsert(i);
  }

  private async postReturn(intentId: string): Promise<void> {
    const i = await this.getIntent(intentId);
    if (!i.netsuitePaymentId)
      throw new TransientError('PAYMENT_NOT_POSTED_YET', 'Customer payment not yet in NetSuite');
    const outstanding = new Decimal(i.amount).minus(i.refundedAmount);
    if (outstanding.lte(0)) return;
    // ⚠️ Accounting policy to review (accounting-event-matrix R5): here a chargeback is booked as a refund
    // that re-opens the invoice. Some companies book it to a separate "chargebacks" account instead.
    await this.d.netsuite.createCustomerRefund({
      externalId: `${i.id}-RET`,
      customerExternalId: i.customerExternalId,
      currency: i.currency,
      tranDate: isoDate(this.d.clock.now()),
      amount: outstanding.toFixed(2),
      paymentExternalId: i.id,
      providerRef: i.providerRef,
    });
  }

  private async postDeposit(settlementId: string): Promise<{ internalId: string }> {
    const s = await this.settlements().get(settlementId);
    if (!s) throw new NotFoundError(`Settlement ${settlementId}`);
    if (s.netsuiteDepositId) return { internalId: s.netsuiteDepositId };
    // Every payment in the deposit must already exist in NetSuite. If not yet, retry later.
    for (const p of s.payments) {
      if (!(await this.getIntent(p.intentId)).netsuitePaymentId)
        throw new TransientError('PAYMENT_NOT_POSTED_YET', `Payment ${p.intentId} not yet in NetSuite`);
    }
    const r = await this.d.netsuite.createDeposit({
      externalId: s.id,
      currency: s.currency,
      tranDate: s.date,
      paymentExternalIds: s.payments.map((p) => p.intentId),
      gross: s.gross,
      fees: s.fees,
      net: s.net,
      providerRef: s.id,
    });
    await this.settlements().upsert({ ...s, status: 'POSTED', netsuiteDepositId: r.internalId });
    await this.d.audit.record({
      action: 'NETSUITE_DEPOSIT_CREATED',
      entityType: 'settlement',
      entityId: s.id,
      outcome: 'SUCCESS',
      source: 'jobs',
      details: { internalId: r.internalId, net: s.net, fees: s.fees },
    });
    return { internalId: r.internalId };
  }
}
