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
      RL_WEBHOOK?: RateLimit;
      RL_WS?: RateLimit;
      RL_UNPAIRED?: RateLimit;

      // Vars
      GATEWAY_ENV?: string;
      BOT_USERNAME?: string;

      // Secrets (wrangler secret put)
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_WEBHOOK_SECRET?: string;
      TOKEN_PEPPER?: string;
      ADMIN_TOKEN?: string;

      // Test only (vitest.config.ts); the shape of cloudflare:test's D1Migration.
      TEST_MIGRATIONS?: Array<{ name: string; queries: string[] }>;
    }

    interface GlobalProps {
      mainModule: typeof mainModule;
      durableNamespaces: 'Hub';
    }
  }
}
