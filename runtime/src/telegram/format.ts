import { CHAINS, isNativeToken } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import { containsSecret, redactString } from '../logging/redact.js';

/**
 * Text helpers for Telegram replies and notifications.
 *
 * Everything sent to Telegram is plain text and goes through {@link finalize}
 * last, which caps the length and runs the same secret scrubber the logger
 * uses. The scrubber is the last line of defence, not the first: no reply
 * builder in this module ever reads a secret to begin with.
 */

export const MAX_REPLY_CHARS = 3_500;

/** `0x1234…abcd` / `EPjF…Dt1v`. Never the whole address. */
export function shortAddress(address: string): string {
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

/** A registry symbol when the token is known, else the shortened address. */
export function tokenLabel(chain: ChainId, token: string): string {
  if (isNativeToken(chain, token)) return CHAINS[chain].nativeSymbol;
  const entry = CHAINS[chain].tokens.find((candidate) => candidate.address === token);
  return entry?.symbol ?? shortAddress(token);
}

export function chainLabel(chain: ChainId): string {
  return CHAINS[chain].displayName;
}

/**
 * Render a decimal USD string with two decimals, by string manipulation only.
 * `null` renders as "unknown" — never as zero.
 */
export function fmtUsd(
  value: string | null | undefined,
  options: { signed?: boolean } = {},
): string {
  if (value === null || value === undefined) return 'unknown';
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(value.trim());
  if (!match) return 'unknown';
  const negative = match[1] === '-';
  const whole = match[2] ?? '0';
  const fraction = (match[3] ?? '').padEnd(2, '0').slice(0, 2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const sign = negative ? '-' : options.signed ? '+' : '';
  return `${sign}$${grouped}.${fraction}`;
}

/** Base units → a human amount, truncated to `places` decimals (default 6). */
export function fmtUnits(amount: string, decimals: number, places = 6): string {
  let raw: bigint;
  try {
    raw = BigInt(amount);
  } catch {
    return 'unknown';
  }
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fractionDigits = (abs % scale).toString().padStart(decimals, '0').slice(0, places);
  const fraction = fractionDigits.replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function fmtDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const days = Math.floor(total / 86_400);
  const hours = Math.floor((total % 86_400) / 3_600);
  const minutes = Math.floor((total % 3_600) / 60);
  if (days > 0) return `${String(days)}d ${String(hours)}h`;
  if (hours > 0) return `${String(hours)}h ${String(minutes)}m`;
  return `${String(minutes)}m`;
}

/** `2026-09-20 14:02 UTC` from an ISO timestamp; the raw value if it does not parse. */
export function fmtTime(iso: string | null): string {
  if (iso === null) return 'never';
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return iso;
  return `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

/** Percentage of `part` over `whole`, both decimal USD strings, as an integer. */
export function percentOf(part: string, whole: string): number | null {
  const toMicros = (value: string): bigint | null => {
    const match = /^(-?)(\d+)(?:\.(\d{0,6}))?/.exec(value);
    if (!match) return null;
    const micros = BigInt(match[2] ?? '0') * 1_000_000n + BigInt((match[3] ?? '').padEnd(6, '0'));
    return match[1] === '-' ? -micros : micros;
  };
  const a = toMicros(part);
  const b = toMicros(whole);
  if (a === null || b === null || b <= 0n) return null;
  return Number((a * 100n) / b);
}

/**
 * The last step before text leaves the runtime: cap the length and scrub
 * anything that looks like key material. A reply that had to be scrubbed is
 * a bug upstream; it is still better sent scrubbed than sent intact.
 */
export function finalize(text: string, max = MAX_REPLY_CHARS): string {
  const scrubbed = containsSecret(text) ? redactString(text) : text;
  if (scrubbed.length <= max) return scrubbed;
  return `${scrubbed.slice(0, max - 1)}…`;
}
