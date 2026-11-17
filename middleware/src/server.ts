/**
 * Process entry point: load config → build container → start HTTP server → shut down gracefully.
 *
 * GRACEFUL SHUTDOWN: when the platform stops a container (deploys, scaling), it sends SIGTERM. We stop
 * accepting new requests, let in-flight ones finish, then close the DB pool. Killing the process
 * abruptly could cut off a request halfway through a payment flow.
 */
import { createApp } from './app';
import { createContainer } from './container';
import { loadConfig } from './shared/config';

function main(): void {
  const config = loadConfig();
  const container = createContainer(config);
  const app = createApp(container);
  const { logger } = container;

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
    server.close(async () => {
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
