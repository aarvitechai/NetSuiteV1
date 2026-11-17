/**
 * ⚠️ PAYMENT PROVIDER SIMULATOR: imitates a hosted-checkout card acquirer.
 *
 * It behaves like the real thing in the ways that matter for integration:
 *   - hosted checkout: we get a URL, and the "customer" pays there (completeCheckout). No card data reaches us.
 *   - asynchronous results through SIGNED webhooks (it may deliver the same event more than once);
 *   - manual capture (authorize now, capture later) or automatic capture;
 *   - refunds, chargebacks ("returns") and daily settlement with fees (2.9% + 0.30 per payment);
 *   - idempotency keys on every write call.
 *
 * Test card tokens: "tok_visa_ok" succeeds, "tok_card_declined" fails. These are provider TEST tokens.
 * They are never real card numbers.
 */
import Decimal from 'decimal.js';
import { randomUUID } from 'node:crypto';
import type {
  CheckoutSession,
  PaymentProviderPort,
  WebhookEvent,
} from '../../application/ports/payment-provider';
import { BusinessRuleError } from '../../shared/errors';
import type { Clock } from '../../shared/util';
import { signPayload } from './webhook-signature';

type SessionState = 'OPEN' | 'AUTHORIZED' | 'CAPTURED' | 'FAILED' | 'VOIDED';

interface Session {
  id: string;
  intentId: string;
  amount: string;
  currency: string;
  captureMode: 'automatic' | 'manual';
  state: SessionState;
  refunded: Decimal;
  settled: boolean;
}

export type Deliver = (rawBody: string, signatureHeader: string) => Promise<void>;

export class SimulatedPaymentProvider implements PaymentProviderPort {
  readonly name = 'simpay';
  readonly sessions = new Map<string, Session>();
  /** Every event ever emitted, so tests and demos can redeliver (simulating the provider's retries). */
  readonly events: { event: WebhookEvent; raw: string }[] = [];
  private readonly idem = new Map<string, unknown>();
  private deliver: Deliver = async () => undefined;

  constructor(
    private readonly secret: string,
    private readonly clock: Clock,
  ) {}

  /** Where webhooks are sent (in the server: an HTTP POST to /webhooks/payment-provider; in tests: supertest). */
  setDeliver(fn: Deliver): void {
    this.deliver = fn;
  }

  /** Provider-side idempotency: the same key returns the same result without doing the work again. */
  private once<T>(key: string, fn: () => T): T {
    if (this.idem.has(key)) return this.idem.get(key) as T;
    const r = fn();
    this.idem.set(key, r);
    return r;
  }

  private async emit(type: WebhookEvent['type'], data: WebhookEvent['data']): Promise<WebhookEvent> {
    const event = {
      id: `evt_${randomUUID()}`,
      version: '2026-01',
      created: this.clock.now().toISOString(),
      type,
      data,
    } as WebhookEvent;
    const raw = JSON.stringify(event);
    this.events.push({ event, raw });
    await this.deliver(raw, signPayload(this.secret, raw, Math.floor(this.clock.now().getTime() / 1000)));
    return event;
  }

  /** Re-sends an already-delivered event (providers retry when they do not get a 2xx in time). */
  async redeliver(eventId: string, opts: { resign?: boolean } = { resign: true }): Promise<void> {
    const e = this.events.find((x) => x.event.id === eventId);
    if (!e) throw new Error(`No event ${eventId}`);
    const t = Math.floor(this.clock.now().getTime() / 1000);
    await this.deliver(
      e.raw,
      opts.resign === false ? signPayload(this.secret, e.raw, t - 3600) : signPayload(this.secret, e.raw, t),
    );
  }

  private session(id: string): Session {
    const s = this.sessions.get(id);
    if (!s) throw new BusinessRuleError('PROVIDER_SESSION_NOT_FOUND', `Unknown session ${id}`);
    return s;
  }

  // ---------------- PaymentProviderPort ----------------

  async createCheckoutSession(
    input: Parameters<PaymentProviderPort['createCheckoutSession']>[0],
  ): Promise<CheckoutSession> {
    return this.once(`checkout:${input.idempotencyKey}`, () => {
      const id = `cs_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      this.sessions.set(id, {
        id,
        intentId: input.intentId,
        amount: input.amount,
        currency: input.currency,
        captureMode: input.captureMode,
        state: 'OPEN',
        refunded: new Decimal(0),
        settled: false,
      });
      return { sessionId: id, checkoutUrl: `https://checkout.simpay.example/pay/${id}` };
    });
  }

  async capture(sessionId: string, idempotencyKey: string): Promise<void> {
    if (this.idem.has(`capture:${idempotencyKey}`)) return;
    this.idem.set(`capture:${idempotencyKey}`, true);
    const s = this.session(sessionId);
    if (s.state !== 'AUTHORIZED')
      throw new BusinessRuleError('PROVIDER_INVALID_STATE', `Cannot capture a ${s.state} payment`);
    s.state = 'CAPTURED';
    await this.emit('payment.succeeded', {
      sessionId,
      intentId: s.intentId,
      amount: s.amount,
      currency: s.currency,
    });
  }

  async void(sessionId: string, idempotencyKey: string): Promise<void> {
    if (this.idem.has(`void:${idempotencyKey}`)) return;
    this.idem.set(`void:${idempotencyKey}`, true);
    const s = this.session(sessionId);
    if (s.state !== 'AUTHORIZED')
      throw new BusinessRuleError('PROVIDER_INVALID_STATE', `Cannot void a ${s.state} payment`);
    s.state = 'VOIDED';
    await this.emit('payment.voided', { sessionId, intentId: s.intentId });
  }

  async refund(sessionId: string, amount: string, idempotencyKey: string): Promise<{ refundId: string }> {
    const cached = this.idem.get(`refund:${idempotencyKey}`) as { refundId: string } | undefined;
    if (cached) return cached;
    const s = this.session(sessionId);
    if (s.state !== 'CAPTURED')
      throw new BusinessRuleError('PROVIDER_INVALID_STATE', 'Only captured payments can be refunded');
    if (s.refunded.plus(amount).gt(s.amount))
      throw new BusinessRuleError('REFUND_EXCEEDS_PAYMENT', 'Refund exceeds the captured amount');
    s.refunded = s.refunded.plus(amount);
    const result = { refundId: `re_${randomUUID().slice(0, 18)}` };
    this.idem.set(`refund:${idempotencyKey}`, result);
    await this.emit('refund.succeeded', {
      refundId: result.refundId,
      sessionId,
      intentId: s.intentId,
      amount: new Decimal(amount).toFixed(2),
      currency: s.currency,
    });
    return result;
  }

  // ---------------- simulation controls (what the customer / provider does) ----------------

  /** The customer pays on the hosted page with a TEST token. */
  async completeCheckout(
    sessionId: string,
    testToken: 'tok_visa_ok' | 'tok_card_declined',
  ): Promise<WebhookEvent> {
    const s = this.session(sessionId);
    if (testToken === 'tok_card_declined') {
      s.state = 'FAILED';
      return this.emit('payment.failed', { sessionId, intentId: s.intentId, reason: 'card_declined' });
    }
    if (s.captureMode === 'manual') {
      s.state = 'AUTHORIZED';
      return this.emit('payment.authorized', {
        sessionId,
        intentId: s.intentId,
        amount: s.amount,
        currency: s.currency,
      });
    }
    s.state = 'CAPTURED';
    return this.emit('payment.succeeded', {
      sessionId,
      intentId: s.intentId,
      amount: s.amount,
      currency: s.currency,
    });
  }

  /** The cardholder disputes the payment and the bank pulls the money back (chargeback / return). */
  async chargeback(sessionId: string, reasonCode = 'fraudulent'): Promise<WebhookEvent> {
    const s = this.session(sessionId);
    return this.emit('payment.returned', {
      sessionId,
      intentId: s.intentId,
      amount: s.amount,
      currency: s.currency,
      reasonCode,
    });
  }

  /** Fee model: 2.9% + 0.30 per captured payment, rounded half-up to cents. */
  static fee(amount: string): Decimal {
    return new Decimal(amount).times('0.029').plus('0.30').toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  }

  /** Daily payout: every captured, not-yet-settled payment is paid out net of fees, in one bank credit. */
  async settle(date: string): Promise<WebhookEvent | undefined> {
    const due = [...this.sessions.values()].filter((s) => s.state === 'CAPTURED' && !s.settled);
    if (!due.length) return undefined;
    const payments = due.map((s) => {
      const fee = SimulatedPaymentProvider.fee(s.amount);
      s.settled = true;
      return {
        sessionId: s.id,
        intentId: s.intentId,
        gross: new Decimal(s.amount).toFixed(2),
        fee: fee.toFixed(2),
        net: new Decimal(s.amount).minus(fee).toFixed(2),
      };
    });
    const sumOf = (k: 'gross' | 'fee' | 'net') =>
      payments.reduce((acc, p) => acc.plus(p[k]), new Decimal(0)).toFixed(2);
    return this.emit('settlement.paid', {
      settlementId: `po_${date.replace(/-/g, '')}_${randomUUID().slice(0, 6)}`,
      date,
      currency: due[0]!.currency,
      gross: sumOf('gross'),
      fees: sumOf('fee'),
      net: sumOf('net'),
      payments,
    });
  }
}
