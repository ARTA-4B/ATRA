/**
 * Secret redaction.
 *
 * ATRA must never write key material to disk, stdout, an audit row, a Telegram
 * message or an LLM prompt. Redaction here is the last line of defence: the
 * primary rule is that secrets never enter a loggable object in the first
 * place. Both layers are covered by tests.
 */

export const REDACTED = '[REDACTED]';

/** Object keys whose value is always replaced, regardless of shape. */
const SECRET_KEY_PATTERN =
  /^(pass(word|phrase)?|secret|secretkey|privatekey|private_key|priv|mnemonic|seed|seedphrase|apikey|api_key|token|accesstoken|access_token|refreshtoken|refresh_token|sessiontoken|session_token|authorization|auth|cookie|signature|keystore|dek|kek|entropy|pepper)$/i;

interface ValuePattern {
  name: string;
  re: RegExp;
  /** The replacement; the whole match becomes {@link REDACTED} when absent. */
  replace?: (...match: string[]) => string;
  /**
   * True for the patterns that also match public chain identifiers, so a
   * caller can exempt a field that is known to hold one.
   */
  hashShaped?: boolean;
}

/**
 * A URL whose path, query or userinfo could carry a credential. RPC and LLM
 * providers put the API key in the path (`/v2/<key>`) or the query, and the
 * `user:pass@` form is a credential by definition. A bare origin is left
 * alone: the host is what an operator needs to recognise the endpoint.
 *
 * Group 1 is the scheme, group 2 or 3 the host (with userinfo, or without).
 */
const URL_WITH_SECRET_RE =
  /\b(https?|wss?):\/\/(?:[^\s/?#@]*@([^\s/?#@]+)(?:[/?#][^\s]*)?|([^\s/?#@]+)(?:\/[^\s]+|[?#][^\s]*))/gi;

/**
 * Value patterns scrubbed from free-form strings.
 *
 * Ordered most specific first. Each pattern is deliberately conservative: it is
 * better to leave a low-entropy string readable than to redact so much that
 * logs stop being useful, but anything that could be key material goes.
 */
const VALUE_PATTERNS: ValuePattern[] = [
  // 0x-prefixed 32-byte hex: an EVM private key. Transaction hashes have the
  // same shape and are public, so callers log those through a dedicated field
  // (see HASH_KEYS) rather than as free text.
  { name: 'hex32', re: /\b0x[0-9a-fA-F]{64}\b/g, hashShaped: true },
  // Bare 32-byte hex.
  { name: 'hex32-bare', re: /\b[0-9a-fA-F]{64}\b/g, hashShaped: true },
  // Base58 encoding of a 64-byte Solana secret key. A Solana transaction
  // signature has the same shape.
  { name: 'base58-64', re: /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g, hashShaped: true },
  // Solana CLI id.json: a JSON array of 64 byte values.
  { name: 'id-json', re: /\[\s*(?:\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/g },
  // BIP-39 style phrase: 12 or 24 lowercase words in a row.
  { name: 'mnemonic', re: /\b(?:[a-z]{3,8}\s+){11}[a-z]{3,8}(?:(?:\s+[a-z]{3,8}){12})?\b/g },
  // Telegram bot token.
  { name: 'tg-token', re: /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g },
  // Common API key prefixes.
  { name: 'api-key', re: /\b(?:sk|pk|rk|api|key)[-_][A-Za-z0-9_-]{16,}\b/gi },
  // A URL with userinfo, a path beyond "/" or a query: reduced to its origin.
  // Last, so a key already caught above inside a URL costs nothing extra.
  {
    name: 'url',
    re: URL_WITH_SECRET_RE,
    replace: (_match, scheme = '', hostWithAuth, hostBare) =>
      `${scheme.toLowerCase()}://${hostWithAuth ?? hostBare ?? ''}/${REDACTED}`,
  },
];

/**
 * Object keys that hold a public chain identifier with the same shape as key
 * material: a transaction hash (0x + 64 hex, or base58 on Solana), a block
 * hash, or a Solana transaction signature. Values under these keys skip the
 * hash-shaped value patterns only. The key-name rule still applies first,
 * so `signature` — which SECRET_KEY_PATTERN lists because the same word
 * names a signature over a message — is still replaced wholesale; it is in
 * this list so that the exemption reads as a complete statement of intent
 * should the key rule ever be narrowed.
 */
const HASH_KEYS = new Set(['txHash', 'hash', 'signature', 'blockHash']);

function scrub(input: string, patterns: ValuePattern[]): string {
  let out = input;
  for (const { re, replace } of patterns) {
    re.lastIndex = 0;
    out = replace ? out.replace(re, replace) : out.replace(re, REDACTED);
  }
  return out;
}

const NON_HASH_PATTERNS = VALUE_PATTERNS.filter((pattern) => !pattern.hashShaped);

/** Replace secret-looking substrings inside a single string. */
export function redactString(input: string): string {
  return scrub(input, VALUE_PATTERNS);
}

/**
 * Scrub a value that is known to hold a public chain identifier: everything
 * except the patterns that a transaction hash or signature shares with key
 * material. A URL or an API key inside such a field is still removed.
 */
function redactHashValue(input: string): string {
  return scrub(input, NON_HASH_PATTERNS);
}

/** True when the string contains something that looks like key material. */
export function containsSecret(input: string): boolean {
  return VALUE_PATTERNS.some(({ re }) => {
    re.lastIndex = 0;
    return re.test(input);
  });
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERN.test(key);
}

const MAX_DEPTH = 8;

/**
 * Deep-redact an arbitrary value for logging.
 *
 * - keys matching the secret-key pattern are replaced wholesale
 * - strings are scrubbed for secret-looking values
 * - Uint8Array / Buffer are never rendered (they may hold raw key bytes)
 * - cycles and excessive depth are cut off rather than throwing
 */
export function redact<T>(value: T): unknown {
  return redactValue(value, 0, new WeakSet<object>());
}

function redactValue(value: unknown, depth: number, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactString(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'function') return '[Function]';
  if (typeof value === 'symbol') return value.toString();

  if (ArrayBuffer.isView(value)) {
    return `[bytes:${value.byteLength}]`;
  }
  if (value instanceof ArrayBuffer) {
    return `[bytes:${value.byteLength}]`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }

  if (depth >= MAX_DEPTH) return '[MaxDepth]';

  if (typeof value === 'object') {
    if (seen.has(value)) return '[Circular]';
    seen.add(value);

    if (Array.isArray(value)) {
      return value.map((item) => redactValue(item, depth + 1, seen));
    }

    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = REDACTED;
      } else if (HASH_KEYS.has(key) && typeof item === 'string') {
        // The audit trail is worth nothing if it cannot name the transaction
        // it describes, and a hash is public by construction.
        out[key] = redactHashValue(item);
      } else {
        out[key] = redactValue(item, depth + 1, seen);
      }
    }
    return out;
  }

  return '[Unknown]';
}
