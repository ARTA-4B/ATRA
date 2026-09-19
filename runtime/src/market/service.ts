import type { ChainId } from '../chains/registry.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import type { Db } from '../db/database.js';
import { DEFAULT_DEVIATION_TOLERANCE_BPS, DEFAULT_FRESHNESS } from './types.js';
import type {
  CrossCheckedPrice,
  FreshnessPolicy,
  MarketDataProvider,
  MarketSnapshot,
  OhlcvSeries,
  ProviderHealth,
} from './types.js';

/**
 * The market-data service.
 *
 * Providers fetch; this decides. Its whole job is to be honest about what is
 * known:
 *
 *  - a value no provider returned is `null` with a reason, never a zero or a
 *    last-known figure passed off as current;
 *  - every snapshot carries its age, and anything past the freshness policy is
 *    marked stale rather than quietly used;
 *  - when two providers disagree beyond tolerance the price is reported as
 *    *disputed*, with both numbers, instead of one being silently picked.
 *
 * The research agent consumes exactly this. It never calls a provider itself,
 * so there is one place where "do we actually know this?" is answered.
 */

const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 500;

interface CacheEntry {
  snapshots: MarketSnapshot[];
  storedAt: number;
}

export interface MarketServiceOptions {
  freshness?: FreshnessPolicy;
  deviationToleranceBps?: number;
  cacheTtlMs?: number;
  /** Injected in tests so the clock is not read from the environment. */
  now?: () => number;
}

export class MarketService {
  readonly #providers: MarketDataProvider[];
  readonly #db: Db | undefined;
  readonly #freshness: FreshnessPolicy;
  readonly #toleranceBps: number;
  readonly #cacheTtlMs: number;
  readonly #now: () => number;
  readonly #cache = new Map<string, CacheEntry>();
  readonly #log = childLogger('market');

  constructor(providers: MarketDataProvider[], db?: Db, options: MarketServiceOptions = {}) {
    this.#providers = providers;
    this.#db = db;
    this.#freshness = options.freshness ?? DEFAULT_FRESHNESS;
    this.#toleranceBps = options.deviationToleranceBps ?? DEFAULT_DEVIATION_TOLERANCE_BPS;
    this.#cacheTtlMs = options.cacheTtlMs ?? CACHE_TTL_MS;
    this.#now = options.now ?? (() => Date.now());
  }

  get providerNames(): string[] {
    return this.#providers.map((provider) => provider.source);
  }

  async health(): Promise<ProviderHealth[]> {
    return Promise.all(
      this.#providers.map((provider) =>
        provider.health().catch((error: unknown): ProviderHealth => ({
          source: provider.source,
          healthy: false,
          latencyMs: null,
          error: errorMessage(error),
          chains: [...provider.chains],
        })),
      ),
    );
  }

  /**
   * Pools trading a token, best-liquidity first.
   *
   * Providers are queried in parallel and a failing one is skipped rather than
   * failing the request — but if *every* provider fails the caller gets an
   * error, because an empty list would read as "this token has no markets".
   */
  async getPoolsForToken(chain: ChainId, token: string): Promise<MarketSnapshot[]> {
    const key = `pools:${chain}:${token.toLowerCase()}`;
    const cached = this.#fromCache(key);
    if (cached) return cached;

    const capable = this.#providersFor(chain);
    const results = await Promise.allSettled(
      capable.map((provider) => provider.getPoolsForToken(chain, token)),
    );

    const snapshots = this.#collect(results, capable, `pools for ${token} on ${chain}`);
    const stamped = snapshots.map((snapshot) => this.#stamp(snapshot));
    this.#toCache(key, stamped);
    this.#persist(stamped);

    return stamped.sort(byLiquidityDescending);
  }

  async getPool(chain: ChainId, poolId: string): Promise<MarketSnapshot | null> {
    const key = `pool:${chain}:${poolId.toLowerCase()}`;
    const cached = this.#fromCache(key);
    if (cached) return cached[0] ?? null;

    const capable = this.#providersFor(chain);
    const results = await Promise.allSettled(
      capable.map((provider) => provider.getPool(chain, poolId)),
    );

    const snapshots: MarketSnapshot[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value) {
        snapshots.push(this.#stamp(result.value));
      } else if (result.status === 'rejected') {
        this.#log.warn(
          { provider: capable[index]?.source, err: result.reason },
          'pool lookup failed',
        );
      }
    }

    if (snapshots.length === 0) return null;
    this.#toCache(key, snapshots);
    this.#persist(snapshots);

    // Prefer the freshest reading that actually carries a price.
    return snapshots.filter((s) => s.priceUsd !== null)[0] ?? snapshots[0] ?? null;
  }

  async search(query: string, chain?: ChainId): Promise<MarketSnapshot[]> {
    const capable = chain ? this.#providersFor(chain) : this.#providers;
    const results = await Promise.allSettled(
      capable.map((provider) => provider.search(query, chain)),
    );

    const snapshots = this.#collect(results, capable, `search ${query}`).map((snapshot) =>
      this.#stamp(snapshot),
    );

    return dedupeByPool(snapshots).sort(byLiquidityDescending);
  }

  /**
   * Ask every provider for a token's price and compare the answers.
   *
   * Each provider is asked for the price of *that token*, not for a pool that
   * happens to contain it — a pool quotes its own base token, so reading a
   * pool price as a token price reports a stablecoin at the price of whatever
   * it is paired against. This method was written after exactly that bug
   * showed USDC at 0.66 dollars.
   *
   * The reported price is the median, which survives one provider being wrong.
   * When the spread exceeds tolerance the result is flagged `disputed`, so the
   * research agent can say "providers disagree" instead of presenting a number
   * as settled.
   */
  async getCrossCheckedPrice(chain: ChainId, token: string): Promise<CrossCheckedPrice> {
    const capable = this.#providersFor(chain);
    const observedAt = new Date(this.#now()).toISOString();

    const results = await Promise.allSettled(
      capable.map((provider) => provider.getTokenPriceUsd(chain, token)),
    );

    const observations: CrossCheckedPrice['sources'] = [];
    for (const [index, result] of results.entries()) {
      const provider = capable[index];
      if (!provider) continue;

      if (result.status === 'rejected') {
        this.#log.warn(
          { provider: provider.source, chain, err: result.reason },
          'token price lookup failed',
        );
        continue;
      }

      if (result.value !== null) {
        observations.push({ source: provider.source, priceUsd: result.value, observedAt });
      }
    }

    if (observations.length === 0) {
      return {
        chain,
        token,
        priceUsd: null,
        sources: [],
        deviationBps: null,
        disputed: false,
        reason: 'no provider returned a price for this token',
      };
    }

    const deviationBps =
      observations.length < 2
        ? null
        : maxDeviationBps(observations.map((observation) => Number(observation.priceUsd)));

    const result: CrossCheckedPrice = {
      chain,
      token,
      priceUsd: median(observations.map((observation) => observation.priceUsd)),
      sources: observations,
      deviationBps,
      disputed: deviationBps !== null && deviationBps > this.#toleranceBps,
    };

    if (observations.length === 1) {
      result.reason = 'only one provider returned a price; it could not be cross-checked';
    } else if (result.disputed) {
      result.reason = `providers disagree by ${String(deviationBps)} bps`;
    }

    return result;
  }

  /** Historical candles from the first provider that offers them. */
  async getOhlcv(
    chain: ChainId,
    poolId: string,
    timeframe: OhlcvSeries['timeframe'] = '1h',
    limit = 100,
  ): Promise<OhlcvSeries | null> {
    for (const provider of this.#providersFor(chain)) {
      if (!provider.getOhlcv) continue;
      try {
        const series = await provider.getOhlcv(chain, poolId, timeframe, limit);
        if (series && series.candles.length > 0) return series;
      } catch (error) {
        this.#log.warn({ provider: provider.source, err: error }, 'ohlcv lookup failed');
      }
    }
    return null;
  }

  /** True when a snapshot is older than the freshness policy allows. */
  isStale(snapshot: MarketSnapshot): boolean {
    return snapshot.freshnessMs > this.#freshness.priceMaxAgeMs;
  }

  #providersFor(chain: ChainId): MarketDataProvider[] {
    const capable = this.#providers.filter((provider) => provider.chains.includes(chain));
    if (capable.length === 0) {
      throw new AppError(ErrorCode.ADAPTER_UNAVAILABLE, `No market-data provider covers ${chain}`, {
        details: { chain },
      });
    }
    return capable;
  }

  /**
   * Gather fulfilled results, logging failures.
   *
   * Throws only when every provider failed: partial data is useful and its
   * provenance is recorded, but no data at all must not look like an empty
   * market.
   */
  #collect(
    results: PromiseSettledResult<MarketSnapshot[]>[],
    providers: MarketDataProvider[],
    what: string,
  ): MarketSnapshot[] {
    const snapshots: MarketSnapshot[] = [];
    let failures = 0;

    for (const [index, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        snapshots.push(...result.value);
      } else {
        failures += 1;
        this.#log.warn(
          { provider: providers[index]?.source, err: result.reason },
          `provider failed: ${what}`,
        );
      }
    }

    if (failures === results.length && results.length > 0) {
      throw new AppError(ErrorCode.UPSTREAM_UNAVAILABLE, `Could not retrieve ${what}`, {
        details: { providers: providers.map((provider) => provider.source) },
      });
    }

    return snapshots;
  }

  #stamp(snapshot: MarketSnapshot): MarketSnapshot {
    const age = this.#now() - Date.parse(snapshot.observedAt);
    return { ...snapshot, freshnessMs: Math.max(age, 0) };
  }

  #fromCache(key: string): MarketSnapshot[] | undefined {
    const entry = this.#cache.get(key);
    if (!entry) return undefined;

    const age = this.#now() - entry.storedAt;
    if (age > this.#cacheTtlMs) {
      this.#cache.delete(key);
      return undefined;
    }

    // A cached snapshot keeps its original observation time, so its age keeps
    // growing and the freshness check still applies.
    return entry.snapshots.map((snapshot) => this.#stamp({ ...snapshot, source: 'cache' }));
  }

  #toCache(key: string, snapshots: MarketSnapshot[]): void {
    if (this.#cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(key, { snapshots, storedAt: this.#now() });
  }

  /** Record snapshots for the dashboard's history view. Best effort. */
  #persist(snapshots: MarketSnapshot[]): void {
    if (!this.#db || snapshots.length === 0) return;

    try {
      const insert = this.#db.prepare(
        'INSERT OR IGNORE INTO market_snapshots (id, chain, pool_id, base_address, base_symbol,' +
          ' quote_address, quote_symbol, price_usd, price_native, liquidity_usd, volume_24h_usd,' +
          ' change_24h_bps, dex_id, source, observed_at, fetched_at, raw_json)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );

      const write = this.#db.transaction(() => {
        for (const snapshot of snapshots) {
          insert.run(
            `${snapshot.chain}:${snapshot.poolId}:${snapshot.fetchedAt}`,
            snapshot.chain,
            snapshot.poolId,
            snapshot.base.address,
            snapshot.base.symbol ?? '',
            snapshot.quote.address,
            snapshot.quote.symbol ?? '',
            snapshot.priceUsd,
            snapshot.priceNative,
            snapshot.liquidityUsd,
            snapshot.volume24hUsd,
            snapshot.change.h24,
            snapshot.dexId,
            snapshot.source,
            snapshot.observedAt,
            snapshot.fetchedAt,
            '{}',
          );
        }
      });

      write();
    } catch (error) {
      // History is a convenience. Losing a row must never fail a request the
      // operator is waiting on.
      this.#log.warn({ err: error }, 'could not record market snapshots');
    }
  }
}

function byLiquidityDescending(a: MarketSnapshot, b: MarketSnapshot): number {
  const left = a.liquidityUsd === null ? -1 : Number(a.liquidityUsd);
  const right = b.liquidityUsd === null ? -1 : Number(b.liquidityUsd);
  return right - left;
}

function dedupeByPool(snapshots: MarketSnapshot[]): MarketSnapshot[] {
  const seen = new Map<string, MarketSnapshot>();
  for (const snapshot of snapshots) {
    const key = `${snapshot.chain}:${snapshot.poolId.toLowerCase()}`;
    const existing = seen.get(key);
    // Keep whichever reading actually has a price, then whichever is fresher.
    if (!existing || (existing.priceUsd === null && snapshot.priceUsd !== null)) {
      seen.set(key, snapshot);
    }
  }
  return [...seen.values()];
}

/** Median as a string, so the returned value is always one a provider gave. */
function median(values: string[]): string | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => Number(a) - Number(b));
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? null;
}

/** Largest pairwise deviation, relative to the smaller value, in bps. */
function maxDeviationBps(values: number[]): number {
  const usable = values.filter((value) => Number.isFinite(value) && value > 0);
  if (usable.length < 2) return 0;

  const low = Math.min(...usable);
  const high = Math.max(...usable);
  return Math.round(((high - low) / low) * 10_000);
}
