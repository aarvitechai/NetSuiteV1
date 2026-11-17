/**
 * Composition root: the ONE place that decides which implementation backs each interface.
 *
 * WHY: services receive their dependencies (store, NetSuite port, clock…) through their constructor
 * instead of creating them. This is "dependency injection". It means:
 *   - tests can swap in fakes (memory store, mock NetSuite, fixed clock, instant sleep);
 *   - configuration (STORAGE_MODE, NETSUITE_MODE) is interpreted here only, not in business code.
 */
import type { Logger } from 'pino';
import { ApPaymentService } from './application/ap-payments';
import { ArPaymentService } from './application/ar-payments';
import { AuditService } from './application/audit';
import { BankInboundService } from './application/bank-inbound';
import { DirectDispatcher, type Dispatcher } from './application/dispatcher';
import { CollectionsService, RecordingNotifier, type Notifier } from './application/collections';
import { IdempotencyService } from './application/idempotency';
import { JobRunner } from './application/jobs';
import { MasterDataSyncService } from './application/master-data-sync';
import type { NetSuitePort } from './application/ports/netsuite';
import type { Store } from './application/ports/store';
import { ReconciliationService } from './application/reconciliation';
import { WebhookService } from './application/webhooks';
import { SimulatedPaymentProvider } from './adapters/payment-provider/simulated-provider';
import { DEFAULT_RETRY, type RetryPolicy } from './application/retry';
import { MockNetSuiteAdapter } from './adapters/netsuite/mock-netsuite';
import { NetSuiteRestAdapter } from './adapters/netsuite/rest-netsuite';
import { SimulatedVault, type BankVault } from './adapters/bank/vault';
import { LocalFolderSftp, type FileTransport } from './infrastructure/files/file-transport';
import { PgStore } from './infrastructure/db/pg-store';
import { MemoryStore } from './infrastructure/memory/memory-store';
import type { AppConfig } from './shared/config';
import { createLogger } from './shared/logger';
import { sleep as realSleep, systemClock, type Clock } from './shared/util';

export interface Container {
  config: AppConfig;
  logger: Logger;
  clock: Clock;
  store: Store;
  netsuite: NetSuitePort;
  idempotency: IdempotencyService;
  audit: AuditService;
  jobs: JobRunner;
  masterData: MasterDataSyncService;
  files: FileTransport;
  vault: BankVault;
  dispatcher: Dispatcher;
  ap: ApPaymentService;
  bankInbound: BankInboundService;
  /** The simulator is exposed with its concrete type so the demo and tests can drive the "customer" side. */
  provider: SimulatedPaymentProvider;
  ar: ArPaymentService;
  webhooks: WebhookService;
  collections: CollectionsService;
  notifier: Notifier;
  reconciliation: ReconciliationService;
}

export interface ContainerOverrides {
  logger?: Logger;
  clock?: Clock;
  store?: Store;
  netsuite?: NetSuitePort;
  /** Tests pass `async () => {}` so retries do not actually wait. */
  sleep?: (ms: number) => Promise<void>;
  retryPolicy?: RetryPolicy;
  files?: FileTransport;
  vault?: BankVault;
  notifier?: Notifier;
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
  const sleep = overrides.sleep ?? realSleep;

  const audit = new AuditService(store, clock);
  const jobs = new JobRunner(store, audit, clock, logger, overrides.retryPolicy ?? DEFAULT_RETRY, { sleep });
  const masterData = new MasterDataSyncService(netsuite, jobs, audit);
  const files = overrides.files ?? new LocalFolderSftp(config.SFTP_ROOT);
  const vault = overrides.vault ?? new SimulatedVault();
  const dispatcher = new DirectDispatcher(jobs);
  const ap = new ApPaymentService({
    store,
    netsuite,
    audit,
    jobs,
    dispatcher,
    vault,
    files,
    clock,
    logger,
    company: {
      companyName: config.COMPANY_NAME,
      companyId: config.COMPANY_ID,
      originRouting: config.ORIGIN_ROUTING,
    },
  });
  const bankInbound = new BankInboundService(files, store, ap, audit, clock, logger);

  const provider = new SimulatedPaymentProvider(config.WEBHOOK_SIGNING_SECRET, clock);
  const ar = new ArPaymentService({ store, netsuite, provider, audit, jobs, dispatcher, clock });
  const webhooks = new WebhookService(
    store,
    ar,
    jobs,
    audit,
    clock,
    logger,
    config.WEBHOOK_SIGNING_SECRET,
    provider.name,
  );
  const notifier = overrides.notifier ?? new RecordingNotifier();
  const collections = new CollectionsService(netsuite, store, audit, notifier, clock);

  const reconciliation = new ReconciliationService(store, netsuite, audit, jobs, dispatcher, clock);
  // Statement files arriving via SFTP are routed to reconciliation.
  bankInbound.onStatement((name, content, fileId) => reconciliation.importStatement(name, content, fileId));

  return {
    config,
    logger,
    clock,
    store,
    netsuite,
    idempotency: new IdempotencyService(store, clock),
    audit,
    jobs,
    masterData,
    files,
    vault,
    dispatcher,
    ap,
    bankInbound,
    provider,
    ar,
    webhooks,
    collections,
    notifier,
    reconciliation,
  };
}
