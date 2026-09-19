/**
 * The runtime <-> gateway wire protocol, version 1.
 *
 * Transport: one outbound WebSocket per runtime to GET /v1/ws, text frames
 * only, Sec-WebSocket-Protocol "atra.v1". Heartbeat is the literal frames
 * "ping" -> "pong", answered by the Durable Object's auto-response so a
 * hibernating hub never wakes for it. Every JSON frame carries
 * { v: 1, type, id, ts } plus its payload.
 *
 * Runtime -> gateway frames are validated here with zod because they come from
 * an authenticated but remote process. Gateway -> runtime frames are built by
 * encodeFrame().
 */
import { z } from 'zod';

export const PROTOCOL_VERSION = 1;
export const WS_SUBPROTOCOL = 'atra.v1';

/** A pair code as typed by the user: XXXX-XXXX over [A-Z2-9] (no 0/1/O/I). */
export const PAIR_CODE_DISPLAY_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
/** The normalized form that is hashed: upper-case, dash removed. */
export const PAIR_CODE_NORMALIZED_RE = /^[A-Z2-9]{8}$/;
export const PAIR_CODE_TTL_MS = 5 * 60_000;
/** A runtime may not offer a code that outlives the dashboard's 5 minute TTL by much. */
export const PAIR_OFFER_MAX_TTL_MS = 10 * 60_000;

/** How long the gateway waits for a "reply" to a forwarded command. */
export const COMMAND_REPLY_TIMEOUT_MS = 8_000;
/** Largest text frame the hub will parse. */
export const MAX_FRAME_BYTES = 16 * 1024;
/** Telegram's own limit for one message. */
export const MAX_TELEGRAM_TEXT = 4096;
/** Longest command text forwarded to a runtime. */
export const MAX_COMMAND_TEXT = 512;

const base = z.object({
  v: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1).max(64),
  ts: z.number().int().nonnegative(),
});

export const helloFrameSchema = base.extend({
  type: z.literal('hello'),
  installationId: z.string().min(1).max(64),
  runtimeVersion: z.string().max(64),
  capabilities: z.array(z.string().max(32)).max(16),
});

export const pairOfferFrameSchema = base.extend({
  type: z.literal('pair.offer'),
  codeHash: z.string().regex(/^[0-9a-f]{64}$/),
  expiresAt: z.number().int().positive(),
});

export const pairRevokeFrameSchema = base.extend({
  type: z.literal('pair.revoke'),
});

export const replyFrameSchema = base.extend({
  type: z.literal('reply'),
  requestId: z.string().min(1).max(64),
  text: z.string().max(MAX_TELEGRAM_TEXT),
});

export const notifyFrameSchema = base.extend({
  type: z.literal('notify'),
  kind: z.string().min(1).max(64),
  text: z.string().min(1).max(MAX_TELEGRAM_TEXT),
});

export const runtimeFrameSchema = z.discriminatedUnion('type', [
  helloFrameSchema,
  pairOfferFrameSchema,
  pairRevokeFrameSchema,
  replyFrameSchema,
  notifyFrameSchema,
]);

export type RuntimeFrame = z.infer<typeof runtimeFrameSchema>;

/** The Telegram identity linked to an installation, as sent to the runtime. */
export interface TelegramIdentity {
  userId: number;
  chatId: number;
  displayName: string;
}

export type GatewayFrame =
  | {
      type: 'welcome';
      paired: boolean;
      telegram: TelegramIdentity | null;
      botUsername: string;
    }
  | { type: 'paired'; telegram: TelegramIdentity; pairedAt: number }
  | { type: 'unpaired'; reason: string }
  | {
      type: 'command';
      requestId: string;
      updateId: number;
      telegram: TelegramIdentity;
      text: string;
      receivedAt: number;
    }
  | { type: 'error'; requestId?: string; code: string; message: string };

/** Serialize a gateway -> runtime frame with the protocol envelope. */
export function encodeFrame(frame: GatewayFrame, now: number = Date.now()): string {
  const { type, ...payload } = frame;
  return JSON.stringify({
    v: PROTOCOL_VERSION,
    type,
    id: crypto.randomUUID(),
    ts: now,
    ...payload,
  });
}

export type DecodeResult =
  | { ok: true; frame: RuntimeFrame }
  | { ok: false; code: 'too_large' | 'not_json' | 'invalid_frame'; message: string };

/** Parse and validate a runtime -> gateway text frame. Never throws. */
export function decodeRuntimeFrame(raw: string): DecodeResult {
  if (raw.length > MAX_FRAME_BYTES) {
    return { ok: false, code: 'too_large', message: `frame exceeds ${MAX_FRAME_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, code: 'not_json', message: 'frame is not valid JSON' };
  }
  const parsed = runtimeFrameSchema.safeParse(json);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    return {
      ok: false,
      code: 'invalid_frame',
      message: `${first?.message ?? 'invalid frame'}${where}`,
    };
  }
  return { ok: true, frame: parsed.data };
}
