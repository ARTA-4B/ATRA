import type { Market } from './services';

/**
 * Live market data for the public site and the demo dashboard.
 *
 * Source: DexScreener's public API (no key, CORS open). For each token the
 * runtime supports, the deepest pool in which the token is the *base* asset
 * is used, because a pool quotes the price of its own base token — reading
 * a pool where the token is the quote would report the wrong asset's price.
 *
 * Nothing here is invented: a token without a usable pool comes back with
 * every numeric field null and a reason, and the caller shows it as
 * unavailable. No price history is fabricated either; DexScreener does not
 * serve candles, so `history` stays empty and the UI draws no sparkline.
 */

const API = 'https://api.dexscreener.com/token-pairs/v1';

interface DexPair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { address: string; symbol: string };
  quoteToken: { address: string; symbol: string };
  priceUsd?: string;
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  priceChange?: { h24?: number };
}

interface TrackedToken {
  id: string;
  symbol: string;
  name: string;
  chain: Market['chain'];
  dexChain: string;
  address: string;
}

/** The runtime's registry tokens, one row per asset per chain. */
export const TRACKED: TrackedToken[] = [
  { id: 'eth-base', symbol: 'ETH', name: 'Ethereum', chain: 'Base', dexChain: 'base', address: '0x4200000000000000000000000000000000000006' },
  { id: 'usdc-base', symbol: 'USDC', name: 'USD Coin', chain: 'Base', dexChain: 'base', address: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' },
  { id: 'sol-solana', symbol: 'SOL', name: 'Solana', chain: 'Solana', dexChain: 'solana', address: 'So11111111111111111111111111111111111111112' },
  { id: 'bnb-bsc', symbol: 'BNB', name: 'BNB', chain: 'BNB Smart Chain', dexChain: 'bsc', address: '0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c' },
  { id: 'eth-robinhood', symbol: 'ETH', name: 'Ethereum', chain: 'Robinhood Chain', dexChain: 'robinhood', address: '0x0bd7d308f8e1639fab988df18a8011f41eacad73' },
];

export interface LiveMarket extends Market {
  source: 'dexscreener';
  /** Epoch ms when the row was fetched. */
  observedAt: number;
  dex: string | null;
  /** Why the numbers are null, when they are. */
  reason: string | null;
}

async function pairsFor(token: TrackedToken, signal?: AbortSignal): Promise<DexPair[]> {
  const response = await fetch(`${API}/${token.dexChain}/${token.address}`, { signal, headers: { accept: 'application/json' } });
  if (!response.ok) throw new Error(`DexScreener returned HTTP ${response.status} for ${token.symbol} on ${token.chain}`);
  const body: unknown = await response.json();
  return Array.isArray(body) ? (body as DexPair[]) : [];
}

function toMarket(token: TrackedToken, pairs: DexPair[], observedAt: number): LiveMarket {
  const asBase = pairs
    .filter((p) => p.baseToken.address.toLowerCase() === token.address.toLowerCase() && typeof p.liquidity?.usd === 'number')
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  const top = asBase[0];
  const price = top?.priceUsd !== undefined ? Number(top.priceUsd) : NaN;

  if (!top || !Number.isFinite(price) || price <= 0) {
    return {
      id: token.id, symbol: token.symbol, name: token.name, chain: token.chain,
      price: null, change: null, volume: null, liquidity: null, pool: 'No pool found', history: [],
      source: 'dexscreener', observedAt, dex: null,
      reason: pairs.length === 0 ? 'provider returned no pools for this token' : 'no pool quotes this token as its base asset',
    };
  }

  return {
    id: token.id, symbol: token.symbol, name: token.name, chain: token.chain,
    price,
    change: typeof top.priceChange?.h24 === 'number' ? top.priceChange.h24 : null,
    volume: typeof top.volume?.h24 === 'number' ? top.volume.h24 : null,
    liquidity: top.liquidity?.usd ?? null,
    pool: `${top.baseToken.symbol} / ${top.quoteToken.symbol} · ${top.dexId}`,
    history: [],
    source: 'dexscreener', observedAt, dex: top.dexId, reason: null,
  };
}

/**
 * Fetch every tracked token. One failed token does not hide the others: it
 * becomes an unavailable row with the error as its reason. Only when *every*
 * request fails is the whole call rejected, so the page can show the
 * provider-unavailable state instead of five empty rows.
 */
export async function fetchLiveMarkets(signal?: AbortSignal): Promise<LiveMarket[]> {
  const observedAt = Date.now();
  const settled = await Promise.allSettled(TRACKED.map((token) => pairsFor(token, signal)));
  const rows = settled.map((result, index) => {
    const token = TRACKED[index];
    if (result.status === 'fulfilled') return toMarket(token, result.value, observedAt);
    return {
      id: token.id, symbol: token.symbol, name: token.name, chain: token.chain,
      price: null, change: null, volume: null, liquidity: null, pool: 'Unavailable', history: [],
      source: 'dexscreener' as const, observedAt, dex: null,
      reason: result.reason instanceof Error ? result.reason.message : 'request failed',
    };
  });
  if (settled.every((r) => r.status === 'rejected')) {
    throw new Error('Market provider unavailable. DexScreener did not answer for any chain.');
  }
  return rows;
}

export function ageLabel(observedAt: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - observedAt) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`;
}
