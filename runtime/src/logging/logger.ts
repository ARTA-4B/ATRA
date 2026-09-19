import pino from 'pino';
import type { Logger, LoggerOptions } from 'pino';
import { redact } from './redact.js';

export type { Logger };

export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

export interface LoggerConfig {
  level: LogLevel;
  /** Human-readable output for local development; JSON lines otherwise. */
  pretty: boolean;
}

/**
 * Keys pino redacts structurally, before our formatter runs. This is belt and
 * braces: {@link redact} already scrubs by key name, but pino's own redaction
 * also covers paths our formatter never visits (e.g. HTTP header objects).
 */
const PINO_REDACT_PATHS = [
  'password',
  'passphrase',
  'secret',
  'secretKey',
  'privateKey',
  'mnemonic',
  'seed',
  'apiKey',
  'token',
  'authorization',
  'cookie',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers.authorization',
  'headers.cookie',
  '*.password',
  '*.privateKey',
  '*.secretKey',
  '*.mnemonic',
];

let rootLogger: Logger | undefined;

export function createLogger(config: LoggerConfig): Logger {
  const options: LoggerOptions = {
    level: config.level,
    base: { service: 'atra-runtime' },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: PINO_REDACT_PATHS, censor: '[REDACTED]' },
    formatters: {
      level: (label) => ({ level: label }),
      // Every log object passes through our deep redactor, so a secret that
      // slips into a nested field still cannot reach the transport.
      log: (object) => redact(object) as Record<string, unknown>,
    },
  };

  if (config.pretty) {
    return pino({
      ...options,
      transport: {
        target: 'pino-pretty',
        options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
      },
    });
  }

  return pino(options);
}

/** Install the process-wide logger. Called once during bootstrap. */
export function setRootLogger(logger: Logger): void {
  rootLogger = logger;
}

/**
 * The process-wide logger.
 *
 * Falls back to a silent logger when bootstrap has not run yet, so importing a
 * module in a unit test never writes noise to stdout.
 */
export function getLogger(): Logger {
  rootLogger ??= pino({ level: 'silent' });
  return rootLogger;
}

/** A child logger tagged with a subsystem name, e.g. `vault` or `http`. */
export function childLogger(component: string, bindings: Record<string, unknown> = {}): Logger {
  return getLogger().child({ component, ...bindings });
}
