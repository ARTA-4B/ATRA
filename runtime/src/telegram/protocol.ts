import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { TelegramIdentity } from './types.js';

/**
 * The runtime ↔ gateway wire protocol, and the pairing-code helpers both
 * transports share.
 *
 * Text frames only. Every JSON frame carries the protocol version, a type, a
 * per-frame id and a timestamp. Heartbeats are the bare strings "ping" and
 * "pong", outside JSON, so the gateway can answer them without waking a
 * Durable Object. The full protocol is written up for the gateway and
 * dashboard engineers in docs/specs/telegram-protocol.md; this file is its
 * executable form.
 */

export const PROTOCOL_VERSION = 1 as const;
export const SUBPROTOCOL = 'atra.v1';
export const PING_FRAME = 'ping';
export const PONG_FRAME = 'pong';
export const GATEWAY_WS_PATH = '/v1/ws';

// --- pairing codes -------------------------------------------------------------

/** No 0/1/O/I: the code is read off a screen and typed on a phone. */
export const PAIR_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const PAIR_CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
export const PAIR_CODE_TTL_MS = 5 * 60 * 1_000;

/**
 * A fresh code from the CSPRNG.
 *
 * The alphabet has exactly 32 symbols, so masking each random byte to five
 * bits picks a symbol uniformly with no modulo bias. Eight symbols is 40 bits:
 * against a 5-minute window and a rate-limited verifier that is far more than
 * enough, and short enough to type.
 */
export function generatePairCode(random: (size: number) => Uint8Array = randomBytes): string {
  const bytes = random(8);
  let out = '';
  for (let index = 0; index < 8; index += 1) {
    const byte = bytes[index] ?? 0;
    out += PAIR_CODE_ALPHABET[byte & 31];
    if (index === 3) out += '-';
  }
  return out;
}

/**
 * Canonical form of whatever the operator typed: upper-case, dash inserted,
 * or null when it cannot be a code. A wrong-shaped input is rejected before
 * it reaches the database.
 */
export function normalizePairCode(input: string): string | null {
  const compact = input.trim().toUpperCase().replace(/[-\s]/g, '');
  if (compact.length !== 8) return null;
  const candidate = `${compact.slice(0, 4)}-${compact.slice(4)}`;
  return PAIR_CODE_RE.test(candidate) ? candidate : null;
}

/** sha256 of the code without its dash, upper-case, as lowercase hex. Same on the gateway. */
export function hashPairCode(code: string): string {
  return createHash('sha256').update(code.toUpperCase().replace('-', '')).digest('hex');
}

// --- frames ------------------------------------------------------------------------

const identitySchema = z.object({
  userId: z.number().int(),
  chatId: z.number().int(),
  displayName: z.string().max(256),
});

const base = {
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(128),
  ts: z.number().int().min(0),
};

export const welcomeFrameSchema = z.object({
  ...base,
  type: z.literal('welcome'),
  paired: z.boolean(),
  telegram: identitySchema.nullable(),
  botUsername: z.string().max(64),
});

export const pairedFrameSchema = z.object({
  ...base,
  type: z.literal('paired'),
  telegram: identitySchema,
  pairedAt: z.number().int().min(0),
});

export const unpairedFrameSchema = z.object({
  ...base,
  type: z.literal('unpaired'),
  reason: z.string().max(512),
});

export const commandFrameSchema = z.object({
  ...base,
  type: z.literal('command'),
  requestId: z.string().min(1).max(128),
  updateId: z.number().int().min(0),
  telegram: identitySchema,
  text: z.string().max(4_096),
  receivedAt: z.number().int().min(0),
});

export const errorFrameSchema = z.object({
  ...base,
  type: z.literal('error'),
  requestId: z.string().max(128).optional(),
  code: z.string().max(64),
  message: z.string().max(1_024),
});

export const inboundFrameSchema = z.discriminatedUnion('type', [
  welcomeFrameSchema,
  pairedFrameSchema,
  unpairedFrameSchema,
  commandFrameSchema,
  errorFrameSchema,
]);

export type WelcomeFrame = z.infer<typeof welcomeFrameSchema>;
export type PairedFrame = z.infer<typeof pairedFrameSchema>;
export type UnpairedFrame = z.infer<typeof unpairedFrameSchema>;
export type CommandFrame = z.infer<typeof commandFrameSchema>;
export type ErrorFrame = z.infer<typeof errorFrameSchema>;
export type InboundFrame = z.infer<typeof inboundFrameSchema>;

export interface OutboundPayloads {
  hello: { installationId: string; runtimeVersion: string; capabilities: string[] };
  'pair.offer': { codeHash: string; expiresAt: number };
  'pair.revoke': Record<string, never>;
  reply: { requestId: string; text: string };
  notify: { kind: string; text: string };
}

export type OutboundType = keyof OutboundPayloads;

export interface OutboundFrame<T extends OutboundType = OutboundType> {
  v: typeof PROTOCOL_VERSION;
  type: T;
  id: string;
  ts: number;
  payload: OutboundPayloads[T];
}

/** Build and serialise an outbound frame. The payload is spread at the top level. */
export function encodeFrame<T extends OutboundType>(
  type: T,
  payload: OutboundPayloads[T],
  options: { now?: () => number; id?: () => string } = {},
): string {
  const frame = {
    v: PROTOCOL_VERSION,
    type,
    id: (options.id ?? randomUUID)(),
    ts: (options.now ?? Date.now)(),
    ...payload,
  };
  return JSON.stringify(frame);
}

export type DecodeResult =
  | { ok: true; frame: InboundFrame }
  | { ok: false; reason: 'not-json' | 'unknown-type' | 'invalid'; type?: string };

/**
 * Parse a text frame from the gateway.
 *
 * Unknown types are reported, not thrown: a newer gateway may add frame types
 * this runtime does not know, and ignoring them is the compatible behaviour.
 */
export function decodeFrame(text: string): DecodeResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'not-json' };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, reason: 'not-json' };

  const type = (raw as { type?: unknown }).type;
  const known = ['welcome', 'paired', 'unpaired', 'command', 'error'];
  if (typeof type !== 'string' || !known.includes(type)) {
    return { ok: false, reason: 'unknown-type', ...(typeof type === 'string' ? { type } : {}) };
  }

  const parsed = inboundFrameSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: 'invalid', type };
  return { ok: true, frame: parsed.data };
}

export function identityFromFrame(value: z.infer<typeof identitySchema>): TelegramIdentity {
  return { userId: value.userId, chatId: value.chatId, displayName: value.displayName };
}
