/**
 * Accounts Payable endpoints.
 *
 * Role separation (segregation of duties):
 *   ap_maker   – may see proposals and CREATE batches
 *   ap_checker – may APPROVE or REJECT batches (and never ones they made: checked in the service)
 *   ops        – may SUBMIT approved batches and poll bank files (technical operations)
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { idempotent, parse, requireRole } from '../http';

const Criteria = z.object({
  currency: z.string().regex(/^[A-Z]{3}$/),
  rail: z.enum(['ACH', 'WIRE', 'VCARD']),
  windowDays: z.coerce.number().int().min(0).max(90).default(7),
});
const BatchId = z.object({ id: z.string().regex(/^PB-[0-9a-f-]{36}$/, 'invalid batch id') });

export function apRoutes(c: Container): Router {
  const r = Router();

  r.get('/ap/proposal', requireRole('ap_maker', 'ap_checker'), async (req, res) => {
    res.json(await c.ap.propose(parse(Criteria, req.query)));
  });

  r.post(
    '/payment-batches',
    requireRole('ap_maker'),
    idempotent(c.idempotency, 'payment-batch.create', async (req) => {
      const body = parse(
        Criteria.extend({ billExternalIds: z.array(z.string().max(64)).max(1000).optional() }),
        req.body,
      );
      return { status: 201, body: await c.ap.createBatch(body) };
    }),
  );

  r.get('/payment-batches', requireRole('ap_maker', 'ap_checker', 'ops'), async (req, res) => {
    const { status } = parse(
      z.object({
        status: z
          .enum([
            'PENDING_APPROVAL',
            'APPROVED',
            'REJECTED',
            'SUBMITTED',
            'ACKNOWLEDGED',
            'COMPLETED',
            'FAILED',
          ])
          .optional(),
      }),
      req.query,
    );
    res.json({ items: await c.ap.listBatches(status) });
  });

  r.get('/payment-batches/:id', requireRole('ap_maker', 'ap_checker', 'ops'), async (req, res) => {
    res.json(await c.ap.getBatch(parse(BatchId, req.params).id));
  });

  r.post('/payment-batches/:id/approve', requireRole('ap_checker'), async (req, res) => {
    res.json(await c.ap.approve(parse(BatchId, req.params).id, req.principal!.subject));
  });

  r.post('/payment-batches/:id/reject', requireRole('ap_checker'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    res.json(await c.ap.reject(parse(BatchId, req.params).id, req.principal!.subject, reason));
  });

  r.post(
    '/payment-batches/:id/submit',
    requireRole('ops', 'ap_checker'),
    idempotent(c.idempotency, 'payment-batch.submit', async (req) => ({
      status: 200,
      body: await c.ap.submit(parse(BatchId, req.params).id),
    })),
  );

  r.post('/bank/inbound/poll', requireRole('ops'), async (_req, res) => {
    res.json({ results: await c.bankInbound.poll() });
  });

  return r;
}
