/**
 * The Hono environment every gateway route shares.
 *
 * `Variables.install` is set by the `requireInstall` middleware once a bearer
 * token has been resolved to an installation, so a handler never has to touch
 * the Authorization header again. Nothing secret is ever put on the context:
 * the principal carries the installation id, its scopes and the token *hash*,
 * never the token.
 */
import type { Env } from './env.js';
import type { InstallPrincipal } from './tokens.js';

export interface AppEnv {
  Bindings: Env;
  Variables: {
    install: InstallPrincipal;
  };
}
