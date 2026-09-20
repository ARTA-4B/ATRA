/**
 * RFC 9457 problem documents.
 *
 * The runtime's HTTP layer answers errors the same way (see
 * runtime/src/http/respond.ts), so an operator reading a gateway failure and a
 * runtime failure reads the same fields: a stable machine `code`, a human
 * `detail`, and whatever extra members the code implies (a quota's limit and
 * reset, a refused JSON-RPC method's name).
 *
 * The Phase 4 routes (webhook, /v1/ws, the admin mint) answer
 * `{ "error": "..." }` and keep doing so; the Phase 5 proxy, quota and admin
 * routes use problem documents. Nothing in a problem document may come from an
 * upstream response body or a secret: `detail` is always a string this file or
 * its caller wrote.
 */

export interface ProblemInit {
  status: number;
  /** Stable machine-readable code, lower_snake_case. */
  code: string;
  title: string;
  detail: string;
  /** Extra top-level members, e.g. `limit`, `resetAt`, `method`. */
  extra?: Record<string, unknown>;
  headers?: Record<string, string>;
}

export interface ProblemDocument extends Record<string, unknown> {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
}

export function problemDocument(init: ProblemInit): ProblemDocument {
  return {
    type: `https://atra.local/errors/${init.code}`,
    title: init.title,
    status: init.status,
    detail: init.detail,
    code: init.code,
    ...(init.extra ?? {}),
  };
}

/** Build the response. Hono's `c.json` cannot set problem+json, so this does. */
export function problem(init: ProblemInit): Response {
  return new Response(JSON.stringify(problemDocument(init)), {
    status: init.status,
    headers: {
      'content-type': 'application/problem+json; charset=utf-8',
      ...(init.headers ?? {}),
    },
  });
}

export function unauthorized(detail = 'a valid installation token is required'): Response {
  return problem({
    status: 401,
    code: 'unauthorized',
    title: 'Unauthorized',
    detail,
    headers: { 'www-authenticate': 'Bearer' },
  });
}

export function forbidden(code: string, detail: string, extra?: Record<string, unknown>): Response {
  return problem({
    status: 403,
    code,
    title: 'Forbidden',
    detail,
    ...(extra === undefined ? {} : { extra }),
  });
}

export function badRequest(
  code: string,
  detail: string,
  extra?: Record<string, unknown>,
): Response {
  return problem({
    status: 400,
    code,
    title: 'Bad request',
    detail,
    ...(extra === undefined ? {} : { extra }),
  });
}

export function notFound(code: string, detail: string, extra?: Record<string, unknown>): Response {
  return problem({
    status: 404,
    code,
    title: 'Not found',
    detail,
    ...(extra === undefined ? {} : { extra }),
  });
}

/** The burst limiter (Workers rate limiting binding) said no. */
export function rateLimited(retryAfterSeconds: number): Response {
  return problem({
    status: 429,
    code: 'rate_limited',
    title: 'Too many requests',
    detail: `too many requests in a short window; retry after ${retryAfterSeconds} s`,
    extra: { retryAfterSeconds },
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}

/** 502 for an upstream that failed; the upstream is named by role, never by URL. */
export function badGateway(
  code: string,
  detail: string,
  extra?: Record<string, unknown>,
): Response {
  return problem({
    status: 502,
    code,
    title: 'Bad gateway',
    detail,
    ...(extra === undefined ? {} : { extra }),
  });
}

/** 503 with Retry-After: the upstream is rate limiting us, so the caller should wait. */
export function upstreamBusy(
  code: string,
  detail: string,
  retryAfterSeconds: number,
  extra?: Record<string, unknown>,
): Response {
  return problem({
    status: 503,
    code,
    title: 'Service unavailable',
    detail,
    extra: { retryAfterSeconds, ...(extra ?? {}) },
    headers: { 'retry-after': String(retryAfterSeconds) },
  });
}

export function notImplemented(code: string, detail: string): Response {
  return problem({ status: 501, code, title: 'Not implemented', detail });
}

export function serviceUnavailable(code: string, detail: string): Response {
  return problem({ status: 503, code, title: 'Service unavailable', detail });
}
