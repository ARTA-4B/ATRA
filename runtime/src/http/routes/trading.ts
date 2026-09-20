import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../context.js';
import { envelope } from '../respond.js';
import { limitParam } from '../query.js';
import { parse } from './auth.js';
import { requireSession } from '../middleware.js';
import { AppError, ErrorCode } from '../../util/errors.js';
import { CHAIN_IDS, CHAINS, isNativeToken } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import { formatUnits } from '../../wallet/withdrawal.js';
import type { TradeStatus } from '../../trading/trades.js';

/**
 * Trading routes.
 *
 * The dashboard *observes* trading: positions, decisions, the cycle status.
 * There is no route that takes a token and an amount and executes it — trades
 * are proposed by the agent and gated by the risk engine, and the only
 * operator-initiated action is "run a cycle now", which walks the same path.
 *
 * Paper balances are the one thing the operator seeds by hand: they state the
 * bankroll a paper experiment may pretend to have. They never touch a chain.
 */

const runSchema = z
  .object({
    chain: z.enum(CHAIN_IDS),
    token: z.string().min(1).max(64).optional(),
    poolId: z.string().min(1).max(128).optional(),
  })
  .refine((body) => body.token !== undefined || body.poolId !== undefined, {
    message: 'token or poolId is required',
    path: ['token'],
  });

const schedulerSchema = z.object({
  enabled: z.boolean(),
  intervalSeconds: z.number().int().min(60).max(86_400),
});

const paperBalanceSchema = z.object({
  chain: z.enum(CHAIN_IDS),
  token: z.string().min(1).max(64),
  /** Base-unit integer string. */
  amount: z.string().regex(/^(0|[1-9]\d*)$/),
});

const TRADE_STATUSES: TradeStatus[] = [
  'proposed',
  'rejected',
  'allowed',
  'dispatched',
  'signed',
  'broadcast',
  'filled',
  'failed',
  'cancelled',
];

export function tradingRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('*', requireSession());

  /** Positions + recent decisions + cycle status, in one call. */
  app.get('/', (c) => {
    const services = c.get('services');
    const mode = services.state.getMode();
    const scheduler = services.scheduler.status();

    return c.json(
      envelope(
        c,
        {
          status: {
            enabled: scheduler.enabled,
            paused: services.state.getSwitches().globalPause,
            running: scheduler.running || services.pipeline.running,
            lastCycleAt: scheduler.lastCycleAt,
            lastCycleStatus: scheduler.lastCycleStatus,
            nextCycleAt: scheduler.nextRunAt,
            intervalSeconds: scheduler.intervalSeconds,
          },
          positions: positionsView(services, mode),
          decisions: services.gate.listDecisions(50),
          execution: services.execution.list(),
          modelStatus: 'UNTRAINED',
        },
        { source: 'local' },
      ),
    );
  });

  app.get('/positions', (c) => {
    const services = c.get('services');
    return c.json(
      envelope(c, positionsView(services, services.state.getMode()), { source: 'local' }),
    );
  });

  app.get('/decisions', (c) => {
    const services = c.get('services');
    const limit = limitParam(c.req.query('limit'), 50, 500);
    return c.json(envelope(c, services.gate.listDecisions(limit), { source: 'local' }));
  });

  /** One decision in full: every check, the action and the snapshot it saw. */
  app.get('/decisions/:actionId', (c) => {
    const services = c.get('services');
    const decision = services.gate.getDecision(c.req.param('actionId'));
    if (!decision) throw new AppError(ErrorCode.NOT_FOUND, 'No such decision');
    return c.json(envelope(c, decision, { source: 'local' }));
  });

  app.get('/trades', (c) => {
    const services = c.get('services');
    const limit = limitParam(c.req.query('limit'), 50, 500);
    const status = c.req.query('status');
    if (status !== undefined && !TRADE_STATUSES.includes(status as TradeStatus)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Unknown trade status');
    }
    return c.json(
      envelope(
        c,
        services.trades.list({ limit, ...(status ? { status: status as TradeStatus } : {}) }),
        { source: 'local' },
      ),
    );
  });

  app.get('/trades/:tradeId', (c) => {
    const services = c.get('services');
    const trade = services.trades.get(c.req.param('tradeId'));
    if (!trade) throw new AppError(ErrorCode.NOT_FOUND, 'No such trade');
    return c.json(envelope(c, trade, { source: 'local' }));
  });

  /** Which chains can execute, and why not. */
  app.get('/execution', (c) => {
    const services = c.get('services');
    return c.json(envelope(c, services.execution.list(), { source: 'local' }));
  });

  /**
   * Run one cycle now. Same path as the scheduler: research → decide → gate →
   * execute in the current mode. Refused while paused or stopped.
   */
  app.post('/run', async (c) => {
    const services = c.get('services');
    const body = await parse(c, runSchema);
    const switches = services.state.getSwitches();
    if (switches.emergencyStop) {
      throw new AppError(ErrorCode.CONFLICT, 'Emergency stop is active');
    }
    if (switches.globalPause) {
      throw new AppError(ErrorCode.CONFLICT, 'Runtime is paused');
    }
    if (services.pipeline.running) {
      throw new AppError(ErrorCode.CONFLICT, 'A cycle is already running');
    }

    const report = await services.pipeline.runCycle({
      chain: body.chain,
      ...(body.token ? { token: body.token } : {}),
      ...(body.poolId ? { poolId: body.poolId } : {}),
      source: 'operator',
    });
    return c.json(envelope(c, report, { source: 'local' }), 202);
  });

  app.get('/scheduler', (c) => {
    const services = c.get('services');
    return c.json(envelope(c, services.scheduler.status(), { source: 'local' }));
  });

  app.put('/scheduler', async (c) => {
    const services = c.get('services');
    const body = await parse(c, schedulerSchema);
    const status = services.scheduler.configure(body.enabled, body.intervalSeconds, 'operator');
    return c.json(envelope(c, status, { source: 'local' }));
  });

  app.get('/paper-balances', (c) => {
    const services = c.get('services');
    return c.json(
      envelope(
        c,
        services.ledger.listPaperBalances().map((row) => ({
          ...row,
          symbol: symbolOf(row.chain, row.token),
          formatted: formatUnits(BigInt(row.amount), row.decimals),
        })),
        { source: 'local' },
      ),
    );
  });

  /** Seed a paper balance. The token must be one the registry knows. */
  app.put('/paper-balances', async (c) => {
    const services = c.get('services');
    const body = await parse(c, paperBalanceSchema);
    const known = CHAINS[body.chain].tokens.find((token) => token.address === body.token);
    if (!known) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Unknown token for this chain', {
        errors: [{ path: 'token', message: 'must be a registry token' }],
      });
    }

    services.ledger.setPaperBalance(body.chain, body.token, known.decimals, body.amount);
    services.audit.append({
      category: 'wallet',
      action: 'paper.balance.set',
      status: 'ok',
      summary: `Paper balance set: ${formatUnits(BigInt(body.amount), known.decimals)} ${known.symbol} on ${CHAINS[body.chain].displayName}`,
      chain: body.chain,
      actor: 'operator',
      mode: 'PAPER',
      detail: { token: body.token, amount: body.amount, simulated: true },
    });

    return c.json(
      envelope(
        c,
        { chain: body.chain, token: body.token, decimals: known.decimals, amount: body.amount },
        {
          source: 'local',
        },
      ),
    );
  });

  return app;
}

function positionsView(services: AppEnv['Variables']['services'], mode: 'PAPER' | 'LIVE') {
  return services.ledger.listPositions(mode).map((position) => ({
    id: position.id,
    mode: position.mode,
    chain: position.chain,
    chainName: CHAINS[position.chain].displayName,
    token: position.token,
    symbol: symbolOf(position.chain, position.token),
    size: {
      raw: position.amount,
      decimals: position.decimals,
      formatted: formatUnits(BigInt(position.amount), position.decimals),
      symbol: symbolOf(position.chain, position.token),
    },
    costBasisUsd: position.costBasisUsd,
    status: position.mode === 'PAPER' ? 'SIMULATED' : 'LIVE',
    source: position.mode === 'PAPER' ? 'paper-sim' : 'chain',
    openedAt: position.openedAt,
    updatedAt: position.updatedAt,
  }));
}

function symbolOf(chain: ChainId, token: string): string {
  if (isNativeToken(chain, token)) return CHAINS[chain].nativeSymbol;
  return CHAINS[chain].tokens.find((entry) => entry.address === token)?.symbol ?? token.slice(0, 8);
}
