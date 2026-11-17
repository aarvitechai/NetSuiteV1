/**
 * Health endpoints (no authentication, no sensitive data).
 *
 *  GET /health → "liveness": the process is running. If this fails, the orchestrator restarts the container.
 *  GET /ready  → "readiness": dependencies (DB, NetSuite) are reachable. If this fails, the load balancer
 *                stops sending traffic, but the container is NOT restarted. Restarting would not fix
 *                NetSuite being down.
 */
import { Router } from 'express';
import type { Container } from '../../container';

async function check(fn: () => Promise<void>, timeoutMs = 3000): Promise<'ok' | string> {
  try {
    await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
    ]);
    return 'ok';
  } catch (e) {
    return `error: ${(e as Error).message}`;
  }
}

export function healthRoutes(c: Container): Router {
  const r = Router();

  r.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  r.get('/ready', async (_req, res) => {
    const checks = {
      database: await check(() => c.store.ping()),
      netsuite: await check(() => c.netsuite.ping()),
    };
    const ready = Object.values(checks).every((v) => v === 'ok');
    res
      .status(ready ? 200 : 503)
      .json({ status: ready ? 'ready' : 'not_ready', checks, netsuiteMode: c.netsuite.kind });
  });

  return r;
}
