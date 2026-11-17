/**
 * Process entry point: load config → build container → start HTTP server → shut down gracefully.
 *
 * GRACEFUL SHUTDOWN: when the platform stops a container (deploys, scaling), it sends SIGTERM. We stop
 * accepting new requests, let in-flight ones finish, then close the DB pool. Killing the process
 * abruptly could cut off a request halfway through a payment flow.
 */
import { OutboxWorker } from './application/dispatcher';
import { createApp } from './app';
import { createContainer } from './container';
import { loadConfig } from './shared/config';

function main(): void {
  const config = loadConfig();
  const container = createContainer(config);
  const app = createApp(container);
  const { logger } = container;

  // The SIMULATED payment provider delivers its webhooks to our own public endpoint over HTTP,
  // exactly as a real provider would (signature header included).
  container.provider.setDeliver(async (raw, signature) => {
    await fetch(`http://127.0.0.1:${config.PORT}/webhooks/payment-provider`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Signature': signature },
      body: raw,
    });
  });

  // Crash recovery: re-queue outbox messages a previous (crashed) process had claimed.
  void container.dispatcher
    .recoverStuck()
    .then((n) => n && logger.warn({ recovered: n }, 'recovered stuck outbox messages'));
  const worker = config.DISPATCH_MODE === 'worker' ? new OutboxWorker(container.dispatcher) : undefined;
  worker?.start();

  const server = app.listen(config.PORT, () => {
    logger.info(
      { port: config.PORT, netsuite: container.netsuite.kind, storage: config.STORAGE_MODE },
      'middleware started',
    );
  });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down');
    worker?.stop();
    server.close(async () => {
      await container.webhooks.drain(); // finish processing webhooks already accepted
      await container.store.close();
      logger.info('stopped');
      process.exit(0);
    });
    // Safety net: force-exit if connections do not drain in time.
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main();
