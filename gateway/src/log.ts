/* eslint-disable no-console */
/**
 * Structured logging for Workers Logs.
 *
 * One JSON object per line. Keys that could carry a secret are dropped before
 * anything is written, so a careless call site cannot leak a token, a bot
 * token or a pair code into the account's log retention.
 */

const SECRET_KEY = /^(token|secret|pepper|password|authorization|code|codehash|code_hash)$/i;

type Level = 'info' | 'warn' | 'error';

function scrub(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    out[key] = SECRET_KEY.test(key) ? '[REDACTED]' : value;
  }
  return out;
}

function write(level: Level, component: string, message: string, fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, component, message, ...scrub(fields), at: Date.now() });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export function logger(component: string): Logger {
  return {
    info: (message, fields = {}) => write('info', component, message, fields),
    warn: (message, fields = {}) => write('warn', component, message, fields),
    error: (message, fields = {}) => write('error', component, message, fields),
  };
}

/** Render an unknown thrown value for a log line without leaking a stack. */
export function errorSummary(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}
