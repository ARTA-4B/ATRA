import type { Session } from '../core/auth.js';
import type { Services } from '../core/services.js';

/**
 * The Hono environment: what every handler can read off the context.
 *
 * `services` is the composition root, attached once at startup, so handlers
 * never reach for a module-level singleton and tests can build a server with
 * an in-memory database and mock adapters.
 */
export interface AppEnv {
  Variables: {
    requestId: string;
    services: Services;
    session?: Session;
    mode?: 'PAPER' | 'LIVE' | 'NONE';
  };
  Bindings: {
    incoming?: { socket?: { remoteAddress?: string } };
  };
}
