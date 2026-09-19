import { Hono } from 'hono';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { CHAIN_IDS, CHAINS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';

/**
 * Health, readiness and metadata.
 *
 * `/health` is what `docker compose up --wait` and the container HEALTHCHECK
 * poll, so it must answer without a password, without the vault being unlocked
 * and without touching the network. It reports that the process is alive and
 * its database is writable — nothing more. Chain connectivity belongs in
 * `/api/v1/status`, where a degraded RPC is information rather than a reason to
 * restart the container.
 */
export function systemRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/health', (c) => {
    const services = c.get('services');
    let databaseOk = true;
    try {
      services.db.prepare('SELECT 1').get();
    } catch {
      databaseOk = false;
    }

    const uptimeSec = Math.floor((Date.now() - services.startedAt.getTime()) / 1_000);
    const body = {
      status: databaseOk ? 'ok' : 'degraded',
      uptimeSec,
      mode: services.state.getMode(),
      runtimeMode: services.config.mode,
      database: databaseOk ? 'ok' : 'unavailable',
      version: '0.1.0',
    };

    return c.json(body, databaseOk ? 200 : 503);
  });

  /**
   * Readiness: has the operator finished setup?
   *
   * Kept separate from health so an unconfigured install is still "up" — the
   * container is working exactly as intended, it is just waiting for a human.
   */
  app.get('/ready', (c) => {
    const services = c.get('services');
    const installation = services.state.getInstallation();
    const ready = installation?.setupCompleted === true;

    return c.json(
      {
        ready,
        setupRequired: !ready,
        reason: ready ? null : 'first-run setup has not been completed',
      },
      ready ? 200 : 503,
    );
  });

  /** Unauthenticated bootstrap information for the dashboard. */
  app.get('/api/v1/meta', (c) => {
    const services = c.get('services');
    const installation = services.state.getInstallation();

    return c.json(
      envelope(c, {
        name: 'ATRA',
        version: '0.1.0',
        setupRequired: !installation?.setupCompleted,
        passwordSet: services.auth.isConfigured,
        mode: services.state.getMode(),
        runtimeMode: services.config.mode,
        supportedChains: CHAIN_IDS.map((chain) => chainDescriptor(chain)),
        enabledChains: installation?.enabledChains ?? [],
        modelStatus: 'UNTRAINED',
      }),
    );
  });

  return app;
}

function chainDescriptor(chain: ChainId) {
  const info = CHAINS[chain];
  return {
    id: info.id,
    name: info.displayName,
    family: info.family,
    evmChainId: info.evmChainId ?? null,
    nativeSymbol: info.nativeSymbol,
    nativeDecimals: info.nativeDecimals,
    explorerUrl: info.explorerUrl,
  };
}
