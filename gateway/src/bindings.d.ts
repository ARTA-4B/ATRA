// Ambient bindings for the Worker. Merged into `Cloudflare.Env`, which is what
// `env` from "cloudflare:workers" and the handler's second argument are typed
// as. Kept by hand (instead of `wrangler types`) so the file stays small and
// reviewable; keep it in sync with wrangler.jsonc.
import type { Hub } from './hub.js';
import type * as mainModule from './index.js';

declare global {
  namespace Cloudflare {
    interface Env {
      // Bindings (wrangler.jsonc)
      DB: D1Database;
      HUB: DurableObjectNamespace<Hub>;
      /** Market-data cache. Optional: the Cache API is used when unbound. */
      KV?: KVNamespace;
      /** Usage metering (dataset atra_usage). Optional: silently skipped when unbound. */
      AE?: AnalyticsEngineDataset;
      /**
       * Workers AI, optional and unbound by default. Typed by the one call the
       * gateway makes rather than by @cloudflare/workers-types' `Ai`, whose
       * `run` is keyed on a fixed model catalogue and cannot take a model name
       * that comes from configuration.
       */
      AI?: { run(model: string, inputs: Record<string, unknown>): Promise<unknown> };
      RL_WEBHOOK?: RateLimit;
      RL_WS?: RateLimit;
      RL_UNPAIRED?: RateLimit;
      /** Burst guard for the RPC, market and inference proxies. */
      RL_PROXY?: RateLimit;

      // Vars
      GATEWAY_ENV?: string;
      BOT_USERNAME?: string;
      /** Per-install, per-UTC-day quotas as decimal strings. See quota.ts for defaults. */
      QUOTA_RPC_PER_DAY?: string;
      QUOTA_MARKET_PER_DAY?: string;
      QUOTA_INFERENCE_PER_DAY?: string;
      QUOTA_WS_CONNECTS_PER_DAY?: string;

      // Secrets (wrangler secret put)
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_WEBHOOK_SECRET?: string;
      TOKEN_PEPPER?: string;
      ADMIN_TOKEN?: string;
      /** Keyed upstream JSON-RPC URLs. Unset means the chain's public endpoint. */
      RPC_URL_BASE?: string;
      RPC_URL_BSC?: string;
      RPC_URL_ROBINHOOD?: string;
      RPC_URL_SOLANA?: string;
      /** Optional OpenAI-compatible chat-completions URL for POST /v1/inference. */
      INFERENCE_URL?: string;
      INFERENCE_API_KEY?: string;
      /** Model name passed to the AI binding or the upstream. Required for either. */
      INFERENCE_MODEL?: string;

      // Test only (vitest.config.ts); the shape of cloudflare:test's D1Migration.
      TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
    }

    interface GlobalProps {
      mainModule: typeof mainModule;
      durableNamespaces: 'Hub';
    }
  }
}
