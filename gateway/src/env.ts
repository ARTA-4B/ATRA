/** The Worker's bindings, vars and secrets. See bindings.d.ts and wrangler.jsonc. */
export type Env = Cloudflare.Env;

export const GATEWAY_VERSION = '0.1.0';

/** The four chains the gateway proxies, and nothing else. Same ids as the runtime. */
export const CHAIN_IDS = ['base', 'bsc', 'robinhood', 'solana'] as const;
export type ChainId = (typeof CHAIN_IDS)[number];

export function isChainId(value: string): value is ChainId {
  return (CHAIN_IDS as readonly string[]).includes(value);
}
