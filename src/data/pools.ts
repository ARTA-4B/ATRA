import { z } from 'zod';
import type { Chain } from './services';

const TokenSchema = z.object({ address: z.string(), name: z.string().optional(), symbol: z.string().optional() });
const ProviderPoolSchema = z.object({ chainId: z.string(), dexId: z.string(), pairAddress: z.string(), labels: z.array(z.string()).nullish(), baseToken: TokenSchema, quoteToken: TokenSchema, priceUsd: z.string().nullish(), volume: z.object({ h24: z.number().nullish() }).nullish(), liquidity: z.object({ usd: z.number().nullish() }).nullish(), pairCreatedAt: z.number().nullish() });
export type PoolVersion = 'V2' | 'V3' | 'V4' | 'Other / unknown';

/**
 * Whether the runtime could act on a pool of this version.
 *
 * The LP adapters in `runtime/src/liquidity/protocols.ts` cover v2-style
 * pools only. Discovery deliberately shows everything the indexer returns --
 * a pool you cannot manage is still worth seeing -- so each row has to carry
 * the difference rather than implying that finding a pool means using it.
 */
export type PoolExecution = 'Manageable' | 'Inspect only';
export function executionFor(version: PoolVersion): PoolExecution {
  return version === 'V2' ? 'Manageable' : 'Inspect only';
}
export type Pool = { id: string; chain: Chain; protocol: string; version: PoolVersion; base: string; quote: string; baseAddress: string; quoteAddress: string; liquidity: number | null; volume: number | null; createdAt: number | null; source: 'DEX Screener' | 'Demo fixture'; observedAt: number; fee: number | null; hooks: string | null; execution: PoolExecution };
export type PoolSnapshot = { pools: Pool[]; source: string; observedAt: number; coverage: string };
export interface PoolDiscoveryService { discover(chain: Chain, address: string, signal?: AbortSignal): Promise<PoolSnapshot> }
export function validTokenAddress(chain: Chain, address: string) { return chain === 'Solana' ? /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) : /^0x[0-9a-fA-F]{40}$/.test(address) && !/^0x0{40}$/.test(address); }
const chainIds: Partial<Record<Chain, string>> = { Base: 'base', 'BNB Smart Chain': 'bsc', Solana: 'solana' };
export const poolDiscoveryService: PoolDiscoveryService = {
  async discover(chain, address, signal) {
    if (!validTokenAddress(chain, address)) throw new Error('Enter a valid token contract address for the selected network.');
    const chainId = chainIds[chain];
    if (!chainId) throw new Error('Robinhood Chain discovery is not configured with this provider. A chain-specific indexer is required.');
    const response = await fetch(`https://api.dexscreener.com/token-pairs/v1/${chainId}/${encodeURIComponent(address)}`, { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error(response.status === 429 ? 'Provider rate limit reached. Wait a moment and retry.' : 'Pool provider unavailable. Try again shortly.');
    const body: unknown = await response.json();
    if (!Array.isArray(body)) throw new Error('The provider returned an unexpected response. No pools were loaded.');
    const observedAt = Date.now(); const sameAddress = (a: string) => chain === 'Solana' ? a === address : a.toLowerCase() === address.toLowerCase();
    const pools: Pool[] = []; let invalidRows = 0;
    for (const raw of body) {
      const result = ProviderPoolSchema.safeParse(raw); if (!result.success) { invalidRows++; continue; }
      const p = result.data;
      if (p.chainId !== chainId || (!sameAddress(p.baseToken.address) && !sameAddress(p.quoteToken.address))) continue;
      const versionLabel = (p.labels || []).find(l => /^v[234]$/i.test(l));
      const version: PoolVersion = versionLabel ? versionLabel.toUpperCase() as PoolVersion : 'Other / unknown';
      if (pools.some(row => row.id === p.pairAddress && row.protocol === p.dexId)) continue;
      pools.push({ id: p.pairAddress, chain, protocol: p.dexId, version, base: p.baseToken.symbol || 'Unknown token', quote: p.quoteToken.symbol || 'Unknown token', baseAddress: p.baseToken.address, quoteAddress: p.quoteToken.address, liquidity: p.liquidity?.usd ?? null, volume: p.volume?.h24 ?? null, createdAt: p.pairCreatedAt ?? null, source: 'DEX Screener', observedAt, fee: null, hooks: null, execution: executionFor(version) });
    }
    if (body.length && invalidRows === body.length) throw new Error('Provider data could not be validated. No pools were loaded.');
    return { pools, source: 'DEX Screener', observedAt, coverage: `All matching pools returned by this provider are included. Only v2-style pools can be managed by this build; the rest are shown for comparison. Indexer coverage may be incomplete; a missing pool is not proof that it does not exist.${invalidRows ? ` ${invalidRows} malformed provider rows were omitted.` : ''}` };
  },
};
export function demoPoolSnapshot(): PoolSnapshot { const observedAt = Date.now(); return { source: 'Demo fixture', observedAt, coverage: 'Illustrative pool versions only. These are not real token addresses or executable pools.', pools: [
  { id: 'DEMO-V2-POOL', protocol: 'Uniswap', version: 'V2', liquidity: 24500, volume: 8150 },
  { id: 'DEMO-V3-POOL', protocol: 'Uniswap', version: 'V3', liquidity: 78200, volume: 18600 },
  { id: 'DEMO-V4-POOL-ID', protocol: 'Uniswap', version: 'V4', liquidity: 16300, volume: 4020 },
].map(p => ({ ...p, version: p.version as PoolVersion, chain: 'Base', base: 'TOKEN', quote: 'WETH', baseAddress: 'DEMO-TOKEN', quoteAddress: 'DEMO-WETH', createdAt: null, source: 'Demo fixture', observedAt, fee: null, hooks: null, execution: executionFor(p.version as PoolVersion) })) }; }
export const LPPolicySchema = z.object({ capital: z.coerce.number().positive().max(1000000), maxSlippage: z.coerce.number().min(.01).max(5), minLiquidity: z.coerce.number().min(0), cooldown: z.coerce.number().int().min(1).max(1440), feeThreshold: z.coerce.number().min(0), lower: z.coerce.number().positive().optional(), upper: z.coerce.number().positive().optional() }).refine(v => v.lower === undefined || v.upper === undefined || v.lower < v.upper, { message: 'The lower price must be below the upper price.' });
