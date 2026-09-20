/**
 * Per-install daily quotas.
 *
 * The counters live in the Hub Durable Object's SQLite storage (see hub.ts),
 * so they survive eviction and are exact: one object, one writer, one
 * statement per increment. This file holds what does not need the object:
 * the quota kinds, the configurable limits, the UTC-day window arithmetic and
 * the 429 problem document.
 *
 * Defaults are meant to be generous for one household (a runtime polling
 * balances, gas and a few pools every minute stays well inside them) and
 * cheap for the project (the Free plan's 100,000 requests/day are shared by
 * every Worker on the account). They are a choice, not a measurement; the
 * README says so. Each is overridable per environment with a var.
 */
import type { Env } from './env.js';
import { problem } from './problem.js';

export const QUOTA_KINDS = ['rpc', 'market', 'inference', 'ws'] as const;
export type QuotaKind = (typeof QUOTA_KINDS)[number];

export type QuotaLimits = Record<QuotaKind, number>;

export const DEFAULT_QUOTAS: QuotaLimits = {
  rpc: 5_000,
  market: 2_000,
  inference: 200,
  ws: 500,
};

const VAR_FOR_KIND: Record<QuotaKind, keyof Env> = {
  rpc: 'QUOTA_RPC_PER_DAY',
  market: 'QUOTA_MARKET_PER_DAY',
  inference: 'QUOTA_INFERENCE_PER_DAY',
  ws: 'QUOTA_WS_CONNECTS_PER_DAY',
};

/**
 * Limits from the environment. A var that is missing or not a non-negative
 * integer falls back to the default rather than to "unlimited": a typo in
 * wrangler.jsonc must never switch a quota off.
 */
export function quotaLimits(env: Env): QuotaLimits {
  const out = { ...DEFAULT_QUOTAS };
  for (const kind of QUOTA_KINDS) {
    const raw = env[VAR_FOR_KIND[kind]];
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!/^\d{1,9}$/.test(trimmed)) continue;
    out[kind] = Number(trimmed);
  }
  return out;
}

/** "2026-09-20" for any instant on that UTC day. */
export function utcDayKey(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The next UTC midnight, when every counter resets. */
export function utcDayEnd(now: number): number {
  return utcDayStart(now) + 24 * 60 * 60_000;
}

/** What the Hub returns for one consume() call. */
export interface QuotaDecision {
  allowed: boolean;
  kind: QuotaKind;
  limit: number;
  /** Requests counted so far today, including this one when allowed. */
  used: number;
  /** Requests refused today because the limit was reached. */
  rejected: number;
  day: string;
  windowStart: number;
  resetAt: number;
}

export function retryAfterSeconds(decision: QuotaDecision, now: number): number {
  return Math.max(1, Math.ceil((decision.resetAt - now) / 1000));
}

/** 429 naming the limit, the window and when it resets, plus Retry-After. */
export function quotaExceeded(decision: QuotaDecision, now: number): Response {
  const retryAfter = retryAfterSeconds(decision, now);
  const resetAt = new Date(decision.resetAt).toISOString();
  return problem({
    status: 429,
    code: 'quota_exceeded',
    title: 'Quota exceeded',
    detail: `the ${decision.kind} quota of ${decision.limit} requests per UTC day is exhausted; it resets at ${resetAt}`,
    extra: {
      quota: decision.kind,
      limit: decision.limit,
      used: decision.used,
      window: 'utc_day',
      windowStart: new Date(decision.windowStart).toISOString(),
      resetAt,
      retryAfterSeconds: retryAfter,
    },
    headers: {
      'retry-after': String(retryAfter),
      'x-ratelimit-limit': String(decision.limit),
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(Math.ceil(decision.resetAt / 1000)),
    },
  });
}

/** Headers added to every proxied success so a runtime can pace itself. */
export function quotaHeaders(decision: QuotaDecision): Record<string, string> {
  return {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(Math.max(0, decision.limit - decision.used)),
    'x-ratelimit-reset': String(Math.ceil(decision.resetAt / 1000)),
  };
}
