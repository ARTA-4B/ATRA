import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEXSCREENER_ORIGIN, GECKOTERMINAL_ORIGIN, MARKET_CACHE_TTL_S } from '../src/market.js';
import { call, jsonResponse, mintToken, stubUpstreams } from './helpers.js';
import type { UpstreamStub } from './helpers.js';

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const POOL = '0xd0b53d9277642d899df5c87a3966a349a798f224';

/** A DexScreener token-pairs row shaped like the real API (fields ATRA reads). */
function dsPair(overrides: Record<string, unknown> = {}) {
  return {
    chainId: 'base',
    dexId: 'uniswap',
    pairAddress: POOL,
    baseToken: { address: WETH_BASE, name: 'Wrapped Ether', symbol: 'WETH' },
    quoteToken: { address: USDC_BASE, name: 'USD Coin', symbol: 'USDC' },
    priceUsd: '2500.12',
    priceNative: '1.0',
    liquidity: { usd: 1234567.891 },
    volume: { h24: 987654.3 },
    priceChange: { m5: 0.12, h1: -1.5, h6: 2, h24: 10.25 },
    ...overrides,
  };
}

function gtPool(overrides: Record<string, unknown> = {}) {
  return {
    id: `base_${POOL}`,
    type: 'pool',
    attributes: {
      name: 'WETH / USDC 0.05%',
      address: POOL,
      base_token_price_usd: '2501.5',
      base_token_price_native_currency: '1.0',
      reserve_in_usd: '1000000.5',
      volume_usd: { h24: '500000' },
      price_change_percentage: { m5: '0.1', h1: '-1.25', h6: '2', h24: 'nope' },
      ...(overrides.attributes as object),
    },
    relationships: {
      base_token: { data: { id: `base_${WETH_BASE}` } },
      quote_token: { data: { id: `base_${USDC_BASE}` } },
      dex: { data: { id: 'uniswap_v3_base' } },
    },
  };
}

let upstream: UpstreamStub | null = null;
let token: string;

beforeEach(async () => {
  token = (await mintToken()).token;
});
afterEach(() => {
  upstream?.restore();
  upstream = null;
});

const get = (path: string, options: { env?: typeof env; token?: string | null } = {}) =>
  call(path, {
    method: 'GET',
    token: options.token === undefined ? token : options.token,
    ...(options.env ? { env: options.env } : {}),
  });

describe('GET /v1/market', () => {
  it('requires a token with the market scope', async () => {
    upstream = stubUpstreams({});
    expect(
      (await get(`/v1/market/base/tokens/${USDC_BASE}/pools`, { token: null })).response.status,
    ).toBe(401);
    const telegramOnly = await mintToken({ scopes: ['telegram'] });
    const scoped = await get(`/v1/market/base/tokens/${USDC_BASE}/pools`, {
      token: telegramOnly.token,
    });
    expect(scoped.response.status).toBe(403);
    expect(scoped.body.code).toBe('scope_missing');
    expect(upstream.calls).toHaveLength(0);
  });

  it('returns pools in the runtime shape with source and asOf, from DexScreener by default', async () => {
    upstream = stubUpstreams({
      [DEXSCREENER_ORIGIN]: () =>
        jsonResponse([dsPair(), dsPair({ chainId: 'bsc' }), { junk: true }]),
    });
    const before = Date.now();
    const { response, body } = await get(`/v1/market/base/tokens/${WETH_BASE}/pools`);
    expect(response.status).toBe(200);
    expect(body.source).toBe('dexscreener');
    expect(body.cache).toBe('miss');
    expect(body.ttlSeconds).toBe(MARKET_CACHE_TTL_S);
    expect(Date.parse(body.asOf)).toBeGreaterThanOrEqual(before);
    // The bsc row and the junk row are dropped, never substituted.
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      chain: 'base',
      poolId: POOL,
      dexId: 'uniswap',
      base: { address: WETH_BASE, symbol: 'WETH', name: 'Wrapped Ether', decimals: null },
      quote: { address: USDC_BASE, symbol: 'USDC' },
      priceUsd: '2500.12',
      priceNative: '1.0',
      liquidityUsd: '1234567.891',
      volume24hUsd: '987654.3',
      change: { m5: 12, h1: -150, h6: 200, h24: 1025 },
      source: 'dexscreener',
      freshnessMs: 0,
    });
    expect(body.data[0].observedAt).toBe(body.asOf);
    expect(upstream.calls[0]!.url).toBe(`${DEXSCREENER_ORIGIN}/token-pairs/v1/base/${WETH_BASE}`);
    expect(response.headers.get('x-ratelimit-limit')).toBe('2000');
  });

  it('maps GeckoTerminal into the same shape when asked for that source', async () => {
    upstream = stubUpstreams({
      [GECKOTERMINAL_ORIGIN]: () => jsonResponse({ data: [gtPool()] }),
    });
    const { response, body } = await get(
      `/v1/market/base/tokens/${WETH_BASE}/pools?source=geckoterminal`,
    );
    expect(response.status).toBe(200);
    expect(body.source).toBe('geckoterminal');
    expect(body.data[0]).toMatchObject({
      chain: 'base',
      poolId: POOL,
      dexId: 'uniswap_v3_base',
      base: { address: WETH_BASE, symbol: 'WETH' },
      quote: { address: USDC_BASE, symbol: 'USDC' },
      priceUsd: '2501.5',
      liquidityUsd: '1000000.5',
      volume24hUsd: '500000',
      change: { m5: 10, h1: -125, h6: 200, h24: null },
      source: 'geckoterminal',
    });
    expect(upstream.calls[0]!.headers.accept).toContain('version=20230302');
  });

  it('serves the second call within 60 s from KV with the original asOf and no provider call', async () => {
    upstream = stubUpstreams({ [DEXSCREENER_ORIGIN]: () => jsonResponse([dsPair()]) });
    const first = await get(`/v1/market/base/pools/${POOL}`);
    expect(first.response.status).toBe(200);
    expect(first.body.cache).toBe('miss');
    const second = await get(`/v1/market/base/pools/${POOL}`);
    expect(second.response.status).toBe(200);
    expect(second.body.cache).toBe('hit');
    expect(second.body.asOf).toBe(first.body.asOf);
    expect(second.body.data).toEqual(first.body.data);
    expect(upstream.callsTo(DEXSCREENER_ORIGIN)).toHaveLength(1);
    // The entry is in the KV namespace, not only in a per-colo cache.
    const keys = await env.KV!.list({ prefix: 'market:' });
    expect(keys.keys.length).toBeGreaterThan(0);
  });

  it('falls back to the Cache API when no KV namespace is bound', async () => {
    upstream = stubUpstreams({ [DEXSCREENER_ORIGIN]: () => jsonResponse([dsPair()]) });
    const noKv = { ...env, KV: undefined } as unknown as typeof env;
    const address = '0x0000000000000000000000000000000000000abc';
    const first = await get(`/v1/market/base/tokens/${address}/pools`, { env: noKv });
    expect(first.body.cache).toBe('miss');
    const second = await get(`/v1/market/base/tokens/${address}/pools`, { env: noKv });
    expect(second.body.cache).toBe('hit');
    expect(upstream.callsTo(DEXSCREENER_ORIGIN)).toHaveLength(1);
  });

  it('reports a missing price as null with a reason, never as zero', async () => {
    upstream = stubUpstreams({
      // A pool where the asked token is the QUOTE token quotes the other
      // token's price; a "0" price is no price at all.
      [DEXSCREENER_ORIGIN]: () =>
        jsonResponse([
          dsPair(),
          dsPair({
            pairAddress: '0xother',
            baseToken: { address: USDC_BASE, symbol: 'USDC' },
            quoteToken: { address: WETH_BASE, symbol: 'WETH' },
            priceUsd: '0',
          }),
        ]),
    });
    const { response, body } = await get(`/v1/market/base/tokens/${USDC_BASE}/price`);
    expect(response.status).toBe(200);
    expect(body.source).toBe('dexscreener');
    expect(typeof body.asOf).toBe('string');
    expect(body.data).toEqual({
      chain: 'base',
      token: USDC_BASE,
      priceUsd: null,
      reason: 'provider has no pool quoting this token as base',
    });

    const weth = await get(`/v1/market/base/tokens/${WETH_BASE}/price`);
    expect(weth.body.data).toEqual({ chain: 'base', token: WETH_BASE, priceUsd: '2500.12' });
  });

  it('answers 404 with source and asOf for a pool the provider does not know, and caches the miss', async () => {
    upstream = stubUpstreams({
      [DEXSCREENER_ORIGIN]: () => jsonResponse({ schemaVersion: '1.0.0', pairs: null }),
      [GECKOTERMINAL_ORIGIN]: () =>
        jsonResponse({ errors: [{ status: '404', title: 'Not Found' }] }, 404),
    });
    const unknown = '0x00000000000000000000000000000000000000ff';
    const miss = await get(`/v1/market/base/pools/${unknown}`);
    expect(miss.response.status).toBe(404);
    expect(miss.response.headers.get('content-type')).toContain('application/problem+json');
    expect(miss.body).toMatchObject({ code: 'not_found', source: 'dexscreener', cache: 'miss' });
    expect(typeof miss.body.asOf).toBe('string');
    expect(miss.body.detail).toContain('no pool');

    const again = await get(`/v1/market/base/pools/${unknown}`);
    expect(again.response.status).toBe(404);
    expect(again.body.cache).toBe('hit');
    expect(upstream.callsTo(DEXSCREENER_ORIGIN)).toHaveLength(1);

    const gt = await get(`/v1/market/base/pools/${unknown}?source=geckoterminal`);
    expect(gt.response.status).toBe(404);
    expect(gt.body.source).toBe('geckoterminal');
  });

  it('returns OHLCV candles in chronological order from GeckoTerminal', async () => {
    upstream = stubUpstreams({
      [GECKOTERMINAL_ORIGIN]: () =>
        jsonResponse({
          data: {
            attributes: {
              ohlcv_list: [
                [1_700_003_600, 2, 3, 1, 2.5, 100],
                [1_700_000_000, 1, 2, 0.5, 2, 50],
              ],
            },
          },
        }),
    });
    const { response, body } = await get(
      `/v1/market/base/pools/${POOL}/ohlcv?timeframe=1h&limit=2`,
    );
    expect(response.status).toBe(200);
    expect(body.source).toBe('geckoterminal');
    expect(body.data).toMatchObject({
      chain: 'base',
      poolId: POOL,
      timeframe: '1h',
      source: 'geckoterminal',
    });
    expect(body.data.candles.map((c: any) => c.openedAt)).toEqual([
      '2023-11-14T22:13:20.000Z',
      '2023-11-14T23:13:20.000Z',
    ]);
    expect(body.data.candles[1]).toEqual({
      openedAt: '2023-11-14T23:13:20.000Z',
      open: '2',
      high: '3',
      low: '1',
      close: '2.5',
      volumeUsd: '100',
    });
    expect(upstream.calls[0]!.url).toContain(
      `/networks/base/pools/${POOL}/ohlcv/hour?aggregate=1&limit=2&currency=usd`,
    );
  });

  it('searches through DexScreener and keeps only supported chains', async () => {
    upstream = stubUpstreams({
      [DEXSCREENER_ORIGIN]: () =>
        jsonResponse({
          pairs: [
            dsPair(),
            dsPair({ chainId: 'ethereum' }),
            dsPair({ chainId: 'solana', pairAddress: 'So1PooL' }),
          ],
        }),
    });
    const all = await get('/v1/market/search?q=weth');
    expect(all.response.status).toBe(200);
    expect(all.body.data.map((p: any) => p.chain)).toEqual(['base', 'solana']);
    const only = await get('/v1/market/search?q=weth&chain=solana');
    expect(only.body.data.map((p: any) => p.chain)).toEqual(['solana']);
  });

  it('validates chain, address, source, timeframe and query before spending anything', async () => {
    upstream = stubUpstreams({});
    expect((await get(`/v1/market/ethereum/tokens/${USDC_BASE}/pools`)).response.status).toBe(404);
    expect((await get('/v1/market/base/tokens/short/pools')).body.code).toBe('invalid_address');
    expect(
      (await get(`/v1/market/base/tokens/${USDC_BASE}/pools?source=coingecko`)).body.code,
    ).toBe('invalid_source');
    expect((await get(`/v1/market/base/pools/${POOL}/ohlcv?timeframe=2h`)).body.code).toBe(
      'invalid_timeframe',
    );
    expect((await get('/v1/market/search?q=')).body.code).toBe('invalid_query');
    expect(upstream.calls).toHaveLength(0);
  });

  it('turns a provider failure into a 502/503 problem naming the provider, never a fabricated row', async () => {
    upstream = stubUpstreams({
      [DEXSCREENER_ORIGIN]: () =>
        new Response('rate limited', { status: 429, headers: { 'retry-after': '30' } }),
      [GECKOTERMINAL_ORIGIN]: () => new Response('boom', { status: 500 }),
    });
    const busy = await get(`/v1/market/bsc/tokens/${USDC_BASE}/pools`);
    expect(busy.response.status).toBe(503);
    expect(busy.body).toMatchObject({
      code: 'upstream_rate_limited',
      source: 'dexscreener',
      retryAfterSeconds: 30,
    });
    expect(busy.response.headers.get('retry-after')).toBe('30');

    const broken = await get(`/v1/market/bsc/tokens/${USDC_BASE}/pools?source=geckoterminal`);
    expect(broken.response.status).toBe(502);
    expect(broken.body).toMatchObject({
      code: 'upstream_error',
      source: 'geckoterminal',
      upstreamStatus: 500,
    });
  });
});
