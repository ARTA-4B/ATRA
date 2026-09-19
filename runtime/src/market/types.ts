import type { ChainId } from '../chains/registry.js';

/**
 * Normalized market data.
 *
 * Every provider is mapped into these shapes before anything else sees it, so
 * the research agent and the risk engine work with one vocabulary rather than
 * three JSON dialects.
 *
 * Two invariants hold throughout:
 *
 *  - **Every reading is dated and attributed.** `observedAt` is when the
 *    provider says the data was true; `fetchedAt` is when ATRA received it;
 *    `source` names the provider. Nothing downstream may use a number whose
 *    age it cannot compute.
 *  - **Unknown is null, never zero.** A missing price is `null` with a reason.
 *    A zero would be indistinguishable from a real price of zero and would
 *    flow into a size calculation as if it were observed.
 */

export type MarketSource = 'dexscreener' | 'geckoterminal' | 'jupiter' | 'rpc' | 'cache';

export interface TokenRef {
  address: string;
  symbol: string | null;
  name: string | null;
  decimals: number | null;
}

export interface MarketSnapshot {
  chain: ChainId;
  /** Provider-specific pool or pair identifier. */
  poolId: string;
  /** The DEX the pool belongs to, as the provider names it. */
  dexId: string | null;
  base: TokenRef;
  quote: TokenRef;

  /** USD price of the base token. Null when no provider could supply one. */
  priceUsd: string | null;
  /** Price of the base token denominated in the quote token. */
  priceNative: string | null;

  liquidityUsd: string | null;
  volume24hUsd: string | null;
  /** Price change over the trailing window, in basis points. */
  change: {
    m5: number | null;
    h1: number | null;
    h6: number | null;
    h24: number | null;
  };

  /** When the provider says this was true. */
  observedAt: string;
  /** When ATRA received it. */
  fetchedAt: string;
  source: MarketSource;
  /** Age in milliseconds at the moment the snapshot was assembled. */
  freshnessMs: number;
  /** Set when a value is missing, explaining why rather than hiding it. */
  reason?: string;
}

export interface Candle {
  /** Start of the interval. */
  openedAt: string;
  open: string;
  high: string;
  low: string;
  close: string;
  volumeUsd: string | null;
}

export interface OhlcvSeries {
  chain: ChainId;
  poolId: string;
  timeframe: '1m' | '5m' | '15m' | '1h' | '4h' | '1d';
  candles: Candle[];
  source: MarketSource;
  fetchedAt: string;
}

/**
 * The result of asking several providers the same question.
 *
 * `agreement` is how far apart the providers were, in basis points. A large
 * spread is not an error — thin markets genuinely disagree — but it is
 * evidence the research agent must be able to see and report.
 */
export interface CrossCheckedPrice {
  chain: ChainId;
  token: string;
  priceUsd: string | null;
  sources: Array<{ source: MarketSource; priceUsd: string; observedAt: string }>;
  /** Largest pairwise deviation, in basis points. Null with fewer than two. */
  deviationBps: number | null;
  /** True when the deviation exceeds the configured tolerance. */
  disputed: boolean;
  reason?: string;
}

export interface ProviderHealth {
  source: MarketSource;
  healthy: boolean;
  latencyMs: number | null;
  error: string | null;
  /** Chains this provider covers, as verified at runtime. */
  chains: ChainId[];
}

/**
 * A market-data provider.
 *
 * Implementations are thin: fetch, validate, map, stamp. Anything that needs
 * judgement (which price to believe, whether data is too old to use) lives in
 * the service above them, so provider code stays easy to audit.
 */
export interface MarketDataProvider {
  readonly source: MarketSource;
  /** Chains this provider claims to cover. */
  readonly chains: readonly ChainId[];

  health(): Promise<ProviderHealth>;

  /** Pools trading a token, most liquid first. */
  getPoolsForToken(chain: ChainId, token: string): Promise<MarketSnapshot[]>;

  /** A single pool by its provider-specific identifier. */
  getPool(chain: ChainId, poolId: string): Promise<MarketSnapshot | null>;

  /** Search by symbol or address. */
  search(query: string, chain?: ChainId): Promise<MarketSnapshot[]>;

  /** Historical candles, when the provider offers them. */
  getOhlcv?(
    chain: ChainId,
    poolId: string,
    timeframe: OhlcvSeries['timeframe'],
    limit: number,
  ): Promise<OhlcvSeries | null>;
}

/** Maximum acceptable age per kind of reading, in milliseconds. */
export interface FreshnessPolicy {
  priceMaxAgeMs: number;
  liquidityMaxAgeMs: number;
  ohlcvMaxAgeMs: number;
}

export const DEFAULT_FRESHNESS: FreshnessPolicy = {
  priceMaxAgeMs: 120_000,
  liquidityMaxAgeMs: 900_000,
  ohlcvMaxAgeMs: 3_600_000,
};

/** Providers disagreeing by more than this are reported as disputed. */
export const DEFAULT_DEVIATION_TOLERANCE_BPS = 200;
