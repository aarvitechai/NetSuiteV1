/**
 * Accounts Receivable endpoints.
 *
 * Authorization rules:
 *  - customer role: may create and read payment intents ONLY for their own customer ID (their token's
 *    subject). The body's customerExternalId is ignored for customers. We never trust it.
 *  - ar_clerk: may act for any customer, capture, void, refund, run collections and manage disputes.
 *
 * Note `.strict()` on the intent schema: unknown fields are rejected. If a client tries to send card
 * data (cardNumber, cvv…), the request fails. Card data must go to the provider's hosted page only.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { NotFoundError } from '../../shared/errors';
import { idempotent, parse, requireRole } from '../http';

const IntentId = z.object({ id: z.string().regex(/^PAYI-[0-9a-f-]{36}$/, 'invalid payment intent id') });
const Amount = z.string().regex(/^\d+(\.\d{1,2})?$/, 'amount must be a decimal string like "100.00"');
const ExternalId = z.object({ externalId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/) });

export function arRoutes(c: Container): Router {
  const r = Router();

  r.post(
    '/payment-intents',
    requireRole('customer', 'ar_clerk'),
    idempotent(c.idempotency, 'payment-intent.create', async (req) => {
      const body = parse(
        z
          .object({
            customerExternalId: z.string().max(64).optional(),
            invoiceExternalIds: z.array(z.string().max(64)).min(1).max(50),
            amount: Amount.optional(),
            captureMode: z.enum(['automatic', 'manual']).optional(),
          })
          .strict(),
        req.body,
      );
      const p = req.principal!;
      const customerExternalId = p.role === 'customer' ? p.subject : body.customerExternalId;
      if (!customerExternalId) throw new NotFoundError('customerExternalId');
      const intent = await c.ar.createIntent({
        ...body,
        customerExternalId,
        captureMode: p.role === 'customer' ? 'automatic' : body.captureMode,
      });
      return { status: 201, body: intent };
    }),
  );

  r.get('/payment-intents/:id', requireRole('customer', 'ar_clerk'), async (req, res) => {
    const intent = await c.ar.getIntent(parse(IntentId, req.params).id);
    // A customer asking for another customer's intent gets 404, not 403, so we do not even confirm that it exists.
    if (req.principal!.role === 'customer' && intent.customerExternalId !== req.principal!.subject)
      throw new NotFoundError('Payment intent');
    res.json(intent);
  });

  r.post('/payment-intents/:id/capture', requireRole('ar_clerk'), async (req, res) => {
    const intent = await c.ar.capture(parse(IntentId, req.params).id);
    await c.webhooks.drain();
    res.json(await c.ar.getIntent(intent.id));
  });

  r.post('/payment-intents/:id/void', requireRole('ar_clerk'), async (req, res) => {
    const intent = await c.ar.void(parse(IntentId, req.params).id);
    await c.webhooks.drain();
    res.json(await c.ar.getIntent(intent.id));
  });

  r.post(
    '/payment-intents/:id/refunds',
    requireRole('ar_clerk'),
    idempotent(c.idempotency, 'payment-intent.refund', async (req) => {
      const { amount, reason } = parse(
        z.object({ amount: Amount, reason: z.string().trim().min(3).max(300) }).strict(),
        req.body,
      );
      const refund = await c.ar.refund(
        parse(IntentId, req.params).id,
        amount,
        reason,
        req.header('idempotency-key')!,
      );
      return { status: 202, body: { ...refund, status: 'PENDING_PROVIDER_CONFIRMATION' } };
    }),
  );

  r.get('/settlements', requireRole('ar_clerk', 'ops'), async (_req, res) => {
    res.json({ items: await c.ar.listSettlements() });
  });

  r.get('/ar/aging', requireRole('ar_clerk', 'ops'), async (req, res) => {
    const { asOf } = parse(
      z.object({
        asOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
      req.query,
    );
    res.json(await c.collections.aging(asOf));
  });

  r.post('/ar/collections/run', requireRole('ar_clerk', 'ops'), async (req, res) => {
    const { asOf } = parse(
      z.object({
        asOf: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
      }),
      req.body ?? {},
    );
    res.json(await c.collections.run(asOf));
  });

  r.get('/ar/collections/actions', requireRole('ar_clerk', 'ops'), async (req, res) => {
    const q = parse(
      z.object({ invoice: z.string().max(64).optional(), customer: z.string().max(64).optional() }),
      req.query,
    );
    res.json({
      items: await c.collections.history({ invoiceExternalId: q.invoice, customerExternalId: q.customer }),
    });
  });

  r.post('/invoices/:externalId/dispute', requireRole('ar_clerk'), async (req, res) => {
    const { externalId } = parse(ExternalId, req.params);
    const { disputed, note } = parse(
      z.object({ disputed: z.boolean(), note: z.string().trim().min(3).max(500) }),
      req.body,
    );
    res.json(await c.collections.setDispute(externalId, disputed, note));
  });

  return r;
}
