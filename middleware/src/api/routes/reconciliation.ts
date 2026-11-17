/**
 * Reconciliation and bank-file endpoints. Decisions require the `finance` role (segregation of duties:
 * the people who pay are not the people who confirm the bank agrees).
 */
import { Router } from 'express';
import { z } from 'zod';
import type { Container } from '../../container';
import { assertSafeName } from '../../infrastructure/files/file-transport';
import { parse, requireRole } from '../http';

const MatchId = z.object({ id: z.string().regex(/^RM-[0-9a-f-]{36}$/, 'invalid match id') });
const Date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export function reconciliationRoutes(c: Container): Router {
  const r = Router();
  const read = requireRole('finance', 'ops');

  r.post('/reconciliation/statements', requireRole('finance', 'ops'), async (req, res) => {
    const { fileName, content } = parse(
      z.object({ fileName: z.string().regex(/\.(csv|xml)$/i), content: z.string().min(1).max(5_000_000) }),
      req.body,
    );
    assertSafeName(fileName);
    res.json(await c.bankInbound.ingest(fileName, content));
  });

  r.get('/reconciliation/lines', read, async (req, res) => {
    const { status } = parse(
      z.object({ status: z.enum(['UNMATCHED', 'MATCHED', 'SUGGESTED', 'EXCEPTION']).optional() }),
      req.query,
    );
    res.json({ items: await c.reconciliation.listLines(status) });
  });

  r.get('/reconciliation/matches', read, async (req, res) => {
    const { status } = parse(
      z.object({
        status: z
          .enum(['AUTO_APPROVED', 'SUGGESTED', 'APPROVED', 'REJECTED', 'EXCEPTION', 'RESOLVED'])
          .optional(),
      }),
      req.query,
    );
    res.json({ items: await c.reconciliation.listMatches(status) });
  });

  r.post('/reconciliation/matches/:id/approve', requireRole('finance'), async (req, res) => {
    res.json(await c.reconciliation.approve(parse(MatchId, req.params).id));
  });

  r.post('/reconciliation/matches/:id/reject', requireRole('finance'), async (req, res) => {
    const { reason } = parse(z.object({ reason: z.string().trim().min(5).max(500) }), req.body);
    res.json(await c.reconciliation.reject(parse(MatchId, req.params).id, reason));
  });

  r.post('/reconciliation/manual-match', requireRole('finance'), async (req, res) => {
    const body = parse(
      z.object({
        bankLineIds: z.array(z.string().max(40)).min(1).max(50),
        nsExternalIds: z.array(z.string().max(80)).min(1).max(50),
        reason: z.string().trim().min(5).max(500),
      }),
      req.body,
    );
    res.json(await c.reconciliation.manualMatch(body));
  });

  r.post('/reconciliation/rematch', requireRole('finance', 'ops'), async (_req, res) => {
    res.json(await c.reconciliation.rematch());
  });

  r.get('/reconciliation/report', read, async (req, res) => {
    const { from, to } = parse(z.object({ from: Date, to: Date }), req.query);
    res.json(await c.reconciliation.report(from, to));
  });

  /** Period control totals: proof that counts and amounts balance across every system (UAT evidence). */
  r.get('/reconciliation/control-totals', read, async (req, res) => {
    const { from, to } = parse(z.object({ from: Date, to: Date }), req.query);
    res.json(await c.controlTotals.run(from, to));
  });

  r.get('/bank/files/quarantine', requireRole('ops'), async (_req, res) => {
    res.json({ items: await c.bankInbound.listQuarantined() });
  });

  r.post('/bank/files/quarantine/:name/replay', requireRole('ops'), async (req, res) => {
    const { name } = parse(z.object({ name: z.string().max(200) }), req.params);
    assertSafeName(name);
    res.json(await c.bankInbound.replayQuarantined(name));
  });

  return r;
}
