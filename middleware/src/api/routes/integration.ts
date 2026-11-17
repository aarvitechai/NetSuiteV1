/**
 * Integration and operations endpoints:
 *   POST /sync/vendors, /sync/customers   – push master data to NetSuite (idempotent per key)
 *   GET  /jobs/:id                        – inspect one integration job
 *   GET  /dead-letters                    – list the DLQ
 *   POST /dead-letters/:id/replay         – re-run with the original payload and correlation ID
 *   POST /dead-letters/:id/discard        – close without re-running (a reason is mandatory)
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { NotFoundError } from '../../shared/errors';
import { idempotent, parse, requireRole } from '../http';

const SyncBody = z.object({ records: z.array(z.unknown()).min(1).max(500) });
const IdParam = z.object({ id: z.string().regex(/^[A-Z]+-[0-9a-f-]{36}$/, 'invalid id') });

export function integrationRoutes(c: Container): Router {
  const r = Router();

  r.post(
    '/sync/vendors',
    requireRole('ops'),
    idempotent(c.idempotency, 'sync.vendors', async (req) => {
      const { records } = parse(SyncBody, req.body);
      return { status: 200, body: await c.masterData.syncVendors(records) };
    }),
  );

  r.post(
    '/sync/customers',
    requireRole('ops'),
    idempotent(c.idempotency, 'sync.customers', async (req) => {
      const { records } = parse(SyncBody, req.body);
      return { status: 200, body: await c.masterData.syncCustomers(records) };
    }),
  );

  r.get('/jobs/:id', requireRole('ops'), async (req, res) => {
    const { id } = parse(IdParam, req.params);
    const job = await c.jobs.getJob(id);
    if (!job) throw new NotFoundError(`Job ${id}`);
    res.json(job);
  });

  r.get('/dead-letters', requireRole('ops'), async (req, res) => {
    const { status } = parse(
      z.object({ status: z.enum(['OPEN', 'REPLAYED', 'DISCARDED']).default('OPEN') }),
      req.query,
    );
    res.json({ items: await c.jobs.listDeadLetters(status) });
  });

  r.post('/dead-letters/:id/replay', requireRole('ops'), async (req, res) => {
    const { id } = parse(IdParam, req.params);
    res.json(await c.jobs.replay(id));
  });

  r.post('/dead-letters/:id/discard', requireRole('ops'), async (req, res) => {
    const { id } = parse(IdParam, req.params);
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    res.json(await c.jobs.discard(id, reason));
  });

  return r;
}
