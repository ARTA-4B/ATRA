import { z } from 'zod';
import { activityFixtures, marketFixtures } from './fixtures';
import { ageLabel, fetchLiveMarkets } from './live-market';
export const chains = ['Base', 'BNB Smart Chain', 'Robinhood Chain', 'Solana'] as const;
export type Chain = typeof chains[number];
const MarketSchema = z.object({ id: z.string(), symbol: z.string(), name: z.string(), chain: z.enum(chains), price: z.number().nullable(), change: z.number().nullable(), volume: z.number().nullable(), liquidity: z.number().nullable(), pool: z.string(), history: z.array(z.number()), source: z.enum(['dexscreener', 'fixture']).optional(), observedAt: z.number().optional(), dex: z.string().nullable().optional(), reason: z.string().nullable().optional() });
export type Market = z.infer<typeof MarketSchema>;
export type DataState = 'ready' | 'loading' | 'empty' | 'stale' | 'error';
export type Research = { observed: string; interpretation: string; risks: string; missing: string; action: 'NO ACTION' };
export interface MarketService { list(state?: DataState): Promise<Market[]>; research(market: Market): Promise<Research> }
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const marketService: MarketService = {
  // 'ready' is live data from DexScreener; the other states exist for the
  // preview selector and are deliberately simulated, with the fixtures
  // labelled as such by the UI.
  async list(state = 'ready') { if (state === 'ready') return z.array(MarketSchema).parse(await fetchLiveMarkets()); await delay(400); if (state === 'error') throw new Error('Market provider unavailable. Check your connection and try again.'); return state === 'empty' ? [] : z.array(MarketSchema).parse(marketFixtures.map(m => ({ ...m, source: 'fixture' as const }))); },
  async research(market) {
    await delay(750);
    const live = market.source === 'dexscreener' && market.price !== null;
    const observed = market.price === null
      ? `${market.symbol} on ${market.chain}. Price and liquidity are unavailable${market.reason ? ` (${market.reason})` : ''}.`
      : live
        ? `${market.symbol} on ${market.chain}. Price ${money(market.price)}, 24h change ${market.change === null ? 'unknown' : `${market.change >= 0 ? '+' : ''}${market.change.toFixed(2)}%`}, liquidity ${compactMoney(market.liquidity)}, 24h volume ${compactMoney(market.volume)} — DexScreener, ${market.pool}, ${market.observedAt ? ageLabel(market.observedAt) : 'just now'}.`
        : `${market.symbol} on ${market.chain}. The preview contains a static price and liquidity snapshot.`;
    return {
      observed,
      interpretation: 'No reasoning model is connected in this preview; the observation above is the data as the provider reported it, not an assessment.',
      risks: 'Price volatility, execution slippage, and liquidity changes are not modeled here. A pool figure is the deepest pool for the asset, not the whole market.',
      missing: live ? 'A second price provider for cross-checking, verified contract metadata, and a connected reasoning model.' : 'Live provider data, verified contract metadata, and a connected reasoning model.',
      action: 'NO ACTION',
    };
  },
};
export const RiskSchema = z.object({ trade: z.coerce.number().min(1).max(1000000), loss: z.coerce.number().min(1).max(1000000), capital: z.coerce.number().min(1).max(10000000), slippage: z.coerce.number().min(0.01).max(5), fee: z.coerce.number().min(0).max(1000), cooldown: z.coerce.number().int().min(1).max(1440), liquidity: z.coerce.number().min(1000), tokens: z.string(), protocols: z.string() }).refine(v => v.trade <= v.capital, { message: 'Maximum trade size cannot exceed maximum deployed capital.', path: ['trade'] });
export type RiskLimits = z.infer<typeof RiskSchema>;
export const defaultRisk: RiskLimits = { trade: 500, loss: 100, capital: 5000, slippage: 0.5, fee: 5, cooldown: 15, liquidity: 100000, tokens: 'ETH, SOL, BNB, USDC', protocols: '' };
const SettingsSchema = z.object({ name: z.string().trim().min(1).max(60), chains: z.array(z.enum(chains)).min(1), provider: z.enum(['hosted', 'custom']), endpoint: z.string().refine(v => !v || /^https?:\/\//.test(v), 'Use an HTTP or HTTPS URL.'), model: z.enum(['atra', 'local', 'external']), density: z.enum(['comfortable', 'compact']) });
export type Settings = z.infer<typeof SettingsSchema>;
export const defaultSettings: Settings = { name: 'Local installation', chains: [...chains], provider: 'custom', endpoint: '', model: 'atra', density: 'comfortable' };
function read<T>(key: string, schema: z.ZodType<T>, fallback: T): T { try { const parsed = schema.safeParse(JSON.parse(localStorage.getItem(key) || 'null')); return parsed.success ? parsed.data : fallback; } catch { return fallback; } }
export const riskService = { load: () => read('atra.risk', RiskSchema, defaultRisk), save: (value: RiskLimits) => { const parsed = RiskSchema.parse(value); localStorage.setItem('atra.risk', JSON.stringify(parsed)); return parsed; } };
export const settingsService = { load: () => read('atra.settings', SettingsSchema, defaultSettings), save: (value: Settings) => { const parsed = SettingsSchema.parse(value); localStorage.setItem('atra.settings', JSON.stringify(parsed)); return parsed; } };
const unavailable = async (): Promise<never> => { throw new Error('A local ATRA runtime is required. This frontend preview cannot perform this action.'); };
export interface WalletService { create(): Promise<never>; withdraw(): Promise<never>; export(): Promise<never>; status(): { connected: false; evmAddress: null; solanaAddress: null } }
export const walletService: WalletService = { create: unavailable, withdraw: unavailable, export: unavailable, status: () => ({ connected: false, evmAddress: null, solanaAddress: null }) };
export const agentService = { enableLive: unavailable, status: () => ({ source: 'demo' as const, mode: 'PAPER' as const, connected: false }) };
export const tradingService = { execute: unavailable };
export const liquidityService = { execute: unavailable };
export const telegramService = { pair: unavailable, unpair: unavailable, status: () => ({ paired: false, botUrl: null }) };
export const activityService = { list: () => activityFixtures };
export const money = (v: number | null, digits = 2) => v === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
export const compactMoney = (v: number | null) => v === null ? '—' : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 2 }).format(v);
