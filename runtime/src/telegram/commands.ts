import type { Db } from '../db/database.js';
import type { AuditLog, AuditStatus } from '../audit/audit.js';
import type { StateStore } from '../core/state.js';
import type { LedgerService } from '../trading/ledger.js';
import type { TradeStore } from '../trading/trades.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { MarketService } from '../market/service.js';
import type { AutoTradeScheduler } from '../trading/scheduler.js';
import type { LlmProvider } from '../llm/provider.js';
import { microsToUsd } from '../risk/money.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';
import type { PairingService } from './pairing.js';
import type { Notifier } from './notifications.js';
import { dailyLossMicros, positionPriceLookup } from './notifications.js';
import {
  chainLabel,
  finalize,
  fmtDuration,
  fmtTime,
  fmtUnits,
  fmtUsd,
  percentOf,
  tokenLabel,
  yesNo,
} from './format.js';
import type { InboundCommand, LiquiditySummary, TransportKind } from './types.js';
import { maskUserId } from './types.js';

/**
 * The command router: the only code that turns a Telegram message into an
 * action.
 *
 * Every message walks the same gates in the same order:
 *
 *   replay (update id must advance) ─> age (≤ 120 s) ─> identity (must equal
 *   the stored pairing) ─> rate limits ─> the command itself
 *
 * A message that fails a gate is dropped or answered generically, and the
 * attempt is written to the append-only telegram_commands table and the
 * audit log. The gateway already filters by identity; the runtime does it
 * again because the gateway is a server and this process is the one holding
 * the keys.
 *
 * What a command can do is bounded by what this file calls: StateStore's
 * pause and emergency-stop setters, and reads. There is no path from here to
 * a signer, a withdrawal, a key export or the risk policy.
 */

export const COMMAND_LIMITS = {
  perUserPerMinute: 20,
  controlPerMinute: 5,
  foreignRepliesPer10Min: 3,
  pairAttemptsPer10Min: 5,
  maxMessageAgeMs: 120_000,
  maxFutureSkewMs: 60_000,
  emergencyChallengeMs: 60_000,
  modelProbeTimeoutMs: 3_000,
} as const;

export const UNPAIRED_REPLY =
  'This bot is not paired with an ATRA installation. Generate a code in your dashboard and send /pair CODE.';

const REFUSED_REPLY =
  'Not available over Telegram. Wallet export and withdrawals are done in the local dashboard, with re-authentication.';

const CONTROL_COMMANDS = new Set(['pause', 'resume', 'emergency']);
const REFUSED_COMMANDS = new Set([
  'export',
  'withdraw',
  'withdrawal',
  'send',
  'transfer',
  'sweep',
  'key',
  'keys',
  'privatekey',
  'private_key',
  'seed',
  'mnemonic',
  'backup',
  'keystore',
]);

export type CommandOutcome =
  'ok' | 'refused' | 'unauthorized' | 'replayed' | 'stale' | 'rate_limited' | 'failed';

export interface CommandRouterDeps {
  db: Db;
  audit: AuditLog;
  state: StateStore;
  ledger: LedgerService;
  trades: TradeStore;
  riskPolicy: RiskPolicyStore;
  market: MarketService;
  scheduler: AutoTradeScheduler;
  pairing: PairingService;
  notifier: Notifier;
  liquidity?: LiquiditySummary | undefined;
  llm?: LlmProvider | undefined;
  transportKind: () => TransportKind | null;
  transportConnected: () => boolean;
  installationName: () => string;
  startedAt: () => number;
  now?: () => number;
}

/** A sliding-window counter keyed by caller. Replies once per streak of denials. */
class SlidingWindow {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #hits = new Map<string, number[]>();
  readonly #denials = new Map<string, number>();

  constructor(limit: number, windowMs: number) {
    this.#limit = limit;
    this.#windowMs = windowMs;
  }

  /** Returns whether the hit is allowed and, when not, how many were denied in a row. */
  take(key: string, now: number): { allowed: boolean; denials: number } {
    const cutoff = now - this.#windowMs;
    const hits = (this.#hits.get(key) ?? []).filter((at) => at > cutoff);
    if (hits.length < this.#limit) {
      hits.push(now);
      this.#hits.set(key, hits);
      this.#denials.delete(key);
      return { allowed: true, denials: 0 };
    }
    this.#hits.set(key, hits);
    const denials = (this.#denials.get(key) ?? 0) + 1;
    this.#denials.set(key, denials);
    return { allowed: false, denials };
  }
}

interface ParsedCommand {
  word: string;
  args: string[];
}

/** `/Status@atra_bot  now` → { word: 'status', args: ['now'] }. Non-commands → null. */
export function parseCommand(text: string): ParsedCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith('/')) return null;
  const [head = '', ...rest] = trimmed.split(/\s+/);
  const word = head.slice(1).split('@')[0]?.toLowerCase() ?? '';
  if (!/^[a-z_]{1,32}$/.test(word)) return null;
  return { word, args: rest.slice(0, 8) };
}

export class CommandRouter {
  readonly #d: CommandRouterDeps;
  readonly #now: () => number;
  readonly #log = childLogger('telegram-commands');

  readonly #perUser = new SlidingWindow(COMMAND_LIMITS.perUserPerMinute, 60_000);
  readonly #control = new SlidingWindow(COMMAND_LIMITS.controlPerMinute, 60_000);
  readonly #foreign = new SlidingWindow(COMMAND_LIMITS.foreignRepliesPer10Min, 10 * 60_000);
  readonly #pairAttempts = new SlidingWindow(COMMAND_LIMITS.pairAttemptsPer10Min, 10 * 60_000);

  #emergencyChallenge: { userId: number; issuedAt: number } | null = null;

  constructor(deps: CommandRouterDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => Date.now());
  }

  /** Handle one message. Returns the reply, or null to stay silent. Never throws. */
  async handle(command: InboundCommand): Promise<string | null> {
    try {
      const reply = await this.#handle(command);
      return reply === null ? null : finalize(reply);
    } catch (error) {
      this.#log.error({ err: error, requestId: command.requestId }, 'command failed');
      this.#recordCommand(command, parseCommand(command.text)?.word ?? '(text)', 'failed');
      return 'The command could not be completed. Check the runtime log.';
    }
  }

  async #handle(command: InboundCommand): Promise<string | null> {
    const now = this.#now();
    const parsed = parseCommand(command.text);
    const word = parsed?.word ?? '(text)';
    const identity = command.telegram;

    // --- replay -------------------------------------------------------------
    const cursor = this.#cursor(identity.chatId);
    if (cursor !== undefined && command.updateId <= cursor) {
      this.#recordCommand(command, word, 'replayed');
      this.#audit(
        command,
        word,
        'telegram.replay',
        'rejected',
        'Telegram update replayed; dropped',
      );
      return null;
    }
    this.#setCursor(identity.chatId, command.updateId, now);

    // --- age -------------------------------------------------------------------
    const age = now - command.receivedAt;
    if (age > COMMAND_LIMITS.maxMessageAgeMs || -age > COMMAND_LIMITS.maxFutureSkewMs) {
      this.#recordCommand(command, word, 'stale');
      this.#audit(
        command,
        word,
        'telegram.stale',
        'rejected',
        'Telegram message too old; dropped',
        {
          ageMs: age,
        },
      );
      return null;
    }

    // --- identity ------------------------------------------------------------
    const link = this.#d.pairing.link();
    const authorized =
      link !== undefined && link.userId === identity.userId && link.chatId === identity.chatId;

    if (parsed?.word === 'pair') {
      return this.#pair(command, parsed.args, now);
    }

    if (!authorized) {
      this.#recordCommand(command, word, 'unauthorized');
      const gate = this.#foreign.take(String(identity.userId), now);
      if (gate.allowed) {
        this.#audit(
          command,
          word,
          'telegram.unauthorized',
          'rejected',
          'Telegram command from an unpaired user refused',
        );
        return UNPAIRED_REPLY;
      }
      this.#log.warn({ userIdMasked: maskUserId(identity.userId) }, 'unpaired user rate limited');
      return null;
    }

    // --- rate limits ------------------------------------------------------------
    const perUser = this.#perUser.take(String(identity.userId), now);
    if (!perUser.allowed) {
      this.#recordCommand(command, word, 'rate_limited');
      if (perUser.denials === 1) {
        this.#audit(
          command,
          word,
          'telegram.ratelimited',
          'rejected',
          'Telegram command rate limit hit',
        );
        return 'Too many commands. Wait a minute and try again.';
      }
      return null;
    }
    if (parsed && CONTROL_COMMANDS.has(parsed.word)) {
      const control = this.#control.take(String(identity.userId), now);
      if (!control.allowed) {
        this.#recordCommand(command, word, 'rate_limited');
        if (control.denials === 1) {
          this.#audit(
            command,
            word,
            'telegram.ratelimited',
            'rejected',
            'Telegram control command rate limit hit',
          );
          return 'Too many control commands. Wait a minute and try again.';
        }
        return null;
      }
    }

    // --- dispatch -------------------------------------------------------------------
    if (!parsed) {
      this.#recordCommand(command, word, 'ok');
      return 'Send /help for the list of commands.';
    }

    if (REFUSED_COMMANDS.has(parsed.word)) {
      this.#recordCommand(command, word, 'refused');
      this.#audit(
        command,
        word,
        'telegram.refused',
        'rejected',
        `Telegram /${word} refused: not available over Telegram`,
      );
      return REFUSED_REPLY;
    }

    const reply = await this.#dispatch(command, parsed, now);
    return reply;
  }

  async #dispatch(command: InboundCommand, parsed: ParsedCommand, now: number): Promise<string> {
    const { word, args } = parsed;
    const record = (outcome: CommandOutcome, status: AuditStatus, summary: string, extra = {}) => {
      this.#recordCommand(command, word, outcome);
      this.#audit(command, word, `telegram.command.${word}`, status, summary, extra);
    };

    switch (word) {
      case 'start':
        record('ok', 'ok', 'Telegram /start');
        return `ATRA — ${this.#d.installationName()}\nThis chat is paired. Send /help for the list of commands.`;

      case 'help':
        record('ok', 'ok', 'Telegram /help');
        return helpText();

      case 'status': {
        const text = await this.#status(now);
        record('ok', 'ok', 'Telegram /status');
        return text;
      }

      case 'portfolio': {
        const text = await this.#portfolio(true);
        record('ok', 'ok', 'Telegram /portfolio');
        return text;
      }

      case 'positions': {
        const text = await this.#portfolio(false);
        record('ok', 'ok', 'Telegram /positions');
        return text;
      }

      case 'trades':
        record('ok', 'ok', 'Telegram /trades');
        return this.#trades();

      case 'lp': {
        const text = await this.#lp();
        record('ok', 'ok', 'Telegram /lp');
        return text;
      }

      case 'risk': {
        const text = await this.#risk();
        record('ok', 'ok', 'Telegram /risk');
        return text;
      }

      case 'alerts':
        return this.#alerts(command, args, record);

      case 'pause': {
        const switches = this.#d.state.getSwitches();
        if (switches.globalPause) {
          record('ok', 'hold', 'Telegram /pause: already paused');
          return 'Automation is already paused.';
        }
        this.#d.state.setGlobalPause(
          true,
          `paused from Telegram by ${command.telegram.displayName}`,
          'telegram',
        );
        record('ok', 'ok', 'Telegram /pause engaged the global pause');
        return 'Automation paused. No new cycles will run until /resume.';
      }

      case 'resume': {
        const switches = this.#d.state.getSwitches();
        if (switches.emergencyStop) {
          record('refused', 'rejected', 'Telegram /resume refused: emergency stop engaged');
          return 'The emergency stop is engaged. Clearing it requires the local dashboard and re-authentication; /resume cannot do it.';
        }
        if (!switches.globalPause) {
          record('ok', 'hold', 'Telegram /resume: not paused');
          return 'Automation is not paused.';
        }
        this.#d.state.setGlobalPause(false, null, 'telegram');
        record('ok', 'ok', 'Telegram /resume cleared the global pause');
        return 'Automation resumed.';
      }

      case 'emergency':
        return this.#emergency(command, args, now, record);

      default:
        record('ok', 'hold', `Telegram unknown command /${word}`);
        return 'Unknown command. Send /help for the list.';
    }
  }

  // --- pairing -----------------------------------------------------------------------

  #pair(command: InboundCommand, args: string[], now: number): string | null {
    const identity = command.telegram;
    if (command.source === 'gateway') {
      // The gateway answers /pair itself; a forwarded one means it chose not to.
      this.#recordCommand(command, 'pair', 'refused');
      return 'Pairing is handled by the bot: send /pair CODE with the code from your dashboard.';
    }

    const gate = this.#pairAttempts.take(String(identity.userId), now);
    if (!gate.allowed) {
      this.#recordCommand(command, 'pair', 'rate_limited');
      if (gate.denials === 1) {
        this.#audit(
          command,
          'pair',
          'telegram.ratelimited',
          'rejected',
          'Telegram pairing attempts rate limited',
        );
        return 'Too many pairing attempts. Wait ten minutes and generate a fresh code.';
      }
      return null;
    }

    const code = args[0];
    if (!code) {
      this.#recordCommand(command, 'pair', 'refused');
      return 'Send /pair CODE with the code shown in your dashboard.';
    }

    const result = this.#d.pairing.verify(code, identity, 'direct');
    if (!result.ok) {
      this.#recordCommand(command, 'pair', 'refused');
      return 'That code is not valid or has expired. Generate a new one in the dashboard.';
    }
    this.#recordCommand(command, 'pair', 'ok');
    return `Paired with ${this.#d.installationName()}. Send /help for the list of commands.`;
  }

  // --- emergency -----------------------------------------------------------------------

  #emergency(
    command: InboundCommand,
    args: string[],
    now: number,
    record: (outcome: CommandOutcome, status: AuditStatus, summary: string, extra?: object) => void,
  ): string {
    const argument = (args[0] ?? '').toUpperCase();
    const switches = this.#d.state.getSwitches();

    if (
      argument === 'CLEAR' ||
      argument === 'OFF' ||
      argument === 'RESET' ||
      argument === 'RESUME'
    ) {
      record('refused', 'rejected', 'Telegram /emergency clear refused', { argument });
      return 'Clearing the emergency stop requires the local dashboard and re-authentication. It cannot be cleared from Telegram.';
    }

    if (switches.emergencyStop) {
      record('ok', 'hold', 'Telegram /emergency: already engaged');
      return `The emergency stop is already engaged${switches.emergencyReason ? ` (${switches.emergencyReason})` : ''}. Clearing it requires the local dashboard.`;
    }

    if (argument === 'CONFIRM') {
      const challenge = this.#emergencyChallenge;
      const valid =
        challenge !== null &&
        challenge.userId === command.telegram.userId &&
        now - challenge.issuedAt <= COMMAND_LIMITS.emergencyChallengeMs;
      if (!valid) {
        this.#emergencyChallenge = null;
        record('refused', 'rejected', 'Telegram /emergency CONFIRM without a live challenge', {
          argument,
        });
        return 'No pending emergency challenge (they expire after 60 seconds). Send /emergency first.';
      }
      this.#emergencyChallenge = null;
      // One database row, no model, no network. StateStore also drops LIVE to
      // PAPER and its hook disarms the scheduler.
      this.#d.state.setEmergencyStop(
        true,
        `engaged from Telegram by ${command.telegram.displayName}`,
        'telegram',
      );
      record('ok', 'ok', 'Telegram /emergency CONFIRM engaged the emergency stop', { argument });
      return 'EMERGENCY STOP ENGAGED. Automation is halted, the scheduler is disabled and the runtime is in PAPER mode. Open positions were not closed. Clearing the stop requires the local dashboard.';
    }

    this.#emergencyChallenge = { userId: command.telegram.userId, issuedAt: now };
    record('ok', 'pending', 'Telegram /emergency challenge issued');
    return 'Emergency stop: this halts all automation, disables the scheduler and drops the runtime to PAPER. Open positions are NOT closed.\nTo confirm, send /emergency CONFIRM within 60 seconds.';
  }

  // --- alerts -------------------------------------------------------------------------

  #alerts(
    command: InboundCommand,
    args: string[],
    record: (outcome: CommandOutcome, status: AuditStatus, summary: string, extra?: object) => void,
  ): string {
    const argument = (args[0] ?? 'status').toLowerCase();
    const actor = `telegram:${maskUserId(command.telegram.userId)}`;
    if (argument === 'on' || argument === 'off') {
      this.#d.notifier.setAlertsEnabled(argument === 'on', actor);
      record('ok', 'ok', `Telegram /alerts ${argument}`, { argument });
    } else if (argument !== 'status') {
      record('ok', 'hold', 'Telegram /alerts with an unknown argument');
      return 'Usage: /alerts on | off | status';
    } else {
      record('ok', 'ok', 'Telegram /alerts status', { argument });
    }
    const toggles = this.#d.notifier.toggles();
    const on = (value: boolean) => (value ? 'on' : 'off');
    return [
      `Alerts: ${on(this.#d.notifier.alertsEnabled())}`,
      `Risk rejections: ${on(toggles.riskRejections)}`,
      `Trade decisions: ${on(toggles.tradeDecisions)}`,
      `Liquidity updates: ${on(toggles.liquidityUpdates)}`,
      `Runtime alerts: ${on(toggles.runtimeAlerts)}`,
      'Categories are set in the dashboard; /alerts on|off is the master switch.',
    ].join('\n');
  }

  // --- reads --------------------------------------------------------------------------

  async #status(now: number): Promise<string> {
    const d = this.#d;
    const mode = d.state.getMode();
    const switches = d.state.getSwitches();
    const installation = d.state.getInstallation();
    const scheduler = d.scheduler.status();
    const model = await this.#modelStatus();
    const transport = d.transportKind();

    const lines = [
      `ATRA — ${d.installationName()}`,
      `Mode: ${mode}`,
      `Paused: ${yesNo(switches.globalPause)}${switches.pausedReason ? ` (${switches.pausedReason})` : ''}`,
      `Emergency stop: ${yesNo(switches.emergencyStop)}${switches.emergencyReason ? ` (${switches.emergencyReason})` : ''}`,
      `Uptime: ${fmtDuration(now - d.startedAt())}`,
      scheduler.enabled
        ? `Auto-trade: on, every ${String(scheduler.intervalSeconds)} s${scheduler.running ? ', running now' : ''}, next ${fmtTime(scheduler.nextRunAt)}`
        : 'Auto-trade: off',
      `Last cycle: ${scheduler.lastCycleStatus ? `${scheduler.lastCycleStatus} at ${fmtTime(scheduler.lastCycleAt)}` : 'none yet'}`,
      `Chains: ${(installation?.enabledChains ?? []).map(chainLabel).join(', ') || 'none'}`,
      `Model: ${model}`,
      `Telegram: ${transport ?? 'not configured'}${transport ? (d.transportConnected() ? ', connected' : ', disconnected') : ''}`,
    ];
    return lines.join('\n');
  }

  /** UNTRAINED when a model answers, UNAVAILABLE otherwise. Never blocks for long. */
  async #modelStatus(): Promise<string> {
    const llm = this.#d.llm;
    if (!llm) return 'UNAVAILABLE (no model wired)';
    try {
      const probe = await Promise.race([
        llm.available(),
        new Promise<{ available: boolean; detail: string }>((resolve) => {
          setTimeout(
            () => resolve({ available: false, detail: 'probe timed out' }),
            COMMAND_LIMITS.modelProbeTimeoutMs,
          ).unref();
        }),
      ]);
      return probe.available ? 'UNTRAINED (endpoint reachable)' : 'UNAVAILABLE';
    } catch {
      return 'UNAVAILABLE';
    }
  }

  async #portfolio(withTotals: boolean): Promise<string> {
    const d = this.#d;
    const mode = d.state.getMode();
    const lookup = await positionPriceLookup(d.ledger, d.market, mode);
    const mark = d.ledger.mark(mode, lookup);

    const lines: string[] = [withTotals ? `Portfolio (${mode})` : `Positions (${mode})`];
    if (withTotals) {
      lines.push(
        `Positions: ${String(mark.positions.length)}${mark.unpriced.length > 0 ? ` (${String(mark.unpriced.length)} unpriced)` : ''}`,
        `Value: ${mark.positionsValueUsd === null ? 'unknown (a position has no reliable price)' : fmtUsd(mark.positionsValueUsd)}`,
        `Deployed: ${fmtUsd(mark.deployedUsd)}`,
        `Unrealized P&L: ${mark.unrealizedPnlUsd === null ? 'unknown' : fmtUsd(mark.unrealizedPnlUsd, { signed: true })}`,
        `Realized today: ${fmtUsd(mark.realizedPnlTodayUsd, { signed: true })}`,
      );
    }
    if (mark.positions.length === 0) {
      lines.push('No open positions.');
      return lines.join('\n');
    }
    lines.push('');
    for (const position of mark.positions.slice(0, 20)) {
      const size = fmtUnits(position.amount, position.decimals);
      const pnl =
        position.unrealizedUsd === null
          ? ''
          : ` (${fmtUsd(position.unrealizedUsd, { signed: true })})`;
      lines.push(
        `- ${chainLabel(position.chain)} ${tokenLabel(position.chain, position.token)} ${size} · cost ${fmtUsd(position.costBasisUsd)} · mark ${position.markUsd === null ? 'unknown' : fmtUsd(position.markUsd)}${pnl}`,
      );
    }
    if (mark.positions.length > 20) {
      lines.push(`… and ${String(mark.positions.length - 20)} more`);
    }
    return lines.join('\n');
  }

  #trades(): string {
    const trades = this.#d.trades.list({ limit: 5 });
    if (trades.length === 0) return 'No trades yet.';
    const lines = ['Last 5 trades'];
    for (const trade of trades) {
      const size = trade.amountInUsd === null ? '' : ` ${fmtUsd(trade.amountInUsd)}`;
      const outcome =
        trade.status === 'rejected'
          ? `rejected (${trade.rejectionCode ?? '?'})`
          : trade.status === 'failed'
            ? 'failed'
            : trade.status;
      lines.push(
        `- ${fmtTime(trade.proposedAt)} ${trade.mode} ${chainLabel(trade.chain)} ${trade.kind} ${tokenLabel(trade.chain, trade.tokenIn)}→${tokenLabel(trade.chain, trade.tokenOut)}${size} · ${outcome}`,
      );
    }
    return lines.join('\n');
  }

  async #lp(): Promise<string> {
    const liquidity = this.#d.liquidity;
    if (!liquidity) return 'LP not available in this build.';
    try {
      const text = await liquidity.summary();
      return text.trim() || 'No liquidity positions.';
    } catch (error) {
      this.#log.warn({ err: errorMessage(error) }, 'LP summary failed');
      return 'LP summary is unavailable right now.';
    }
  }

  async #risk(): Promise<string> {
    const d = this.#d;
    if (!d.riskPolicy.exists())
      return 'No risk policy is configured yet. Set one in the dashboard.';
    const policy = d.riskPolicy.get();
    const version = d.riskPolicy.version();
    const mode = d.state.getMode();
    const switches = d.state.getSwitches();

    const lookup = await positionPriceLookup(d.ledger, d.market, mode);
    const ledger = d.ledger.toRiskLedger(mode, lookup);
    const dailyLoss = microsToUsd(dailyLossMicros(ledger, policy.dailyLoss.includeUnrealized));
    const lossPct = percentOf(dailyLoss, policy.maxDailyLossUsd);
    const deployedPct = percentOf(ledger.deployedUsd, policy.maxTotalDeployedUsd);

    return [
      `Risk limits (policy v${String(version)})`,
      `Per trade: ${fmtUsd(policy.maxAmountPerTradeUsd)} · Daily loss: ${fmtUsd(policy.maxDailyLossUsd)} · Deployed cap: ${fmtUsd(policy.maxTotalDeployedUsd)}`,
      `Fee cap: ${fmtUsd(policy.maxTransactionFeeUsd)} · Slippage: ${String(policy.maxSlippageBps)} bps · Price impact: ${String(policy.maxPriceImpactBps)} bps · Min liquidity: ${fmtUsd(policy.minLiquidityUsd)}`,
      `Cooldown: ${String(policy.cooldownSeconds)} s · Global interval: ${String(policy.globalMinIntervalSeconds)} s`,
      `Chains: ${policy.enabledChains.map(chainLabel).join(', ')}`,
      '',
      `Usage today (${mode})`,
      `Daily loss: ${fmtUsd(dailyLoss)}${lossPct === null ? '' : ` (${String(lossPct)}% of limit)`}`,
      `Deployed: ${fmtUsd(ledger.deployedUsd)}${deployedPct === null ? '' : ` (${String(deployedPct)}% of cap)`}`,
      `Paused: ${yesNo(switches.globalPause)} · Emergency stop: ${yesNo(switches.emergencyStop)}`,
    ].join('\n');
  }

  // --- bookkeeping -----------------------------------------------------------------------

  #cursor(chatId: number): number | undefined {
    const row = this.#d.db
      .prepare<[number], { last_update_id: number }>(
        'SELECT last_update_id FROM telegram_chat_cursor WHERE chat_id = ?',
      )
      .get(chatId);
    return row?.last_update_id;
  }

  #setCursor(chatId: number, updateId: number, now: number): void {
    this.#d.db
      .prepare(
        'INSERT INTO telegram_chat_cursor (chat_id, last_update_id, updated_at) VALUES (?, ?, ?)' +
          ' ON CONFLICT(chat_id) DO UPDATE SET last_update_id = MAX(last_update_id, excluded.last_update_id),' +
          ' updated_at = excluded.updated_at',
      )
      .run(chatId, updateId, new Date(now).toISOString());
  }

  /** The append-only record of every message, by command word only. */
  #recordCommand(command: InboundCommand, word: string, outcome: CommandOutcome): void {
    this.#d.db
      .prepare(
        'INSERT INTO telegram_commands (received_at, transport, update_id, chat_id, user_id, command, outcome)' +
          ' VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        new Date(this.#now()).toISOString(),
        command.source,
        command.updateId,
        command.telegram.chatId,
        command.telegram.userId,
        word.slice(0, 32),
        outcome,
      );
  }

  #audit(
    command: InboundCommand,
    word: string,
    action: string,
    status: AuditStatus,
    summary: string,
    extra: object = {},
  ): void {
    this.#d.audit.append({
      category: 'telegram',
      action,
      status,
      summary,
      actor: `telegram:${maskUserId(command.telegram.userId)}`,
      mode: this.#d.state.getMode(),
      correlationId: command.requestId,
      detail: {
        command: word.slice(0, 32),
        updateId: command.updateId,
        source: command.source,
        ...extra,
      },
    });
  }
}

export function helpText(): string {
  return [
    'ATRA commands',
    '/status — mode, switches, scheduler, model',
    '/portfolio — positions marked at current prices',
    '/positions — open positions',
    '/trades — the last 5 trades',
    '/lp — liquidity positions',
    '/risk — limits and today’s usage',
    '/pause — pause automation',
    '/resume — resume automation',
    '/emergency — engage the emergency stop (asks for confirmation)',
    '/alerts on|off|status — notifications',
    '/help — this list',
    '',
    'Not available here: wallet export, withdrawals, risk-policy changes and clearing an emergency stop. Those need the local dashboard.',
  ].join('\n');
}
