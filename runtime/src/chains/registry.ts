/**
 * The four chains ATRA supports, and nothing else.
 *
 * Every constant here was verified on-chain on 2026-09-19 (chain id via
 * `eth_chainId` / genesis hash via `getGenesisHash`, token metadata via
 * `symbol()` and `decimals()`, contracts via non-empty `eth_getCode`). The
 * provenance for each value is in docs/specs/risk-engine-spec.md section 2.
 *
 * Two rules this file exists to enforce:
 *  - ATRA never silently substitutes one chain for another. A caller asks for
 *    `robinhood` and either gets Robinhood Chain or an error.
 *  - addresses copied between chains are a real and common bug (the OP-stack
 *    WETH address is *not* WETH on Robinhood Chain), so nothing is derived:
 *    every address is listed per chain.
 */

export const CHAIN_IDS = ['base', 'bsc', 'robinhood', 'solana'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];

export type ChainFamily = 'evm' | 'solana';

/** Sentinel used in policies and actions to mean "the chain's native coin". */
export const EVM_NATIVE_SENTINEL = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
export const SOLANA_NATIVE_SENTINEL = 'So11111111111111111111111111111111111111112';

export interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
}

export interface ChainInfo {
  id: ChainId;
  family: ChainFamily;
  displayName: string;
  /** EVM chain id; undefined for Solana. */
  evmChainId: number | undefined;
  nativeSymbol: string;
  nativeDecimals: number;
  nativeSentinel: string;
  /** Keyless public endpoints, tried in order. Operators may override these. */
  publicRpcUrls: string[];
  explorerUrl: string;
  /** Well-known tokens seeded into a fresh allowlist. */
  tokens: TokenInfo[];
}

export const CHAINS: Record<ChainId, ChainInfo> = {
  base: {
    id: 'base',
    family: 'evm',
    displayName: 'Base',
    evmChainId: 8453,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativeSentinel: EVM_NATIVE_SENTINEL,
    publicRpcUrls: ['https://mainnet.base.org'],
    explorerUrl: 'https://basescan.org',
    tokens: [
      { address: EVM_NATIVE_SENTINEL, symbol: 'ETH', decimals: 18 },
      { address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', symbol: 'USDC', decimals: 6 },
      { address: '0x4200000000000000000000000000000000000006', symbol: 'WETH', decimals: 18 },
    ],
  },
  bsc: {
    id: 'bsc',
    family: 'evm',
    displayName: 'BNB Smart Chain',
    evmChainId: 56,
    nativeSymbol: 'BNB',
    nativeDecimals: 18,
    nativeSentinel: EVM_NATIVE_SENTINEL,
    publicRpcUrls: ['https://bsc-dataseed.bnbchain.org'],
    explorerUrl: 'https://bscscan.com',
    tokens: [
      { address: EVM_NATIVE_SENTINEL, symbol: 'BNB', decimals: 18 },
      // BSC-pegged stablecoins use 18 decimals, not the 6 they have elsewhere.
      { address: '0x55d398326f99059ff775485246999027b3197955', symbol: 'USDT', decimals: 18 },
      { address: '0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d', symbol: 'USDC', decimals: 18 },
      { address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c', symbol: 'WBNB', decimals: 18 },
    ],
  },
  robinhood: {
    id: 'robinhood',
    family: 'evm',
    displayName: 'Robinhood Chain',
    evmChainId: 4663,
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    nativeSentinel: EVM_NATIVE_SENTINEL,
    // Public endpoint is rate limited; the chain's docs recommend a keyed
    // provider for production, which an operator supplies through BYOK.
    publicRpcUrls: ['https://rpc.mainnet.chain.robinhood.com'],
    explorerUrl: 'https://robinhoodchain.blockscout.com',
    tokens: [
      { address: EVM_NATIVE_SENTINEL, symbol: 'ETH', decimals: 18 },
      { address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73', symbol: 'WETH', decimals: 18 },
      { address: '0x5fc5360d0400a0fd4f2af552add042d716f1d168', symbol: 'USDG', decimals: 6 },
    ],
  },
  solana: {
    id: 'solana',
    family: 'solana',
    displayName: 'Solana',
    evmChainId: undefined,
    nativeSymbol: 'SOL',
    nativeDecimals: 9,
    nativeSentinel: SOLANA_NATIVE_SENTINEL,
    publicRpcUrls: ['https://api.mainnet-beta.solana.com'],
    explorerUrl: 'https://solscan.io',
    tokens: [
      { address: SOLANA_NATIVE_SENTINEL, symbol: 'SOL', decimals: 9 },
      { address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', symbol: 'USDC', decimals: 6 },
    ],
  },
};

/** Solana genesis hash, used to prove an RPC really serves mainnet-beta. */
export const SOLANA_MAINNET_GENESIS = '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d';

/**
 * Programs that legitimately appear alongside an allowlisted Solana program.
 * Not operator-editable: widening this set widens what a transaction may touch.
 */
export const SOLANA_SYSTEM_PROGRAMS: readonly string[] = [
  '11111111111111111111111111111111',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb',
  'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'ComputeBudget111111111111111111111111111111',
  'AddressLookupTab1e1111111111111111111111111',
];

/** Protocols seeded into a fresh allowlist, verified to have code on-chain. */
export const DEFAULT_PROTOCOLS: Record<
  ChainId,
  Record<string, { contracts: string[]; approveSpenders: string[] }>
> = {
  base: {
    'uniswap-v4': {
      contracts: [
        '0x6ff5693b99212da76ad316178a184ab56d299b43', // Universal Router
        '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
      ],
      approveSpenders: ['0x000000000022d473030f116ddee9f6b43ac78ba3'],
    },
    'aerodrome-v2': {
      contracts: ['0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43'],
      approveSpenders: ['0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43'],
    },
  },
  bsc: {
    'pancakeswap-v3': {
      contracts: ['0x13f4ea83d0bd40e75c8222255bc855a974568dd4'],
      approveSpenders: ['0x13f4ea83d0bd40e75c8222255bc855a974568dd4'],
    },
    'pancakeswap-v2': {
      contracts: ['0x10ed43c718714eb63d5aa57b78b54704e256024e'],
      approveSpenders: ['0x10ed43c718714eb63d5aa57b78b54704e256024e'],
    },
    'uniswap-v4': {
      contracts: [
        '0x1906c1d672b88cd1b9ac7593301ca990f94eae07',
        '0x000000000022d473030f116ddee9f6b43ac78ba3',
      ],
      approveSpenders: ['0x000000000022d473030f116ddee9f6b43ac78ba3'],
    },
  },
  robinhood: {
    'uniswap-v4': {
      contracts: [
        '0x8876789976decbfcbbbe364623c63652db8c0904', // Universal Router
        '0x8dc178efb8111bb0973dd9d722ebeff267c98f94', // V4Quoter (read-only)
        '0x000000000022d473030f116ddee9f6b43ac78ba3', // Permit2
      ],
      approveSpenders: ['0x000000000022d473030f116ddee9f6b43ac78ba3'],
    },
  },
  solana: {
    'jupiter-v6': {
      contracts: ['JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4'],
      approveSpenders: [],
    },
  },
};

/**
 * Concentrated-liquidity (Uniswap v3 lineage) deployments this build may READ,
 * and nothing else.
 *
 * A deliberately separate map from `DEFAULT_PROTOCOLS`. Policy seeding, the
 * contract allowlist and every execution adapter read that one, so nothing
 * here can be selected for a swap, an approval or a liquidity action however a
 * policy is edited: there is no code path from this constant to a transaction.
 * A v3 position is an ERC-721 with a tick range, and the ledger, the risk
 * checks and the reconciler all assume fungible LP tokens, so the honest
 * capability today is inspection.
 *
 * Every address was verified on 2026-09-21 against the protocol's own
 * published deployment list and then with read-only `eth_call`:
 *
 *  - Base / Uniswap v3, block 51569133. Published list:
 *    developers.uniswap.org/contracts/v3/reference/deployments/base-deployments.
 *    `eth_getCode` is non-empty for all three; `positionManager.factory()` and
 *    `quoter.factory()` both return `0x3312…FDfD`; the position manager is
 *    `name() = "Uniswap V3 Positions NFT-V1"`, `symbol() = "UNI-V3-POS"`;
 *    `factory.feeAmountTickSpacing` = 1 / 10 / 60 / 200 for the 100 / 500 /
 *    3000 / 10000 fee tiers. `factory.getPool(WETH, USDC, 500)` =
 *    `0xd0b53d9277642d899df5c87a3966a349a798f224`, whose `token0` is WETH,
 *    `token1` USDC, `fee` 500, `tickSpacing` 10 and `factory()` the factory
 *    above.
 *  - BNB Smart Chain / PancakeSwap v3, block 123034328. Published list:
 *    developer.pancakeswap.finance/contracts/v3/addresses. Same checks:
 *    `positionManager.factory()` and `quoter.factory()` both return
 *    `0x0BFb…1865`, `name() = "Pancake V3 Positions NFT-V1"`, `symbol() =
 *    "PCS-V3-POS"`, `feeAmountTickSpacing` = 1 / 10 / 50 / 200 for the 100 /
 *    500 / 2500 / 10000 tiers (2500 is PancakeSwap's tier and has no Uniswap
 *    equivalent). `factory.getPool(USDT, WBNB, 500)` =
 *    `0x36696169c63e42cd08ce11f5deebbcebae652050`, `token0` USDT, `token1`
 *    WBNB, `fee` 500, `tickSpacing` 10, `factory()` the factory above.
 *    The same page lists the Smart Router `0x13f4…8Dd4` that `DEFAULT_PROTOCOLS`
 *    already carries for swaps, which cross-checks the source.
 *
 * Robinhood Chain and Solana have no v3 deployment listed here: Robinhood
 * Chain's only DEX is Uniswap v4 and Solana's concentrated-liquidity venues
 * are not EVM contracts at all.
 *
 * The BSC key is `pancakeswap-v3-lp` rather than `pancakeswap-v3`, which
 * `DEFAULT_PROTOCOLS` already uses for the Smart Router: same protocol, but a
 * name shared between the two maps could let a lookup fall through to an
 * executable contract, and these must never resolve to one.
 */
export interface InspectOnlyProtocol {
  /** Role -> address. None of these is ever a transaction target. */
  contracts: Record<string, string>;
  /** Fee tiers the factory reports, in hundredths of a basis point. */
  feeTiers: number[];
  note: string;
}

export const INSPECT_ONLY_PROTOCOLS: Record<ChainId, Record<string, InspectOnlyProtocol>> = {
  base: {
    'uniswap-v3': {
      contracts: {
        factory: '0x33128a8fc17869897dce68ed026d694621f6fdfd',
        positionManager: '0x03a520b32c04bf3beef7beb72e919cf822ed34f1',
        quoter: '0x3d4e44eb1374240ce5f1b871ab261cd16335b76a',
      },
      feeTiers: [100, 500, 3000, 10000],
      note: 'read-only: v3 position management is not implemented in this build',
    },
  },
  bsc: {
    'pancakeswap-v3-lp': {
      contracts: {
        factory: '0x0bfbcf9fa4f9c56b0f40a671ad40e0805a091865',
        positionManager: '0x46a15b0b27311cedf172ab29e4f4766fbe7f4364',
        quoter: '0xb048bbc1ee6b733fffcfb9e9cef7375518e25997',
      },
      feeTiers: [100, 500, 2500, 10000],
      note: 'read-only: v3 position management is not implemented in this build',
    },
  },
  robinhood: {},
  solana: {},
};

export function isChainId(value: unknown): value is ChainId {
  return typeof value === 'string' && (CHAIN_IDS as readonly string[]).includes(value);
}

export function getChain(id: ChainId): ChainInfo {
  return CHAINS[id];
}

export function chainFamily(id: ChainId): ChainFamily {
  return CHAINS[id].family;
}

/** Canonical form for comparisons: EVM addresses lowercase, Solana untouched. */
export function canonicalizeAddress(chain: ChainId, address: string): string {
  return chainFamily(chain) === 'evm' ? address.toLowerCase() : address;
}

/**
 * Registry-listed stablecoins are the quote assets: the side a trade is funded
 * from and the side an exit returns to. The list is fixed here rather than
 * read from a provider so that nothing outside the repository can promote a
 * token to "stable".
 */
const STABLE_SYMBOLS = /^(USDC|USDT|USDG|USDbC|DAI)$/i;
export function isStablecoin(chain: ChainId, address: string): boolean {
  const canonical = canonicalizeAddress(chain, address);
  const entry = CHAINS[chain].tokens.find(
    (t) => canonicalizeAddress(chain, t.address) === canonical,
  );
  return entry !== undefined && STABLE_SYMBOLS.test(entry.symbol);
}

export function isNativeToken(chain: ChainId, address: string): boolean {
  return canonicalizeAddress(chain, address) === CHAINS[chain].nativeSentinel;
}
