import { z } from 'zod';
import { CHAIN_IDS } from '../../chains/registry.js';
import type { ChainId } from '../../chains/registry.js';
import { AppError, ErrorCode, errorMessage } from '../../util/errors.js';
import { childLogger } from '../../logging/logger.js';
import type {
  MarketDataProvider,
  MarketSnapshot,
  ProviderHealth,
  TokenRef,
} from '../types.js';

/**
 * DexScreener.
 *
 * Keyless, covers all four chains ATRA supports (including Robinhood Chain,
 * verified on 2026-09-20 with the slug `robinhood`), and returns price,
 * liquidity and volume in one call. Documented limit is 300 requests per
 * minute, which the service above respects through caching rather than by
 * counting requests.
 *
 * Every field is validated before use. A provider that starts returning a
 * number as a string, or drops `liquidity`, must surface as missing data, not
 * as a silent NaN propagating into a size calculation.
 */

const BASE_URL = 'https://api.dexscreener.com';
const DEFAULT_TIMEOUT_MS = 10_000;

/** ATRA chain id to DexScreener slug. */
const CHAIN_SLUGS: Record<ChainId, string> = {
  base: 'base',
  bsc: 'bsc',
  robinhood: 'robinhood',
  solana: 'solana',
};

const SLUG_TO_CHAIN = new Map<string, ChainId>(
  CHAIN_IDS.map((chain) => [CHAIN_SLUGS[chain], chain]),
);

const tokenSchema = z.object({
  address: z.string().min(1),
  name: z.string().nullish(),
  symbol: z.string().nullish(),
});

const pairSchema = z.object({
  chainId: z.string(),
  dexId: z.string().nullish(),
  pairAddress: z.string().min(1),
  baseToken: tokenSchema,
  quoteToken: tokenSchema,
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
  pairCreatedAt: z.number().nullish(),
});

type Pair = z.infer<typeof pairSchema>;

export interface DexScreenerOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class DexScreenerProvider implements MarketDataProvider {
  readonly source = 'dexscreener' as const;
  readonly chains = CHAIN_IDS;

  readonly #baseUrl: string;
  readonly #timeoutMs: number;
  readonly #fetch: typeof fetch;
  readonly #log = childLogger('dexscreener');

  constructor(options: DexScreenerOptions = {}) {
    this.#baseUrl = options.baseUrl ?? BASE_URL;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      // A token that certainly exists, so an empty result means the provider is
      // broken rather than the token being unknown.
      const pairs = await this.#get<Pair[]>(
        '/token-pairs/v1/base/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      );
      return {
        source: this.source,
        healthy: Array.isArray(pairs) && pairs.length > 0,
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
    const slug = CHAIN_SLUGS[chain];
    const raw = await this.#get<unknown>(`/token-pairs/v1/${slug}/${encodeURIComponent(token)}`);
    return this.#mapMany(raw, chain).sort(byLiquidityDescending);
  }

  async getPool(chain: ChainId, poolId: string): Promise<MarketSnapshot | null> {
    const slug = CHAIN_SLUGS[chain];
    const raw = await this.#get<unknown>(`/latest/dex/pairs/${slug}/${encodeURIComponent(poolId)}`);

    // This endpoint wraps results in { pairs: [...] } while the token endpoint
    // returns a bare array.
    const pairs =
      raw !== null && typeof raw === 'object' && 'pairs' in raw
        ? (raw as { pairs: unknown }).pairs
        : raw;

    return this.#mapMany(pairs, chain)[0] ?? null;
  }

  async search(query: string, chain?: ChainId): Promise<MarketSnapshot[]> {
    const raw = await this.#get<unknown>(`/latest/dex/search?q=${encodeURIComponent(query)}`);
    const pairs =
      raw !== null && typeof raw === 'object' && 'pairs' in raw
        ? (raw as { pairs: unknown }).pairs
        : raw;

    const snapshots = this.#mapMany(pairs, chain);
    return snapshots.sort(byLiquidityDescending);
  }

  /**
   * Map provider rows into snapshots.
   *
   * Rows that fail validation, name a chain ATRA does not support, or belong to
   * a different chain than the caller asked for are dropped with a log line.
   * Silently substituting another chain's pool would be worse than returning
   * nothing.
   */
  #mapMany(raw: unknown, expectedChain?: ChainId): MarketSnapshot[] {
    if (!Array.isArray(raw)) return [];
    const fetchedAt = Date.now();
    const out: MarketSnapshot[] = [];

    for (const entry of raw) {
      const parsed = pairSchema.safeParse(entry);
      if (!parsed.success) {
        this.#log.debug({ issue: parsed.error.issues[0]?.message }, 'dropped malformed pair');
        continue;
      }

      const chain = SLUG_TO_CHAIN.get(parsed.data.chainId);
      if (!chain) continue;
      if (expectedChain && chain !== expectedChain) continue;

      out.push(toSnapshot(parsed.data, chain, fetchedAt));
    }

    return out;
  }

  async #get<T>(path: string): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetch(`${this.#baseUrl}${path}`, {
        headers: { accept: 'application/json' },
        signal: controller.signal,
      });

      if (response.status === 429) {
        throw new AppError(ErrorCode.RATE_LIMITED, 'DexScreener rate limit reached', {
          retryAfterSec: Number(response.headers.get('retry-after') ?? 60),
        });
      }
      if (!response.ok) {
        throw new AppError(
          ErrorCode.UPSTREAM_UNAVAILABLE,
          `DexScreener returned HTTP ${response.status}`,
          { details: { path, status: response.status } },
        );
      }

      return (await response.json()) as T;
    } catch (cause) {
      if (cause instanceof AppError) throw cause;
      const timedOut = cause instanceof Error && cause.name === 'AbortError';
      throw new AppError(
        timedOut ? ErrorCode.UPSTREAM_TIMEOUT : ErrorCode.UPSTREAM_UNAVAILABLE,
        'DexScreener request failed',
        { cause, details: { path } },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function toSnapshot(pair: Pair, chain: ChainId, fetchedAt: number): MarketSnapshot {
  // DexScreener does not stamp its rows, so the fetch time is the best claim
  // that can honestly be made about when the data was true.
  const observedAt = fetchedAt;

  return {
    chain,
    poolId: pair.pairAddress,
    dexId: pair.dexId ?? null,
    base: toTokenRef(pair.baseToken),
    quote: toTokenRef(pair.quoteToken),
    priceUsd: normalizeDecimal(pair.priceUsd),
    priceNative: normalizeDecimal(pair.priceNative),
    liquidityUsd: numberToDecimal(pair.liquidity?.usd),
    volume24hUsd: numberToDecimal(pair.volume?.h24),
    change: {
      m5: percentToBps(pair.priceChange?.m5),
      h1: percentToBps(pair.priceChange?.h1),
      h6: percentToBps(pair.priceChange?.h6),
      h24: percentToBps(pair.priceChange?.h24),
    },
    observedAt: new Date(observedAt).toISOString(),
    fetchedAt: new Date(fetchedAt).toISOString(),
    source: 'dexscreener',
    freshnessMs: 0,
    ...(pair.priceUsd ? {} : { reason: 'provider returned no USD price for this pair' }),
  };
}

function toTokenRef(token: Pair['baseToken']): TokenRef {
  return {
    address: token.address,
    symbol: token.symbol ?? null,
    name: token.name ?? null,
    // DexScreener does not report decimals; the chain adapter is authoritative
    // for that, and guessing here would be a silent source of scaling bugs.
    decimals: null,
  };
}

/** Keep provider decimals as a string; never parse a price into a float. */
function normalizeDecimal(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return /^\d+(\.\d+)?$/.test(value) ? value : null;
}

/**
 * Convert a provider's JSON number into a decimal string.
 *
 * These arrive as IEEE doubles, so precision is already lost upstream. The
 * conversion is bounded to six decimals and the value is only ever used for
 * liquidity and volume comparisons, never to size a trade.
 */
function numberToDecimal(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value < 0) return null;
  return value.toFixed(6).replace(/\.?0+$/, '') || '0';
}

function percentToBps(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  return Math.round(value * 100);
}

function byLiquidityDescending(a: MarketSnapshot, b: MarketSnapshot): number {
  const left = a.liquidityUsd === null ? -1 : Number(a.liquidityUsd);
  const right = b.liquidityUsd === null ? -1 : Number(b.liquidityUsd);
  return right - left;
}

export { CHAIN_SLUGS as DEXSCREENER_CHAIN_SLUGS };
