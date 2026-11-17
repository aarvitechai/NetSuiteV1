/**
 * Operations endpoints (role ops):
 *   GET /metrics                Prometheus metrics (HTTP traffic and latency, plus the gauges below)
 *   GET /api/v1/ops/dashboard   one JSON snapshot of integration health: the "monitoring dashboard"
 *
 * Every number here maps to an SLI or alert in docs/operations/slos-and-alerts.md.
 */
import { Router } from 'express';
import type { Container } from '../../container';
import { authenticate, requireRole } from '../http';

async function snapshot(c: Container) {
  const count = async (
    collection: Parameters<Container['store']['repo']>[0],
    filter: Record<string, string>,
  ) => (await c.store.repo(collection).list(filter)).length;
  const outbox = await c.dispatcher.stats();
  const batchStatuses = [
    'PENDING_APPROVAL',
    'APPROVED',
    'SUBMITTED',
    'ACKNOWLEDGED',
    'COMPLETED',
    'FAILED',
  ] as const;
  return {
    at: c.clock.now().toISOString(),
    outbox,
    deadLetters: { open: await count('dead_letters', { status: 'OPEN' }) },
    webhooks: {
      received: await count('webhook_receipts', { status: 'RECEIVED' }),
      processed: await count('webhook_receipts', { status: 'PROCESSED' }),
      failed: await count('webhook_receipts', { status: 'FAILED' }),
    },
    paymentBatches: Object.fromEntries(
      await Promise.all(
        batchStatuses.map(async (s) => [s, await count('payment_batches', { status: s })] as const),
      ),
    ),
    reconciliation: {
      exceptions: await count('recon_matches', { status: 'EXCEPTION' }),
      awaitingApproval: await count('recon_matches', { status: 'SUGGESTED' }),
    },
    settlements: { mismatched: await count('settlements', { status: 'MISMATCH' }) },
    bankFiles: { quarantined: (await c.bankInbound.listQuarantined()).length },
    jobs: { failed: await count('integration_jobs', { status: 'FAILED' }) },
  };
}

export function opsRoutes(c: Container): Router {
  const r = Router();
  const guard = [authenticate(c.config.API_TOKENS), requireRole('ops')];

  r.get('/api/v1/ops/dashboard', ...guard, async (_req, res) => {
    res.json(await snapshot(c));
  });

  r.get('/metrics', ...guard, async (_req, res) => {
    const s = await snapshot(c);
    // Gauges are refreshed at scrape time from the store, so they are always current.
    c.metrics.set('nsd_outbox_pending', s.outbox.pending);
    c.metrics.set('nsd_outbox_oldest_pending_age_seconds', s.outbox.oldestPendingAgeSeconds);
    c.metrics.set('nsd_dead_letters_open', s.deadLetters.open);
    c.metrics.set('nsd_recon_exceptions_open', s.reconciliation.exceptions);
    c.metrics.set('nsd_bank_files_quarantined', s.bankFiles.quarantined);
    c.metrics.set('nsd_settlements_mismatched', s.settlements.mismatched);
    c.metrics.set('nsd_webhooks_failed', s.webhooks.failed);
    res.type('text/plain; version=0.0.4').send(c.metrics.render());
  });

  return r;
}
