/**
 * Telegram Bot API: the incoming Update shape the gateway cares about and the
 * one outbound call it makes (sendMessage, plain text, no parse mode).
 *
 * The bot token is a Worker secret. It appears in exactly one place, the
 * request URL built here, and never in a log line, a D1 row or a frame.
 */
import { z } from 'zod';
import { errorSummary, logger } from './log.js';
import { MAX_TELEGRAM_TEXT } from './protocol.js';
import type { TelegramIdentity } from './protocol.js';

const log = logger('telegram');

export const TELEGRAM_API_ORIGIN = 'https://api.telegram.org';
/** A short, awaited call: Telegram is waiting for the webhook to answer. */
export const SEND_TIMEOUT_MS = 5_000;

const userSchema = z.object({
  id: z.number().int(),
  is_bot: z.boolean().optional(),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
  username: z.string().optional(),
});

const chatSchema = z.object({
  id: z.number().int(),
  type: z.string(),
});

const messageSchema = z.object({
  message_id: z.number().int(),
  date: z.number().int(),
  chat: chatSchema,
  from: userSchema.optional(),
  text: z.string().optional(),
});

/** Only `message` updates are handled; anything else is acknowledged and dropped. */
export const updateSchema = z.object({
  update_id: z.number().int(),
  message: messageSchema.optional(),
});

export type TelegramUpdate = z.infer<typeof updateSchema>;
export type TelegramMessage = z.infer<typeof messageSchema>;
export type TelegramUser = z.infer<typeof userSchema>;

/**
 * What the dashboard shows as the paired account. Username when there is one
 * (stable and public), otherwise the first name. Never a phone number: the
 * Bot API does not expose one and the gateway would not store it if it did.
 */
export function displayNameOf(user: TelegramUser): string {
  if (user.username) return `@${user.username}`;
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name.slice(0, 64) : `user ${user.id}`;
}

export function identityOf(message: TelegramMessage, user: TelegramUser): TelegramIdentity {
  return { userId: user.id, chatId: message.chat.id, displayName: displayNameOf(user) };
}

export interface ParsedCommand {
  /** Lower-case command without the slash or a @botname suffix. */
  name: string;
  /** Everything after the command, trimmed. */
  args: string;
}

/** "/pair ABCD-2345" -> { name: "pair", args: "ABCD-2345" }; null for plain text. */
export function parseCommand(text: string): ParsedCommand | null {
  const match = /^\/([A-Za-z0-9_]{1,32})(?:@[A-Za-z0-9_]{1,32})?(?:\s+([\s\S]*))?$/.exec(
    text.trim(),
  );
  if (!match) return null;
  return { name: (match[1] ?? '').toLowerCase(), args: (match[2] ?? '').trim() };
}

export interface SendResult {
  ok: boolean;
  status: number | null;
  description?: string;
}

/**
 * Send a plain-text message. Errors are reported, never thrown: a failed
 * reply must not turn into a 5xx that makes Telegram redeliver the update.
 */
export async function sendMessage(
  botToken: string | undefined,
  chatId: number,
  text: string,
): Promise<SendResult> {
  if (!botToken) {
    log.warn('sendMessage skipped: TELEGRAM_BOT_TOKEN is not configured');
    return { ok: false, status: null, description: 'bot token not configured' };
  }
  const body = JSON.stringify({
    chat_id: chatId,
    text: text.length > MAX_TELEGRAM_TEXT ? `${text.slice(0, MAX_TELEGRAM_TEXT - 1)}…` : text,
    disable_web_page_preview: true,
  });
  try {
    const response = await fetch(`${TELEGRAM_API_ORIGIN}/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
    if (!response.ok) {
      let description = '';
      try {
        const json = await response.json<{ description?: unknown }>();
        description = typeof json.description === 'string' ? json.description : '';
      } catch {
        description = '';
      }
      log.warn('sendMessage rejected', { status: response.status, description });
      return { ok: false, status: response.status, description };
    }
    // Drain the body so the connection can be reused.
    await response.arrayBuffer();
    return { ok: true, status: response.status };
  } catch (error) {
    log.warn('sendMessage failed', { error: errorSummary(error) });
    return { ok: false, status: null, description: errorSummary(error) };
  }
}
