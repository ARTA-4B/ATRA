import type { ChainId } from '../chains/registry.js';
import { CHAINS, DEFAULT_PROTOCOLS } from '../chains/registry.js';
import type { RuntimeConfig } from '../config/env.js';
import type { ExecutionAdapter } from './types.js';
import { JupiterAdapter } from './solana/jupiter.js';
import { V2RouterAdapter } from './evm/v2-router.js';

/**
 * Which execution adapter serves which chain.
 *
 * One adapter per chain in this build:
 *
 *  - Solana → Jupiter v6 (aggregated routing, programs reported before signing)
 *  - BNB Smart Chain → PancakeSwap v2 router
 *  - Base → Aerodrome v2 router
 *  - Robinhood Chain → **none**. Its only DEX is Uniswap v4, whose Universal
 *    Router encoding is not implemented here. The runtime reports the chain as
 *    observable but not executable, and the trader agent returns NO_ACTION for
 *    it with that reason.
 *
 * The registry is the only place adapters are constructed, and every router
 * address it uses comes from `DEFAULT_PROTOCOLS`. There is no way to register
 * an adapter for an address the registry does not know.
 */

export interface ExecutableStatus {
  chain: ChainId;
  executable: boolean;
  protocol: string | null;
  reason: string;
}

export class ExecutionRegistry {
  readonly #adapters = new Map<ChainId, ExecutionAdapter>();
  readonly #reasons = new Map<ChainId, string>();

  constructor(
    adapters: Iterable<ExecutionAdapter>,
    unavailable: Partial<Record<ChainId, string>> = {},
  ) {
    for (const adapter of adapters) {
      this.#adapters.set(adapter.chain, adapter);
    }
    for (const chain of Object.keys(CHAINS) as ChainId[]) {
      if (!this.#adapters.has(chain)) {
        this.#reasons.set(
          chain,
          unavailable[chain] ?? `no execution adapter is built for ${CHAINS[chain].displayName}`,
        );
      }
    }
  }

  get(chain: ChainId): ExecutionAdapter | undefined {
    return this.#adapters.get(chain);
  }

  status(chain: ChainId): ExecutableStatus {
    const adapter = this.#adapters.get(chain);
    if (adapter) {
      return {
        chain,
        executable: true,
        protocol: adapter.protocol,
        reason: `${adapter.protocol} adapter`,
      };
    }
    return {
      chain,
      executable: false,
      protocol: null,
      reason: this.#reasons.get(chain) ?? 'unavailable',
    };
  }

  list(): ExecutableStatus[] {
    return (Object.keys(CHAINS) as ChainId[]).map((chain) => this.status(chain));
  }
}

/** The production registry. Construction performs no I/O. */
export function buildExecutionRegistry(config: RuntimeConfig): ExecutionRegistry {
  const adapters: ExecutionAdapter[] = [
    new JupiterAdapter({
      ...(config.rpcOverrides.solana ? { rpcUrl: config.rpcOverrides.solana } : {}),
    }),
    new V2RouterAdapter({
      chain: 'bsc',
      protocol: 'pancakeswap-v2',
      dialect: 'uniswap-v2',
      router: DEFAULT_PROTOCOLS.bsc['pancakeswap-v2']!.contracts[0]!,
      rpcUrl: config.rpcOverrides.bsc,
    }),
    new V2RouterAdapter({
      chain: 'base',
      protocol: 'aerodrome-v2',
      dialect: 'aerodrome',
      router: DEFAULT_PROTOCOLS.base['aerodrome-v2']!.contracts[0]!,
      rpcUrl: config.rpcOverrides.base,
    }),
  ];

  return new ExecutionRegistry(adapters, {
    robinhood:
      'Robinhood Chain has no execution adapter in this build: its only DEX is Uniswap v4 and the Universal Router path is not implemented. The chain is observable (balances, market data, research) but the agent cannot trade on it.',
  });
}
