import type { Context } from 'hono';
import type { AppEnv } from './context.js';
import { AppError, ErrorCode, isAppError } from '../util/errors.js';
import type { FieldIssue } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';

/**
 * The response envelope.
 *
 * Every successful body is `{ data, meta }`. `meta` carries the provenance the
 * dashboard needs to be honest with the operator: where a value came from, when
 * it was observed, and whether it is stale. A field ATRA does not know is
 * `null` with `source: 'none'` and a machine-readable reason — never a
 * plausible-looking placeholder. A fabricated price is worse than a blank one,
 * because the operator cannot tell it apart from a real one.
 *
 * Errors are RFC 9457 problem documents with a stable `code`.
 */

export type DataSource = 'rpc' | 'provider' | 'local' | 'cache' | 'none';

export interface ResponseMeta {
  source: DataSource;
  /** When the underlying data was observed, not when the response was built. */
  asOf: string | null;
  stale: boolean;
  mode: 'PAPER' | 'LIVE' | 'NONE';
  requestId: string;
  reason?: string;
  nextCursor?: string | number | null;
}

export interface Envelope<T> {
  data: T;
  meta: ResponseMeta;
}

export interface MetaOptions {
  source?: DataSource;
  asOf?: string | null;
  stale?: boolean;
  mode?: 'PAPER' | 'LIVE' | 'NONE';
  reason?: string;
  nextCursor?: string | number | null;
}

const log = childLogger('http');

export function envelope<T>(c: Context<AppEnv>, data: T, options: MetaOptions = {}): Envelope<T> {
  const mode: ResponseMeta['mode'] = options.mode ?? c.get('mode') ?? 'NONE';
  const requestId: string = c.get('requestId') ?? 'unknown';

  const meta: ResponseMeta = {
    source: options.source ?? 'local',
    asOf: options.asOf ?? null,
    stale: options.stale ?? false,
    mode,
    requestId,
  };
  if (options.reason !== undefined) meta.reason = options.reason;
  if (options.nextCursor !== undefined) meta.nextCursor = options.nextCursor;

  return { data, meta };
}

export interface ProblemDocument {
  type: string;
  title: string;
  status: number;
  detail: string;
  code: string;
  requestId: string;
  errors?: FieldIssue[];
  retryAfterSec?: number;
}

/**
 * Turn any thrown value into a problem document.
 *
 * An unexpected error becomes a generic INTERNAL problem: the operator gets a
 * request id to correlate with the log, and nothing about the runtime's
 * internals leaks into the response body.
 */
export function toProblem(error: unknown, requestId: string): ProblemDocument {
  if (isAppError(error)) {
    const problem: ProblemDocument = {
      type: `https://atra.local/errors/${error.code.toLowerCase()}`,
      title: titleFor(error.code),
      status: error.status,
      detail: error.message,
      code: error.code,
      requestId,
    };
    if (error.errors) problem.errors = error.errors;
    if (error.retryAfterSec !== undefined) problem.retryAfterSec = error.retryAfterSec;
    return problem;
  }

  log.error({ err: error, requestId }, 'unhandled error');
  return {
    type: 'https://atra.local/errors/internal',
    title: 'Internal error',
    status: 500,
    detail: 'The runtime hit an unexpected error. Check the logs for the request id.',
    code: ErrorCode.INTERNAL,
    requestId,
  };
}

function titleFor(code: string): string {
  return code
    .toLowerCase()
    .split('_')
    .map((word, index) => (index === 0 ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Throw a schema error carrying zod-style issues the dashboard can render. */
export function invalid(message: string, errors: FieldIssue[]): AppError {
  return new AppError(ErrorCode.SCHEMA_INVALID, message, { errors });
}
