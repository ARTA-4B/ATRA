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

  /**
   * Telegram, transport A: the official ATRA gateway. The runtime dials out
   * to the gateway over WebSocket with the installation token; the project's
   * bot token stays on the gateway and never reaches an installation.
   */
  ATRA_GATEWAY_URL: z.url().optional(),
  ATRA_GATEWAY_TOKEN: z.string().min(1).max(512).optional(),

  /**
   * Telegram, transport B: the operator's own bot, long-polled directly. Used
   * only when no gateway URL is set. The token is read here, handed to the
   * transport, and never written to the database, a log line or a message.
   */
  ATRA_TELEGRAM_BOT_TOKEN: z.string().min(1).max(512).optional(),
  /** The bot's @username, for the dashboard's "open the bot" link. */
  ATRA_TELEGRAM_BOT_USERNAME: z
    .string()
    .regex(/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/, 'must be a Telegram bot username')
    .optional(),
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
  /**
   * Telegram transport selection. The tokens themselves are deliberately not
   * on this object: a config object gets logged and passed around, and the
   * secrets are read from the environment by {@link readTelegramSecrets} at
   * the one place that constructs the transport.
   */
  telegram: {
    transport: 'gateway' | 'direct' | 'none';
    gatewayUrl: string | undefined;
    gatewayTokenConfigured: boolean;
    botTokenConfigured: boolean;
    /** Without the leading @. */
    botUsername: string | undefined;
  };
}

export interface TelegramSecrets {
  gatewayToken: string | undefined;
  botToken: string | undefined;
}

/**
 * The Telegram secrets, read straight from the environment.
 *
 * Kept separate from {@link RuntimeConfig} so the config object can be logged
 * without a redaction step ever being the only thing between a token and a
 * log line. Called once, by the composition root, when the transport is built.
 */
export function readTelegramSecrets(env: NodeJS.ProcessEnv = process.env): TelegramSecrets {
  const gatewayToken = env['ATRA_GATEWAY_TOKEN']?.trim();
  const botToken = env['ATRA_TELEGRAM_BOT_TOKEN']?.trim();
  return {
    gatewayToken: gatewayToken ? gatewayToken : undefined,
    botToken: botToken ? botToken : undefined,
  };
}

function defaultDataDir(): string {
  const base =
    process.platform === 'win32'
      ? (process.env['LOCALAPPDATA'] ?? homedir())
      : (process.env['XDG_DATA_HOME'] ?? `${homedir()}/.local/share`);
  return resolve(base, 'atra');
}

/** Hostnames that cannot leave the machine, so cleartext is nobody else's to read. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function isLoopbackHost(hostname: string): boolean {
  // A WHATWG URL keeps IPv6 literals bracketed: http://[::1]:8787 → '[::1]'.
  return LOOPBACK_HOSTS.has(hostname.replace(/^\[|\]$/g, '').toLowerCase());
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

  // A gateway URL without its token can only produce a loop of refused
  // connections; fail at boot instead, where the operator is watching.
  if (raw.ATRA_GATEWAY_URL !== undefined && raw.ATRA_GATEWAY_TOKEN === undefined) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'Invalid environment configuration', {
      errors: [{ path: 'ATRA_GATEWAY_TOKEN', message: 'required when ATRA_GATEWAY_URL is set' }],
    });
  }
  if (raw.ATRA_GATEWAY_URL !== undefined) {
    const gateway = new URL(raw.ATRA_GATEWAY_URL);
    if (!/^(https?|wss?):$/.test(gateway.protocol)) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Invalid environment configuration', {
        errors: [{ path: 'ATRA_GATEWAY_URL', message: 'must be an http(s) or ws(s) URL' }],
      });
    }
    // The installation token travels in the upgrade request's Authorization
    // header, so an unencrypted hop off this machine hands it to the network.
    if (
      (gateway.protocol === 'http:' || gateway.protocol === 'ws:') &&
      !isLoopbackHost(gateway.hostname)
    ) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'Invalid environment configuration', {
        errors: [
          {
            path: 'ATRA_GATEWAY_URL',
            message: 'must use https or wss; plain http is allowed only for localhost',
          },
        ],
      });
    }
  }
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
    telegram: {
      // Gateway wins when both are configured: the official bot is the
      // supported path and the direct bot is the self-hosted fallback. CI mode
      // never opens a transport.
      transport:
        raw.ATRA_MODE === 'ci'
          ? 'none'
          : raw.ATRA_GATEWAY_URL !== undefined
            ? 'gateway'
            : raw.ATRA_TELEGRAM_BOT_TOKEN !== undefined
              ? 'direct'
              : 'none',
      gatewayUrl: raw.ATRA_GATEWAY_URL,
      gatewayTokenConfigured: raw.ATRA_GATEWAY_TOKEN !== undefined,
      botTokenConfigured: raw.ATRA_TELEGRAM_BOT_TOKEN !== undefined,
      botUsername: raw.ATRA_TELEGRAM_BOT_USERNAME?.replace(/^@/, ''),
    },
  };
}
