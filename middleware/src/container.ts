/**
 * Composition root: the ONE place that decides which implementation backs each interface.
 *
 * WHY: services receive their dependencies (store, NetSuite port, clock…) through their constructor
 * instead of creating them. This is "dependency injection". It means:
 *   - tests can swap in fakes (memory store, mock NetSuite, fixed clock);
 *   - configuration (STORAGE_MODE, NETSUITE_MODE) is interpreted here only, not in business code.
 */
import type { Logger } from 'pino';
import { AuditService } from './application/audit';
import { IdempotencyService } from './application/idempotency';
import type { NetSuitePort } from './application/ports/netsuite';
import type { Store } from './application/ports/store';
import { MockNetSuiteAdapter } from './adapters/netsuite/mock-netsuite';
import { NetSuiteRestAdapter } from './adapters/netsuite/rest-netsuite';
import { PgStore } from './infrastructure/db/pg-store';
import { MemoryStore } from './infrastructure/memory/memory-store';
import type { AppConfig } from './shared/config';
import { createLogger } from './shared/logger';
import { systemClock, type Clock } from './shared/util';

export interface Container {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  store: Store;
  netsuite: NetSuitePort;
  idempotency: IdempotencyService;
  audit: AuditService;
}

export interface ContainerOverrides {
  logger?: Logger;
  clock?: Clock;
  store?: Store;
  netsuite?: NetSuitePort;
}

function buildNetSuite(config: AppConfig): NetSuitePort {
  if (config.NETSUITE_MODE === 'mock') return new MockNetSuiteAdapter();
  return new NetSuiteRestAdapter({
    accountId: config.NETSUITE_ACCOUNT_ID!,
    consumerKey: config.NETSUITE_CONSUMER_KEY!,
    consumerSecret: config.NETSUITE_CONSUMER_SECRET!,
    tokenId: config.NETSUITE_TOKEN_ID!,
    tokenSecret: config.NETSUITE_TOKEN_SECRET!,
  });
}

export function createContainer(config: AppConfig, overrides: ContainerOverrides = {}): Container {
  const logger = overrides.logger ?? createLogger(config.LOG_LEVEL);
  const clock = overrides.clock ?? systemClock;
  const store =
    overrides.store ??
    (config.STORAGE_MODE === 'postgres' ? PgStore.fromUrl(config.DATABASE_URL!) : new MemoryStore());
  const netsuite = overrides.netsuite ?? buildNetSuite(config);

  return {
    config,
    logger,
    clock,
    store,
    netsuite,
    idempotency: new IdempotencyService(store, clock),
    audit: new AuditService(store, clock),
  };
}
