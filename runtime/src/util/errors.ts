/**
 * Error taxonomy for the ATRA runtime.
 *
 * Every failure that can reach an API boundary carries a stable machine-readable
 * `code`. Codes are part of the dashboard contract and must not be renamed
 * without updating docs/specs/dashboard-api-contract.md.
 */

export const ErrorCode = {
  // Auth / session
  SETUP_REQUIRED: 'SETUP_REQUIRED',
  ALREADY_INITIALIZED: 'ALREADY_INITIALIZED',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  REAUTH_REQUIRED: 'REAUTH_REQUIRED',
  REAUTH_INVALID: 'REAUTH_INVALID',
  FORBIDDEN_ORIGIN: 'FORBIDDEN_ORIGIN',
  LOOPBACK_ONLY: 'LOOPBACK_ONLY',
  RATE_LIMITED: 'RATE_LIMITED',

  // Vault
  VAULT_LOCKED: 'VAULT_LOCKED',
  VAULT_NOT_FOUND: 'VAULT_NOT_FOUND',
  VAULT_ALREADY_EXISTS: 'VAULT_ALREADY_EXISTS',
  VAULT_CORRUPT: 'VAULT_CORRUPT',

  // Input
  SCHEMA_INVALID: 'SCHEMA_INVALID',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',

  // Execution / mode
  MODE_PAPER_ONLY: 'MODE_PAPER_ONLY',
  LIVE_ACTIVATION_INCOMPLETE: 'LIVE_ACTIVATION_INCOMPLETE',
  ADAPTER_UNAVAILABLE: 'ADAPTER_UNAVAILABLE',
  CHAIN_UNSUPPORTED: 'CHAIN_UNSUPPORTED',

  // Upstream
  UPSTREAM_UNAVAILABLE: 'UPSTREAM_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  DATA_STALE: 'DATA_STALE',

  // Generic
  INTERNAL: 'INTERNAL',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface FieldIssue {
  path: string;
  message: string;
}

export interface AppErrorOptions {
  status?: number;
  errors?: FieldIssue[];
  retryAfterSec?: number;
  cause?: unknown;
  /** Extra context for logs only. Never serialized into API responses. */
  details?: Record<string, unknown>;
}

/**
 * An error that is safe to surface to the local dashboard: the message is
 * written for a human operator and never contains secret material.
 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly errors: FieldIssue[] | undefined;
  readonly retryAfterSec: number | undefined;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message: string, options: AppErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? defaultStatusFor(code);
    this.errors = options.errors;
    this.retryAfterSec = options.retryAfterSec;
    this.details = options.details;
  }
}

function defaultStatusFor(code: ErrorCode): number {
  switch (code) {
    case ErrorCode.SETUP_REQUIRED:
    case ErrorCode.UNAUTHENTICATED:
    case ErrorCode.INVALID_CREDENTIALS:
    case ErrorCode.VAULT_LOCKED:
      return 401;
    case ErrorCode.REAUTH_REQUIRED:
    case ErrorCode.REAUTH_INVALID:
    case ErrorCode.FORBIDDEN_ORIGIN:
    case ErrorCode.LOOPBACK_ONLY:
    case ErrorCode.MODE_PAPER_ONLY:
    case ErrorCode.LIVE_ACTIVATION_INCOMPLETE:
      return 403;
    case ErrorCode.NOT_FOUND:
    case ErrorCode.VAULT_NOT_FOUND:
      return 404;
    case ErrorCode.CONFLICT:
    case ErrorCode.ALREADY_INITIALIZED:
    case ErrorCode.VAULT_ALREADY_EXISTS:
      return 409;
    case ErrorCode.SCHEMA_INVALID:
      return 422;
    case ErrorCode.RATE_LIMITED:
      return 429;
    case ErrorCode.UPSTREAM_UNAVAILABLE:
    case ErrorCode.ADAPTER_UNAVAILABLE:
    case ErrorCode.CHAIN_UNSUPPORTED:
      return 503;
    case ErrorCode.UPSTREAM_TIMEOUT:
      return 504;
    case ErrorCode.DATA_STALE:
    case ErrorCode.VAULT_CORRUPT:
    case ErrorCode.INTERNAL:
      return 500;
    default:
      return 500;
  }
}

export function isAppError(value: unknown): value is AppError {
  return value instanceof AppError;
}

/** Narrow an unknown thrown value to a message without leaking object internals. */
export function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === 'string') return value;
  return 'unknown error';
}
