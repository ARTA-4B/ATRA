import { randomUUID } from 'node:crypto';
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie } from 'hono/cookie';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import type { AppEnv } from './context.js';

/**
 * HTTP middleware.
 *
 * ATRA listens on loopback and holds wallet keys, which makes it a textbook
 * target for DNS rebinding: a page the operator visits resolves an attacker's
 * hostname to 127.0.0.1 and then speaks to this server with the operator's
 * cookies. The defences are layered because each one alone has a known gap:
 *
 *  - Host header allowlist (rebinding sends an attacker hostname)
 *  - Origin / Sec-Fetch-Site checks on state-changing requests
 *  - a custom header that a simple cross-origin form cannot set
 *  - SameSite=Strict on the session cookie
 */

export const SESSION_COOKIE = 'atra_session';
export const CLIENT_HEADER = 'x-atra-client';
export const REAUTH_HEADER = 'x-atra-reauth';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export function requestContext(): MiddlewareHandler<AppEnv> {
  const log = childLogger('http');

  return async (c, next) => {
    const requestId = randomUUID();
    c.set('requestId', requestId);
    c.header('x-request-id', requestId);

    const started = Date.now();
    await next();

    log.debug(
      {
        requestId,
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Date.now() - started,
      },
      'request',
    );
  };
}

/** Reject requests whose Host header is not a loopback name we recognise. */
export function hostGuard(allowlist: string[]): MiddlewareHandler<AppEnv> {
  const allowed = new Set([...LOOPBACK_HOSTS, ...allowlist.map((h) => h.toLowerCase())]);

  return async (c, next) => {
    const host = c.req.header('host') ?? '';
    const name = stripPort(host).toLowerCase();

    if (!allowed.has(name)) {
      throw new AppError(
        ErrorCode.FORBIDDEN_ORIGIN,
        'This request was addressed to a hostname ATRA does not serve',
        { details: { host } },
      );
    }

    await next();
  };
}

/**
 * Require an explicit client header and a same-origin signal on writes.
 *
 * A cross-origin HTML form can issue a POST but cannot set a custom header, so
 * requiring one blocks the classic CSRF shape without a token round-trip.
 */
export function csrfGuard(corsOrigins: string[]): MiddlewareHandler<AppEnv> {
  const allowedOrigins = new Set(corsOrigins);

  return async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD' || c.req.method === 'OPTIONS') {
      await next();
      return;
    }

    if (c.req.header(CLIENT_HEADER) !== 'atra-dashboard') {
      throw new AppError(
        ErrorCode.FORBIDDEN_ORIGIN,
        'This request is missing the ATRA dashboard header',
      );
    }

    const origin = c.req.header('origin');
    const site = c.req.header('sec-fetch-site');

    if (site && site !== 'same-origin' && site !== 'none') {
      throw new AppError(ErrorCode.FORBIDDEN_ORIGIN, 'Cross-site requests are refused');
    }

    if (origin && !allowedOrigins.has(origin)) {
      const host = stripPort(c.req.header('host') ?? '').toLowerCase();
      const originHost = stripPort(safeHostname(origin)).toLowerCase();
      if (originHost !== host) {
        throw new AppError(ErrorCode.FORBIDDEN_ORIGIN, 'Cross-origin requests are refused', {
          details: { origin },
        });
      }
    }

    await next();
  };
}

/**
 * Restrict a route to callers on the machine itself.
 *
 * Used for setup and export: even if an operator deliberately exposes the
 * dashboard to their LAN, the paths that create or reveal key material stay
 * local.
 */
export function loopbackOnly(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const address = remoteAddress(c);
    if (address && !isLoopbackAddress(address)) {
      throw new AppError(
        ErrorCode.LOOPBACK_ONLY,
        'This action can only be performed from the machine running ATRA',
        { details: { remote: address } },
      );
    }
    await next();
  };
}

/** Resolve the session cookie; 401 when it is missing or expired. */
export function requireSession(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const services = c.get('services');
    const token = getCookie(c, SESSION_COOKIE);
    const session = services.auth.resolveSession(token);

    if (!session) {
      throw new AppError(ErrorCode.UNAUTHENTICATED, 'Sign in to continue');
    }

    // The vault holds the key that decrypts wallet secrets. A session whose
    // vault has auto-locked is still a valid session, but anything touching a
    // secret will ask for the password again.
    c.set('session', session);
    await next();
  };
}

/** Conservative headers for a locally served dashboard. */
export function securityHeaders(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    await next();
    c.header('x-content-type-options', 'nosniff');
    c.header('referrer-policy', 'no-referrer');
    c.header('x-frame-options', 'DENY');
    c.header('cross-origin-opener-policy', 'same-origin');
    c.header('permissions-policy', 'geolocation=(), microphone=(), camera=()');
    if (c.req.path.startsWith('/api/')) {
      c.header('cache-control', 'no-store');
    }
  };
}

function stripPort(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function safeHostname(origin: string): string {
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

function isLoopbackAddress(address: string): boolean {
  const clean = address.replace(/^::ffff:/, '');
  return clean === '127.0.0.1' || clean === '::1' || clean.startsWith('127.');
}

function remoteAddress(c: Context<AppEnv>): string | undefined {
  const info = c.env?.incoming?.socket?.remoteAddress;
  return typeof info === 'string' ? info : undefined;
}
