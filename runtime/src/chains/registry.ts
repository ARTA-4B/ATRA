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

export function isNativeToken(chain: ChainId, address: string): boolean {
  return canonicalizeAddress(chain, address) === CHAINS[chain].nativeSentinel;
}
