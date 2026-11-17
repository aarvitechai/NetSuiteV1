/**
 * PaymentProviderPort: what we need from an online payment provider (card / bank-debit acquirer).
 *
 * The provider hosts the checkout page. The customer types card details on THE PROVIDER's page, never
 * ours. We only ever receive references (session id, payment id). This keeps card data out of our
 * systems, which greatly reduces PCI DSS scope. See docs/architecture/security.md.
 */
import { z } from 'zod';

export interface CheckoutSession {
  sessionId: string; // provider reference for this payment attempt
  checkoutUrl: string; // where the customer is redirected to pay
}

export interface PaymentProviderPort {
  readonly name: string;
  createCheckoutSession(input: {
    intentId: string;
    amount: string;
    currency: string;
    customerRef: string;
    captureMode: 'automatic' | 'manual';
    idempotencyKey: string;
  }): Promise<CheckoutSession>;
  capture(sessionId: string, idempotencyKey: string): Promise<void>;
  void(sessionId: string, idempotencyKey: string): Promise<void>;
  refund(sessionId: string, amount: string, idempotencyKey: string): Promise<{ refundId: string }>;
}

/** Webhook event envelope (versioned). Each type has its own data shape. */
const Amount = z.string().regex(/^\d+(\.\d{1,2})?$/);
export const WebhookEventSchema = z.discriminatedUnion('type', [
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('payment.authorized'),
    data: z.object({ sessionId: z.string(), intentId: z.string(), amount: Amount, currency: z.string() }),
  }),
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('payment.succeeded'),
    data: z.object({ sessionId: z.string(), intentId: z.string(), amount: Amount, currency: z.string() }),
  }),
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('payment.failed'),
    data: z.object({ sessionId: z.string(), intentId: z.string(), reason: z.string() }),
  }),
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('payment.voided'),
    data: z.object({ sessionId: z.string(), intentId: z.string() }),
  }),
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('refund.succeeded'),
    data: z.object({
      refundId: z.string(),
      sessionId: z.string(),
      intentId: z.string(),
      amount: Amount,
      currency: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('payment.returned'),
    data: z.object({
      sessionId: z.string(),
      intentId: z.string(),
      amount: Amount,
      currency: z.string(),
      reasonCode: z.string(),
    }),
  }),
  z.object({
    id: z.string(),
    version: z.literal('2026-01'),
    created: z.string(),
    type: z.literal('settlement.paid'),
    data: z.object({
      settlementId: z.string(),
      date: z.string(),
      currency: z.string(),
      gross: Amount,
      fees: Amount,
      net: Amount,
      payments: z.array(
        z.object({ sessionId: z.string(), intentId: z.string(), gross: Amount, fee: Amount, net: Amount }),
      ),
    }),
  }),
]);
export type WebhookEvent = z.infer<typeof WebhookEventSchema>;
