import type { ChainId } from '../chains/registry.js';
import type { ErrorCode } from '../util/errors.js';

/**
 * Shared shapes for the Telegram subsystem.
 *
 * Telegram is a remote control with a deliberately small surface: it can
 * read status, pause, resume and engage the emergency stop. It cannot export
 * a key, withdraw funds, change the risk policy or clear an emergency stop —
 * every one of those needs the local dashboard and a re-authentication.
 * Nothing that reaches this subsystem from Telegram is trusted: the gateway
 * says who sent a command, and the runtime checks that claim against its own
 * stored pairing before doing anything.
 */

export type TransportKind = 'gateway' | 'direct';

/** Public Telegram identifiers. None of these is a credential. */
export interface TelegramIdentity {
  userId: number;
  chatId: number;
  displayName: string;
}

export interface TelegramLink extends TelegramIdentity {
  pairedAt: string;
  transport: TransportKind;
}

export interface NotificationToggles {
  riskRejections: boolean;
  tradeDecisions: boolean;
  liquidityUpdates: boolean;
  runtimeAlerts: boolean;
}

/** The dashboard's view. Matches `TelegramView` in the API contract. */
export interface TelegramView {
  configured: boolean;
  paired: boolean;
  botUrl: string | null;
  botUsername: string | null;
  account: { displayName: string; userIdMasked: string; pairedAt: string } | null;
  installation: string;
  notifications: NotificationToggles;
  /** Additive: which transport is in use and whether it is currently up. */
  transport: TransportKind | null;
  connected: boolean;
  /** Additive: the master switch toggled with /alerts on|off. */
  alertsEnabled: boolean;
}

export interface PairCode {
  code: string;
  command: string;
  expiresAt: string;
  botUrl: string | null;
}

export type PairStatus = 'pending' | 'confirmed' | 'expired';

/** A command as the transport hands it to the router. */
export interface InboundCommand {
  /** Gateway request id, or a synthetic one on the direct transport. */
  requestId: string;
  updateId: number;
  telegram: TelegramIdentity;
  text: string;
  /** When Telegram received the message, epoch ms. */
  receivedAt: number;
  source: TransportKind;
}

export const NOTIFICATION_KINDS = [
  'trade.filled',
  'trade.rejected',
  'trade.failed',
  'lp.rebalanced',
  'lp.exited',
  'lp.filled',
  'risk.dailyLossNear',
  'gas.low',
  'emergency.engaged',
  'emergency.cleared',
  'runtime.online',
  'runtime.offline',
  'paused',
  'resumed',
] as const;

export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export interface NotificationEvent {
  kind: NotificationKind;
  chain?: ChainId | undefined;
  /** One line, already free of secrets. Addresses shortened by the caller. */
  summary: string;
  detail?: string | undefined;
  correlationId?: string | undefined;
  /**
   * Suppresses an identical event for an hour. Defaults to kind + chain +
   * summary, which is right for state changes; fills pass their trade id so
   * two identical fills are two messages.
   */
  dedupeKey?: string | undefined;
  /** For trade.rejected: the rejection code the cooldown is keyed on. */
  rejectionCode?: string | undefined;
}

/**
 * What the liquidity engine exposes to /lp. Optional: the Telegram service
 * replies "LP not available" when nothing is wired.
 */
export interface LiquiditySummary {
  summary(): Promise<string>;
}

/**
 * The contract's error code for "no transport configured". It is not in the
 * shared {@link ErrorCode} table because that file belongs to another owner in
 * this phase; the status is passed explicitly so the response is a 409.
 */
export const TELEGRAM_NOT_CONFIGURED = 'TELEGRAM_NOT_CONFIGURED' as ErrorCode;

/** Mask a Telegram user id for audit rows and the dashboard: keep the last 3 digits. */
export function maskUserId(userId: number): string {
  const digits = String(Math.abs(Math.trunc(userId)));
  if (digits.length <= 3) return '***';
  return `${'*'.repeat(digits.length - 3)}${digits.slice(-3)}`;
}
