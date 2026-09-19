import { z } from 'zod';
import { CHAIN_IDS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import type { MarketDataProvider, MarketSnapshot, OhlcvSeries, ProviderHealth } from '../types.js';

/**
 * GeckoTerminal.
 *
 * Keyless, covers all four chains (Robinhood Chain appears as network
 * `robinhood`, verified 2026-09-20), and — unlike DexScreener — exposes OHLCV
 * candles, which the research agent needs for anything beyond a spot price.
 *
 * It exists here mainly as a second opinion: two independent providers let the
 * service detect when a price is disputed instead of trusting a single number.
 * Documented limit on the free tier is 30 requests per minute, so the service
 * caches aggressively and treats a 429 as a reason to fall back rather than
 * retry.
 */

const BASE_URL = 'https://api.geckoterminal.com/api/v2';
const DEFAULT_TIMEOUT_MS = 12_000;

const NETWORKS: Record<ChainId, string> = {
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
  solana: 'solana',
};

const NETWORK_TO_CHAIN = new Map<string, ChainId>(
  CHAIN_IDS.map((chain) => [NETWORKS[chain], chain]),
);

const poolAttributes = z.object({
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
  pool_created_at: z.string().nullish(),
});

const poolSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: poolAttributes,
  relationships: z
    .object({
      base_token: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
      quote_token: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
      dex: z.object({ data: z.object({ id: z.string() }).nullish() }).nullish(),
    })
    .nullish(),
});

const listResponse = z.object({ data: z.array(poolSchema) });
const singleResponse = z.object({ data: poolSchema });

const tokenPriceResponse = z.object({
  data: z.object({
    attributes: z.object({ token_prices: z.record(z.string(), z.string()) }),
  }),
});

const ohlcvResponse = z.object({
  data: z.object({
    attributes: z.object({
      // [timestamp, open, high, low, close, volume]
      ohlcv_list: z.array(
        z.tuple([z.number(), z.number(), z.number(), z.number(), z.number(), z.number()]),
      ),
    }),
  }),
});

const TIMEFRAMES: Record<OhlcvSeries['timeframe'], { path: string; aggregate: string }> = {
  '1m': { path: 'minute', aggregate: '1' },
  '5m': { path: 'minute', aggregate: '5' },
  '15m': { path: 'minute', aggregate: '15' },
  '1h': { path: 'hour', aggregate: '1' },
  '4h': { path: 'hour', aggregate: '4' },
  '1d': { path: 'day', aggregate: '1' },
};

export interface GeckoTerminalOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class GeckoTerminalProvider implements MarketDataProvider {
  readonly source = 'geckoterminal' as const;
  readonly chains = CHAIN_IDS;

  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log = childLogger('geckoterminal');

  constructor(options: GeckoTerminalOptions = {}) {
    this.#baseUrl = options.baseUrl ?? BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      await this.#get<unknown>('/networks?page=1');
      return {
        source: this.source,
        healthy: true,
        latencyMs: Date.now() - started,
        error: null,
        chains: [...this.chains],
      };
    } catch (cause) {
      return {
        source: this.source,
        healthy: false,
        latencyMs: Date.now() - started,
        error: errorMessage(cause),
        chains: [...this.chains],
      };
    }
  }

  async getPoolsForToken(chain: ChainId, token: string): Promise<MarketSnapshot[]> {
    const network = NETWORKS[chain];
    const raw = await this.#get<unknown>(
      `/networks/${network}/tokens/${encodeURIComponent(token)}/pools?page=1`,
    );

    const parsed = listResponse.safeParse(raw);
    if (!parsed.success) {
      this.#log.debug({ issue: parsed.error.issues[0]?.message }, 'unexpected pools payload');
      return [];
    }

    const fetchedAt = Date.now();
    return parsed.data.data.map((pool) => toSnapshot(pool, chain, fetchedAt));
  }

  /**
   * USD price of a token, from the dedicated endpoint rather than inferred
   * from a pool. One request, and it answers the question actually asked.
   */
  async getTokenPriceUsd(chain: ChainId, token: string): Promise<string | null> {
    const network = NETWORKS[chain];
    const raw = await this.#get<unknown>(
      `/simple/networks/${network}/token_price/${encodeURIComponent(token)}`,
    );

    const parsed = tokenPriceResponse.safeParse(raw);
    if (!parsed.success) return null;

    const prices = parsed.data.data.attributes.token_prices;
    // The endpoint echoes the address back in its own casing, so match loosely.
    const entry = Object.entries(prices).find(
      ([address]) => address.toLowerCase() === token.toLowerCase(),
    );

    return entry ? decimalOrNull(entry[1]) : null;
  }

  async getPool(chain: ChainId, poolId: string): Promise<MarketSnapshot | null> {
    const network = NETWORKS[chain];
    const raw = await this.#get<unknown>(
      `/networks/${network}/pools/${encodeURIComponent(poolId)}`,
    );

    const parsed = singleResponse.safeParse(raw);
    if (!parsed.success) return null;
    return toSnapshot(parsed.data.data, chain, Date.now());
  }

  async search(query: string, chain?: ChainId): Promise<MarketSnapshot[]> {
    const params = new URLSearchParams({ query, page: '1' });
    if (chain) params.set('network', NETWORKS[chain]);

    const raw = await this.#get<unknown>(`/search/pools?${params.toString()}`);
    const parsed = listResponse.safeParse(raw);
    if (!parsed.success) return [];

    const fetchedAt = Date.now();
    const out: MarketSnapshot[] = [];

    for (const pool of parsed.data.data) {
      // Pool ids are prefixed with the network, e.g. "base_0xabc…". That prefix
      // is the only reliable way to tell which chain a search hit belongs to.
      const resolved = chain ?? chainFromPoolId(pool.id);
      if (!resolved) continue;
      out.push(toSnapshot(pool, resolved, fetchedAt));
    }

    return out;
  }

  async getOhlcv(
    chain: ChainId,
    poolId: string,
    timeframe: OhlcvSeries['timeframe'],
    limit: number,
  ): Promise<OhlcvSeries | null> {
    const network = NETWORKS[chain];
    const spec = TIMEFRAMES[timeframe];
    const params = new URLSearchParams({
      aggregate: spec.aggregate,
      limit: String(Math.min(Math.max(limit, 1), 1000)),
      currency: 'usd',
    });

    const raw = await this.#get<unknown>(
      `/networks/${network}/pools/${encodeURIComponent(poolId)}/ohlcv/${spec.path}?${params.toString()}`,
    );

    const parsed = ohlcvResponse.safeParse(raw);
    if (!parsed.success) return null;

    return {
      chain,
      poolId,
      timeframe,
      // The provider returns newest first; chronological order is what every
      // consumer actually wants, and reversing it here avoids each of them
      // getting it wrong separately.
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
      source: this.source,
      fetchedAt: new Date().toISOString(),
    };
  }

  async #get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { accept: 'application/json;version=20230302' },
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AppError(ErrorCode.RATE_LIMITED, 'GeckoTerminal rate limit reached', {
          retryAfterSec: Number(response.headers.get('retry-after') ?? 60),
        });
      }
      if (!response.ok) {
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `GeckoTerminal returned HTTP ${response.status}`,
          { details: { path, status: response.status } },
        );
      }

      return (await response.json()) as T;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'AbortError';
      throw new AppError(
        timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_UNAVAILABLE,
        'GeckoTerminal request failed',
        { cause, details: { path } },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

type Pool = z.infer<typeof poolSchema>;

function toSnapshot(pool: Pool, chain: ChainId, fetchedAt: number): MarketSnapshot {
  const attributes = pool.attributes;
  const [baseSymbol, quoteSymbol] = splitPairName(attributes.name);

  return {
    chain,
    poolId: attributes.address,
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
    priceUsd: decimalOrNull(attributes.base_token_price_usd),
    priceNative: decimalOrNull(attributes.base_token_price_native_currency),
    liquidityUsd: decimalOrNull(attributes.reserve_in_usd),
    volume24hUsd: decimalOrNull(attributes.volume_usd?.h24),
    change: {
      m5: percentStringToBps(attributes.price_change_percentage?.m5),
      h1: percentStringToBps(attributes.price_change_percentage?.h1),
      h6: percentStringToBps(attributes.price_change_percentage?.h6),
      h24: percentStringToBps(attributes.price_change_percentage?.h24),
    },
    observedAt: new Date(fetchedAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: 'geckoterminal',
    freshnessMs: 0,
    ...(attributes.base_token_price_usd ? {} : { reason: 'provider returned no USD price' }),
  };
}

/** Pool ids look like `base_0xabc…`; the prefix names the network. */
function chainFromPoolId(id: string): ChainId | undefined {
  const network = id.split('_')[0];
  return network === undefined ? undefined : NETWORK_TO_CHAIN.get(network);
}

/** Token ids look like `base_0xabc…`. */
function tokenAddressFromId(id: string | null | undefined): string {
  if (!id) return '';
  const index = id.indexOf('_');
  return index === -1 ? id : id.slice(index + 1);
}

function splitPairName(name: string | null | undefined): [string | null, string | null] {
  if (!name) return [null, null];
  const parts = name.split('/').map((part) => part.trim());
  return [parts[0] ?? null, parts[1] ?? null];
}

function decimalOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  // Scientific notation and negatives are rejected rather than coerced: a price
  // ATRA cannot parse exactly is a price it should not use.
  return /^\d+(\.\d+)?$/.test(value) ? value : null;
}

function percentStringToBps(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export { NETWORKS as GECKOTERMINAL_NETWORKS };
