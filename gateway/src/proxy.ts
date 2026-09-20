/**
 * The two gates every proxied request passes after authentication:
 *
 *   1. the burst limiter (Workers rate limiting binding RL_PROXY; per install,
 *      10 s window, absent in dev and tests);
 *   2. the daily quota (Hub Durable Object, SQLite, exact).
 *
 * The order matters: the burst check is free and stops a tight loop before
 * it costs a Durable Object request. Both refusals are metered so the admin
 * usage summary and Analytics Engine see them.
 */
import type { Context } from 'hono';
import type { AppEnv } from './context.js';
import { HUB_NAME } from './hub.js';
import { rateLimited } from './problem.js';
import { quotaExceeded, quotaLimits } from './quota.js';
import type { QuotaDecision, QuotaKind } from './quota.js';
import { allow } from './ratelimit.js';
import { recordUsage } from './usage.js';
import type { UsageRoute } from './usage.js';

/** Retry-After for the burst limiter; its window is 10 s. */
export const BURST_RETRY_AFTER_S = 10;

export type GuardResult = { ok: true; decision: QuotaDecision } | { ok: false; response: Response };

export async function guardProxy(
  c: Context<AppEnv>,
  kind: QuotaKind,
  route: UsageRoute,
  chain: string,
  now: number = Date.now(),
): Promise<GuardResult> {
  const install = c.get('install');
  if (!(await allow(c.env.RL_PROXY, `${route}:${install.installId}`))) {
    recordUsage(c.env, {
      installId: install.installId,
      route,
      chain,
      outcome: 'rate_limited',
      cached: false,
    });
    return { ok: false, response: rateLimited(BURST_RETRY_AFTER_S) };
  }
  const limit = quotaLimits(c.env)[kind];
  const decision = await c.env.HUB.getByName(HUB_NAME).consumeQuota(
    install.installId,
    kind,
    limit,
    now,
  );
  if (!decision.allowed) {
    recordUsage(c.env, {
      installId: install.installId,
      route,
      chain,
      outcome: 'quota_exceeded',
      cached: false,
    });
    return { ok: false, response: quotaExceeded(decision, now) };
  }
  return { ok: true, decision };
}

/** Read a JSON body without throwing; null when it is not JSON. */
export async function readJson(
  c: Context<AppEnv>,
): Promise<{ ok: true; body: unknown } | { ok: false }> {
  try {
    const text = await c.req.text();
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
