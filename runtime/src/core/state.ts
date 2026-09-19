import type { Db } from '../db/database.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import type { AuditLog } from '../audit/audit.js';
import type { ActivationState, Mode, RuntimeState } from '../risk/types.js';
import type { ChainId } from '../chains/registry.js';

/**
 * Runtime switches: mode, global pause and emergency stop.
 *
 * These are the controls an operator reaches for when something is wrong, so
 * they are deliberately the least clever part of the system:
 *
 *  - they live in their own SQLite table and are read straight from it, so
 *    nothing needs to be running for the stop to take effect;
 *  - stopping requires no model, no network and no scheduler tick;
 *  - the state survives a restart, because an emergency stop that forgets
 *    itself on reboot is not an emergency stop.
 *
 * PAPER is the default and the only mode a fresh install can be in. Reaching
 * LIVE requires every step of {@link LiveActivation} to be satisfied
 * explicitly; there is no code path that flips it automatically.
 */

export const LIVE_SESSION_TTL_MS = 12 * 60 * 60 * 1_000;

interface InstallationRow {
  id: string;
  name: string;
  created_at: string;
  mode: Mode;
  setup_completed: number;
  enabled_chains: string;
}

interface RuntimeStateRow {
  global_pause: number;
  emergency_stop: number;
  paused_reason: string | null;
  emergency_reason: string | null;
  updated_at: string;
}

interface LiveActivationRow {
  acknowledged_at: string | null;
  reauth_at: string | null;
  risk_reviewed_at: string | null;
  wallet_funded_at: string | null;
  gas_checked_at: string | null;
  adapter_checked_at: string | null;
  activated_at: string | null;
}

export interface Installation {
  id: string;
  name: string;
  createdAt: string;
  mode: Mode;
  setupCompleted: boolean;
  enabledChains: ChainId[];
}

export interface LiveActivationProgress {
  acknowledged: boolean;
  reauthenticated: boolean;
  riskReviewed: boolean;
  walletFunded: boolean;
  gasChecked: boolean;
  adapterChecked: boolean;
  activatedAt: string | null;
  /** Steps still outstanding, in the order the dashboard should present them. */
  missing: string[];
}

export type ActivationStep =
  | 'acknowledged'
  | 'reauthenticated'
  | 'riskReviewed'
  | 'walletFunded'
  | 'gasChecked'
  | 'adapterChecked';

const STEP_COLUMNS: Record<ActivationStep, string> = {
  acknowledged: 'acknowledged_at',
  reauthenticated: 'reauth_at',
  riskReviewed: 'risk_reviewed_at',
  walletFunded: 'wallet_funded_at',
  gasChecked: 'gas_checked_at',
  adapterChecked: 'adapter_checked_at',
};

export class StateStore {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #log = childLogger('state');

  constructor(db: Db, audit: AuditLog) {
    this.#db = db;
    this.#audit = audit;
    this.#ensureRows();
  }

  #ensureRows(): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'INSERT INTO runtime_state (id, global_pause, emergency_stop, updated_at)' +
          ' VALUES (1, 0, 0, ?) ON CONFLICT(id) DO NOTHING',
      )
      .run(now);
    this.#db
      .prepare('INSERT INTO live_activation (id, updated_at) VALUES (1, ?) ON CONFLICT(id) DO NOTHING')
      .run(now);
  }

  // --- installation --------------------------------------------------------

  getInstallation(): Installation | undefined {
    const row = this.#db
      .prepare<[], InstallationRow>('SELECT * FROM installation WHERE singleton = 1')
      .get();
    if (!row) return undefined;
    return {
      id: row.id,
      name: row.name,
      createdAt: row.created_at,
      mode: row.mode,
      setupCompleted: row.setup_completed === 1,
      enabledChains: JSON.parse(row.enabled_chains) as ChainId[],
    };
  }

  createInstallation(id: string, name: string, enabledChains: ChainId[]): Installation {
    if (this.getInstallation()) {
      throw new AppError(ErrorCode.ALREADY_INITIALIZED, 'This installation already exists');
    }
    // Always PAPER at creation. There is no parameter to change that.
    this.#db
      .prepare(
        'INSERT INTO installation (id, name, created_at, mode, setup_completed, enabled_chains,' +
          ' singleton) VALUES (?, ?, ?, ?, 0, ?, 1)',
      )
      .run(id, name, new Date().toISOString(), 'PAPER', JSON.stringify(enabledChains));

    this.#audit.append({
      category: 'setup',
      action: 'installation.created',
      status: 'ok',
      summary: `Installation ${name} created in PAPER mode`,
      mode: 'PAPER',
      detail: { installationId: id, enabledChains },
    });

    return this.getInstallation()!;
  }

  setEnabledChains(chains: ChainId[]): void {
    this.#db
      .prepare('UPDATE installation SET enabled_chains = ? WHERE singleton = 1')
      .run(JSON.stringify(chains));
  }

  completeSetup(): void {
    this.#db.prepare('UPDATE installation SET setup_completed = 1 WHERE singleton = 1').run();
    this.#audit.append({
      category: 'setup',
      action: 'setup.completed',
      status: 'ok',
      summary: 'First-run setup completed; running in PAPER mode',
      mode: 'PAPER',
    });
  }

  // --- pause / emergency ---------------------------------------------------

  getSwitches(): { globalPause: boolean; emergencyStop: boolean; pausedReason: string | null; emergencyReason: string | null } {
    const row = this.#db
      .prepare<[], RuntimeStateRow>('SELECT * FROM runtime_state WHERE id = 1')
      .get();
    return {
      globalPause: row?.global_pause === 1,
      emergencyStop: row?.emergency_stop === 1,
      pausedReason: row?.paused_reason ?? null,
      emergencyReason: row?.emergency_reason ?? null,
    };
  }

  setGlobalPause(paused: boolean, reason: string | null, actor: string): void {
    this.#db
      .prepare('UPDATE runtime_state SET global_pause = ?, paused_reason = ?, updated_at = ? WHERE id = 1')
      .run(paused ? 1 : 0, paused ? reason : null, new Date().toISOString());

    this.#audit.append({
      category: 'control',
      action: paused ? 'pause.enabled' : 'pause.cleared',
      status: 'ok',
      summary: paused ? `Automation paused: ${reason ?? 'no reason given'}` : 'Automation resumed',
      actor,
      mode: this.getMode(),
    });
    this.#log.warn({ paused, actor }, 'global pause changed');
  }

  /**
   * Engage or clear the emergency stop.
   *
   * Engaging it also drops LIVE mode back to PAPER: after an emergency the
   * operator must walk the activation checklist again rather than resuming
   * live trading with a single click.
   */
  setEmergencyStop(active: boolean, reason: string | null, actor: string): void {
    const now = new Date().toISOString();
    this.#db
      .prepare(
        'UPDATE runtime_state SET emergency_stop = ?, emergency_reason = ?, updated_at = ? WHERE id = 1',
      )
      .run(active ? 1 : 0, active ? reason : null, now);

    if (active) {
      this.#db.prepare("UPDATE installation SET mode = 'PAPER' WHERE singleton = 1").run();
      this.#db
        .prepare('UPDATE live_activation SET activated_at = NULL, updated_at = ? WHERE id = 1')
        .run(now);
    }

    this.#audit.append({
      category: 'control',
      action: active ? 'emergency.engaged' : 'emergency.cleared',
      status: 'ok',
      summary: active
        ? `Emergency stop engaged: ${reason ?? 'no reason given'}`
        : 'Emergency stop cleared',
      actor,
      mode: this.getMode(),
      detail: { revertedToPaper: active },
    });
    this.#log.error({ active, actor }, 'emergency stop changed');
  }

  // --- mode ----------------------------------------------------------------

  getMode(): Mode {
    const row = this.#db
      .prepare<[], { mode: Mode }>('SELECT mode FROM installation WHERE singleton = 1')
      .get();
    return row?.mode ?? 'PAPER';
  }

  getActivation(): LiveActivationProgress {
    const row = this.#db
      .prepare<[], LiveActivationRow>('SELECT * FROM live_activation WHERE id = 1')
      .get();

    const progress: LiveActivationProgress = {
      acknowledged: row?.acknowledged_at !== null && row?.acknowledged_at !== undefined,
      reauthenticated: row?.reauth_at !== null && row?.reauth_at !== undefined,
      riskReviewed: row?.risk_reviewed_at !== null && row?.risk_reviewed_at !== undefined,
      walletFunded: row?.wallet_funded_at !== null && row?.wallet_funded_at !== undefined,
      gasChecked: row?.gas_checked_at !== null && row?.gas_checked_at !== undefined,
      adapterChecked: row?.adapter_checked_at !== null && row?.adapter_checked_at !== undefined,
      activatedAt: row?.activated_at ?? null,
      missing: [],
    };

    progress.missing = (Object.keys(STEP_COLUMNS) as ActivationStep[]).filter(
      (step) => !progress[step],
    );
    return progress;
  }

  recordActivationStep(step: ActivationStep, actor: string): LiveActivationProgress {
    const now = new Date().toISOString();
    this.#db
      .prepare(`UPDATE live_activation SET ${STEP_COLUMNS[step]} = ?, updated_at = ? WHERE id = 1`)
      .run(now, now);

    this.#audit.append({
      category: 'mode',
      action: `live.step.${step}`,
      status: 'ok',
      summary: `LIVE activation step recorded: ${step}`,
      actor,
      mode: this.getMode(),
    });

    return this.getActivation();
  }

  /**
   * Switch to LIVE.
   *
   * Refuses unless every checklist step is present and neither stop switch is
   * engaged. The caller has already re-authenticated; this is the last gate.
   */
  activateLive(actor: string): Installation {
    const switches = this.getSwitches();
    if (switches.emergencyStop) {
      throw new AppError(ErrorCode.LIVE_ACTIVATION_INCOMPLETE, 'Clear the emergency stop first');
    }

    const progress = this.getActivation();
    if (progress.missing.length > 0) {
      throw new AppError(
        ErrorCode.LIVE_ACTIVATION_INCOMPLETE,
        'LIVE activation is incomplete',
        { details: { missing: progress.missing } },
      );
    }

    const now = new Date().toISOString();
    this.#db.prepare("UPDATE installation SET mode = 'LIVE' WHERE singleton = 1").run();
    this.#db
      .prepare('UPDATE live_activation SET activated_at = ?, updated_at = ? WHERE id = 1')
      .run(now, now);

    this.#audit.append({
      category: 'mode',
      action: 'mode.live',
      status: 'ok',
      summary: 'Switched to LIVE mode',
      actor,
      mode: 'LIVE',
    });
    this.#log.warn({ actor }, 'runtime switched to LIVE');

    return this.getInstallation()!;
  }

  /** Return to PAPER. Always allowed, never requires a checklist. */
  revertToPaper(actor: string, reason: string): Installation {
    const now = new Date().toISOString();
    this.#db.prepare("UPDATE installation SET mode = 'PAPER' WHERE singleton = 1").run();
    this.#db
      .prepare('UPDATE live_activation SET activated_at = NULL, updated_at = ? WHERE id = 1')
      .run(now);

    this.#audit.append({
      category: 'mode',
      action: 'mode.paper',
      status: 'ok',
      summary: `Switched back to PAPER mode: ${reason}`,
      actor,
      mode: 'PAPER',
    });

    return this.getInstallation()!;
  }

  // --- risk-engine view ----------------------------------------------------

  /**
   * Assemble the slice of state the risk engine needs.
   *
   * Cooldowns and the ledger come from their own stores in Phase 3; until then
   * they are empty, which is the safe default (no cooldown suppressed, no
   * phantom position that could authorise a reduce-only action).
   */
  toRiskState(options: {
    now: number;
    cooldowns?: Record<string, number>;
    lastAnyActionAt?: number | null;
    ledger?: RuntimeState['ledger'];
  }): RuntimeState {
    const switches = this.getSwitches();
    const activation = this.getActivation();
    const mode = this.getMode();

    const activationState: ActivationState =
      mode === 'LIVE' && activation.activatedAt !== null
        ? 'LIVE'
        : activation.missing.length === 0
          ? 'PENDING'
          : 'PAPER';

    const activatedAtMs =
      activation.activatedAt === null ? null : Date.parse(activation.activatedAt);

    return {
      mode,
      emergencyStop: {
        active: switches.emergencyStop,
        since: null,
        reason: switches.emergencyReason,
        source: switches.emergencyStop ? 'api' : null,
      },
      globalPause: switches.globalPause,
      activation: {
        state: activationState,
        liveSession:
          activationState === 'LIVE' && activatedAtMs !== null
            ? { startedAt: activatedAtMs, expiresAt: activatedAtMs + LIVE_SESSION_TTL_MS }
            : null,
      },
      cooldowns: options.cooldowns ?? {},
      lastAnyActionAt: options.lastAnyActionAt ?? null,
      ledger: options.ledger ?? {
        dayStartUtcMs: Math.floor(options.now / 86_400_000) * 86_400_000,
        deployedUsd: '0',
        realizedPnlTodayUsd: '0',
        unrealizedPnlUsd: '0',
        unrealizedPnlAtDayStartUsd: '0',
        positions: [],
        lpRebalancesToday: {},
      },
    };
  }
}
