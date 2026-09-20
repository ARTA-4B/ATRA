import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { StateStore } from '../core/state.js';
import type { LedgerService } from '../trading/ledger.js';
import type { TradeStore } from '../trading/trades.js';
import type { RiskPolicyStore } from '../risk/store.js';
import type { WalletService } from '../wallet/service.js';
import type { MarketService } from '../market/service.js';
import type { AutoTradeScheduler } from '../trading/scheduler.js';
import type { CycleReport } from '../trading/pipeline.js';
import type { LlmProvider } from '../llm/provider.js';
import type { RuntimeConfig, TelegramSecrets } from '../config/env.js';
import { AppError } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import { PairingService } from './pairing.js';
import { CommandRouter } from './commands.js';
import { DailyLossWatcher, GasWatcher, Notifier } from './notifications.js';
import type { DailyLossUsage, NotificationRecord, NotifyOutcome } from './notifications.js';
import { DirectBotTransport, GatewayTransport } from './transport.js';
import type { TelegramTransport, Timers, TransportEvents, TransportStatus } from './transport.js';
import { fmtUsd, shortAddress, tokenLabel } from './format.js';
import type {
  InboundCommand,
  LiquiditySummary,
  NotificationEvent,
  NotificationToggles,
  PairCode,
  PairStatus,
  TelegramIdentity,
  TelegramView,
  TransportKind,
} from './types.js';
import { TELEGRAM_NOT_CONFIGURED, maskUserId } from './types.js';

/**
 * The Telegram facade the composition root constructs and the routes call.
 *
 * It owns the transport (or none), the pairing store, the command router and
 * the notifier, and it is the only thing that touches the transport. It is
 * built to be constructed with nothing configured: every method then reports
 * "not configured" instead of failing, because a runtime without Telegram is
 * a perfectly good runtime.
 */

export const RUNTIME_VERSION = '0.1.0';

export interface TelegramServiceDeps {
  db: Db;
  audit: AuditLog;
  state: StateStore;
  ledger: LedgerService;
  trades: TradeStore;
  riskPolicy: RiskPolicyStore;
  wallets: WalletService;
  market: MarketService;
  scheduler: AutoTradeScheduler;
  config: RuntimeConfig;
  liquidity?: LiquiditySummary | undefined;
  llm?: LlmProvider | undefined;
  /** From {@link readTelegramSecrets}. Absent means no transport can be built. */
  secrets?: TelegramSecrets | undefined;
  /** Test injection. `null` forces "not configured" regardless of config. */
  transport?: TelegramTransport | null | undefined;
  startedAt?: Date | undefined;
  timers?: Timers | undefined;
  now?: (() => number) | undefined;
  runtimeVersion?: string | undefined;
}

export interface TelegramStatus {
  transport: TransportStatus | null;
  paired: boolean;
  alertsEnabled: boolean;
  notifications: NotificationToggles;
  recent: NotificationRecord[];
}

export class TelegramService {
  readonly #d: TelegramServiceDeps;
  readonly #now: () => number;
  readonly #log = childLogger('telegram');
  readonly #pairing: PairingService;
  readonly #notifier: Notifier;
  readonly #router: CommandRouter;
  readonly #gas: GasWatcher;
  readonly #dailyLoss: DailyLossWatcher;
  readonly #transport: TelegramTransport | null;
  readonly #startedAt: number;
  #started = false;
  #connected = false;

  constructor(deps: TelegramServiceDeps) {
    this.#d = deps;
    this.#now = deps.now ?? (() => Date.now());
    this.#startedAt = (deps.startedAt ?? new Date(this.#now())).getTime();

    this.#pairing = new PairingService({ db: deps.db, audit: deps.audit, now: this.#now });
    this.#notifier = new Notifier({
      db: deps.db,
      audit: deps.audit,
      send: (event, text) => this.#deliver(event, text),
      isPaired: () => this.#pairing.link() !== undefined,
      mode: () => deps.state.getMode(),
      now: this.#now,
    });

    this.#transport = deps.transport !== undefined ? deps.transport : this.#buildTransport();

    this.#router = new CommandRouter({
      db: deps.db,
      audit: deps.audit,
      state: deps.state,
      ledger: deps.ledger,
      trades: deps.trades,
      riskPolicy: deps.riskPolicy,
      market: deps.market,
      scheduler: deps.scheduler,
      pairing: this.#pairing,
      notifier: this.#notifier,
      liquidity: deps.liquidity,
      llm: deps.llm,
      transportKind: () => this.transportKind,
      transportConnected: () => this.#connected,
      installationName: () => this.#installationName(),
      startedAt: () => this.#startedAt,
      now: this.#now,
    });

    this.#gas = new GasWatcher({
      wallets: deps.wallets,
      state: deps.state,
      notifier: this.#notifier,
      isPaired: () => this.#pairing.link() !== undefined,
      ...(deps.timers ? { timers: deps.timers } : {}),
    });
    this.#dailyLoss = new DailyLossWatcher({
      ledger: deps.ledger,
      riskPolicy: deps.riskPolicy,
      market: deps.market,
      state: deps.state,
      notifier: this.#notifier,
      now: this.#now,
    });
  }

  // --- dashboard ---------------------------------------------------------------

  get transportKind(): TransportKind | null {
    return this.#transport?.kind ?? null;
  }

  get configured(): boolean {
    return this.#transport !== null;
  }

  view(): TelegramView {
    const link = this.#pairing.link();
    const username = this.#botUsername();
    return {
      configured: this.configured,
      paired: link !== undefined,
      botUrl: username ? `https://t.me/${username}` : null,
      botUsername: username,
      account: link
        ? {
            displayName: link.displayName,
            userIdMasked: maskUserId(link.userId),
            pairedAt: link.pairedAt,
          }
        : null,
      installation: this.#installationName(),
      notifications: this.#notifier.toggles(),
      transport: this.transportKind,
      connected: this.#connected,
      alertsEnabled: this.#notifier.alertsEnabled(),
    };
  }

  status(): TelegramStatus {
    return {
      transport: this.#transport?.status() ?? null,
      paired: this.#pairing.link() !== undefined,
      alertsEnabled: this.#notifier.alertsEnabled(),
      notifications: this.#notifier.toggles(),
      recent: this.#notifier.recent(),
    };
  }

  issuePairCode(): PairCode {
    const transport = this.#transport;
    if (!transport) {
      throw new AppError(
        TELEGRAM_NOT_CONFIGURED,
        'Telegram is not configured: set ATRA_GATEWAY_URL and ATRA_GATEWAY_TOKEN, or ATRA_TELEGRAM_BOT_TOKEN',
        { status: 409 },
      );
    }

    const issued = this.#pairing.issue(transport.kind);
    // The offer is best-effort: a disconnected gateway gets it again on the
    // next welcome, from the pending row. The dashboard shows the code either way.
    transport.offerPairCode(issued.codeHash, issued.expiresAt).catch((error: unknown) => {
      this.#log.warn({ err: error }, 'pair offer not sent; will retry on reconnect');
    });

    const username = this.#botUsername();
    return {
      code: issued.code,
      command: `/pair ${issued.code}`,
      expiresAt: new Date(issued.expiresAt).toISOString(),
      botUrl: username ? `https://t.me/${username}` : null,
    };
  }

  pairStatus(code: string): PairStatus {
    return this.#pairing.status(code);
  }

  unpair(actor = 'operator'): TelegramView {
    this.#pairing.unpair(actor, 'requested from the dashboard');
    this.#transport?.revokePairing().catch((error: unknown) => {
      this.#log.warn({ err: error }, 'pair.revoke not sent');
    });
    return this.view();
  }

  setNotifications(partial: Partial<NotificationToggles>, actor = 'operator'): TelegramView {
    this.#notifier.setToggles(partial, actor);
    return this.view();
  }

  // --- notifications -------------------------------------------------------------

  /** Never throws; the outcome says what happened. */
  async notify(event: NotificationEvent): Promise<NotifyOutcome> {
    return this.#notifier.notify(event);
  }

  /** Hook for StateStore.onEmergencyStop. */
  onEmergencyStop(active: boolean, reason: string | null): void {
    void this.notify({
      kind: active ? 'emergency.engaged' : 'emergency.cleared',
      summary: active
        ? `Emergency stop engaged: ${reason ?? 'no reason given'}. Automation halted; runtime is in PAPER mode.`
        : 'Emergency stop cleared from the dashboard. Automation stays off until re-enabled.',
      dedupeKey: `emergency:${active ? 'on' : 'off'}:${String(this.#now())}`,
    });
  }

  /** Hook for StateStore.onPauseChanged. */
  onPauseChanged(paused: boolean, reason: string | null, actor: string): void {
    void this.notify({
      kind: paused ? 'paused' : 'resumed',
      summary: paused
        ? `Automation paused by ${actor}${reason ? `: ${reason}` : ''}.`
        : `Automation resumed by ${actor}.`,
      dedupeKey: `pause:${paused ? 'on' : 'off'}:${String(this.#now())}`,
    });
  }

  /**
   * Hook for the pipeline: one call per finished cycle. Raises the trade
   * notification the outcome warrants, then checks the daily-loss threshold.
   */
  async onCycleReport(report: CycleReport): Promise<void> {
    try {
      const trade = report.trade ? this.#d.trades.get(report.trade.tradeId) : undefined;
      const pair = trade
        ? `${tokenLabel(trade.chain, trade.tokenIn)}→${tokenLabel(trade.chain, trade.tokenOut)}`
        : null;
      const size = trade?.amountInUsd ? ` for ${fmtUsd(trade.amountInUsd)}` : '';

      if (report.outcome === 'filled') {
        await this.notify({
          kind: 'trade.filled',
          chain: report.chain,
          summary: `${trade?.kind ?? 'trade'} ${pair ?? ''}${size} filled in ${report.mode} mode.`,
          ...(report.execution?.txHash
            ? { detail: `tx ${shortAddress(report.execution.txHash)}` }
            : {
                detail:
                  report.mode === 'PAPER' ? 'Simulated fill; no chain was touched.' : undefined,
              }),
          correlationId: report.cycleId,
          dedupeKey: `trade.filled:${report.trade?.tradeId ?? report.cycleId}`,
        });
      } else if (report.outcome === 'rejected') {
        await this.notify({
          kind: 'trade.rejected',
          chain: report.chain,
          summary: `${trade?.kind ?? 'trade'} ${pair ?? ''}${size} rejected: ${report.risk?.code ?? 'UNKNOWN'}.`,
          detail: report.risk?.reason.slice(0, 200),
          correlationId: report.cycleId,
          rejectionCode: report.risk?.code ?? 'UNKNOWN',
          dedupeKey: `trade.rejected:${report.trade?.tradeId ?? report.cycleId}`,
        });
      } else if (report.outcome === 'failed') {
        await this.notify({
          kind: 'trade.failed',
          chain: report.chain,
          summary: `${trade?.kind ?? 'trade'} ${pair ?? ''}${size} failed in ${report.mode} mode.`,
          detail: report.reason.slice(0, 200),
          correlationId: report.cycleId,
          dedupeKey: `trade.failed:${report.trade?.tradeId ?? report.cycleId}`,
        });
      }
    } catch (error) {
      this.#log.warn({ err: error }, 'cycle notification failed');
    }
    await this.checkDailyLoss();
  }

  /** Hook for the orchestrator after each cycle, or on its own schedule. */
  async checkDailyLoss(usage?: DailyLossUsage): Promise<boolean> {
    try {
      return await this.#dailyLoss.check(usage);
    } catch (error) {
      this.#log.warn({ err: error }, 'daily loss check failed');
      return false;
    }
  }

  checkGas(): Promise<Array<{ chain: string; gasLow: boolean | null }>> {
    return this.#gas.check();
  }

  // --- lifecycle ---------------------------------------------------------------------

  start(): Promise<void> {
    if (this.#started) return Promise.resolve();
    this.#started = true;
    const transport = this.#transport;
    if (!transport) {
      this.#log.info('telegram not configured; remote control is off');
      return Promise.resolve();
    }
    transport.start(this.#events());
    this.#gas.start();
    this.#log.info({ transport: transport.kind }, 'telegram transport starting');
    return Promise.resolve();
  }

  /** Best-effort offline notice, then release the transport. Safe to call twice. */
  async stop(): Promise<void> {
    if (!this.#started) return;
    this.#started = false;
    this.#gas.stop();
    if (this.#connected && this.#pairing.link()) {
      await Promise.race([
        this.notify({
          kind: 'runtime.offline',
          summary: 'The runtime is shutting down. Automation stops with it.',
          dedupeKey: `runtime.offline:${String(this.#now())}`,
        }),
        new Promise<void>((resolve) => {
          setTimeout(resolve, 2_000).unref();
        }),
      ]);
    }
    this.#connected = false;
    await this.#transport?.stop();
  }

  /** Direct entry for tests and for a fake transport. */
  handleCommand(command: InboundCommand): Promise<string | null> {
    return this.#router.handle(command);
  }

  // --- internals -----------------------------------------------------------------------

  #events(): TransportEvents {
    return {
      onCommand: (command) => this.#router.handle(command),
      onPaired: (identity, pairedAt) => {
        const link = this.#pairing.confirmFromGateway(identity, pairedAt);
        if (!link) {
          this.#log.error(
            { userIdMasked: maskUserId(identity.userId) },
            'gateway pairing refused: another Telegram account tried to take the link',
          );
        }
      },
      onUnpaired: (reason) => {
        this.#pairing.unpair('gateway', reason.slice(0, 200));
      },
      onWelcome: (welcome) => this.#reconcile(welcome),
      onConnected: () => {
        this.#connected = true;
        void this.notify({
          kind: 'runtime.online',
          summary: `Runtime online in ${this.#d.state.getMode()} mode.`,
          dedupeKey: 'runtime.online',
        });
      },
      onDisconnected: (reason) => {
        this.#connected = false;
        this.#log.warn({ reason }, 'telegram transport disconnected');
      },
      onSuperseded: () => {
        this.#d.audit.append({
          category: 'telegram',
          action: 'telegram.transport.superseded',
          status: 'failed',
          summary:
            "Another client connected to the gateway with this installation's token. If you did not just restart ATRA, revoke and reissue the token.",
          actor: 'system',
        });
        this.#log.error('gateway session superseded by another client');
      },
      onRevoked: () => {
        this.#d.audit.append({
          category: 'telegram',
          action: 'telegram.transport.revoked',
          status: 'failed',
          summary:
            'The gateway revoked this installation token. Telegram stays offline until a new token is issued.',
          actor: 'system',
        });
        this.#log.error('gateway installation token revoked; telegram transport stopped');
      },
    };
  }

  /**
   * On every gateway welcome, make the two sides agree — and when they do not,
   * fail closed. The runtime's own row decides who may command it; a gateway
   * that claims a different user, or one we never recorded, is told to drop
   * its link rather than trusted.
   */
  #reconcile(welcome: {
    paired: boolean;
    telegram: TelegramIdentity | null;
    botUsername: string;
  }): void {
    const local = this.#pairing.link();
    const revoke = (why: string): void => {
      this.#log.warn({ why }, 'revoking gateway pairing');
      this.#transport?.revokePairing().catch((error: unknown) => {
        this.#log.warn({ err: error }, 'pair.revoke not sent');
      });
    };

    if (local) {
      if (!welcome.paired) {
        this.#pairing.unpair('system', 'the gateway reports no pairing');
      } else if (welcome.telegram && welcome.telegram.userId !== local.userId) {
        this.#pairing.unpair('system', 'the gateway reports a different Telegram user');
        revoke('identity mismatch');
      }
    } else if (welcome.paired) {
      revoke('gateway paired but the runtime has no record of it');
    }

    // A code issued while the gateway was unreachable is offered now.
    const pending = this.#pairing.pending();
    if (pending && this.#pairing.link() === undefined) {
      this.#transport
        ?.offerPairCode(pending.codeHash, pending.expiresAt)
        .catch((error: unknown) => {
          this.#log.warn({ err: error }, 'pending pair offer not sent');
        });
    }
  }

  async #deliver(event: NotificationEvent, text: string): Promise<void> {
    const transport = this.#transport;
    if (!transport) throw new Error('telegram not configured');
    await transport.notify(event.kind, text);
  }

  #buildTransport(): TelegramTransport | null {
    const { config, secrets } = this.#d;
    const telegram = config.telegram;

    if (telegram.transport === 'gateway') {
      if (!telegram.gatewayUrl || !secrets?.gatewayToken) {
        this.#log.warn(
          'ATRA_GATEWAY_URL is set but no gateway token was provided; Telegram is off',
        );
        return null;
      }
      return new GatewayTransport({
        url: telegram.gatewayUrl,
        token: secrets.gatewayToken,
        installationId: () => this.#d.state.getInstallation()?.id ?? 'pending-setup',
        runtimeVersion: this.#d.runtimeVersion ?? RUNTIME_VERSION,
        ...(this.#d.timers ? { timers: this.#d.timers } : {}),
        now: this.#now,
      });
    }

    if (telegram.transport === 'direct') {
      if (!secrets?.botToken) {
        this.#log.warn(
          'ATRA_TELEGRAM_BOT_TOKEN is set but was not passed to the service; Telegram is off',
        );
        return null;
      }
      return new DirectBotTransport({
        token: secrets.botToken,
        username: telegram.botUsername,
        offset: {
          load: () => this.#notifier.pollOffset(),
          save: (offset) => {
            this.#notifier.setPollOffset(offset);
          },
        },
        linkedChatId: () => this.#pairing.link()?.chatId,
        ...(this.#d.timers ? { timers: this.#d.timers } : {}),
        now: this.#now,
      });
    }

    return null;
  }

  #botUsername(): string | null {
    return this.#transport?.status().botUsername ?? this.#d.config.telegram.botUsername ?? null;
  }

  #installationName(): string {
    return this.#d.state.getInstallation()?.name ?? '';
  }
}
