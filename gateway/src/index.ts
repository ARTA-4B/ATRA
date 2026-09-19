/**
 * atra-gateway: the Worker entry point.
 *
 *   GET  /health                 liveness
 *   POST /tg/webhook             Telegram -> gateway (secret token header)
 *   GET  /v1/ws                  runtime -> gateway WebSocket (bearer token)
 *   POST /v1/admin/installs      mint an installation token (admin token)
 *   cron (every 5 minutes)       purge tg_updates older than 24 h
 *
 * The Worker holds no state: D1 has the rows, the Hub Durable Object has the
 * sockets. No R2, no KV, no Workers AI. See README.md for deployment.
 */
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import { timingSafeEqualStrings } from './crypto.js';
import { GATEWAY_VERSION } from './env.js';
import type { Env } from './env.js';
import { HUB_NAME, Hub } from './hub.js';
import { errorSummary, logger } from './log.js';
import { purgeStale } from './pairing.js';
import { WS_SUBPROTOCOL } from './protocol.js';
import { allow } from './ratelimit.js';
import { updateSchema } from './telegram.js';
import { authenticateInstallToken, bearerToken, mintInstallToken } from './tokens.js';
import { handleUpdate } from './webhook.js';

const log = logger('worker');

const app = new Hono<{ Bindings: Env }>();

app.onError((error, c) => {
  log.error('unhandled error', { path: c.req.path, error: errorSummary(error) });
  return c.json({ error: 'internal' }, 500);
});

app.notFound((c) => c.json({ error: 'not_found' }, 404));

// The largest legitimate body is a Telegram update (a few KB) or the admin
// request (a few bytes). Nothing needs more.
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

  const principal = await authenticateInstallToken(c.env.DB, pepper, token);
  if (!principal) return c.json({ error: 'unauthorized' }, 401);
  if (!principal.scopes.includes('telegram')) return c.json({ error: 'forbidden' }, 403);

  if (!(await allow(c.env.RL_WS, principal.installId))) {
    return c.json({ error: 'too many connections' }, 429, { 'retry-after': '60' });
  }

  const offered = (c.req.header('sec-websocket-protocol') ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!offered.includes(WS_SUBPROTOCOL)) {
    return c.json({ error: `subprotocol ${WS_SUBPROTOCOL} required` }, 400);
  }

  // Only the install id crosses into the object; the token never does.
  const forwarded = new Request(c.req.url, {
    method: 'GET',
    headers: {
      upgrade: 'websocket',
      'sec-websocket-protocol': WS_SUBPROTOCOL,
      'x-atra-install-id': principal.installId,
    },
  });
  return c.env.HUB.getByName(HUB_NAME).fetch(forwarded);
});

// --- Admin: mint an installation token -----------------------------------
//
// Phase 5 stand-in for self-service registration. The operator of the
// gateway mints a token per installation and hands it to the runtime as
// ATRA_GATEWAY_TOKEN. The clear-text token is returned exactly once.

const mintSchema = z
  .object({
    installId: z
      .string()
      .regex(/^[A-Za-z0-9_-]{8,64}$/)
      .optional(),
    scopes: z
      .array(z.enum(['telegram']))
      .min(1)
      .max(8)
      .optional(),
    ttlDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

app.post('/v1/admin/installs', async (c) => {
  const adminToken = c.env.ADMIN_TOKEN;
  const pepper = c.env.TOKEN_PEPPER;
  if (!adminToken || !pepper) {
    log.error('ADMIN_TOKEN or TOKEN_PEPPER is not configured');
    return c.json({ error: 'admin endpoint not configured' }, 503);
  }
  const presented = bearerToken(c.req.header('authorization'));
  if (!presented || !(await timingSafeEqualStrings(presented, adminToken))) {
    return c.json({ error: 'unauthorized' }, 401);
  }

  let body: unknown = {};
  const raw = await c.req.text();
  if (raw.trim().length > 0) {
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: 'body is not JSON' }, 400);
    }
  }
  const parsed = mintSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: 'invalid body', issues: parsed.error.issues.map((i) => i.message) },
      422,
    );
  }

  const options: Parameters<typeof mintInstallToken>[2] = {};
  if (parsed.data.installId !== undefined) options.installId = parsed.data.installId;
  if (parsed.data.scopes !== undefined) options.scopes = parsed.data.scopes;
  if (parsed.data.ttlDays !== undefined) {
    options.ttlMs = parsed.data.ttlDays === null ? null : parsed.data.ttlDays * 24 * 60 * 60_000;
  }

  const minted = await mintInstallToken(c.env.DB, pepper, options);
  log.info('install token minted', { installId: minted.installId });
  return c.json(
    {
      installId: minted.installId,
      token: minted.token,
      scopes: minted.scopes,
      expiresAt: minted.expiresAt,
      note: 'Store the token now; it is not shown again. Set it as ATRA_GATEWAY_TOKEN on the runtime.',
    },
    201,
  );
});

// --- Cron: housekeeping ------------------------------------------------------

async function scheduled(_controller: ScheduledController, env: Env): Promise<void> {
  const removed = await purgeStale(env.DB);
  log.info('purged', removed);
}

export default {
  fetch: app.fetch,
  scheduled: (controller, env, ctx) => {
    ctx.waitUntil(scheduled(controller, env));
  },
} satisfies ExportedHandler<Env>;

export { Hub };
