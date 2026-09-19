import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { StateStore } from '../core/state.js';
import type { WalletService } from '../wallet/service.js';
import type { LedgerService, PriceLookup } from '../trading/ledger.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { MarketService } from '../market/service.js';
import type { Ledger as RiskLedger, Mode } from '../risk/types.js';
import { microsToUsd, usdToMicros } from '../risk/money.js';
import type { ChainId } from '../chains/registry.js';
import { CHAINS } from '../chains/registry.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';
import { chainLabel, finalize, fmtUnits, fmtUsd } from './format.js';
import type { Timers } from './transport.js';
import { realTimers } from './transport.js';
import type { NotificationEvent, NotificationKind, NotificationToggles } from './types.js';

/**
 * Outbound notifications, with the anti-spam rules in one place.
 *
 * A phone that buzzes thirty times an hour gets muted, and a muted phone
 * misses the one message that mattered. So: category toggles from the
 * dashboard, a master switch from /alerts, a per-code cooldown on risk
 * rejections (with the count of what was swallowed), one-hour deduplication,
 * and a hard cap of thirty messages an hour. Nothing is sent while unpaired.
 * A delivery failure is logged and recorded; it never propagates into the
 * trading path that raised the event.
 */

export type NotifyOutcome =
  | 'sent'
  | 'unpaired'
  | 'alerts-off'
  | 'category-off'
  | 'cooldown'
  | 'duplicate'
  | 'hourly-cap'
  | 'failed';

export interface NotificationRecord {
  at: string;
  kind: NotificationKind;
  chain: ChainId | null;
  summary: string;
  outcome: NotifyOutcome;
  suppressed: number;
}

export const NOTIFIER_LIMITS = {
  hourlyCap: 30,
  dedupeMs: 60 * 60 * 1_000,
  rejectionCooldownMs: 10 * 60 * 1_000,
  queueSize: 100,
} as const;

export interface NotifierDeps {
  db: Db;
  audit: AuditLog;
  /** Deliver one message. May reject; the notifier records the failure. */
  send: (event: NotificationEvent, text: string) => Promise<void>;
  isPaired: () => boolean;
  mode: () => Mode;
  now?: () => number;
}

interface StateRow {
  notify_risk_rejections: number;
  notify_trade_decisions: number;
  notify_liquidity_updates: number;
  notify_runtime_alerts: number;
  alerts_enabled: number;
  poll_offset: number | null;
  daily_loss_warned_day_ms: number | null;
}

const CATEGORY: Record<NotificationKind, keyof NotificationToggles> = {
  'trade.filled': 'tradeDecisions',
  'trade.failed': 'tradeDecisions',
  'trade.rejected': 'riskRejections',
  'lp.rebalanced': 'liquidityUpdates',
  'lp.exited': 'liquidityUpdates',
  'lp.filled': 'liquidityUpdates',
  'risk.dailyLossNear': 'runtimeAlerts',
  'gas.low': 'runtimeAlerts',
  'emergency.engaged': 'runtimeAlerts',
  'emergency.cleared': 'runtimeAlerts',
  'runtime.online': 'runtimeAlerts',
  'runtime.offline': 'runtimeAlerts',
  paused: 'runtimeAlerts',
  resumed: 'runtimeAlerts',
};

const TITLE: Record<NotificationKind, string> = {
  'trade.filled': 'Trade filled',
  'trade.rejected': 'Trade rejected by the risk engine',
  'trade.failed': 'Trade failed',
  'lp.rebalanced': 'LP position rebalanced',
  'lp.exited': 'LP position exited',
  'lp.filled': 'LP position opened',
  'risk.dailyLossNear': 'Daily loss limit approaching',
  'gas.low': 'Low gas balance',
  'emergency.engaged': 'EMERGENCY STOP ENGAGED',
  'emergency.cleared': 'Emergency stop cleared',
  'runtime.online': 'Runtime online',
  'runtime.offline': 'Runtime going offline',
  paused: 'Automation paused',
  resumed: 'Automation resumed',
};

export function categoryFor(kind: NotificationKind): keyof NotificationToggles {
  return CATEGORY[kind];
}

/** The text of a notification. Plain, short, and mode-labelled on every line one. */
export function renderNotification(
  event: NotificationEvent,
  mode: Mode,
  suppressed: number,
): string {
  const where = event.chain ? ` — ${chainLabel(event.chain)}` : '';
  const lines = [`[ATRA ${mode}] ${TITLE[event.kind]}${where}`, event.summary];
  if (event.detail) lines.push(event.detail);
  if (suppressed > 0) {
    lines.push(
      `(${String(suppressed)} similar ${suppressed === 1 ? 'event was' : 'events were'} not sent in the last 10 minutes)`,
    );
  }
  return finalize(lines.join('\n'));
}

export class Notifier {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #send: NotifierDeps['send'];
  readonly #isPaired: () => boolean;
  readonly #mode: () => Mode;
  readonly #now: () => number;
  readonly #log = childLogger('telegram-notify');

  readonly #sentAt: number[] = [];
  readonly #dedupe = new Map<string, number>();
  readonly #cooldowns = new Map<string, { until: number; suppressed: number }>();
  readonly #recent: NotificationRecord[] = [];

  constructor(deps: NotifierDeps) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#send = deps.send;
    this.#isPaired = deps.isPaired;
    this.#mode = deps.mode;
    this.#now = deps.now ?? (() => Date.now());
    this.#ensureRow();
  }

  // --- settings --------------------------------------------------------------

  toggles(): NotificationToggles {
    const row = this.#row();
    return {
      riskRejections: row.notify_risk_rejections === 1,
      tradeDecisions: row.notify_trade_decisions === 1,
      liquidityUpdates: row.notify_liquidity_updates === 1,
      runtimeAlerts: row.notify_runtime_alerts === 1,
    };
  }

  setToggles(partial: Partial<NotificationToggles>, actor: string): NotificationToggles {
    const next = { ...this.toggles(), ...partial };
    this.#db
      .prepare(
        'UPDATE telegram_state SET notify_risk_rejections = ?, notify_trade_decisions = ?,' +
          ' notify_liquidity_updates = ?, notify_runtime_alerts = ?, updated_at = ? WHERE id = 1',
      )
      .run(
        next.riskRejections ? 1 : 0,
        next.tradeDecisions ? 1 : 0,
        next.liquidityUpdates ? 1 : 0,
        next.runtimeAlerts ? 1 : 0,
        new Date(this.#now()).toISOString(),
      );
    this.#audit.append({
      category: 'telegram',
      action: 'telegram.notifications.updated',
      status: 'ok',
      summary: 'Telegram notification preferences updated',
      actor,
      mode: this.#mode(),
      detail: { ...next },
    });
    return next;
  }

  alertsEnabled(): boolean {
    return this.#row().alerts_enabled === 1;
  }

  setAlertsEnabled(enabled: boolean, actor: string): void {
    this.#db
      .prepare('UPDATE telegram_state SET alerts_enabled = ?, updated_at = ? WHERE id = 1')
      .run(enabled ? 1 : 0, new Date(this.#now()).toISOString());
    this.#audit.append({
      category: 'telegram',
      action: enabled ? 'telegram.alerts.enabled' : 'telegram.alerts.disabled',
      status: 'ok',
      summary: enabled ? 'Telegram alerts switched on' : 'Telegram alerts switched off',
      actor,
      mode: this.#mode(),
    });
  }

  /** The direct transport's long-polling cursor. */
  pollOffset(): number | undefined {
    return this.#row().poll_offset ?? undefined;
  }

  setPollOffset(offset: number): void {
    this.#db
      .prepare('UPDATE telegram_state SET poll_offset = ?, updated_at = ? WHERE id = 1')
      .run(offset, new Date(this.#now()).toISOString());
  }

  dailyLossWarnedDay(): number | null {
    return this.#row().daily_loss_warned_day_ms;
  }

  setDailyLossWarnedDay(dayStartMs: number): void {
    this.#db
      .prepare(
        'UPDATE telegram_state SET daily_loss_warned_day_ms = ?, updated_at = ? WHERE id = 1',
      )
      .run(dayStartMs, new Date(this.#now()).toISOString());
  }

  // --- sending ----------------------------------------------------------------

  /**
   * Send an event, or explain why not. Never throws.
   *
   * Order of the gates matters: the cheap state checks come first, then the
   * spam controls, and only a message that will actually go out consumes a
   * slot of the hourly cap.
   */
  async notify(event: NotificationEvent): Promise<NotifyOutcome> {
    const now = this.#now();
    this.#prune(now);

    if (!this.#isPaired()) return this.#record(event, 'unpaired', 0);
    if (!this.alertsEnabled()) return this.#record(event, 'alerts-off', 0);
    if (!this.toggles()[categoryFor(event.kind)]) return this.#record(event, 'category-off', 0);

    const dedupeKey = event.dedupeKey ?? `${event.kind}|${event.chain ?? ''}|${event.summary}`;
    if (this.#dedupe.has(dedupeKey)) return this.#record(event, 'duplicate', 0);

    let suppressed = 0;
    const cooldownKey = this.#cooldownKey(event);
    if (cooldownKey !== null) {
      const active = this.#cooldowns.get(cooldownKey);
      if (active && active.until > now) {
        active.suppressed += 1;
        return this.#record(event, 'cooldown', active.suppressed);
      }
      suppressed = active?.suppressed ?? 0;
    }

    if (this.#sentAt.length >= NOTIFIER_LIMITS.hourlyCap) {
      return this.#record(event, 'hourly-cap', 0);
    }

    // The slots are taken before the send, not after: two events raised in
    // the same tick must not both pass the dedupe and cap checks while the
    // first is still in flight. A failed send gives them back.
    this.#sentAt.push(now);
    this.#dedupe.set(dedupeKey, now);
    const previousCooldown = cooldownKey === null ? undefined : this.#cooldowns.get(cooldownKey);
    if (cooldownKey !== null) {
      this.#cooldowns.set(cooldownKey, {
        until: now + NOTIFIER_LIMITS.rejectionCooldownMs,
        suppressed: 0,
      });
    }

    const text = renderNotification(event, this.#mode(), suppressed);
    try {
      await this.#send(event, text);
    } catch (error) {
      this.#log.warn({ kind: event.kind, err: errorMessage(error) }, 'notification not delivered');
      const index = this.#sentAt.lastIndexOf(now);
      if (index !== -1) this.#sentAt.splice(index, 1);
      this.#dedupe.delete(dedupeKey);
      if (cooldownKey !== null) {
        if (previousCooldown) this.#cooldowns.set(cooldownKey, previousCooldown);
        else this.#cooldowns.delete(cooldownKey);
      }
      return this.#record(event, 'failed', suppressed);
    }
    return this.#record(event, 'sent', suppressed);
  }

  /** The last hundred outcomes, newest first, for the dashboard and for tests. */
  recent(limit = NOTIFIER_LIMITS.queueSize): NotificationRecord[] {
    return this.#recent.slice(-Math.max(1, Math.min(limit, NOTIFIER_LIMITS.queueSize))).reverse();
  }

  #cooldownKey(event: NotificationEvent): string | null {
    if (event.kind === 'trade.rejected')
      return `trade.rejected:${event.rejectionCode ?? 'UNKNOWN'}`;
    return null;
  }

  #record(event: NotificationEvent, outcome: NotifyOutcome, suppressed: number): NotifyOutcome {
    this.#recent.push({
      at: new Date(this.#now()).toISOString(),
      kind: event.kind,
      chain: event.chain ?? null,
      summary: event.summary,
      outcome,
      suppressed,
    });
    while (this.#recent.length > NOTIFIER_LIMITS.queueSize) this.#recent.shift();
    if (outcome !== 'sent' && outcome !== 'unpaired') {
      this.#log.debug({ kind: event.kind, outcome }, 'notification suppressed');
    }
    return outcome;
  }

  #prune(now: number): void {
    const hourAgo = now - NOTIFIER_LIMITS.dedupeMs;
    while (this.#sentAt.length > 0 && (this.#sentAt[0] ?? 0) <= hourAgo) this.#sentAt.shift();
    for (const [key, at] of this.#dedupe) {
      if (at <= hourAgo) this.#dedupe.delete(key);
    }
  }

  #ensureRow(): void {
    this.#db
      .prepare(
        'INSERT INTO telegram_state (id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(new Date(this.#now()).toISOString());
  }

  #row(): StateRow {
    return this.#db.prepare<[], StateRow>('SELECT * FROM telegram_state WHERE id = 1').get()!;
  }
}

// --- gas watcher -------------------------------------------------------------------

export interface GasWatcherDeps {
  wallets: WalletService;
  state: StateStore;
  notifier: Notifier;
  isPaired: () => boolean;
  timers?: Timers;
  intervalMs?: number;
}

/**
 * Every ten minutes, read the native balance of each enabled chain and raise
 * gas.low when the wallet could not pay for three plain transfers. The
 * message deduplicates per chain for an hour, so a wallet that stays empty
 * produces one message an hour, not one every ten minutes.
 */
export class GasWatcher {
  readonly #deps: GasWatcherDeps;
  readonly #timers: Timers;
  readonly #intervalMs: number;
  readonly #log = childLogger('telegram-gas');
  #timer: unknown = null;
  #running = false;

  constructor(deps: GasWatcherDeps) {
    this.#deps = deps;
    this.#timers = deps.timers ?? realTimers;
    this.#intervalMs = deps.intervalMs ?? 10 * 60 * 1_000;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#timer = this.#timers.setInterval(() => {
      void this.check();
    }, this.#intervalMs);
  }

  stop(): void {
    if (this.#timer !== null) this.#timers.clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One pass. Returns what was observed; a chain that could not be read is `null`. */
  async check(): Promise<Array<{ chain: ChainId; gasLow: boolean | null }>> {
    if (this.#running || !this.#deps.isPaired()) return [];
    this.#running = true;
    const observed: Array<{ chain: ChainId; gasLow: boolean | null }> = [];
    try {
      const chains = this.#deps.state.getInstallation()?.enabledChains ?? [];
      for (const chain of chains) {
        let gasLow: boolean | null = null;
        try {
          const reading = await this.#deps.wallets.readBalances(chain, []);
          gasLow = reading.gasLow;
          if (reading.gasLow === true && reading.native) {
            await this.#deps.notifier.notify({
              kind: 'gas.low',
              chain,
              summary: `${fmtUnits(reading.native.amount, reading.native.decimals)} ${reading.native.symbol} cannot cover three plain transfers.`,
              detail: `Top up the ${CHAINS[chain].displayName} wallet from the dashboard's deposit address.`,
              dedupeKey: `gas.low:${chain}`,
            });
          }
        } catch (error) {
          // No wallet yet, or the RPC is down: nothing to report either way.
          this.#log.debug({ chain, err: errorMessage(error) }, 'gas check skipped');
        }
        observed.push({ chain, gasLow });
      }
    } finally {
      this.#running = false;
    }
    return observed;
  }
}

// --- daily loss watcher --------------------------------------------------------------

export interface DailyLossUsage {
  /** Today's drawdown as a decimal USD string, as the risk view reports it. */
  dailyLossUsd: string;
  maxDailyLossUsd: string;
}

export interface DailyLossWatcherDeps {
  ledger: LedgerService;
  riskPolicy: RiskPolicyStore;
  market: MarketService;
  state: StateStore;
  notifier: Notifier;
  now?: () => number;
}

export const DAILY_LOSS_WARN_PERCENT = 80;

/** Today's drawdown, the same way the risk engine computes it. Floored at zero. */
export function dailyLossMicros(ledger: RiskLedger, includeUnrealized: boolean): bigint {
  const realizedLoss = -usdToMicros(ledger.realizedPnlTodayUsd);
  const unrealizedMove = includeUnrealized
    ? -(usdToMicros(ledger.unrealizedPnlUsd) - usdToMicros(ledger.unrealizedPnlAtDayStartUsd))
    : 0n;
  const total = realizedLoss + unrealizedMove;
  return total > 0n ? total : 0n;
}

/**
 * Warn once per UTC day when the day's loss reaches 80% of the limit.
 *
 * Called after each trade cycle with the usage the cycle computed, or with
 * nothing, in which case it marks the ledger itself. It never raises the
 * warning from a guessed number: a position that cannot be priced counts as
 * zero unrealized move, which is the engine's own convention.
 */
export class DailyLossWatcher {
  readonly #deps: DailyLossWatcherDeps;
  readonly #now: () => number;
  readonly #log = childLogger('telegram-daily-loss');

  constructor(deps: DailyLossWatcherDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  async check(usage?: DailyLossUsage): Promise<boolean> {
    const now = this.#now();
    const dayStart = Math.floor(now / 86_400_000) * 86_400_000;
    if (this.#deps.notifier.dailyLossWarnedDay() === dayStart) return false;

    let loss: bigint;
    let limit: bigint;
    try {
      const resolved = usage ?? (await this.#usageFromLedger(now));
      if (!resolved) return false;
      loss = usdToMicros(resolved.dailyLossUsd);
      limit = usdToMicros(resolved.maxDailyLossUsd);
    } catch (error) {
      this.#log.warn({ err: errorMessage(error) }, 'daily loss could not be computed');
      return false;
    }
    if (limit <= 0n) return false;
    if (loss * 100n < limit * BigInt(DAILY_LOSS_WARN_PERCENT)) return false;

    const percent = Number((loss * 100n) / limit);
    const outcome = await this.#deps.notifier.notify({
      kind: 'risk.dailyLossNear',
      summary: `Today's loss is ${fmtUsd(microsToUsd(loss))} of the ${fmtUsd(microsToUsd(limit))} daily limit (${String(percent)}%).`,
      detail: 'The risk engine will reject any trade that would breach the limit. Consider /pause.',
      dedupeKey: `risk.dailyLossNear:${String(dayStart)}`,
    });
    // Recorded even when the delivery was suppressed: one warning per day
    // means one attempt per day, not one per cycle until something gets out.
    if (outcome !== 'unpaired') this.#deps.notifier.setDailyLossWarnedDay(dayStart);
    return outcome === 'sent';
  }

  async #usageFromLedger(now: number): Promise<DailyLossUsage | undefined> {
    if (!this.#deps.riskPolicy.exists()) return undefined;
    const policy = this.#deps.riskPolicy.get();
    const mode = this.#deps.state.getMode();
    const lookup = await positionPriceLookup(this.#deps.ledger, this.#deps.market, mode);
    const ledger = this.#deps.ledger.toRiskLedger(mode, lookup, now);
    return {
      dailyLossUsd: microsToUsd(dailyLossMicros(ledger, policy.dailyLoss.includeUnrealized)),
      maxDailyLossUsd: policy.maxDailyLossUsd,
    };
  }
}

/**
 * Cross-checked prices for every open position, as a synchronous lookup.
 * A token without an undisputed price is simply absent, and the ledger
 * reports the position as unpriced.
 */
export async function positionPriceLookup(
  ledger: LedgerService,
  market: MarketService,
  mode: Mode,
): Promise<PriceLookup> {
  const prices = new Map<string, string>();
  const positions = ledger.listPositions(mode);
  await Promise.all(
    positions.map(async (position) => {
      try {
        const result = await market.getCrossCheckedPrice(position.chain, position.token);
        if (result.priceUsd !== null && !result.disputed) {
          prices.set(`${position.chain}:${position.token}`, result.priceUsd);
        }
      } catch {
        // Unpriced; the ledger says so.
      }
    }),
  );
  return (chain, token) => prices.get(`${chain}:${token}`) ?? null;
}
