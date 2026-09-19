import { homedir } from 'node:os';
import { resolve, isAbsolute } from 'node:path';
import { z } from 'zod';
import { AppError, ErrorCode } from '../util/errors.js';
import type { FieldIssue } from '../util/errors.js';
import type { LogLevel } from '../logging/logger.js';

/**
 * Runtime configuration.
 *
 * Everything is optional except the data directory, which has a safe default.
 * The runtime must boot with an empty environment (that is what `ATRA_MODE=ci`
 * exercises in CI) so a fresh `docker compose up` always reaches a health
 * check, and the operator completes setup from the dashboard afterwards.
 *
 * No secret is ever read from a build-time constant. Provider API keys are
 * supplied by the operator at runtime and stored encrypted.
 */

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;

const booleanish = z
  .enum(['1', '0', 'true', 'false', 'yes', 'no', 'on', 'off'])
  .transform((v) => v === '1' || v === 'true' || v === 'yes' || v === 'on');

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),

  /**
   * `ci` boots the runtime with no providers, no scheduler and no LLM so that a
   * container smoke test can verify /health without any credential.
   */
  ATRA_MODE: z.enum(['normal', 'ci']).default('normal'),

  ATRA_HOST: z.string().min(1).default('127.0.0.1'),
  ATRA_PORT: z.coerce.number().int().min(1).max(65535).default(3000),

  /** Where the SQLite database, vault file and backups live. */
  ATRA_DATA_DIR: z.string().min(1).optional(),

  /** Directory of the built frontend to serve at `/`. Optional. */
  ATRA_STATIC_DIR: z.string().min(1).optional(),

  ATRA_LOG_LEVEL: z.enum(LOG_LEVELS).optional(),
  ATRA_LOG_PRETTY: booleanish.optional(),

  /**
   * Extra hostnames accepted in the Host header, comma separated. Loopback
   * names are always accepted; anything else is rejected to blunt DNS
   * rebinding against a wallet-bearing service.
   */
  ATRA_HOST_ALLOWLIST: z.string().optional(),

  /** Opt-in CORS origins. Empty means same-origin only. */
  ATRA_CORS_ORIGINS: z.string().optional(),

  /**
   * Client addresses treated as "this machine" for setup and key export, as a
   * comma-separated list of IPs or CIDRs. Defaults to loopback. Inside a
   * container the operator's requests arrive from the bridge gateway rather
   * than 127.0.0.1, so compose sets this to the private ranges.
   */
  ATRA_LOCAL_CLIENTS: z.string().optional(),

  /** Idle minutes before the vault key is dropped from memory. */
  ATRA_AUTOLOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),

  /** Optional BYOK RPC overrides. Never required: public RPC is the default. */
  ATRA_RPC_BASE: z.url().optional(),
  ATRA_RPC_BSC: z.url().optional(),
  ATRA_RPC_ROBINHOOD: z.url().optional(),
  ATRA_RPC_SOLANA: z.url().optional(),

  /** Optional LLM endpoint. Defaults to a local Ollama probe. */
  ATRA_LLM_KIND: z.enum(['none', 'ollama', 'openai-compatible']).optional(),
  ATRA_LLM_URL: z.url().optional(),
  ATRA_LLM_MODEL: z.string().min(1).optional(),
  /** Name of the environment variable holding the LLM key, never the key. */
  ATRA_LLM_API_KEY_ENV: z.string().min(1).optional(),
});

export type RawEnv = z.infer<typeof envSchema>;

export interface RuntimeConfig {
  nodeEnv: 'development' | 'test' | 'production';
  mode: 'normal' | 'ci';
  isCi: boolean;
  host: string;
  port: number;
  dataDir: string;
  staticDir: string | undefined;
  log: { level: LogLevel; pretty: boolean };
  hostAllowlist: string[];
  corsOrigins: string[];
  localClients: string[];
  autolockMs: number;
  rpcOverrides: {
    base: string | undefined;
    bsc: string | undefined;
    robinhood: string | undefined;
    solana: string | undefined;
  };
  llm: {
    kind: 'none' | 'ollama' | 'openai-compatible';
    url: string | undefined;
    model: string | undefined;
    apiKeyEnv: string | undefined;
  };
}

function defaultDataDir(): string {
  const base =
    process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? homedir())
      : (process.env['XDG_DATA_HOME'] ?? `${homedir()}/.local/share`);
  return resolve(base, 'atra');
}

function splitList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

/**
 * Parse and validate `process.env`.
 *
 * Throws an {@link AppError} listing every offending variable rather than
 * failing on the first one, so an operator fixes their .env in one pass.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const errors: FieldIssue[] = parsed.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Invalid environment configuration', { errors });
  }

  const raw = parsed.data;
  const isProd = raw.NODE_ENV === 'production';
  const dataDir = raw.ATRA_DATA_DIR
    ? isAbsolute(raw.ATRA_DATA_DIR)
      ? raw.ATRA_DATA_DIR
      : resolve(process.cwd(), raw.ATRA_DATA_DIR)
    : defaultDataDir();

  return {
    nodeEnv: raw.NODE_ENV,
    mode: raw.ATRA_MODE,
    isCi: raw.ATRA_MODE === 'ci',
    host: raw.ATRA_HOST,
    port: raw.ATRA_PORT,
    dataDir,
    staticDir: raw.ATRA_STATIC_DIR ? resolve(raw.ATRA_STATIC_DIR) : undefined,
    log: {
      level: raw.ATRA_LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
      pretty: raw.ATRA_LOG_PRETTY ?? !isProd,
    },
    hostAllowlist: splitList(raw.ATRA_HOST_ALLOWLIST),
    corsOrigins: splitList(raw.ATRA_CORS_ORIGINS),
    localClients: raw.ATRA_LOCAL_CLIENTS
      ? splitList(raw.ATRA_LOCAL_CLIENTS)
      : ['127.0.0.0/8', '::1'],
    autolockMs: raw.ATRA_AUTOLOCK_MINUTES * 60_000,
    rpcOverrides: {
      base: raw.ATRA_RPC_BASE,
      bsc: raw.ATRA_RPC_BSC,
      robinhood: raw.ATRA_RPC_ROBINHOOD,
      solana: raw.ATRA_RPC_SOLANA,
    },
    llm: {
      kind: raw.ATRA_LLM_KIND ?? (raw.ATRA_MODE === 'ci' ? 'none' : 'ollama'),
      url: raw.ATRA_LLM_URL,
      model: raw.ATRA_LLM_MODEL,
      apiKeyEnv: raw.ATRA_LLM_API_KEY_ENV,
    },
  };
}
