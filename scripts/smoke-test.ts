/**
 * Post-deployment smoke test: a few fast, read-only checks against a DEPLOYED environment.
 *
 *   BASE_URL=https://staging.example.com OPS_TOKEN=… npm run smoke
 *
 * WHY: unit tests prove the code. Smoke tests prove the DEPLOYMENT: the container started, the
 * config is valid, the database and NetSuite are reachable, auth works, and the outbox is not stuck.
 * The deploy pipeline runs this after each deploy and rolls back automatically if it fails.
 * It is read-only on purpose: it never creates payments.
 */
const BASE = process.env.BASE_URL ?? 'http://localhost:3000';
const TOKEN = process.env.OPS_TOKEN ?? '';

interface Check {
  name: string;
  run: () => Promise<void>;
}

async function get(path: string, auth = false): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    headers: auth ? { Authorization: `Bearer ${TOKEN}` } : {},
    signal: AbortSignal.timeout(10_000),
  });
}

function expect(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

const checks: Check[] = [
  {
    name: 'liveness /health',
    run: async () => expect((await get('/health')).status === 200, 'expected 200'),
  },
  {
    name: 'readiness /ready (database + NetSuite)',
    run: async () => {
      const r = await get('/ready');
      expect(r.status === 200, `expected 200, got ${r.status}: ${await r.text()}`);
    },
  },
  {
    name: 'OpenAPI document served',
    run: async () => expect((await get('/api/v1/openapi.yaml')).status === 200, 'expected 200'),
  },
  {
    name: 'unauthenticated API call is rejected',
    run: async () => expect((await get('/api/v1/vendors')).status === 401, 'expected 401'),
  },
  {
    name: 'authenticated ops call works',
    run: async () =>
      expect((await get('/api/v1/ops/dashboard', true)).status === 200, 'expected 200 with OPS_TOKEN'),
  },
  {
    name: 'outbox is not stuck (oldest pending < 300 s)',
    run: async () => {
      const d = (await (await get('/api/v1/ops/dashboard', true)).json()) as {
        outbox: { oldestPendingAgeSeconds: number };
      };
      expect(
        d.outbox.oldestPendingAgeSeconds < 300,
        `oldest pending message is ${d.outbox.oldestPendingAgeSeconds}s old`,
      );
    },
  },
  {
    name: 'dev-only routes are not exposed',
    run: async () =>
      expect(
        [401, 404].includes((await get('/dev/checkout/cs_aaaaaaaaaaaaaaaaaaaa')).status),
        'simulated checkout must not be reachable',
      ),
  },
];

async function main() {
  let failed = 0;
  for (const c of checks) {
    try {
      await c.run();
      console.log(`✔ ${c.name}`);
    } catch (e) {
      failed++;
      console.error(`✘ ${c.name}: ${(e as Error).message}`);
    }
  }
  console.log(failed ? `\n${failed} smoke check(s) FAILED` : '\nAll smoke checks passed');
  // exitCode (not process.exit) lets open HTTP sockets close cleanly before Node exits.
  process.exitCode = failed ? 1 : 0;
}

void main();
