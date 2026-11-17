/**
 * Read endpoints for NetSuite master data and open documents.
 *
 * These pass through to NetSuite (the system of record) instead of reading a local copy. WHY: a
 * local copy of balances would go stale. The trade-off is that each call costs NetSuite API
 * capacity, so they are restricted to internal roles, and the portal uses its own scoped endpoints
 * (Phase 9).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { NotFoundError } from '../../shared/errors';
import { parse, requireRole } from '../http';

const ExternalIdParam = z.object({
  externalId: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, 'invalid externalId'),
});

export function masterDataRoutes(c: Container): Router {
  const r = Router();

  r.get('/vendors', requireRole('ap_maker', 'ap_checker', 'ops'), async (_req, res) => {
    // Never return bank tokens to API clients: they do not need them.
    const vendors = (await c.netsuite.listVendors()).map(({ bankToken: _t, ...v }) => v);
    res.json({ items: vendors });
  });

  r.get('/vendors/:externalId', requireRole('ap_maker', 'ap_checker', 'ops'), async (req, res) => {
    const { externalId } = parse(ExternalIdParam, req.params);
    const v = await c.netsuite.getVendor(externalId);
    if (!v) throw new NotFoundError(`Vendor ${externalId}`);
    const { bankToken: _t, ...safe } = v;
    res.json(safe);
  });

  r.get('/customers', requireRole('ar_clerk', 'ops'), async (_req, res) => {
    res.json({ items: await c.netsuite.listCustomers() });
  });

  r.get('/customers/:externalId', requireRole('ar_clerk', 'ops'), async (req, res) => {
    const { externalId } = parse(ExternalIdParam, req.params);
    const cust = await c.netsuite.getCustomer(externalId);
    if (!cust) throw new NotFoundError(`Customer ${externalId}`);
    res.json(cust);
  });

  r.get('/bills/open', requireRole('ap_maker', 'ap_checker', 'ops'), async (_req, res) => {
    res.json({ items: await c.netsuite.listOpenVendorBills() });
  });

  r.get('/invoices/open', requireRole('ar_clerk', 'ops'), async (req, res) => {
    const q = parse(z.object({ customer: z.string().max(64).optional() }), req.query);
    res.json({ items: await c.netsuite.listOpenInvoices(q.customer) });
  });

  r.get('/audit', requireRole('ops', 'ap_checker'), async (req, res) => {
    const q = parse(
      z.union([
        z.object({ entityType: z.string().min(1).max(50), entityId: z.string().min(1).max(100) }),
        z.object({ correlationId: z.string().min(8).max(100) }),
      ]),
      req.query,
    );
    const items =
      'correlationId' in q
        ? await c.audit.byCorrelation(q.correlationId)
        : await c.audit.forEntity(q.entityType, q.entityId);
    res.json({ items });
  });

  return r;
}
