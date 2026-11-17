/**
 * Customer portal API (used by portal/local-prototype, and the contract an SCMA extension would call).
 *
 * SECURITY MODEL: every endpoint here uses ONLY the customer ID from the authenticated token
 * (req.principal.subject). No endpoint accepts a customer ID from the URL or body. A customer therefore
 * cannot ask for someone else's data, even by editing the request. This is enforced on the SERVER. The
 * UI hiding things is not security.
 *
 * PENDING VERSUS SETTLED: customers see plain-language statuses:
 *   - "Payment received – processing": the provider confirmed it, but funds are not yet settled to Northstar;
 *   - "Completed": the settlement was deposited.
 * This avoids the support calls that "why does my invoice still show a balance?" causes.
 */
import { Router } from 'express';
import Decimal from 'decimal.js';
import type { Container } from '../../container';
import { agingBucket, daysPastDue, type PaymentIntent } from '../../domain/ar';
import { NotFoundError } from '../../shared/errors';
import { isoDate } from '../../shared/util';
import { requireRole } from '../http';

export type PortalPaymentStatus =
  | 'Awaiting payment'
  | 'Authorized – pending capture'
  | 'Payment received – processing'
  | 'Completed'
  | 'Failed'
  | 'Cancelled'
  | 'Refunded'
  | 'Partially refunded'
  | 'Reversed (chargeback)';

export function portalStatus(intent: PaymentIntent, settled: boolean): PortalPaymentStatus {
  switch (intent.status) {
    case 'REQUIRES_PAYMENT':
      return 'Awaiting payment';
    case 'AUTHORIZED':
      return 'Authorized – pending capture';
    case 'SUCCEEDED':
      return settled ? 'Completed' : 'Payment received – processing';
    case 'FAILED':
      return 'Failed';
    case 'CANCELED':
      return 'Cancelled';
    case 'REFUNDED':
      return 'Refunded';
    case 'PARTIALLY_REFUNDED':
      return 'Partially refunded';
    case 'RETURNED':
      return 'Reversed (chargeback)';
  }
}

export function portalRoutes(c: Container): Router {
  const r = Router();
  r.use('/portal', requireRole('customer'));

  r.get('/portal/me', async (req, res) => {
    const customer = await c.netsuite.getCustomer(req.principal!.subject);
    if (!customer) throw new NotFoundError('Customer');
    // Only display-safe fields: no internal IDs.
    res.json({
      customerExternalId: customer.externalId,
      companyName: customer.companyName,
      currency: customer.currency,
    });
  });

  r.get('/portal/statement', async (req, res) => {
    const me = req.principal!.subject;
    const today = isoDate(c.clock.now());
    const [invoices, intents, settlements] = await Promise.all([
      c.netsuite.listOpenInvoices(me),
      c.ar.listIntents(me),
      c.ar.listSettlements(),
    ]);
    const settledIntentIds = new Set(
      settlements.filter((s) => s.status === 'POSTED').flatMap((s) => s.payments.map((p) => p.intentId)),
    );
    // Invoices with a payment in flight are shown as "payment pending" so customers do not pay twice.
    const pendingInvoices = new Set(
      intents
        .filter((i) => ['REQUIRES_PAYMENT', 'AUTHORIZED'].includes(i.status))
        .flatMap((i) => i.applications.map((a) => a.docExternalId)),
    );

    const balances = new Map<string, Decimal>();
    for (const inv of invoices)
      balances.set(inv.currency, (balances.get(inv.currency) ?? new Decimal(0)).plus(inv.amountRemaining));

    res.json({
      asOf: today,
      openBalance: [...balances].map(([currency, amount]) => ({ currency, amount: amount.toFixed(2) })),
      invoices: invoices
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
        .map((inv) => {
          const days = daysPastDue(inv.dueDate, today);
          return {
            externalId: inv.externalId,
            number: inv.tranId,
            dueDate: inv.dueDate,
            currency: inv.currency,
            total: inv.total,
            amountDue: inv.amountRemaining,
            state: inv.disputed
              ? 'disputed'
              : pendingInvoices.has(inv.externalId)
                ? 'payment_pending'
                : days > 0
                  ? 'overdue'
                  : 'open',
            daysOverdue: Math.max(0, days),
            agingBucket: agingBucket(days),
          };
        }),
      payments: intents
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .map((i) => ({
          id: i.id,
          createdAt: i.createdAt,
          amount: i.amount,
          currency: i.currency,
          invoices: i.applications.map((a) => a.docExternalId),
          status: portalStatus(i, settledIntentIds.has(i.id)),
          refundedAmount: i.refundedAmount,
        })),
    });
  });

  return r;
}
