/**
 * Authentication middleware for the Phase 5 routes.
 *
 * `requireInstall(scope)` resolves `Authorization: Bearer atra_…` to an
 * installation through D1 (revoked and expired tokens fail here, which is
 * what makes revocation take effect on the next call) and checks the scope.
 * `requireAdmin` compares the bearer with ADMIN_TOKEN in constant time.
 *
 * Both answer with problem documents. The Phase 4 routes in index.ts keep
 * their own inline checks and `{ error }` bodies; they are covered by tests
 * that pin that shape, and nothing is gained by changing it.
 */
import type { MiddlewareHandler } from 'hono';
import type { AppEnv } from './context.js';
import { timingSafeEqualStrings } from './crypto.js';
import { logger } from './log.js';
import { forbidden, serviceUnavailable, unauthorized } from './problem.js';
import { authenticateInstallToken, bearerToken } from './tokens.js';

const log = logger('auth');

export const SCOPES = ['telegram', 'rpc', 'market', 'inference'] as const;
export type Scope = (typeof SCOPES)[number];

export function requireInstall(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const pepper = c.env.TOKEN_PEPPER;
    if (!pepper) {
      log.error('TOKEN_PEPPER is not configured');
      return serviceUnavailable('not_configured', 'the gateway is not configured');
    }
    const token = bearerToken(c.req.header('authorization'));
    if (!token) return unauthorized();
    const principal = await authenticateInstallToken(c.env.DB, pepper, token);
    if (!principal) return unauthorized('the installation token is unknown, expired or revoked');
    if (!principal.scopes.includes(scope)) {
      return forbidden('scope_missing', `this token does not carry the "${scope}" scope`, {
        scope,
      });
    }
    c.set('install', principal);
    return next();
  };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  const adminToken = c.env.ADMIN_TOKEN;
  if (!adminToken) {
    log.error('ADMIN_TOKEN is not configured');
    return serviceUnavailable('not_configured', 'the admin endpoints are not configured');
  }
  const presented = bearerToken(c.req.header('authorization'));
  if (!presented || !(await timingSafeEqualStrings(presented, adminToken))) {
    return unauthorized('a valid admin token is required');
  }
  return next();
};
