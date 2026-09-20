import { CHAINS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import type { ChainAdapter } from '../chains/types.js';
import type { MarketService } from '../market/service.js';
import { microsToUsd, nativeToUsdMicros, priceToAtto, usdToMicros } from '../risk/money.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';
import type { TreasuryStore } from './store.js';
import type { AssetBalanceView, BalanceReport, TreasuryAddress } from './types.js';

/**
 * Reads the watch-only treasury addresses.
 *
 * The rules are the ones the operator's wallet page already follows, applied
 * to money the runtime cannot touch:
 *
 *  - a failed RPC read is reported as `amount: null` with the error, never as
 *    zero. A zero here would flow into the runway and quietly become "no
 *    money left";
 *  - a balance the market layer cannot price is `valueUsd: null` with the
 *    provider's reason. A disputed price (providers disagree beyond
 *    tolerance) counts as unknown; the treasury would rather say "unpriced"
 *    than pick the number it likes;
 *  - the total is the sum of what *was* priced, flagged `complete: false`
 *    with the missing assets listed whenever anything is missing. The
 *    runway calculation refuses an incomplete total.
 *
 * Every reading is written to `treasury_snapshots`, failures included, so the
 * history shows when the treasury was unreadable rather than a gap.
 */

export interface BalanceReaderDeps {
  adapters: Map<ChainId, ChainAdapter>;
  market: MarketService;
  store: TreasuryStore;
  now?: () => number;
}

export class TreasuryBalanceReader {
  readonly #adapters: Map<ChainId, ChainAdapter>;
  readonly #market: MarketService;
  readonly #store: TreasuryStore;
  readonly #now: () => number;
  readonly #log = childLogger('treasury-balances');

  constructor(deps: BalanceReaderDeps) {
    this.#adapters = deps.adapters;
    this.#market = deps.market;
    this.#store = deps.store;
    this.#now = deps.now ?? (() => Date.now());
  }

  async read(addresses: TreasuryAddress[]): Promise<BalanceReport> {
    const takenAt = new Date(this.#now()).toISOString();
    const assets: AssetBalanceView[] = [];

    for (const entry of addresses) {
      if (!entry.enabled) continue;
      const info = CHAINS[entry.chain];
      const wanted = [
        {
          address: info.nativeSentinel,
          symbol: info.nativeSymbol,
          decimals: info.nativeDecimals,
          native: true,
        },
        ...entry.tokens.map((token) => ({ ...token, native: false })),
      ];
      for (const asset of wanted) {
        const view = await this.#readOne(entry, asset);
        assets.push(view);
        this.#store.insertSnapshot({
          takenAt,
          chain: view.chain,
          address: view.address,
          asset: view.asset,
          symbol: view.symbol,
          decimals: view.decimals,
          amount: view.amount,
          priceUsd: view.priceUsd,
          valueUsd: view.valueUsd,
          reason: view.reason,
          source: view.source,
        });
      }
    }

    let priced = 0n;
    const incomplete: BalanceReport['incomplete'] = [];
    for (const asset of assets) {
      if (asset.valueUsd !== null) {
        priced += usdToMicros(asset.valueUsd);
      } else {
        incomplete.push({
          chain: asset.chain,
          symbol: asset.symbol,
          reason: asset.reason ?? 'unknown',
        });
      }
    }

    return {
      takenAt,
      assets,
      pricedValueUsd: microsToUsd(priced),
      complete: incomplete.length === 0,
      incomplete,
    };
  }

  async #readOne(
    entry: TreasuryAddress,
    asset: { address: string; symbol: string; decimals: number; native: boolean },
  ): Promise<AssetBalanceView> {
    const base: AssetBalanceView = {
      chain: entry.chain,
      address: entry.address,
      label: entry.label,
      asset: asset.address,
      symbol: asset.symbol,
      decimals: asset.decimals,
      amount: null,
      amountDecimal: null,
      priceUsd: null,
      valueUsd: null,
      reason: null,
      observedAt: null,
      source: 'none',
    };

    const adapter = this.#adapters.get(entry.chain);
    if (!adapter) {
      return { ...base, reason: `no adapter is configured for ${entry.chain}` };
    }

    let amount: bigint;
    try {
      const observation = asset.native
        ? await adapter.getNativeBalance(entry.address)
        : await adapter.getTokenBalance(entry.address, asset.address);
      amount = BigInt(observation.value.amount);
      base.amount = amount.toString();
      base.amountDecimal = formatUnits(amount, asset.decimals);
      base.observedAt = new Date(observation.observedAt).toISOString();
      base.source = hostOnly(observation.source);
    } catch (cause) {
      this.#log.warn(
        { chain: entry.chain, symbol: asset.symbol, err: cause },
        'balance read failed',
      );
      return { ...base, reason: `balance unreadable: ${errorMessage(cause)}` };
    }

    let price;
    try {
      price = await this.#market.getCrossCheckedPrice(entry.chain, asset.address);
    } catch (cause) {
      return { ...base, reason: `price lookup failed: ${errorMessage(cause)}` };
    }

    if (price.priceUsd === null) {
      return {
        ...base,
        reason: `price unknown: ${price.reason ?? 'no provider returned a price'}`,
      };
    }
    if (price.disputed) {
      return {
        ...base,
        reason: `price disputed: ${price.reason ?? 'providers disagree'}`,
      };
    }

    let valueMicros: bigint;
    try {
      valueMicros = nativeToUsdMicros(amount, asset.decimals, priceToAtto(price.priceUsd), 'floor');
    } catch (cause) {
      return { ...base, reason: `price unusable: ${errorMessage(cause)}` };
    }

    return {
      ...base,
      priceUsd: price.priceUsd,
      valueUsd: microsToUsd(valueMicros),
      ...(price.reason ? { reason: price.reason } : {}),
    };
  }
}

/** Render base units as a decimal string without floats. */
export function formatUnits(amount: bigint, decimals: number): string {
  if (decimals === 0) return amount.toString();
  const divisor = 10n ** BigInt(decimals);
  const whole = amount / divisor;
  const fraction = (amount % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return fraction.length > 0 ? `${whole.toString()}.${fraction}` : whole.toString();
}

/** Host only: a BYOK endpoint embeds the operator's key in its path. */
function hostOnly(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint;
  }
}
