/**
 * Shared test setup: a fully wired app with in-memory store, mock NetSuite and a FIXED clock.
 *
 * The clock is pinned to 2026-11-20 because the seed data in test-data/netsuite is written relative
 * to that date ("due within 7 days", "20 days overdue"...).
 */
import pino from 'pino';
import { MockNetSuiteAdapter } from '../src/adapters/netsuite/mock-netsuite';
import { createApp } from '../src/app';
import { createContainer, type ContainerOverrides } from '../src/container';
import { MemoryStore } from '../src/infrastructure/memory/memory-store';
import { loadConfig } from '../src/shared/config';
import { fixedClock } from '../src/shared/util';

export const TOKENS = {
  maker: 'dev-maker-token',
  checker: 'dev-checker-token',
  maker2: 'dev-maker2-token',
  ar: 'dev-ar-token',
  ops: 'dev-ops-token',
  acme: 'dev-cust-acme',
  globex: 'dev-cust-globex',
};

export const WEBHOOK_SECRET = 'test-webhook-secret-0123456789abcdef';

export const testConfig = () =>
  loadConfig({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    WEBHOOK_SIGNING_SECRET: WEBHOOK_SECRET,
    SFTP_ROOT: `./runtime-data/test-sftp-${process.pid}-${Math.random().toString(36).slice(2)}`,
    API_TOKENS: [
      `${TOKENS.maker}:ap_maker:alice`,
      `${TOKENS.maker2}:ap_maker:amy`,
      `${TOKENS.checker}:ap_checker:bob`,
      `${TOKENS.ar}:ar_clerk:carol`,
      `${TOKENS.ops}:ops:olivia`,
      `${TOKENS.acme}:customer:CUST-ACME`,
      `${TOKENS.globex}:customer:CUST-GLOBEX`,
    ].join(','),
  });

export function makeTestContext(overrides: ContainerOverrides = {}) {
  const clock = fixedClock('2026-11-20T09:00:00.000Z');
  const netsuite = new MockNetSuiteAdapter();
  const store = new MemoryStore();
  const container = createContainer(testConfig(), {
    logger: pino({ level: 'silent' }),
    clock,
    netsuite,
    store,
    ...overrides,
  });
  return { container, app: createApp(container), clock, netsuite, store };
}

export const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
