import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { limitParam } from '../query.js';
import { parse } from './auth.js';
import { requireSession } from '../middleware.js';
import { CHAIN_IDS } from '../../chains/registry.js';
import type { LiquidityService } from '../../liquidity/service.js';

/**
 * Liquidity routes (Phase 4).
 *
 * The dashboard *observes* liquidity management: positions, recent actions,
 * which protocols have an adapter, and the automation switch. There is no
 * route that takes a pool and an amount and adds liquidity — actions are
 * proposed by the Liquidity Manager and gated by the risk engine, and the
 * only operator-initiated action is "run a cycle now", which walks the same
 * path.
 *
 * Positions in PAPER carry `status: 'SIMULATED'` and `source: 'paper-sim'`.
 * A value ATRA has not observed is `null` with a reason, never a number.
 */

const runSchema = z.object({
  chain: z.enum(CHAIN_IDS),
  poolId: z.string().min(1).max(128),
});

const automationSchema = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(60).max(86_400),
});

export function liquidityRoutes(liquidity: LiquidityService): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  /** Summary + positions + recent actions + protocols + automation, in one call. */
  app.get('/', (c) => c.json(envelope(c, liquidity.view(50), { source: 'local' })));

  app.get('/positions', (c) => c.json(envelope(c, liquidity.positions(), { source: 'local' })));

  app.get('/actions', (c) => {
    const limit = limitParam(c.req.query('limit'), 50, 500);
    return c.json(envelope(c, liquidity.actions(limit), { source: 'local' }));
  });

  /** Which chains can manage liquidity, and why not. */
  app.get('/adapters', (c) =>
    c.json(
      envelope(
        c,
        { adapters: liquidity.registry.list(), protocols: liquidity.registry.supportedProtocols() },
        { source: 'local' },
      ),
    ),
  );

  /**
   * Run one LP cycle now. Same path as the scheduler: read → decide → build →
   * gate → execute in the current mode. 409 while paused, stopped or running.
   */
  app.post('/run', async (c) => {
    const body = await parse(c, runSchema);
    const report = await liquidity.run(body.chain, body.poolId);
    return c.json(envelope(c, report, { source: 'local' }), 202);
  });

  app.get('/automation', (c) => c.json(envelope(c, liquidity.automation(), { source: 'local' })));

  /** The switch to pause or resume LP automation. 409 when enabling under an emergency stop. */
  app.put('/automation', async (c) => {
    const body = await parse(c, automationSchema);
    const status = liquidity.configureAutomation(body.enabled, body.intervalSeconds, 'operator');
    return c.json(envelope(c, status, { source: 'local' }));
  });

  return app;
}
