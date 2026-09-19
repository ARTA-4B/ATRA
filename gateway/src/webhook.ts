/**
 * Telegram webhook processing.
 *
 * The route in index.ts authenticates the secret token and parses the body;
 * this module decides what an update means. Three things are answered by the
 * gateway itself (/start, /help, /pair CODE); every other text from a linked
 * user is forwarded to that user's runtime through the Hub and the runtime's
 * reply is relayed verbatim. Nothing here interprets a trading command, and
 * the gateway never forwards wallet export or withdrawal commands at all.
 */
import type { Env } from './env.js';
import { HUB_NAME } from './hub.js';
import { errorSummary, logger } from './log.js';
import {
  consumePairCode,
  getLinkByUser,
  hashPairCode,
  linkTelegram,
  normalizePairCode,
} from './pairing.js';
import { MAX_COMMAND_TEXT } from './protocol.js';
import type { TelegramIdentity } from './protocol.js';
import { allow } from './ratelimit.js';
import { identityOf, parseCommand, sendMessage } from './telegram.js';
import type { TelegramUpdate } from './telegram.js';

const log = logger('webhook');

export const HELP_TEXT = [
  'ATRA — your local trading runtime, on Telegram.',
  '',
  'To pair this chat with your installation:',
  '1. Open your ATRA dashboard, go to Telegram and generate a code.',
  '2. Send it here as: /pair XXXX-XXXX',
  '',
  'Once paired, commands such as /status, /portfolio, /positions, /trades, /risk, /pause, /resume and /emergency are answered by your own runtime.',
  '',
  'Wallet export and withdrawals are never available over Telegram.',
].join('\n');

export const UNPAIRED_HINT =
  'This bot is not paired with an ATRA installation. Generate a code in your dashboard and send /pair CODE.';
export const OFFLINE_TEXT = 'ATRA runtime is offline or not responding';
export const PAIR_FAILED_TEXT = 'Code invalid or expired';
export const REFUSED_TEXT = 'This command is not available over Telegram.';

/**
 * Commands the gateway refuses to forward, whatever the runtime would do
 * with them. The runtime refuses them too; this is the outer wall.
 */
export const REFUSED_COMMANDS: ReadonlySet<string> = new Set([
  'export',
  'exportkey',
  'exportwallet',
  'withdraw',
  'withdrawal',
  'send',
  'transfer',
  'key',
  'keys',
  'privatekey',
  'private_key',
  'seed',
  'mnemonic',
  'backup',
]);

export function pairedText(installId: string): string {
  return `Paired with installation ${installId.slice(0, 8)}`;
}

/** The slice of ExecutionContext the handler needs (Hono and workerd type it differently). */
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

export type UpdateOutcome =
  | 'ignored'
  | 'duplicate'
  | 'rate_limited'
  | 'help'
  | 'paired'
  | 'pair_failed'
  | 'unpaired_hint'
  | 'refused'
  | 'forwarded';

/**
 * Handle one update. Never throws; the route always returns 200 to Telegram.
 * Work that can wait for the runtime (up to 8 s) runs in ctx.waitUntil so
 * Telegram gets its 200 at once; everything else is short and awaited.
 */
export async function handleUpdate(
  env: Env,
  ctx: WaitUntil,
  update: TelegramUpdate,
  now: number = Date.now(),
): Promise<UpdateOutcome> {
  const message = update.message;
  if (!message || typeof message.text !== 'string' || !message.from || message.from.is_bot) {
    return 'ignored';
  }
  // Pairing and commands are a private conversation between the operator and
  // their bot; a group would show every member the runtime's replies.
  if (message.chat.type !== 'private') return 'ignored';

  const chatId = message.chat.id;
  const user = message.from;

  // Replay protection: Telegram redelivers until it sees a 2xx.
  const inserted = await env.DB.prepare(
    'INSERT OR IGNORE INTO tg_updates (chat_id, update_id, received_at) VALUES (?, ?, ?)',
  )
    .bind(chatId, update.update_id, now)
    .run();
  if (inserted.meta.changes === 0) return 'duplicate';

  if (!(await allow(env.RL_WEBHOOK, `chat:${chatId}`))) return 'rate_limited';

  const identity = identityOf(message, user);
  const text = message.text.trim();
  const command = parseCommand(text);

  if (command && (command.name === 'start' || command.name === 'help')) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, HELP_TEXT);
    return 'help';
  }

  if (command && command.name === 'pair') {
    return pair(env, identity, command.args, now);
  }

  const link = await getLinkByUser(env.DB, user.id);
  if (!link || link.telegram.chatId !== chatId) {
    if (!(await allow(env.RL_UNPAIRED, `user:${user.id}`))) return 'rate_limited';
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, UNPAIRED_HINT);
    return 'unpaired_hint';
  }

  if (command && REFUSED_COMMANDS.has(command.name)) {
    log.warn('refused command', { installId: link.installId, command: command.name });
    await sendMessage(env.TELEGRAM_BOT_TOKEN, chatId, REFUSED_TEXT);
    return 'refused';
  }

  // The frame carries the identity as paired, not as it appears on this
  // update: userId and chatId were just checked to match, and the display
  // name is the one the dashboard shows.
  ctx.waitUntil(
    forward(env, link.installId, link.telegram, update.update_id, text, message.date * 1000).catch(
      (error: unknown) => {
        log.error('forward failed', { installId: link.installId, error: errorSummary(error) });
      },
    ),
  );
  return 'forwarded';
}

async function pair(
  env: Env,
  identity: TelegramIdentity,
  args: string,
  now: number,
): Promise<UpdateOutcome> {
  // Brute force guard: the code space is 32^8 but the limiter makes even
  // that moot. A limited user gets silence, not a hint.
  if (!(await allow(env.RL_UNPAIRED, `pair:${identity.userId}`))) return 'rate_limited';

  const code = normalizePairCode(args);
  if (!code) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, identity.chatId, PAIR_FAILED_TEXT);
    return 'pair_failed';
  }

  const installId = await consumePairCode(env.DB, await hashPairCode(code), now);
  if (!installId) {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, identity.chatId, PAIR_FAILED_TEXT);
    return 'pair_failed';
  }

  const { displaced } = await linkTelegram(env.DB, installId, identity, now);
  log.info('paired', { installId, userId: identity.userId, displaced: displaced.length });

  // Best effort: the runtime learns about the pairing now if it is connected,
  // and from `welcome` on its next connect otherwise.
  try {
    const hub = env.HUB.getByName(HUB_NAME);
    await hub.announcePaired(installId, identity, now);
    for (const other of displaced) {
      await hub.announceUnpaired(other, 'the Telegram user paired another installation');
    }
  } catch (error) {
    log.warn('hub announce failed', { installId, error: errorSummary(error) });
  }

  await sendMessage(env.TELEGRAM_BOT_TOKEN, identity.chatId, pairedText(installId));
  return 'paired';
}

async function forward(
  env: Env,
  installId: string,
  identity: TelegramIdentity,
  updateId: number,
  text: string,
  receivedAt: number,
): Promise<void> {
  const hub = env.HUB.getByName(HUB_NAME);
  const result = await hub.dispatchCommand(installId, {
    requestId: crypto.randomUUID(),
    updateId,
    telegram: identity,
    text: text.slice(0, MAX_COMMAND_TEXT),
    receivedAt,
  });
  if (result.status === 'ok') {
    await sendMessage(env.TELEGRAM_BOT_TOKEN, identity.chatId, result.text);
    return;
  }
  log.info('runtime did not answer', { installId, status: result.status });
  await sendMessage(env.TELEGRAM_BOT_TOKEN, identity.chatId, OFFLINE_TEXT);
}
