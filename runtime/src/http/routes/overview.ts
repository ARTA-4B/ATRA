import { Hono } from 'hono';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { requireSession } from '../middleware.js';
import { CHAINS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import type { ChainHealth } from '../../chains/types.js';

/**
 * Overview and status.
 *
 * The dashboard's landing page. Everything here is either a local fact or a
 * dated reading from a chain; nothing is estimated. Portfolio value in USD is
 * reported as null until Phase 2 provides a priced market snapshot, rather than
 * showing a zero that an operator would read as "my wallet is empty".
 */
function hostOnly(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unknown';
  }
}

export function overviewRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Session is required per route rather than with a wildcard: this sub-app is
  // mounted at /api/v1, and a wildcard here would answer 401 for every unknown
  // path under it, hiding genuine 404s from the dashboard.
  app.get('/status', requireSession(), async (c) => {
    const services = c.get('services');
    const installation = services.state.getInstallation();
    const switches = services.state.getSwitches();

    const health = await Promise.all(
      [...services.adapters.entries()].map(async ([chain, adapter]) => {
        try {
          return await adapter.health();
        } catch (error) {
          return {
            chain,
            healthy: false,
            height: null,
            latencyMs: null,
            endpoint: 'unknown',
            error: error instanceof Error ? error.message : 'health check failed',
            identity: null,
            identityMatches: false,
          } satisfies ChainHealth;
        }
      }),
    );

    return c.json(
      envelope(
        c,
        {
          runtime: {
            status: switches.emergencyStop
              ? 'stopped'
              : switches.globalPause
                ? 'paused'
                : 'running',
            uptimeSec: Math.floor((Date.now() - services.startedAt.getTime()) / 1_000),
            startedAt: services.startedAt.toISOString(),
            runtimeMode: services.config.mode,
          },
          mode: services.state.getMode(),
          activation: services.state.getActivation(),
          switches,
          installation: installation
            ? {
                id: installation.id,
                name: installation.name,
                createdAt: installation.createdAt,
                enabledChains: installation.enabledChains,
              }
            : null,
          // Endpoints are reduced to their host: a BYOK URL carries the key in
          // its path, and it must not be echoed to the browser.
          chains: health.map((entry) => ({ ...entry, endpoint: hostOnly(entry.endpoint) })),
          // Honest about what is not built yet, rather than showing an idle
          // agent that does not exist.
          agents: [
            { id: 'research', name: 'Research', status: 'available', phase: 2 },
            { id: 'trader', name: 'Trader', status: 'not-implemented', phase: 3 },
            { id: 'liquidity', name: 'Liquidity manager', status: 'not-implemented', phase: 4 },
            { id: 'treasury', name: 'Treasury', status: 'not-implemented', phase: 5 },
          ],
          model: { name: 'atra-4b', status: 'UNTRAINED', endpoint: services.config.llm.kind },
        },
        { source: 'rpc', asOf: new Date().toISOString() },
      ),
    );
  });

  app.get('/overview', requireSession(), async (c) => {
    const services = c.get('services');
    const installation = services.state.getInstallation();
    const chains = installation?.enabledChains ?? [];
    const wallets = services.wallets.list();

    const balances = await Promise.all(
      chains.map(async (chain: ChainId) => {
        try {
          return await services.wallets.readBalances(chain);
        } catch (error) {
          return {
            chain,
            address: '',
            native: null,
            tokens: [],
            observedAt: null,
            source: null,
            error: error instanceof Error ? error.message : 'balance read failed',
            gasLow: null,
          };
        }
      }),
    );

    const unreadable = balances.filter((balance) => balance.error !== null).map((b) => b.chain);
    const lowGas = balances.filter((balance) => balance.gasLow === true).map((b) => b.chain);

    return c.json(
      envelope(
        c,
        {
          mode: services.state.getMode(),
          switches: services.state.getSwitches(),
          wallets: wallets.map((wallet) => ({
            family: wallet.family,
            address: wallet.address,
            chains: wallet.chains,
          })),
          balances: balances.map((balance) => ({
            chain: balance.chain,
            nativeSymbol: CHAINS[balance.chain].nativeSymbol,
            native: balance.native,
            tokens: balance.tokens,
            observedAt: balance.observedAt,
            source: balance.source,
            error: balance.error,
            gasLow: balance.gasLow,
          })),
          portfolio: {
            // Pricing arrives with the Phase 2 market layer. Until then this is
            // explicitly unavailable, never zero.
            totalValueUsd: null,
            reason: 'portfolio pricing is not available until the market layer is configured',
          },
          warnings: [
            ...unreadable.map((chain) => ({
              level: 'error' as const,
              chain,
              message: `Balances for ${CHAINS[chain].displayName} could not be read`,
            })),
            ...lowGas.map((chain) => ({
              level: 'warning' as const,
              chain,
              message: `Low ${CHAINS[chain].nativeSymbol} balance on ${CHAINS[chain].displayName}; top up to cover fees`,
            })),
          ],
          recentActivity: services.audit.list({ limit: 10 }),
        },
        {
          source: unreadable.length === chains.length && chains.length > 0 ? 'none' : 'rpc',
          asOf: new Date().toISOString(),
          stale: unreadable.length > 0,
          ...(unreadable.length > 0 ? { reason: `could not read: ${unreadable.join(', ')}` } : {}),
        },
      ),
    );
  });

  return app;
}
