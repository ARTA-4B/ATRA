/**
 * GET /v1/market/...: a read-through proxy over DexScreener and GeckoTerminal.
 *
 * The runtime already talks to both providers directly and maps them into
 * one `MarketSnapshot` vocabulary (runtime/src/market/types.ts). This proxy
 * answers in that same shape so a runtime can point at the gateway instead
 * of the providers with no translation layer, and adds what a proxy must be
 * honest about: `source` (which provider), `asOf` (when the provider was
 * read) and `cache` (whether this response came from the 60 s cache).
 *
 * The rules the runtime's providers follow hold here too: a value ATRA
 * cannot parse exactly is null with a reason, a zero price is "no price",
 * and a pool the provider does not know is a 404, never an empty row. Misses
 * are cached for the same 60 s as hits so a hot unknown address does not
 * become 60 provider calls a minute.
 *
 * Both providers are keyless today; the gateway adds nothing but caching and
 * the quota. That is deliberate: the same calls work from the runtime with
 * no gateway at all, and the README says so.
 */
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { requireInstall } from './auth.js';
import { marketStore } from './cache.js';
import type { CacheStore } from './cache.js';
import type { AppEnv } from './context.js';
import { sha256Hex } from './crypto.js';
import { isChainId } from './env.js';
import type { ChainId } from './env.js';
import { logger } from './log.js';
import { badGateway, badRequest, notFound, problem, upstreamBusy } from './problem.js';
import { guardProxy } from './proxy.js';
import { quotaHeaders } from './quota.js';
import { recordUsage } from './usage.js';
import type { UsageOutcome } from './usage.js';

const log = logger('market');

export const MARKET_CACHE_TTL_S = 60;
export const PROVIDER_TIMEOUT_MS = 10_000;

export const DEXSCREENER_ORIGIN = 'https://api.dexscreener.com';
export const GECKOTERMINAL_ORIGIN = 'https://api.geckoterminal.com/api/v2';

export type MarketSource = 'dexscreener' | 'geckoterminal';
const SOURCES: readonly MarketSource[] = ['dexscreener', 'geckoterminal'];

/** Both providers happen to use ATRA's chain ids as their slugs (verified by the runtime, 2026-09-20). */
const SLUGS: Record<ChainId, string> = {
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
  solana: 'solana',
};
const SLUG_TO_CHAIN = new Map<string, ChainId>(
  (Object.entries(SLUGS) as Array<[ChainId, string]>).map(([chain, slug]) => [slug, chain]),
);

// --- The normalised shape (mirrors runtime/src/market/types.ts) ------------

export interface TokenRef {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface MarketSnapshot {
  chain: ChainId;
  poolId: string;
  dexId: string | null;
  base: TokenRef;
  quote: TokenRef;
  priceUsd: string | null;
  priceNative: string | null;
  liquidityUsd: string | null;
  volume24hUsd: string | null;
  change: { m5: number | null; h1: number | null; h6: number | null; h24: number | null };
  observedAt: string;
  fetchedAt: string;
  source: MarketSource;
  freshnessMs: number;
  reason?: string;
}

export interface Candle {
  openedAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeUsd: string | null;
}

export const TIMEFRAMES = ['1m', '5m', '15m', '1h', '4h', '1d'] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export interface OhlcvSeries {
  chain: ChainId;
  poolId: string;
  timeframe: Timeframe;
  candles: Candle[];
  source: MarketSource;
  fetchedAt: string;
}

/** Every market response: the data, where it came from and when. */
export interface MarketEnvelope<T> {
  data: T;
  source: MarketSource;
  /** When the provider was read. Neither provider stamps its rows, so this is the honest claim. */
  asOf: string;
  fetchedAt: string;
  cache: 'hit' | 'miss';
  ttlSeconds: number;
}

// --- Provider schemas (the fields ATRA uses; everything else is dropped) ---

const dsToken = z.object({
  address: z.string().min(1),
  name: z.string().nullish(),
  symbol: z.string().nullish(),
});

const dsPair = z.object({
  chainId: z.string(),
  dexId: z.string().nullish(),
  pairAddress: z.string().min(1),
  baseToken: dsToken,
  quoteToken: dsToken,
  priceUsd: z.string().nullish(),
  priceNative: z.string().nullish(),
  liquidity: z.object({ usd: z.number().nullish() }).nullish(),
  volume: z.object({ h24: z.number().nullish() }).nullish(),
  priceChange: z
    .object({
      m5: z.number().nullish(),
      h1: z.number().nullish(),
      h6: z.number().nullish(),
      h24: z.number().nullish(),
    })
    .nullish(),
});
type DsPair = z.infer<typeof dsPair>;

const gtPool = z.object({
  id: z.string(),
  attributes: z.object({
    name: z.string().nullish(),
    address: z.string().min(1),
    base_token_price_usd: z.string().nullish(),
    base_token_price_native_currency: z.string().nullish(),
    reserve_in_usd: z.string().nullish(),
    volume_usd: z.object({ h24: z.string().nullish() }).nullish(),
    price_change_percentage: z
      .object({
        m5: z.string().nullish(),
        h1: z.string().nullish(),
        h6: z.string().nullish(),
        h24: z.string().nullish(),
      })
      .nullish(),
  }),
  relationships: z
    .object({
      base_token: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
      quote_token: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
      dex: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
    })
    .nullish(),
});
type GtPool = z.infer<typeof gtPool>;
const gtList = z.object({ data: z.array(gtPool) });
const gtSingle = z.object({ data: gtPool });
const gtTokenPrice = z.object({
  data: z.object({ attributes: z.object({ token_prices: z.record(z.string(), z.string()) }) }),
});
const gtOhlcv = z.object({
  data: z.object({
    attributes: z.object({
      ohlcv_list: z.array(
        z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
      ),
    }),
  }),
});

// --- Normalisation helpers (same rules as the runtime's providers) ---------

/** Keep provider decimals as a string; zero and anything unparsable are "no value". */
function decimalOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  return /[1-9]/.test(value) ? value : null;
}

function numberToDecimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return value.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function percentToBps(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function percentStringToBps(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

function dsSnapshot(pair: DsPair, chain: ChainId, fetchedAt: number): MarketSnapshot {
  const priceUsd = decimalOrNull(pair.priceUsd);
  const at = new Date(fetchedAt).toISOString();
  return {
    chain,
    poolId: pair.pairAddress,
    dexId: pair.dexId ?? null,
    base: {
      address: pair.baseToken.address,
      symbol: pair.baseToken.symbol ?? null,
      name: pair.baseToken.name ?? null,
      decimals: null,
    },
    quote: {
      address: pair.quoteToken.address,
      symbol: pair.quoteToken.symbol ?? null,
      name: pair.quoteToken.name ?? null,
      decimals: null,
    },
    priceUsd,
    priceNative: decimalOrNull(pair.priceNative),
    liquidityUsd: numberToDecimal(pair.liquidity?.usd),
    volume24hUsd: numberToDecimal(pair.volume?.h24),
    change: {
      m5: percentToBps(pair.priceChange?.m5),
      h1: percentToBps(pair.priceChange?.h1),
      h6: percentToBps(pair.priceChange?.h6),
      h24: percentToBps(pair.priceChange?.h24),
    },
    observedAt: at,
    fetchedAt: at,
    source: 'dexscreener',
    freshnessMs: 0,
    ...(priceUsd === null ? { reason: 'provider returned no usable USD price for this pair' } : {}),
  };
}

function dsMapMany(raw: unknown, chain: ChainId, fetchedAt: number): MarketSnapshot[] {
  const list = raw !== null && typeof raw === 'object' && 'pairs' in raw ? raw.pairs : raw;
  if (!Array.isArray(list)) return [];
  const out: MarketSnapshot[] = [];
  for (const entry of list) {
    const parsed = dsPair.safeParse(entry);
    if (!parsed.success) continue;
    if (SLUG_TO_CHAIN.get(parsed.data.chainId) !== chain) continue;
    out.push(dsSnapshot(parsed.data, chain, fetchedAt));
  }
  return out.sort(byLiquidityDescending);
}

function splitPairName(name: string | null | undefined): [string | null, string | null] {
  if (!name) return [null, null];
  const parts = name.split('/').map((part) => part.trim());
  const clean = (value: string | undefined): string | null => {
    if (!value) return null;
    const symbol = value.replace(/\s+[\d.]+%$/, '').trim();
    return symbol.length > 0 ? symbol : null;
  };
  return [clean(parts[0]), clean(parts[1])];
}

function tokenAddressFromId(id: string | null | undefined): string {
  if (!id) return '';
  const index = id.indexOf('_');
  return index === -1 ? id : id.slice(index + 1);
}

function gtSnapshot(pool: GtPool, chain: ChainId, fetchedAt: number): MarketSnapshot {
  const a = pool.attributes;
  const [baseSymbol, quoteSymbol] = splitPairName(a.name);
  const priceUsd = decimalOrNull(a.base_token_price_usd);
  const at = new Date(fetchedAt).toISOString();
  return {
    chain,
    poolId: a.address,
    dexId: pool.relationships?.dex?.data?.id ?? null,
    base: {
      address: tokenAddressFromId(pool.relationships?.base_token?.data?.id),
      symbol: baseSymbol,
      name: null,
      decimals: null,
    },
    quote: {
      address: tokenAddressFromId(pool.relationships?.quote_token?.data?.id),
      symbol: quoteSymbol,
      name: null,
      decimals: null,
    },
    priceUsd,
    priceNative: decimalOrNull(a.base_token_price_native_currency),
    liquidityUsd: decimalOrNull(a.reserve_in_usd),
    volume24hUsd: decimalOrNull(a.volume_usd?.h24),
    change: {
      m5: percentStringToBps(a.price_change_percentage?.m5),
      h1: percentStringToBps(a.price_change_percentage?.h1),
      h6: percentStringToBps(a.price_change_percentage?.h6),
      h24: percentStringToBps(a.price_change_percentage?.h24),
    },
    observedAt: at,
    fetchedAt: at,
    source: 'geckoterminal',
    freshnessMs: 0,
    ...(priceUsd === null ? { reason: 'provider returned no usable USD price' } : {}),
  };
}

function byLiquidityDescending(a: MarketSnapshot, b: MarketSnapshot): number {
  const left = a.liquidityUsd === null ? -1 : Number(a.liquidityUsd);
  const right = b.liquidityUsd === null ? -1 : Number(b.liquidityUsd);
  return right - left;
}

// --- Provider fetch ----------------------------------------------------------

type ProviderResult =
  | { ok: true; body: unknown; status: number }
  | { ok: false; kind: 'rate_limited'; retryAfter: number }
  | { ok: false; kind: 'http'; status: number }
  | { ok: false; kind: 'unreachable' };

async function providerGet(url: string, accept: string): Promise<ProviderResult> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept },
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, kind: 'unreachable' };
  }
  if (response.status === 429) {
    const header = Number(response.headers.get('retry-after') ?? '60');
    return { ok: false, kind: 'rate_limited', retryAfter: Number.isFinite(header) ? header : 60 };
  }
  // GeckoTerminal answers 404 for an unknown pool; that is a miss, not a failure.
  if (!response.ok && response.status !== 404) {
    await response.body?.cancel();
    return { ok: false, kind: 'http', status: response.status };
  }
  try {
    return { ok: true, body: await response.json(), status: response.status };
  } catch {
    return { ok: true, body: null, status: response.status };
  }
}

// --- Route wiring ---------------------------------------------------------------

/** What one query produces before it is wrapped: a hit, or a miss with a reason. */
type Fetched<T> = { hit: true; data: T } | { hit: false; reason: string };

/** Serialised into the cache: the outcome plus the observation time. */
interface CachedRecord {
  fetched: Fetched<unknown>;
  source: MarketSource;
  asOf: string;
}

const TIMEFRAME_SPEC: Record<Timeframe, { path: string; aggregate: string }> = {
  '1m': { path: 'minute', aggregate: '1' },
  '5m': { path: 'minute', aggregate: '5' },
  '15m': { path: 'minute', aggregate: '15' },
  '1h': { path: 'hour', aggregate: '1' },
  '4h': { path: 'hour', aggregate: '4' },
  '1d': { path: 'day', aggregate: '1' },
};

const ADDRESS_RE = /^[A-Za-z0-9]{20,64}$/;
const QUERY_RE = /^[\w .:/-]{1,64}$/;

const sourceParam = z.enum(['dexscreener', 'geckoterminal']).default('dexscreener');

interface Query {
  /** Identifies the query for the cache, provider included. */
  key: string;
  source: MarketSource;
  run(
    fetchedAt: number,
  ): Promise<{ ok: true; fetched: Fetched<unknown> } | { ok: false; result: ProviderResult }>;
}

async function poolsForToken(chain: ChainId, token: string, source: MarketSource): Promise<Query> {
  const slug = SLUGS[chain];
  const path =
    source === 'dexscreener'
      ? `${DEXSCREENER_ORIGIN}/token-pairs/v1/${slug}/${encodeURIComponent(token)}`
      : `${GECKOTERMINAL_ORIGIN}/networks/${slug}/tokens/${encodeURIComponent(token)}/pools?page=1`;
  return {
    key: await sha256Hex(`pools:${source}:${chain}:${token.toLowerCase()}`),
    source,
    async run(fetchedAt) {
      const result = await providerGet(path, acceptFor(source));
      if (!result.ok) return { ok: false, result };
      const pools =
        source === 'dexscreener'
          ? dsMapMany(result.body, chain, fetchedAt)
          : gtMapList(result.body, chain, fetchedAt);
      return { ok: true, fetched: { hit: true, data: pools } };
    },
  };
}

function gtMapList(raw: unknown, chain: ChainId, fetchedAt: number): MarketSnapshot[] {
  const parsed = gtList.safeParse(raw);
  if (!parsed.success) return [];
  return parsed.data.data
    .map((pool) => gtSnapshot(pool, chain, fetchedAt))
    .sort(byLiquidityDescending);
}

function acceptFor(source: MarketSource): string {
  return source === 'dexscreener' ? 'application/json' : 'application/json;version=20230302';
}

export interface TokenPrice {
  chain: ChainId;
  token: string;
  priceUsd: string | null;
  reason?: string;
}

async function tokenPrice(chain: ChainId, token: string, source: MarketSource): Promise<Query> {
  const slug = SLUGS[chain];
  return {
    key: await sha256Hex(`price:${source}:${chain}:${token.toLowerCase()}`),
    source,
    async run(fetchedAt) {
      if (source === 'dexscreener') {
        // Only pools where the token is the base token quote the token's own
        // price; the deepest such pool is the least misleading one.
        const result = await providerGet(
          `${DEXSCREENER_ORIGIN}/token-pairs/v1/${slug}/${encodeURIComponent(token)}`,
          acceptFor(source),
        );
        if (!result.ok) return { ok: false, result };
        const wanted = token.toLowerCase();
        const asBase = dsMapMany(result.body, chain, fetchedAt).filter(
          (pool) => pool.base.address.toLowerCase() === wanted && pool.priceUsd !== null,
        );
        const priceUsd = asBase[0]?.priceUsd ?? null;
        const data: TokenPrice = { chain, token, priceUsd };
        if (priceUsd === null) data.reason = 'provider has no pool quoting this token as base';
        return { ok: true, fetched: { hit: true, data } };
      }
      const result = await providerGet(
        `${GECKOTERMINAL_ORIGIN}/simple/networks/${slug}/token_price/${encodeURIComponent(token)}`,
        acceptFor(source),
      );
      if (!result.ok) return { ok: false, result };
      const parsed = gtTokenPrice.safeParse(result.body);
      let priceUsd: string | null = null;
      if (parsed.success) {
        const entry = Object.entries(parsed.data.data.attributes.token_prices).find(
          ([address]) => address.toLowerCase() === token.toLowerCase(),
        );
        priceUsd = entry ? decimalOrNull(entry[1]) : null;
      }
      const data: TokenPrice = { chain, token, priceUsd };
      if (priceUsd === null) data.reason = 'provider returned no usable USD price for this token';
      return { ok: true, fetched: { hit: true, data } };
    },
  };
}

async function poolById(chain: ChainId, poolId: string, source: MarketSource): Promise<Query> {
  const slug = SLUGS[chain];
  return {
    key: await sha256Hex(`pool:${source}:${chain}:${poolId.toLowerCase()}`),
    source,
    async run(fetchedAt) {
      if (source === 'dexscreener') {
        const result = await providerGet(
          `${DEXSCREENER_ORIGIN}/latest/dex/pairs/${slug}/${encodeURIComponent(poolId)}`,
          acceptFor(source),
        );
        if (!result.ok) return { ok: false, result };
        const pool = dsMapMany(result.body, chain, fetchedAt)[0];
        return {
          ok: true,
          fetched: pool
            ? { hit: true, data: pool }
            : { hit: false, reason: 'provider has no pool with that id on this chain' },
        };
      }
      const result = await providerGet(
        `${GECKOTERMINAL_ORIGIN}/networks/${slug}/pools/${encodeURIComponent(poolId)}`,
        acceptFor(source),
      );
      if (!result.ok) return { ok: false, result };
      const parsed = gtSingle.safeParse(result.body);
      return {
        ok: true,
        fetched: parsed.success
          ? { hit: true, data: gtSnapshot(parsed.data.data, chain, fetchedAt) }
          : { hit: false, reason: 'provider has no pool with that id on this chain' },
      };
    },
  };
}

async function ohlcv(
  chain: ChainId,
  poolId: string,
  timeframe: Timeframe,
  limit: number,
): Promise<Query> {
  const slug = SLUGS[chain];
  const spec = TIMEFRAME_SPEC[timeframe];
  return {
    key: await sha256Hex(
      `ohlcv:geckoterminal:${chain}:${poolId.toLowerCase()}:${timeframe}:${limit}`,
    ),
    source: 'geckoterminal',
    async run(fetchedAt) {
      const params = new URLSearchParams({
        aggregate: spec.aggregate,
        limit: String(limit),
        currency: 'usd',
      });
      const result = await providerGet(
        `${GECKOTERMINAL_ORIGIN}/networks/${slug}/pools/${encodeURIComponent(poolId)}/ohlcv/${spec.path}?${params.toString()}`,
        acceptFor('geckoterminal'),
      );
      if (!result.ok) return { ok: false, result };
      const parsed = gtOhlcv.safeParse(result.body);
      if (!parsed.success) {
        return {
          ok: true,
          fetched: { hit: false, reason: 'provider has no candles for that pool' },
        };
      }
      const series: OhlcvSeries = {
        chain,
        poolId,
        timeframe,
        // Provider order is newest first; chronological is what consumers want.
        candles: parsed.data.data.attributes.ohlcv_list
          .slice()
          .reverse()
          .map(([ts, open, high, low, close, volume]) => ({
            openedAt: new Date(ts * 1000).toISOString(),
            open: String(open),
            high: String(high),
            low: String(low),
            close: String(close),
            volumeUsd: Number.isFinite(volume) ? String(volume) : null,
          })),
        source: 'geckoterminal',
        fetchedAt: new Date(fetchedAt).toISOString(),
      };
      return { ok: true, fetched: { hit: true, data: series } };
    },
  };
}

async function search(query: string, chain: ChainId | undefined): Promise<Query> {
  return {
    key: await sha256Hex(`search:dexscreener:${chain ?? '*'}:${query.toLowerCase()}`),
    source: 'dexscreener',
    async run(fetchedAt) {
      const result = await providerGet(
        `${DEXSCREENER_ORIGIN}/latest/dex/search?q=${encodeURIComponent(query)}`,
        acceptFor('dexscreener'),
      );
      if (!result.ok) return { ok: false, result };
      const list =
        result.body !== null && typeof result.body === 'object' && 'pairs' in result.body
          ? result.body.pairs
          : result.body;
      const out: MarketSnapshot[] = [];
      if (Array.isArray(list)) {
        for (const entry of list) {
          const parsed = dsPair.safeParse(entry);
          if (!parsed.success) continue;
          const resolved = SLUG_TO_CHAIN.get(parsed.data.chainId);
          if (!resolved || (chain && resolved !== chain)) continue;
          out.push(dsSnapshot(parsed.data, resolved, fetchedAt));
        }
      }
      return { ok: true, fetched: { hit: true, data: out.sort(byLiquidityDescending) } };
    },
  };
}

function providerFailure(source: MarketSource, result: ProviderResult): Response {
  if (result.ok) throw new Error('unreachable');
  if (result.kind === 'rate_limited') {
    return upstreamBusy(
      'upstream_rate_limited',
      `${source} is rate limiting the gateway; retry later or call the provider directly`,
      result.retryAfter,
      { source },
    );
  }
  if (result.kind === 'http') {
    return badGateway('upstream_error', `${source} answered HTTP ${result.status}`, {
      source,
      upstreamStatus: result.status,
    });
  }
  return badGateway(
    'upstream_unreachable',
    `${source} did not answer within ${PROVIDER_TIMEOUT_MS / 1000} s`,
    {
      source,
    },
  );
}

/** Resolve a query through the cache, then the provider; wrap the outcome. */
async function answer(
  c: Context<AppEnv>,
  chain: string,
  query: Query,
  store: CacheStore,
  extraHeaders: Record<string, string>,
): Promise<Response> {
  const install = c.get('install');
  const meter = (outcome: UsageOutcome, cached: boolean) =>
    recordUsage(c.env, { installId: install.installId, route: 'market', chain, outcome, cached });

  const headers = { ...extraHeaders, 'content-type': 'application/json' };
  const render = (record: CachedRecord, cache: 'hit' | 'miss'): Response => {
    if (!record.fetched.hit) {
      return problem({
        status: 404,
        code: 'not_found',
        title: 'Not found',
        detail: record.fetched.reason,
        extra: { source: record.source, asOf: record.asOf, cache },
        headers: extraHeaders,
      });
    }
    const envelope: MarketEnvelope<unknown> = {
      data: record.fetched.data,
      source: record.source,
      asOf: record.asOf,
      fetchedAt: record.asOf,
      cache,
      ttlSeconds: MARKET_CACHE_TTL_S,
    };
    return new Response(JSON.stringify(envelope), { status: 200, headers });
  };

  const cached = await store.get(query.key);
  if (cached !== null) {
    try {
      const record = JSON.parse(cached) as CachedRecord;
      meter('ok', true);
      return render(record, 'hit');
    } catch {
      // a corrupt entry is a miss
    }
  }

  const fetchedAt = Date.now();
  const outcome = await query.run(fetchedAt);
  if (!outcome.ok) {
    meter('upstream_error', false);
    log.warn('provider failed', {
      source: query.source,
      kind: outcome.result.ok ? 'ok' : outcome.result.kind,
    });
    return providerFailure(query.source, outcome.result);
  }
  const record: CachedRecord = {
    fetched: outcome.fetched,
    source: query.source,
    asOf: new Date(fetchedAt).toISOString(),
  };
  c.executionCtx.waitUntil(store.put(query.key, JSON.stringify(record), MARKET_CACHE_TTL_S));
  meter('ok', false);
  return render(record, 'miss');
}

function parseChain(value: string): ChainId | null {
  return isChainId(value) ? value : null;
}

export function marketRoutes(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.use('/v1/market/*', requireInstall('market'));

  app.get('/v1/market/search', async (c) => {
    const q = c.req.query('q') ?? '';
    if (!QUERY_RE.test(q))
      return badRequest('invalid_query', 'q must be 1-64 characters of [A-Za-z0-9_ .:/-]');
    const chainParam = c.req.query('chain');
    const chain = chainParam === undefined ? undefined : parseChain(chainParam);
    if (chain === null)
      return notFound('unknown_chain', 'the gateway proxies base, bsc, robinhood and solana');
    const guard = await guardProxy(c, 'market', 'market', chain ?? 'any');
    if (!guard.ok) return guard.response;
    return answer(
      c,
      chain ?? 'any',
      await search(q, chain),
      marketStore(c.env),
      quotaHeaders(guard.decision),
    );
  });

  app.get('/v1/market/:chain/tokens/:address/pools', async (c) => {
    const chain = parseChain(c.req.param('chain'));
    if (!chain)
      return notFound('unknown_chain', 'the gateway proxies base, bsc, robinhood and solana');
    const address = c.req.param('address');
    if (!ADDRESS_RE.test(address))
      return badRequest('invalid_address', 'address must be 20-64 alphanumeric characters');
    const source = sourceParam.safeParse(c.req.query('source'));
    if (!source.success)
      return badRequest('invalid_source', `source must be one of ${SOURCES.join(', ')}`);
    const guard = await guardProxy(c, 'market', 'market', chain);
    if (!guard.ok) return guard.response;
    return answer(
      c,
      chain,
      await poolsForToken(chain, address, source.data),
      marketStore(c.env),
      quotaHeaders(guard.decision),
    );
  });

  app.get('/v1/market/:chain/tokens/:address/price', async (c) => {
    const chain = parseChain(c.req.param('chain'));
    if (!chain)
      return notFound('unknown_chain', 'the gateway proxies base, bsc, robinhood and solana');
    const address = c.req.param('address');
    if (!ADDRESS_RE.test(address))
      return badRequest('invalid_address', 'address must be 20-64 alphanumeric characters');
    const source = sourceParam.safeParse(c.req.query('source'));
    if (!source.success)
      return badRequest('invalid_source', `source must be one of ${SOURCES.join(', ')}`);
    const guard = await guardProxy(c, 'market', 'market', chain);
    if (!guard.ok) return guard.response;
    return answer(
      c,
      chain,
      await tokenPrice(chain, address, source.data),
      marketStore(c.env),
      quotaHeaders(guard.decision),
    );
  });

  app.get('/v1/market/:chain/pools/:poolId', async (c) => {
    const chain = parseChain(c.req.param('chain'));
    if (!chain)
      return notFound('unknown_chain', 'the gateway proxies base, bsc, robinhood and solana');
    const poolId = c.req.param('poolId');
    if (!ADDRESS_RE.test(poolId))
      return badRequest('invalid_pool_id', 'poolId must be 20-64 alphanumeric characters');
    const source = sourceParam.safeParse(c.req.query('source'));
    if (!source.success)
      return badRequest('invalid_source', `source must be one of ${SOURCES.join(', ')}`);
    const guard = await guardProxy(c, 'market', 'market', chain);
    if (!guard.ok) return guard.response;
    return answer(
      c,
      chain,
      await poolById(chain, poolId, source.data),
      marketStore(c.env),
      quotaHeaders(guard.decision),
    );
  });

  app.get('/v1/market/:chain/pools/:poolId/ohlcv', async (c) => {
    const chain = parseChain(c.req.param('chain'));
    if (!chain)
      return notFound('unknown_chain', 'the gateway proxies base, bsc, robinhood and solana');
    const poolId = c.req.param('poolId');
    if (!ADDRESS_RE.test(poolId))
      return badRequest('invalid_pool_id', 'poolId must be 20-64 alphanumeric characters');
    const timeframe = z.enum(TIMEFRAMES).default('1h').safeParse(c.req.query('timeframe'));
    if (!timeframe.success)
      return badRequest('invalid_timeframe', `timeframe must be one of ${TIMEFRAMES.join(', ')}`);
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(1000)
      .default(100)
      .safeParse(c.req.query('limit'));
    if (!limit.success)
      return badRequest('invalid_limit', 'limit must be an integer between 1 and 1000');
    const guard = await guardProxy(c, 'market', 'market', chain);
    if (!guard.ok) return guard.response;
    return answer(
      c,
      chain,
      await ohlcv(chain, poolId, timeframe.data, limit.data),
      marketStore(c.env),
      quotaHeaders(guard.decision),
    );
  });

  return app;
}
