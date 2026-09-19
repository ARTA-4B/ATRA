import { DEFAULT_PROTOCOLS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';

/**
 * The liquidity protocols this build can manage, and nothing else.
 *
 * Uniswap-v2-style pools only: one router, one factory, LP tokens that are
 * plain ERC-20s, no position NFTs, no price ranges. Every address was
 * verified with read-only `eth_call` on 2026-09-19:
 *
 *  - Base / Aerodrome v2: router `0xcf77…e43` reports `defaultFactory()` =
 *    `0x420d…40da`; `factory.getPool(USDC, WETH, false)` =
 *    `0xcdac0d6c6c59727a65f871236188350531885c43` (`vAMM-WETH/USDC`,
 *    token0 WETH, token1 USDC, `stable() = false`, `getFee = 30`), block
 *    51533078. The pool is an EIP-1167 clone of `0xa4e4…6d7`, whose bytecode
 *    contains the selectors for `getReserves`, `totalSupply`, `balanceOf`,
 *    `token0`, `token1`, `stable`, `claimable0/1`, `claimFees`, `index0/1`
 *    and `supplyIndex0`. `router.quoteAddLiquidity(USDC, WETH, false,
 *    factory, 10e6, 4e15)` = (10e6, 3808532211238362, 190965324619) and
 *    `quoteRemoveLiquidity(…, 1e12)` = (52365262, 19943680838075363); the
 *    same call with a zero factory reverts, so the factory is always passed
 *    explicitly. The router bytecode contains the `addLiquidity(address,
 *    address,bool,uint256,uint256,uint256,uint256,address,uint256)` and
 *    `removeLiquidity(address,address,bool,uint256,uint256,uint256,address,
 *    uint256)` selectors.
 *    Fee accrual: the pool's gauge (holding 98.7% of the LP supply) had
 *    `claimable0 = 0.771 WETH`, `claimable1 = 2404 USDC` and an unstaked
 *    ex-holder a residual `claimable1 = 3`, so fees accrue per LP-token
 *    holder through `index0/1`, staked or not, and are collected with
 *    `claimFees()` by the holder. `eth_call claimFees()` from an address with
 *    no LP returned (0, 0).
 *  - BSC / PancakeSwap v2: router `0x10ed…24e` reports `factory()` =
 *    `0xca14…c73`; `factory.getPair(USDT, WBNB)` =
 *    `0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae` (`Cake-LP`, token0 USDT,
 *    token1 WBNB), `getReserves` = (39360745189247139973358727,
 *    51815337543989588853076, 1789855457), `totalSupply` =
 *    526570720854700917411686, `router.getAmountsOut(10 USDT)` =
 *    13131302736558717 WBNB, `router.quote(1e18, 1e18, 2e18)` = 2e18, block
 *    122874109. Fees compound into the reserves; there is nothing to claim.
 *
 * The router of each entry must be the same contract the execution registry
 * already uses for swaps (`DEFAULT_PROTOCOLS`), and that is asserted at
 * construction: the two registries cannot drift apart. The factory is only
 * ever read (`getPool` / `getPair`); no transaction targets it.
 *
 * Solana (Orca, Raydium, Meteora concentrated liquidity) and Robinhood Chain
 * (Uniswap v4) have no LP adapter in this build. The registry says so.
 */

export type LpDialect = 'aerodrome' | 'uniswap-v2';

export interface LpProtocolInfo {
  protocol: string;
  dialect: LpDialect;
  router: string;
  factory: string;
  displayName: string;
}

export const LP_PROTOCOLS: Partial<Record<ChainId, LpProtocolInfo>> = {
  base: {
    protocol: 'aerodrome-v2',
    dialect: 'aerodrome',
    router: '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43',
    factory: '0x420dd381b31aef6683db6b902084cb0ffece40da',
    displayName: 'Aerodrome v2',
  },
  bsc: {
    protocol: 'pancakeswap-v2',
    dialect: 'uniswap-v2',
    router: '0x10ed43c718714eb63d5aa57b78b54704e256024e',
    factory: '0xca143ce32fe78f1f7019d7d551a6402fc5350c73',
    displayName: 'PancakeSwap v2',
  },
};

/**
 * Pools verified live on 2026-09-19, for an operator to allowlist. Not part of
 * the default policy: LP automation stays disabled until the operator opts
 * in by listing pools and setting a non-zero capital cap.
 */
export const VERIFIED_EXAMPLE_POOLS: ReadonlyArray<{
  chain: ChainId;
  protocol: string;
  poolId: string;
  label: string;
}> = [
  {
    chain: 'base',
    protocol: 'aerodrome-v2',
    poolId: '0xcdac0d6c6c59727a65f871236188350531885c43',
    label: 'Aerodrome vAMM-WETH/USDC (volatile)',
  },
  {
    chain: 'bsc',
    protocol: 'pancakeswap-v2',
    poolId: '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae',
    label: 'PancakeSwap v2 USDT/WBNB',
  },
];

export const LP_UNAVAILABLE_REASONS: Partial<Record<ChainId, string>> = {
  solana:
    'Solana has no LP adapter in this build: Orca, Raydium and Meteora are concentrated-liquidity protocols with position accounts and price ranges, and none of that is implemented. The chain is observable and tradeable, but the agent cannot manage liquidity on it.',
  robinhood:
    'Robinhood Chain has no LP adapter in this build: its only DEX is Uniswap v4, whose position manager and hook model are not implemented. The chain is observable but the agent cannot manage liquidity on it.',
};

/** Every LP router must already be a registered swap contract for the chain. */
export function assertRegisteredRouter(chain: ChainId, info: LpProtocolInfo): void {
  const registered = DEFAULT_PROTOCOLS[chain][info.protocol]?.contracts ?? [];
  if (!registered.includes(info.router)) {
    throw new Error(
      `${info.router} is not a registered ${info.protocol} contract on ${chain}; refusing to build an LP adapter for it`,
    );
  }
}
