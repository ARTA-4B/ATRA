import { CHAINS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import type { RuntimeConfig } from '../config/env.js';
import { V2PoolLpAdapter } from './evm/v2-pool.js';
import { LP_PROTOCOLS, LP_UNAVAILABLE_REASONS } from './protocols.js';
import type { LpAdapter, LpAdapterStatus } from './types.js';

/**
 * Which LP adapter serves which chain.
 *
 *  - Base → Aerodrome v2 (volatile and stable pools, fee claims)
 *  - BNB Smart Chain → PancakeSwap v2 (pairs; fees compound, no claim)
 *  - Solana → **none**: Orca, Raydium and Meteora are concentrated-liquidity
 *    protocols and none of their position programs are implemented.
 *  - Robinhood Chain → **none**: Uniswap v4 only, not implemented.
 *
 * The registry is the only place LP adapters are constructed, and every
 * router and factory it uses comes from `LP_PROTOCOLS`, whose routers are in
 * turn asserted against the swap registry. A chain without an adapter is
 * reported with its reason, exactly like the execution registry.
 */
export class LiquidityRegistry {
  readonly #adapters = new Map<ChainId, LpAdapter>();
  readonly #reasons = new Map<ChainId, string>();

  constructor(adapters: Iterable<LpAdapter>, unavailable: Partial<Record<ChainId, string>> = {}) {
    for (const adapter of adapters) {
      this.#adapters.set(adapter.chain, adapter);
    }
    for (const chain of Object.keys(CHAINS) as ChainId[]) {
      if (!this.#adapters.has(chain)) {
        this.#reasons.set(
          chain,
          unavailable[chain] ??
            LP_UNAVAILABLE_REASONS[chain] ??
            `no LP adapter is built for ${CHAINS[chain].displayName}`,
        );
      }
    }
  }

  get(chain: ChainId): LpAdapter | undefined {
    return this.#adapters.get(chain);
  }

  status(chain: ChainId): LpAdapterStatus {
    const adapter = this.#adapters.get(chain);
    if (adapter) {
      return {
        chain,
        available: true,
        protocol: adapter.protocol,
        reason: `${adapter.protocol} adapter`,
      };
    }
    return {
      chain,
      available: false,
      protocol: null,
      reason: this.#reasons.get(chain) ?? 'unavailable',
    };
  }

  list(): LpAdapterStatus[] {
    return (Object.keys(CHAINS) as ChainId[]).map((chain) => this.status(chain));
  }

  /** For the dashboard: one entry per protocol with the chains it serves. */
  supportedProtocols(): Array<{ id: string; name: string; chains: ChainId[] }> {
    const byProtocol = new Map<string, { id: string; name: string; chains: ChainId[] }>();
    for (const adapter of this.#adapters.values()) {
      const entry = byProtocol.get(adapter.protocol) ?? {
        id: adapter.protocol,
        name: LP_PROTOCOLS[adapter.chain]?.displayName ?? adapter.protocol,
        chains: [],
      };
      entry.chains.push(adapter.chain);
      byProtocol.set(adapter.protocol, entry);
    }
    return [...byProtocol.values()];
  }
}

/** The production registry. Construction performs no I/O. */
export function buildLiquidityRegistry(config: RuntimeConfig): LiquidityRegistry {
  const adapters: LpAdapter[] = [];
  for (const chain of Object.keys(LP_PROTOCOLS) as ChainId[]) {
    const info = LP_PROTOCOLS[chain];
    if (!info) continue;
    adapters.push(new V2PoolLpAdapter({ chain, info, rpcUrl: config.rpcOverrides[chain] }));
  }
  return new LiquidityRegistry(adapters);
}
