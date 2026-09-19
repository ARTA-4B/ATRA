import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { parse } from './auth.js';
import { requireSession } from '../middleware.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { CHAIN_IDS, CHAINS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import type { MarketSnapshot } from '../../market/types.js';

/**
 * Market and research routes.
 *
 * Every response says where its numbers came from and how old they are. When a
 * provider is unavailable the route returns `source: 'none'` with a reason
 * rather than an empty list, because an empty list reads as "this market does
 * not exist" and that is a different claim entirely.
 */

const watchlistSchema = z.object({
  chain: z.enum(CHAIN_IDS),
  poolId: z.string().min(1).max(128),
  label: z.string().min(1).max(64),
});

const researchSchema = z.object({
  chain: z.enum(CHAIN_IDS),
  token: z.string().min(1).max(128).optional(),
  poolId: z.string().min(1).max(128).optional(),
  includeHistory: z.boolean().optional(),
});

export function marketRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  /** Provider status, so the dashboard can explain an empty market page. */
  app.get('/providers', async (c) => {
    const services = c.get('services');
    const health = await services.market.health();

    return c.json(
      envelope(
        c,
        {
          providers: health,
          configured: services.market.providerNames,
          model: {
            name: services.llm.model,
            kind: services.llm.kind,
            status: 'UNTRAINED',
            ...(await services.llm.available()),
          },
        },
        { source: 'provider', asOf: new Date().toISOString() },
      ),
    );
  });

  /**
   * Markets for a token, or the operator's watchlist when no token is given.
   *
   * There is no "top markets" listing: ranking tokens by anything ATRA has not
   * verified would be an implicit recommendation, and this layer does not make
   * recommendations.
   */
  app.get('/', async (c) => {
    const services = c.get('services');
    const chainParam = c.req.query('chain');
    const token = c.req.query('token');
    const search = c.req.query('q');

    if (services.market.providerNames.length === 0) {
      return c.json(
        envelope(c, [], {
          source: 'none',
          reason: 'no market-data provider is configured in this runtime mode',
        }),
      );
    }

    try {
      if (search) {
        const results = await services.market.search(
          search,
          chainParam ? assertChain(chainParam) : undefined,
        );
        return c.json(envelope(c, results.map(present), meta(results)));
      }

      if (token) {
        const chain = assertChain(chainParam ?? 'base');
        const pools = await services.market.getPoolsForToken(chain, token);
        return c.json(envelope(c, pools.map(present), meta(pools)));
      }

      // The watchlist, resolved to live snapshots.
      const rows = services.db
        .prepare<[], { chain: ChainId; pool_id: string; label: string }>(
          'SELECT chain, pool_id, label FROM watchlist ORDER BY created_at',
        )
        .all();

      const snapshots = await Promise.all(
        rows.map(async (row) => {
          try {
            const snapshot = await services.market.getPool(row.chain, row.pool_id);
            return snapshot ? { ...present(snapshot), label: row.label } : null;
          } catch {
            return null;
          }
        }),
      );

      const resolved = snapshots.filter((entry) => entry !== null);
      return c.json(
        envelope(c, resolved, {
          source: resolved.length > 0 ? 'provider' : 'none',
          asOf: new Date().toISOString(),
          ...(resolved.length < rows.length
            ? { reason: `${String(rows.length - resolved.length)} watched pools could not be read` }
            : {}),
        }),
      );
    } catch (error) {
      if (error instanceof AppError) {
        return c.json(envelope(c, [], { source: 'none', stale: true, reason: error.message }), 200);
      }
      throw error;
    }
  });

  app.get('/:chain/:poolId', async (c) => {
    const services = c.get('services');
    const chain = assertChain(c.req.param('chain'));
    const poolId = c.req.param('poolId');

    const snapshot = await services.market.getPool(chain, poolId);
    if (!snapshot) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No provider knows this pool', {
        details: { chain, poolId },
      });
    }

    const timeframe = (c.req.query('timeframe') ?? '1h') as '1h';
    const history = await services.market.getOhlcv(chain, poolId, timeframe, 100);

    return c.json(
      envelope(
        c,
        {
          pool: present(snapshot),
          history: history
            ? { timeframe: history.timeframe, candles: history.candles, source: history.source }
            : null,
          historyReason: history ? undefined : 'no provider returned candles for this pool',
        },
        {
          source: 'provider',
          asOf: snapshot.observedAt,
          stale: services.market.isStale(snapshot),
        },
      ),
    );
  });

  /**
   * Run the research agent.
   *
   * The result separates observed facts from the model's interpretation, and
   * reports any figure the model invented. A POST because it costs provider
   * calls and model time; it is not a cacheable read.
   */
  app.post('/research', async (c) => {
    const services = c.get('services');
    const body = await parse(c, researchSchema);

    if (!body.token && !body.poolId) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Provide either a token or a pool identifier', {
        errors: [{ path: 'token', message: 'token or poolId is required' }],
      });
    }

    const result = await services.research.research({
      chain: body.chain,
      ...(body.token ? { token: body.token } : {}),
      ...(body.poolId ? { poolId: body.poolId } : {}),
      ...(body.includeHistory ? { includeHistory: true } : {}),
    });

    return c.json(
      envelope(c, result, {
        source: result.facts.length > 0 ? 'provider' : 'none',
        asOf: result.createdAt,
        stale: result.status === 'INSUFFICIENT_DATA',
        ...(result.status === 'INSUFFICIENT_DATA' ? { reason: result.summary } : {}),
      }),
    );
  });

  app.get('/research/history', (c) => {
    const services = c.get('services');
    const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);

    const rows = services.db
      .prepare<[number], Record<string, unknown>>(
        'SELECT * FROM research_results ORDER BY created_at DESC LIMIT ?',
      )
      .all(limit);

    return c.json(envelope(c, rows, { source: 'local' }));
  });

  return app;
}

export function watchlistRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  app.get('/', (c) => {
    const services = c.get('services');
    const rows = services.db
      .prepare<[], Record<string, unknown>>('SELECT * FROM watchlist ORDER BY created_at')
      .all();
    return c.json(envelope(c, rows, { source: 'local' }));
  });

  app.post('/', async (c) => {
    const services = c.get('services');
    const body = await parse(c, watchlistSchema);

    services.db
      .prepare<[string, string, string, string, string]>(
        'INSERT INTO watchlist (id, chain, pool_id, label, created_at) VALUES (?, ?, ?, ?, ?)' +
          ' ON CONFLICT(chain, pool_id) DO UPDATE SET label = excluded.label',
      )
      .run(randomUUID(), body.chain, body.poolId, body.label, new Date().toISOString());

    services.audit.append({
      category: 'market',
      action: 'watchlist.added',
      status: 'ok',
      summary: `Watching ${body.label} on ${CHAINS[body.chain].displayName}`,
      chain: body.chain,
      actor: 'operator',
    });

    return c.json(envelope(c, { added: true }), 201);
  });

  app.delete('/:chain/:poolId', (c) => {
    const services = c.get('services');
    const chain = assertChain(c.req.param('chain'));

    services.db
      .prepare<[string, string]>('DELETE FROM watchlist WHERE chain = ? AND pool_id = ?')
      .run(chain, c.req.param('poolId'));

    return c.json(envelope(c, { removed: true }));
  });

  return app;
}

/**
 * Shape a snapshot for the dashboard.
 *
 * `stale` is computed here rather than left to the client: whether a number is
 * too old to act on is a runtime policy decision, not a presentation one.
 */
function present(snapshot: MarketSnapshot) {
  return {
    chain: snapshot.chain,
    poolId: snapshot.poolId,
    dex: snapshot.dexId,
    pair:
      snapshot.base.symbol && snapshot.quote.symbol
        ? `${snapshot.base.symbol}/${snapshot.quote.symbol}`
        : null,
    base: snapshot.base,
    quote: snapshot.quote,
    priceUsd: snapshot.priceUsd,
    liquidityUsd: snapshot.liquidityUsd,
    volume24hUsd: snapshot.volume24hUsd,
    change24hBps: snapshot.change.h24,
    source: snapshot.source,
    observedAt: snapshot.observedAt,
    freshnessMs: snapshot.freshnessMs,
    reason: snapshot.reason ?? null,
  };
}

function meta(snapshots: MarketSnapshot[]) {
  const newest = snapshots
    .map((snapshot) => snapshot.observedAt)
    .sort()
    .at(-1);

  return {
    source: snapshots.length > 0 ? ('provider' as const) : ('none' as const),
    asOf: newest ?? null,
    ...(snapshots.length === 0 ? { reason: 'no provider returned a market for this query' } : {}),
  };
}

function assertChain(value: string): ChainId {
  if (!(CHAIN_IDS as readonly string[]).includes(value)) {
    throw new AppError(ErrorCode.CHAIN_UNSUPPORTED, `ATRA does not support the chain ${value}`, {
      details: { supported: CHAIN_IDS },
    });
  }
  return value as ChainId;
}
