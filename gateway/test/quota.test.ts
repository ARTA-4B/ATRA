import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, describe, expect, it } from 'vitest';
import { HUB_NAME } from '../src/hub.js';
import type { Hub } from '../src/hub.js';
import { UPSTREAMS } from '../src/rpc.js';
import { DEFAULT_QUOTAS, quotaLimits, utcDayEnd, utcDayKey } from '../src/quota.js';
import { adminCall, jsonResponse, mintToken, postJson, stubUpstreams } from './helpers.js';
import type { UpstreamStub } from './helpers.js';

const BASE_RPC = UPSTREAMS.base.publicUrl;

let upstream: UpstreamStub | null = null;
afterEach(() => {
  upstream?.restore();
  upstream = null;
});

const blockNumber = (id: number) => ({ jsonrpc: '2.0', method: 'eth_blockNumber', params: [], id });

describe('quota configuration', () => {
  it('reads limits from vars and falls back to the defaults on junk', () => {
    expect(quotaLimits(env)).toEqual(DEFAULT_QUOTAS);
    const tuned = {
      ...env,
      QUOTA_RPC_PER_DAY: '42',
      QUOTA_MARKET_PER_DAY: 'unlimited',
      QUOTA_INFERENCE_PER_DAY: '0',
      QUOTA_WS_CONNECTS_PER_DAY: ' 7 ',
    } as typeof env;
    expect(quotaLimits(tuned)).toEqual({
      rpc: 42,
      market: DEFAULT_QUOTAS.market,
      inference: 0,
      ws: 7,
    });
  });

  it('windows are UTC days', () => {
    const t = Date.UTC(2026, 8, 20, 23, 59, 59);
    expect(utcDayKey(t)).toBe('2026-09-20');
    expect(new Date(utcDayEnd(t)).toISOString()).toBe('2026-09-21T00:00:00.000Z');
  });
});

describe('Hub quotas', () => {
  it('counts per install, per kind, per day and refuses at the limit', async () => {
    const hub = env.HUB.getByName(HUB_NAME);
    const now = Date.UTC(2026, 8, 20, 12, 0, 0);
    const a = await hub.consumeQuota('install-a', 'rpc', 2, now);
    expect(a).toMatchObject({ allowed: true, used: 1, rejected: 0, limit: 2, day: '2026-09-20' });
    expect(new Date(a.resetAt).toISOString()).toBe('2026-09-21T00:00:00.000Z');
    expect((await hub.consumeQuota('install-a', 'rpc', 2, now)).used).toBe(2);
    const third = await hub.consumeQuota('install-a', 'rpc', 2, now);
    expect(third).toMatchObject({ allowed: false, used: 2, rejected: 1 });
    // Other kinds and other installs are separate counters.
    expect((await hub.consumeQuota('install-a', 'market', 2, now)).allowed).toBe(true);
    expect((await hub.consumeQuota('install-b', 'rpc', 2, now)).allowed).toBe(true);
    // A new UTC day starts from zero.
    const tomorrow = await hub.consumeQuota('install-a', 'rpc', 2, now + 24 * 60 * 60_000);
    expect(tomorrow).toMatchObject({ allowed: true, used: 1, day: '2026-09-21' });
    // A zero limit refuses everything.
    expect((await hub.consumeQuota('install-c', 'inference', 0, now)).allowed).toBe(false);

    const usage = await hub.usageFor('install-a', now);
    expect(usage).toEqual({
      rpc: { used: 2, rejected: 1 },
      market: { used: 1, rejected: 0 },
      inference: { used: 0, rejected: 0 },
      ws: { used: 0, rejected: 0 },
    });
  });

  it('persists the counters across a Durable Object restart', async () => {
    const hub = env.HUB.getByName(HUB_NAME);
    const now = Date.now();
    await hub.consumeQuota('durable-install', 'rpc', 10, now);
    await hub.consumeQuota('durable-install', 'rpc', 10, now);
    await hub.consumeQuota('durable-install', 'market', 10, now);

    // The instance is torn down; only what is in SQLite survives.
    await evictDurableObject(hub);

    expect(await hub.usageFor('durable-install', now)).toMatchObject({
      rpc: { used: 2, rejected: 0 },
      market: { used: 1, rejected: 0 },
    });
    expect((await hub.consumeQuota('durable-install', 'rpc', 10, now)).used).toBe(3);
    // And the rows really are in the object's SQLite storage.
    const rows = await runInDurableObject(hub, (_instance: Hub, state) =>
      state.storage.sql
        .exec<{ kind: string; used: number }>(
          'SELECT kind, used FROM quota_usage WHERE install_id = ? ORDER BY kind',
          'durable-install',
        )
        .toArray(),
    );
    expect(rows).toEqual([
      { kind: 'market', used: 1 },
      { kind: 'rpc', used: 3 },
    ]);
  });

  it('purges rows older than the retention window', async () => {
    const hub = env.HUB.getByName(HUB_NAME);
    const now = Date.UTC(2026, 8, 20);
    await hub.consumeQuota('old-install', 'rpc', 10, now - 10 * 24 * 60 * 60_000);
    await hub.consumeQuota('new-install', 'rpc', 10, now);
    expect(await hub.purgeUsage(now)).toBe(1);
    expect((await hub.usageSummary(now, '2026-09-10')).installs).toEqual([]);
    // Durable Object storage is shared across the tests in this file, so
    // other installs may be present; the old one must not be.
    const today = (await hub.usageSummary(now)).installs.map((i) => i.installId);
    expect(today).toContain('new-install');
    expect(today).not.toContain('old-install');
  });
});

describe('quota exhaustion over HTTP', () => {
  it('answers 429 with the limit, the window, the reset time and Retry-After, then resets next day', async () => {
    upstream = stubUpstreams({
      [BASE_RPC]: ({ body }) => jsonResponse({ jsonrpc: '2.0', id: body.id, result: '0x1' }),
    });
    const minted = await mintToken();
    const tight = { ...env, QUOTA_RPC_PER_DAY: '2' } as typeof env;

    const first = await postJson('/v1/rpc/base', minted.token, blockNumber(1), { env: tight });
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('x-ratelimit-limit')).toBe('2');
    expect(first.response.headers.get('x-ratelimit-remaining')).toBe('1');
    // Second call: a cache hit, and still counted.
    const second = await postJson('/v1/rpc/base', minted.token, blockNumber(2), { env: tight });
    expect(second.response.status).toBe(200);
    expect(second.response.headers.get('x-ratelimit-remaining')).toBe('0');

    const third = await postJson('/v1/rpc/base', minted.token, blockNumber(3), { env: tight });
    expect(third.response.status).toBe(429);
    expect(third.response.headers.get('content-type')).toContain('application/problem+json');
    expect(third.body).toMatchObject({
      code: 'quota_exceeded',
      quota: 'rpc',
      limit: 2,
      used: 2,
      window: 'utc_day',
    });
    expect(third.body.detail).toContain('2 requests per UTC day');
    const resetAt = Date.parse(third.body.resetAt);
    expect(resetAt).toBe(utcDayEnd(Date.now()));
    expect(third.body.windowStart).toBe(new Date(resetAt - 24 * 60 * 60_000).toISOString());
    const retryAfter = Number(third.response.headers.get('retry-after'));
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(24 * 60 * 60);
    expect(third.body.retryAfterSeconds).toBe(retryAfter);
    expect(third.response.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(upstream.calls).toHaveLength(1);

    // The rejection is visible to the admin summary.
    const usage = await adminCall('/v1/admin/usage');
    expect(usage.response.status).toBe(200);
    const row = usage.body.installs.find((i: any) => i.installId === minted.installId);
    expect(row.counts.rpc).toEqual({ used: 2, rejected: 1 });
    expect(usage.body.limits.rpc).toBe(DEFAULT_QUOTAS.rpc);
  });

  it('caps websocket connects per day', async () => {
    const minted = await mintToken();
    const { openSocket, wsRequest } = await import('./helpers.js');
    const tight = { ...env, QUOTA_WS_CONNECTS_PER_DAY: '1' } as typeof env;
    const { default: worker } = await import('../src/index.js');
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} };
    const first = await worker.fetch(wsRequest(minted.token), tight, ctx);
    expect(first.status).toBe(101);
    first.webSocket!.accept();
    first.webSocket!.close(1000, 'done');
    const second = await worker.fetch(wsRequest(minted.token), tight, ctx);
    expect(second.status).toBe(429);
    const body = (await second.json()) as any;
    expect(body).toMatchObject({ code: 'quota_exceeded', quota: 'ws', limit: 1 });
    expect(second.headers.get('retry-after')).toBeTruthy();
    // Unchanged env: the default limit lets it through.
    expect((await openSocket(wsRequest(minted.token))).status).toBe(101);
  });
});

describe('cron', () => {
  it('purges old quota rows on the hourly run and leaves them alone otherwise', async () => {
    const { createExecutionContext, createScheduledController, waitOnExecutionContext } =
      await import('cloudflare:test');
    const { default: worker } = await import('../src/index.js');
    const hub = env.HUB.getByName(HUB_NAME);
    const now = Date.UTC(2026, 8, 20, 3, 0, 0);
    await hub.consumeQuota('cron-old-install', 'rpc', 10, now - 30 * 24 * 60 * 60_000);

    // Minute 5: not the hourly slot, the row stays.
    let ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: now + 5 * 60_000 }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await hub.usageSummary(now, '2026-08-21')).installs).toHaveLength(1);

    // Minute 0: purged.
    ctx = createExecutionContext();
    worker.scheduled(createScheduledController({ scheduledTime: now }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect((await hub.usageSummary(now, '2026-08-21')).installs).toHaveLength(0);
  });
});
