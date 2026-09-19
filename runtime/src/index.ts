import { loadConfig } from './config/env.js';
import { createLogger, setRootLogger, childLogger } from './logging/logger.js';
import {
  buildServices,
  shutdownServices,
  startBackgroundServices,
  stopBackgroundServices,
} from './core/services.js';
import { startServer } from './http/server.js';
import { isAppError } from './util/errors.js';
import type { StartedServer } from './http/server.js';

/**
 * Entry point.
 *
 * ATRA is meant to run unattended for weeks on a home machine, so startup and
 * shutdown are written for that: the process boots with no credentials
 * configured, never exits because a chain endpoint is down, and on SIGTERM it
 * stops accepting requests, locks the vault and checkpoints the database before
 * exiting.
 */

async function main(): Promise<void> {
  const config = loadConfig();

  const logger = createLogger(config.log);
  setRootLogger(logger);
  const log = childLogger('boot');

  log.info(
    {
      mode: config.mode,
      nodeEnv: config.nodeEnv,
      host: config.host,
      port: config.port,
      dataDir: config.dataDir,
    },
    'starting ATRA runtime',
  );

  const services = buildServices(config);
  const installation = services.state.getInstallation();

  if (!installation) {
    log.info('no installation found; open the dashboard to run first-time setup');
  } else {
    log.info(
      {
        installationId: installation.id,
        mode: installation.mode,
        chains: installation.enabledChains,
        setupCompleted: installation.setupCompleted,
      },
      'installation loaded',
    );
    if (installation.mode === 'LIVE') {
      log.warn('runtime is in LIVE mode');
    }
  }

  const server = await startServer(services);
  installShutdownHandlers(server, services);

  // Reconcile before the scheduler can propose anything new.
  try {
    await startBackgroundServices(services);
  } catch (error) {
    log.error({ err: error }, 'background services failed to start; trading stays idle');
  }

  services.audit.append({
    category: 'system',
    action: 'runtime.started',
    status: 'ok',
    summary: `Runtime started on port ${server.port}`,
    mode: services.state.getMode(),
    detail: { port: server.port, runtimeMode: config.mode },
  });
}

function installShutdownHandlers(
  server: StartedServer,
  services: ReturnType<typeof buildServices>,
): void {
  const log = childLogger('shutdown');
  let shuttingDown = false;

  const stop = (signal: string): void => {
    if (shuttingDown) {
      log.warn({ signal }, 'shutdown already in progress');
      return;
    }
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    // The vault is locked first: if anything below hangs, the key is already
    // out of memory.
    services.vault.lock();

    // Best effort, bounded by the shutdown timer below: let the Telegram
    // transport say the runtime went offline before the database closes.
    void stopBackgroundServices(services).catch((error: unknown) => {
      log.warn({ err: error }, 'background services did not stop cleanly');
    });

    const finish = (code: number): void => {
      try {
        services.audit.append({
          category: 'system',
          action: 'runtime.stopped',
          status: 'ok',
          summary: `Runtime stopped (${signal})`,
          mode: services.state.getMode(),
        });
        shutdownServices(services);
      } catch (error) {
        log.error({ err: error }, 'error during shutdown');
      }
      process.exit(code);
    };

    const timer = setTimeout(() => {
      log.warn('graceful shutdown timed out; exiting anyway');
      finish(1);
    }, 10_000);
    timer.unref();

    server
      .close()
      .then(() => {
        clearTimeout(timer);
        finish(0);
      })
      .catch((error: unknown) => {
        log.error({ err: error }, 'failed to close the HTTP server');
        clearTimeout(timer);
        finish(1);
      });
  };

  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  // An unhandled rejection in a background task must not take down a runtime
  // that is holding positions. It is logged loudly and the process keeps
  // serving; the operator decides what to do.
  process.on('unhandledRejection', (reason) => {
    childLogger('process').error({ err: reason }, 'unhandled promise rejection');
  });

  process.on('uncaughtException', (error) => {
    childLogger('process').fatal({ err: error }, 'uncaught exception; shutting down');
    stop('uncaughtException');
  });
}

main().catch((error: unknown) => {
  const log = childLogger('boot');
  if (isAppError(error)) {
    log.fatal({ code: error.code, errors: error.errors }, error.message);
  } else {
    log.fatal({ err: error }, 'failed to start');
  }
  process.exit(1);
});
