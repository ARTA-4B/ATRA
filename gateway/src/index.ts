/**
 * atra-gateway: the Worker entry point.
 *
 *   GET    /health                          liveness
 *   POST   /tg/webhook                      Telegram -> gateway (secret token header)
 *   GET    /v1/ws                           runtime -> gateway WebSocket (bearer token)
 *   POST   /v1/rpc/{chain}                  read-only JSON-RPC proxy (rpc.ts)
 *   GET    /v1/market/...                   market-data proxy (market.ts)
 *   POST   /v1/inference                    optional inference proxy, 501 unless configured (inference.ts)
 *   POST   /v1/admin/installs               mint an installation token (admin.ts)
 *   GET    /v1/admin/installs               list installations and today's usage
 *   POST   /v1/admin/installs/{id}/revoke   revoke an installation
 *   DELETE /v1/admin/installs/{id}          revoke and unlink an installation
 *   GET    /v1/admin/usage                  usage summary from the Hub
 *   cron (every 5 minutes)                  purge tg_updates older than 24 h; hourly, old quota rows
 *
 * The Worker holds no state: D1 has the rows, the Hub Durable Object has the
 * sockets and the quota counters. KV and Analytics Engine are optional
 * bindings; without them the market cache falls back to the Cache API and
 * metering is skipped. See README.md for deployment.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { adminRoutes } from './admin.js';
import type { AppEnv } from './context.js';
import { timingSafeEqualStrings } from './crypto.js';
import { GATEWAY_VERSION } from './env.js';
import type { Env } from './env.js';
import { HUB_NAME, Hub } from './hub.js';
import { inferenceRoutes } from './inference.js';
import { errorSummary, logger } from './log.js';
import { marketRoutes } from './market.js';
import { purgeStale } from './pairing.js';
import { WS_SUBPROTOCOL } from './protocol.js';
import { quotaExceeded, quotaLimits } from './quota.js';
import { allow } from './ratelimit.js';
import { rpcRoutes } from './rpc.js';
import { updateSchema } from './telegram.js';
import { authenticateInstallToken, bearerToken } from './tokens.js';
import { recordUsage } from './usage.js';
import { handleUpdate } from './webhook.js';

const log = logger('worker');

const app = new Hono<AppEnv>();

app.onError((error, c) => {
  log.error('unhandled error', { path: c.req.path, error: errorSummary(error) });
  return c.json({ error: 'internal' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// The largest legitimate body is a JSON-RPC batch or an inference request
// (tens of KB at most), a Telegram update (a few KB) or an admin request.
app.use('*', bodyLimit({ maxSize: 64 * 1024 }));

app.get('/health', (c) =>
  c.json({ status: 'ok', version: GATEWAY_VERSION, env: c.env.GATEWAY_ENV ?? 'dev' }),
);

// --- Telegram webhook --------------------------------------------------------

app.post('/tg/webhook', async (c) => {
  const expected = c.env.TELEGRAM_WEBHOOK_SECRET;
  if (!expected) {
    log.error('TELEGRAM_WEBHOOK_SECRET is not configured');
    return c.json({ error: 'webhook not configured' }, 503);
  }
  const presented = c.req.header('x-telegram-bot-api-secret-token') ?? '';
  if (!(await timingSafeEqualStrings(presented, expected))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // Telegram would retry a 4xx forever; a malformed update is dropped.
    log.warn('webhook body is not JSON');
    return c.body(null, 200);
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    log.warn('webhook update did not validate', { issue: parsed.error.issues[0]?.message });
    return c.body(null, 200);
  }

  try {
    const outcome = await handleUpdate(c.env, c.executionCtx, parsed.data);
    return c.json({ ok: true, outcome });
  } catch (error) {
    // Still 200: the update is recorded in tg_updates and must not be replayed.
    log.error('update handling failed', { error: errorSummary(error) });
    return c.json({ ok: false }, 200);
  }
});

// --- Runtime WebSocket -------------------------------------------------------

app.get('/v1/ws', async (c) => {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    return c.json({ error: 'expected a WebSocket upgrade' }, 426);
  }
  const pepper = c.env.TOKEN_PEPPER;
  if (!pepper) {
    log.error('TOKEN_PEPPER is not configured');
    return c.json({ error: 'gateway not configured' }, 503);
  }
  const token = bearerToken(c.req.header('authorization'));
  if (!token) return c.json({ error: 'unauthorized' }, 401);

  // A revoked token fails here, so a revoked runtime cannot reconnect.
  const principal = await authenticateInstallToken(c.env.DB, pepper, token);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  if (!principal.scopes.includes('telegram')) return c.json({ error: 'forbidden' }, 403);

  if (!(await allow(c.env.RL_WS, principal.installId))) {
    recordUsage(c.env, {
      installId: principal.installId,
      route: 'ws',
      chain: 'none',
      outcome: 'rate_limited',
      cached: false,
    });
    return c.json({ error: 'too many connections' }, 429, { 'retry-after': '60' });
  }

  const offered = (c.req.header('sec-websocket-protocol') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!offered.includes(WS_SUBPROTOCOL)) {
    return c.json({ error: `subprotocol ${WS_SUBPROTOCOL} required` }, 400);
  }

  // Daily connect quota: a runtime stuck in a reconnect loop is the one
  // thing that turns a free hub into a bill.
  const hub = c.env.HUB.getByName(HUB_NAME);
  const now = Date.now();
  const decision = await hub.consumeQuota(principal.installId, 'ws', quotaLimits(c.env).ws, now);
  if (!decision.allowed) {
    recordUsage(c.env, {
      installId: principal.installId,
      route: 'ws',
      chain: 'none',
      outcome: 'quota_exceeded',
      cached: false,
    });
    return quotaExceeded(decision, now);
  }
  recordUsage(c.env, {
    installId: principal.installId,
    route: 'ws',
    chain: 'none',
    outcome: 'ok',
    cached: false,
  });

  // Only the install id crosses into the object; the token never does.
  const forwarded = new Request(c.req.url, {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      'sec-websocket-protocol': WS_SUBPROTOCOL,
      'x-atra-install-id': principal.installId,
    },
  });
  return hub.fetch(forwarded);
});

// --- Phase 5 routes ----------------------------------------------------------

app.route('/', rpcRoutes());
app.route('/', marketRoutes());
app.route('/', inferenceRoutes());
app.route('/', adminRoutes());

// --- Cron: housekeeping ------------------------------------------------------

async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const removed = await purgeStale(env.DB);
  log.info('purged', removed);
  // The quota rows are small; once an hour is plenty and keeps the Hub
  // from being woken every five minutes for nothing.
  if (new Date(controller.scheduledTime).getUTCMinutes() < 5) {
    try {
      const rows = await env.HUB.getByName(HUB_NAME).purgeUsage(controller.scheduledTime);
      log.info('purged quota rows', { rows });
    } catch (error) {
      log.warn('quota purge failed', { error: errorSummary(error) });
    }
  }
}

export default {
  fetch: app.fetch,
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(scheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;

export { Hub };
