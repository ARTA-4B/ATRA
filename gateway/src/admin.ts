/**
 * Admin endpoints, all behind ADMIN_TOKEN.
 *
 *   POST   /v1/admin/installs               mint an installation token
 *   GET    /v1/admin/installs               list installations with today's usage
 *   POST   /v1/admin/installs/{id}/revoke   revoke every token, close the socket
 *   DELETE /v1/admin/installs/{id}          revoke, close, and drop the Telegram link
 *   GET    /v1/admin/usage?day=YYYY-MM-DD   usage summary from the Hub
 *
 * Revocation sets revoked_at on every live token row of the installation.
 * The next authenticated call (any proxy, /v1/ws) fails in
 * authenticateInstallToken, and the open socket is closed with code 4003.
 * Rotation (a new token with a grace window for the old one) is still a
 * TODO; see tokens.ts. Until it exists, "rotate" is revoke plus mint.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { requireAdmin, SCOPES } from './auth.js';
import type { AppEnv } from './context.js';
import { CLOSE_REVOKED, HUB_NAME } from './hub.js';
import type { UsageCounts } from './hub.js';
import { errorSummary, logger } from './log.js';
import { badRequest, notFound, problem, serviceUnavailable } from './problem.js';
import { unlinkInstall } from './pairing.js';
import { quotaLimits, utcDayKey } from './quota.js';
import { mintInstallToken } from './tokens.js';

const log = logger('admin');

const INSTALL_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const mintSchema = z
  .object({
    installId: z.string().regex(INSTALL_ID_RE).optional(),
    scopes: z.array(z.enum(SCOPES)).min(1).max(8).optional(),
    ttlDays: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

interface TokenRow {
  install_id: string;
  scopes: string;
  created_at: number;
  expires_at: number | null;
  revoked_at: number | null;
}

export interface InstallListing {
  installId: string;
  createdAt: number;
  /** Scopes of the tokens that are still valid (union). */
  scopes: string[];
  tokens: { total: number; active: number };
  /** Latest expiry among active tokens; null when one never expires. */
  expiresAt: number | null;
  revoked: boolean;
  paired: boolean;
  online: boolean;
  usage: UsageCounts;
}

function parseScopes(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

export function adminRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/v1/admin/*', requireAdmin);

  // --- mint ------------------------------------------------------------------
  //
  // Phase 5 stand-in for self-service registration. The operator mints a
  // token per installation and hands it to the runtime as ATRA_GATEWAY_TOKEN.
  // The clear-text token is returned exactly once.
  app.post('/v1/admin/installs', async (c) => {
    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      log.error('TOKEN_PEPPER is not configured');
      return serviceUnavailable('not_configured', 'the admin endpoint is not configured');
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
    log.info('install token minted', { installId: minted.installId, scopes: minted.scopes });
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

  // --- list ------------------------------------------------------------------
  app.get('/v1/admin/installs', async (c) => {
    const now = Date.now();
    const [tokens, links] = await c.env.DB.batch([
      c.env.DB.prepare(
        'SELECT install_id, scopes, created_at, expires_at, revoked_at FROM install_tokens ORDER BY created_at DESC LIMIT 1000',
      ),
      c.env.DB.prepare('SELECT install_id FROM tg_links'),
    ]);
    const paired = new Set(
      (links?.results ?? []).map((r) => (r as { install_id: string }).install_id),
    );

    const hub = c.env.HUB.getByName(HUB_NAME);
    const summary = await hub.usageSummary(now);
    const online = new Set(await hub.onlineInstalls());
    const usageByInstall = new Map(summary.installs.map((u) => [u.installId, u.counts]));
    const empty = (): UsageCounts => ({
      rpc: { used: 0, rejected: 0 },
      market: { used: 0, rejected: 0 },
      inference: { used: 0, rejected: 0 },
      ws: { used: 0, rejected: 0 },
    });

    const byInstall = new Map<string, InstallListing>();
    for (const row of (tokens?.results ?? []) as TokenRow[]) {
      const active = row.revoked_at === null && (row.expires_at === null || row.expires_at > now);
      const entry = byInstall.get(row.install_id) ?? {
        installId: row.install_id,
        createdAt: row.created_at,
        scopes: [],
        tokens: { total: 0, active: 0 },
        expiresAt: null,
        revoked: true,
        paired: paired.has(row.install_id),
        online: online.has(row.install_id),
        usage: usageByInstall.get(row.install_id) ?? empty(),
      };
      entry.createdAt = Math.min(entry.createdAt, row.created_at);
      entry.tokens.total += 1;
      if (active) {
        entry.tokens.active += 1;
        entry.revoked = false;
        for (const scope of parseScopes(row.scopes)) {
          if (!entry.scopes.includes(scope)) entry.scopes.push(scope);
        }
        if (row.expires_at === null) entry.expiresAt = null;
        else if (
          entry.tokens.active === 1 ||
          (entry.expiresAt !== null && row.expires_at > entry.expiresAt)
        ) {
          entry.expiresAt = row.expires_at;
        }
      }
      byInstall.set(row.install_id, entry);
    }

    return c.json({
      day: summary.day,
      resetAt: new Date(summary.resetAt).toISOString(),
      limits: quotaLimits(c.env),
      installs: [...byInstall.values()],
    });
  });

  // --- revoke / delete ---------------------------------------------------------
  async function revoke(c: Context<AppEnv>, installId: string, unlink: boolean): Promise<Response> {
    if (!INSTALL_ID_RE.test(installId)) {
      return badRequest('invalid_install_id', 'install id must match ^[A-Za-z0-9_-]{8,64}$');
    }
    const now = Date.now();
    const known = await c.env.DB.prepare(
      'SELECT COUNT(*) AS n FROM install_tokens WHERE install_id = ?',
    )
      .bind(installId)
      .first<{ n: number }>();
    if (!known || known.n === 0) {
      return notFound('unknown_install', 'no tokens were ever minted for that installation');
    }
    const updated = await c.env.DB.prepare(
      'UPDATE install_tokens SET revoked_at = ? WHERE install_id = ? AND revoked_at IS NULL',
    )
      .bind(now, installId)
      .run();

    let closedSockets = 0;
    try {
      closedSockets = await c.env.HUB.getByName(HUB_NAME).closeSockets(
        installId,
        CLOSE_REVOKED,
        'installation revoked',
      );
    } catch (error) {
      // The tokens are already dead; the socket dies at the next sweep at worst.
      log.warn('hub close failed after revoke', { installId, error: errorSummary(error) });
    }

    let unlinked = false;
    if (unlink) unlinked = await unlinkInstall(c.env.DB, installId);

    log.info('install revoked', {
      installId,
      revokedTokens: updated.meta.changes,
      closedSockets,
      unlinked,
    });
    return c.json({
      installId,
      revokedAt: now,
      revokedTokens: updated.meta.changes,
      closedSockets,
      unlinked,
      note: 'Rotation is not implemented; mint a new token for this installation if it should keep working.',
    });
  }

  app.post('/v1/admin/installs/:id/revoke', (c) => revoke(c, c.req.param('id'), false));
  app.delete('/v1/admin/installs/:id', (c) => revoke(c, c.req.param('id'), true));

  // --- usage -----------------------------------------------------------------
  app.get('/v1/admin/usage', async (c) => {
    const now = Date.now();
    const dayParam = c.req.query('day');
    let day = utcDayKey(now);
    if (dayParam !== undefined) {
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(dayParam) ||
        Number.isNaN(Date.parse(`${dayParam}T00:00:00Z`))
      ) {
        return problem({
          status: 400,
          code: 'invalid_day',
          title: 'Bad request',
          detail: 'day must be YYYY-MM-DD (UTC)',
        });
      }
      day = dayParam;
    }
    const summary = await c.env.HUB.getByName(HUB_NAME).usageSummary(now, day);
    return c.json({
      day: summary.day,
      windowStart: new Date(summary.windowStart).toISOString(),
      resetAt: new Date(summary.resetAt).toISOString(),
      limits: quotaLimits(c.env),
      totals: summary.totals,
      installs: summary.installs,
      openSockets: summary.openSockets,
    });
  });

  return app;
}
