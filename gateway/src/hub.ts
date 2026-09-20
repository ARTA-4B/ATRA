/**
 * The Hub: one Durable Object holding every runtime's WebSocket.
 *
 * Sockets are accepted with the hibernation API and tagged "install:<id>", so
 * the object is evicted from memory between events and a ping/pong heartbeat
 * is answered by the runtime's auto-response without waking it. The only
 * recurring cost is a 60 s alarm that sweeps dead sockets, and it is re-armed
 * only while at least one socket exists.
 *
 * Rules kept here on purpose:
 *   - never ws.accept(): that opts out of hibernation
 *   - never setInterval: the alarm is the timer
 *   - never open an outbound WebSocket or TCP socket from inside the object
 *   - the object trusts the X-ATRA-Install-Id header because only the Worker,
 *     after authenticating the bearer token, can reach it
 *
 * The link and the pair codes live in D1; the object's own SQLite storage
 * holds the alarm and the per-install daily quota counters (table
 * quota_usage), which must survive eviction and be exact: one object, one
 * writer, one statement per increment. One hub at launch, name "global".
 */
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.js';
import { errorSummary, logger } from './log.js';
import { getLinkByInstall, storePairOffer, unlinkInstall } from './pairing.js';
import {
  COMMAND_REPLY_TIMEOUT_MS,
  WS_SUBPROTOCOL,
  decodeRuntimeFrame,
  encodeFrame,
} from './protocol.js';
import type { GatewayFrame, RuntimeFrame, TelegramIdentity } from './protocol.js';
import { QUOTA_KINDS, utcDayEnd, utcDayKey, utcDayStart } from './quota.js';
import type { QuotaDecision, QuotaKind } from './quota.js';
import { sendMessage } from './telegram.js';

const log = logger('hub');

export const HUB_NAME = 'global';
/** Sweep interval while sockets exist. */
export const SWEEP_INTERVAL_MS = 60_000;
/** Three missed 30 s heartbeats, plus slack for a slow pong. */
export const HEARTBEAT_STALE_MS = 3 * 30_000 + 30_000;
/** A socket that has not said hello by then is not a runtime. */
export const HELLO_GRACE_MS = 30_000;

// Close codes in the 4000-4999 application range.
export const CLOSE_SUPERSEDED = 4001;
export const CLOSE_NO_ATTACHMENT = 4002;
/** The installation's tokens were revoked by the operator. */
export const CLOSE_REVOKED = 4003;
export const CLOSE_HEARTBEAT_TIMEOUT = 4004;
export const CLOSE_HELLO_TIMEOUT = 4005;

interface Attachment {
  /** The installation the bearer token was minted for. Routing key. */
  installId: string;
  connectedAt: number;
  hello: boolean;
  runtimeVersion?: string;
  /** What the runtime itself said in hello; informational. */
  reportedInstallationId?: string;
}

export interface CommandPayload {
  requestId: string;
  updateId: number;
  telegram: TelegramIdentity;
  text: string;
  receivedAt: number;
}

export type DispatchResult =
  { status: 'ok'; text: string } | { status: 'offline' } | { status: 'timeout' };

export type UsageCounts = Record<QuotaKind, { used: number; rejected: number }>;

export interface InstallUsage {
  installId: string;
  counts: UsageCounts;
  online: boolean;
}

export interface UsageSummary {
  day: string;
  windowStart: number;
  resetAt: number;
  installs: InstallUsage[];
  totals: UsageCounts;
  /** Sockets open right now, all installations. */
  openSockets: number;
}

/** Days of quota_usage rows kept for the admin summary. */
export const USAGE_RETENTION_DAYS = 7;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quota_usage (
  day        TEXT    NOT NULL,
  install_id TEXT    NOT NULL,
  kind       TEXT    NOT NULL,
  used       INTEGER NOT NULL DEFAULT 0,
  rejected   INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (day, install_id, kind)
);
CREATE INDEX IF NOT EXISTS quota_usage_day ON quota_usage (day);
`;

function emptyCounts(): UsageCounts {
  return {
    rpc: { used: 0, rejected: 0 },
    market: { used: 0, rejected: 0 },
    inference: { used: 0, rejected: 0 },
    ws: { used: 0, rejected: 0 },
  };
}

function isQuotaKind(value: string): value is QuotaKind {
  return (QUOTA_KINDS as readonly string[]).includes(value);
}

function tag(installId: string): string {
  return `install:${installId}`;
}

function readAttachment(ws: WebSocket): Attachment | null {
  try {
    const value: unknown = ws.deserializeAttachment();
    if (value && typeof value === 'object' && typeof (value as Attachment).installId === 'string') {
      return value as Attachment;
    }
  } catch {
    // fall through
  }
  return null;
}

export class Hub extends DurableObject<Env> {
  /** requestId -> resolver for a forwarded command awaiting its reply. */
  private readonly pending = new Map<string, (text: string) => void>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Heartbeats never wake a hibernating object. Idempotent, so it is simply
    // set on every construction.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
    // Synchronous and idempotent: the schema exists before the first RPC.
    ctx.storage.sql.exec(SCHEMA);
  }

  // --- WebSocket upgrade ---------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const installId = request.headers.get('x-atra-install-id');
    if (!installId) {
      return new Response('missing installation', { status: 400 });
    }
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected a WebSocket upgrade', { status: 426 });
    }

    // One runtime per installation: a new connection supersedes the old one
    // (a restarted runtime whose previous socket has not timed out yet).
    for (const existing of this.ctx.getWebSockets(tag(installId))) {
      try {
        existing.close(CLOSE_SUPERSEDED, 'superseded by a new connection');
      } catch {
        // already closing
      }
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server, [tag(installId)]);
    const attachment: Attachment = { installId, connectedAt: Date.now(), hello: false };
    server.serializeAttachment(attachment);
    await this.ensureAlarm();

    log.info('runtime connected', { installId });
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'sec-websocket-protocol': WS_SUBPROTOCOL },
    });
  }

  // --- Hibernation handlers ------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = readAttachment(ws);
    if (!attachment) {
      ws.close(CLOSE_NO_ATTACHMENT, 'unknown socket');
      return;
    }
    if (typeof message !== 'string') {
      this.send(ws, { type: 'error', code: 'binary_not_supported', message: 'text frames only' });
      return;
    }
    const decoded = decodeRuntimeFrame(message);
    if (!decoded.ok) {
      this.send(ws, { type: 'error', code: decoded.code, message: decoded.message });
      return;
    }
    const frame = decoded.frame;

    if (frame.type !== 'hello' && !attachment.hello) {
      this.send(ws, {
        type: 'error',
        code: 'hello_required',
        message: 'send a hello frame first',
      });
      return;
    }

    try {
      await this.handleFrame(ws, attachment, frame);
    } catch (error) {
      log.error('frame handling failed', {
        installId: attachment.installId,
        type: frame.type,
        error: errorSummary(error),
      });
      this.send(ws, {
        type: 'error',
        code: 'internal',
        message: 'the gateway could not process that frame',
      });
    }
  }

  override webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean): void {
    const attachment = readAttachment(ws);
    log.info('runtime disconnected', {
      installId: attachment?.installId ?? null,
      closeCode: code,
      reason: reason.slice(0, 120),
      wasClean,
    });
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    const attachment = readAttachment(ws);
    log.warn('socket error', {
      installId: attachment?.installId ?? null,
      error: errorSummary(error),
    });
  }

  /**
   * Sweep: close sockets whose heartbeat stopped or that never said hello.
   * Re-armed only while sockets remain, so an idle hub costs nothing.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readAttachment(ws);
      if (!attachment) {
        ws.close(CLOSE_NO_ATTACHMENT, 'unknown socket');
        continue;
      }
      const lastPong = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
      const lastSeen = Math.max(lastPong ?? 0, attachment.connectedAt);
      if (now - lastSeen > HEARTBEAT_STALE_MS) {
        ws.close(CLOSE_HEARTBEAT_TIMEOUT, 'heartbeat timeout');
        continue;
      }
      if (!attachment.hello && now - attachment.connectedAt > HELLO_GRACE_MS) {
        ws.close(CLOSE_HELLO_TIMEOUT, 'no hello');
      }
    }
    // Only open sockets need another sweep. A socket whose close handshake
    // is still completing is listed by getWebSockets() but has nothing left
    // to sweep.
    const open = this.ctx
      .getWebSockets()
      .filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN);
    if (open.length > 0) {
      await this.ctx.storage.setAlarm(now + SWEEP_INTERVAL_MS);
    }
  }

  // --- RPC used by the Worker ---------------------------------------------

  /** Forward a Telegram command and wait (bounded) for the runtime's reply. */
  async dispatchCommand(installId: string, command: CommandPayload): Promise<DispatchResult> {
    const ws = this.liveSocket(installId);
    if (!ws) return { status: 'offline' };

    const text = await new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(command.requestId);
        resolve(null);
      }, COMMAND_REPLY_TIMEOUT_MS);
      this.pending.set(command.requestId, (reply) => {
        clearTimeout(timer);
        this.pending.delete(command.requestId);
        resolve(reply);
      });
      try {
        ws.send(encodeFrame({ type: 'command', ...command }));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(command.requestId);
        log.warn('command send failed', { installId, error: errorSummary(error) });
        resolve(null);
      }
    });

    return text === null ? { status: 'timeout' } : { status: 'ok', text };
  }

  /** Tell a connected runtime that its installation was just paired. */
  announcePaired(installId: string, telegram: TelegramIdentity, pairedAt: number): boolean {
    return this.broadcast(installId, { type: 'paired', telegram, pairedAt });
  }

  /** Tell a connected runtime that its link is gone. */
  announceUnpaired(installId: string, reason: string): boolean {
    return this.broadcast(installId, { type: 'unpaired', reason });
  }

  isOnline(installId: string): boolean {
    return this.liveSocket(installId) !== null;
  }

  /** Installation ids with an open socket that has completed hello. */
  onlineInstalls(): string[] {
    const ids = new Set<string>();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attachment = readAttachment(ws);
      if (attachment?.hello) ids.add(attachment.installId);
    }
    return [...ids];
  }

  /**
   * Close every socket of an installation (revocation). The token check on
   * the next connect is what keeps it out; this only ends the current session.
   */
  closeSockets(installId: string, code: number = CLOSE_REVOKED, reason = 'revoked'): number {
    let closed = 0;
    for (const ws of this.ctx.getWebSockets(tag(installId))) {
      try {
        ws.close(code, reason);
        closed += 1;
      } catch {
        // already closing
      }
    }
    return closed;
  }

  // --- Quotas (SQLite-backed, per install, per UTC day) --------------------

  /**
   * Count one request of `kind` against today's quota. The limit is passed
   * by the Worker (it reads the vars) so the object stays configuration-free.
   * A limit of 0 refuses everything of that kind. Durable Object events run
   * one at a time and sql.exec is synchronous, so read-then-write here is
   * atomic without a transaction.
   */
  consumeQuota(
    installId: string,
    kind: QuotaKind,
    limit: number,
    now: number = Date.now(),
  ): QuotaDecision {
    const day = utcDayKey(now);
    const cap = Number.isFinite(limit) && limit >= 0 ? Math.floor(limit) : 0;
    const row = this.ctx.storage.sql
      .exec<{ used: number; rejected: number }>(
        'SELECT used, rejected FROM quota_usage WHERE day = ? AND install_id = ? AND kind = ?',
        day,
        installId,
        kind,
      )
      .toArray()[0];
    const used = row?.used ?? 0;
    const rejected = row?.rejected ?? 0;
    const base = { kind, limit: cap, day, windowStart: utcDayStart(now), resetAt: utcDayEnd(now) };

    if (used >= cap) {
      this.ctx.storage.sql.exec(
        `INSERT INTO quota_usage (day, install_id, kind, used, rejected, updated_at)
         VALUES (?, ?, ?, 0, 1, ?)
         ON CONFLICT (day, install_id, kind)
         DO UPDATE SET rejected = rejected + 1, updated_at = excluded.updated_at`,
        day,
        installId,
        kind,
        now,
      );
      return { ...base, allowed: false, used, rejected: rejected + 1 };
    }
    this.ctx.storage.sql.exec(
      `INSERT INTO quota_usage (day, install_id, kind, used, rejected, updated_at)
       VALUES (?, ?, ?, 1, 0, ?)
       ON CONFLICT (day, install_id, kind)
       DO UPDATE SET used = used + 1, updated_at = excluded.updated_at`,
      day,
      installId,
      kind,
      now,
    );
    return { ...base, allowed: true, used: used + 1, rejected };
  }

  /** Today's counters for one installation (all kinds, zero when unused). */
  usageFor(installId: string, now: number = Date.now()): UsageCounts {
    const counts = emptyCounts();
    const rows = this.ctx.storage.sql
      .exec<{ kind: string; used: number; rejected: number }>(
        'SELECT kind, used, rejected FROM quota_usage WHERE day = ? AND install_id = ?',
        utcDayKey(now),
        installId,
      )
      .toArray();
    for (const r of rows) {
      if (isQuotaKind(r.kind)) counts[r.kind] = { used: r.used, rejected: r.rejected };
    }
    return counts;
  }

  /** Every installation that made a request on `day` (default today), with totals. */
  usageSummary(now: number = Date.now(), day: string = utcDayKey(now)): UsageSummary {
    const rows = this.ctx.storage.sql
      .exec<{ install_id: string; kind: string; used: number; rejected: number }>(
        'SELECT install_id, kind, used, rejected FROM quota_usage WHERE day = ? ORDER BY install_id',
        day,
      )
      .toArray();
    const byInstall = new Map<string, UsageCounts>();
    const totals = emptyCounts();
    for (const r of rows) {
      if (!isQuotaKind(r.kind)) continue;
      const counts = byInstall.get(r.install_id) ?? emptyCounts();
      counts[r.kind] = { used: r.used, rejected: r.rejected };
      byInstall.set(r.install_id, counts);
      totals[r.kind].used += r.used;
      totals[r.kind].rejected += r.rejected;
    }
    const installs: InstallUsage[] = [];
    for (const [installId, counts] of byInstall) {
      installs.push({ installId, counts, online: this.isOnline(installId) });
    }
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    return {
      day,
      windowStart: dayStart,
      resetAt: dayStart + 24 * 60 * 60_000,
      installs,
      totals,
      openSockets: this.ctx
        .getWebSockets()
        .filter((ws) => ws.readyState === WebSocket.READY_STATE_OPEN).length,
    };
  }

  /** Drop counters older than the retention window. Called from the cron. */
  purgeUsage(now: number = Date.now(), retentionDays: number = USAGE_RETENTION_DAYS): number {
    const cutoff = utcDayKey(now - retentionDays * 24 * 60 * 60_000);
    const cursor = this.ctx.storage.sql.exec('DELETE FROM quota_usage WHERE day < ?', cutoff);
    return cursor.rowsWritten;
  }

  // --- internals -------------------------------------------------------------

  private async handleFrame(ws: WebSocket, attachment: Attachment, frame: RuntimeFrame) {
    const { installId } = attachment;
    switch (frame.type) {
      case 'hello': {
        // The token, not the frame, identifies the installation: the runtime
        // reports the id of its local installation row (or "pending-setup"
        // before setup), which need not equal the id the token was minted
        // for. It is kept for the logs only.
        if (frame.installationId !== installId) {
          log.info('hello reports a different installation id', {
            installId,
            reported: frame.installationId.slice(0, 64),
          });
        }
        ws.serializeAttachment({
          ...attachment,
          hello: true,
          runtimeVersion: frame.runtimeVersion.slice(0, 32),
          reportedInstallationId: frame.installationId.slice(0, 64),
        } satisfies Attachment);
        const link = await getLinkByInstall(this.env.DB, installId);
        this.send(ws, {
          type: 'welcome',
          paired: link !== null,
          telegram: link?.telegram ?? null,
          botUsername: this.env.BOT_USERNAME ?? '',
        });
        return;
      }
      case 'pair.offer': {
        const now = Date.now();
        if (frame.expiresAt <= now) {
          this.send(ws, {
            type: 'error',
            code: 'offer_expired',
            message: 'pair.offer.expiresAt is in the past',
          });
          return;
        }
        await storePairOffer(this.env.DB, installId, frame.codeHash, frame.expiresAt, now);
        return;
      }
      case 'pair.revoke': {
        await unlinkInstall(this.env.DB, installId);
        this.send(ws, { type: 'unpaired', reason: 'revoked by runtime' });
        return;
      }
      case 'reply': {
        const resolve = this.pending.get(frame.requestId);
        if (resolve) resolve(frame.text);
        else log.info('reply for unknown or expired request', { installId });
        return;
      }
      case 'notify': {
        const link = await getLinkByInstall(this.env.DB, installId);
        if (!link) return; // unpaired: nowhere to send, and the protocol says ignore
        await sendMessage(this.env.TELEGRAM_BOT_TOKEN, link.telegram.chatId, frame.text);
        return;
      }
      default: {
        const never: never = frame;
        throw new Error(`unhandled frame ${String(never)}`);
      }
    }
  }

  /** The newest open socket for an installation that has completed hello. */
  private liveSocket(installId: string): WebSocket | null {
    let best: { ws: WebSocket; connectedAt: number } | null = null;
    for (const ws of this.ctx.getWebSockets(tag(installId))) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      const attachment = readAttachment(ws);
      if (!attachment?.hello) continue;
      if (!best || attachment.connectedAt > best.connectedAt) {
        best = { ws, connectedAt: attachment.connectedAt };
      }
    }
    return best?.ws ?? null;
  }

  private broadcast(installId: string, frame: GatewayFrame): boolean {
    let delivered = false;
    const encoded = encodeFrame(frame);
    for (const ws of this.ctx.getWebSockets(tag(installId))) {
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;
      try {
        ws.send(encoded);
        delivered = true;
      } catch (error) {
        log.warn('broadcast send failed', { installId, error: errorSummary(error) });
      }
    }
    return delivered;
  }

  private send(ws: WebSocket, frame: GatewayFrame): void {
    try {
      ws.send(encodeFrame(frame));
    } catch (error) {
      log.warn('send failed', { error: errorSummary(error) });
    }
  }

  private async ensureAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + SWEEP_INTERVAL_MS);
    }
  }
}
