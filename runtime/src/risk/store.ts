import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import { AppError, ErrorCode } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import { defaultRiskPolicy, parseRiskPolicy, policyHash } from './policy.js';
import type { RiskPolicy } from './policy.js';
import type { ChainId } from '../chains/registry.js';

/**
 * Persistence for the risk policy.
 *
 * The stored policy is re-validated on every read. A policy file that has been
 * hand-edited into an invalid state is a hard failure, not something to patch
 * up with defaults: silently "repairing" limits is exactly how an operator ends
 * up trading under numbers they never agreed to.
 */
export class RiskPolicyStore {
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #log = childLogger('risk-policy');
  #onChanged: (() => void) | undefined;

  constructor(db: Db, audit: AuditLog) {
    this.#db = db;
    this.#audit = audit;
  }

  /**
   * Called after every successful update.
   *
   * The state store uses it to drop LIVE: limits the operator has not reviewed
   * since they changed are limits they have not agreed to trade under.
   */
  onChanged(handler: () => void): void {
    this.#onChanged = handler;
  }

  exists(): boolean {
    return this.#db.prepare('SELECT 1 FROM risk_policy WHERE id = 1').get() !== undefined;
  }

  /** Seed the default policy. Used once, during first-run setup. */
  initialize(enabledChains: ChainId[]): RiskPolicy {
    if (this.exists()) {
      throw new AppError(ErrorCode.CONFLICT, 'A risk policy already exists');
    }
    const policy = defaultRiskPolicy(enabledChains);
    this.#write(policy, 1);

    this.#audit.append({
      category: 'risk',
      action: 'policy.initialized',
      status: 'ok',
      summary: 'Default risk policy created',
      detail: { policyHash: policyHash(policy), enabledChains },
    });

    return policy;
  }

  get(): RiskPolicy {
    const row = this.#db
      .prepare<[], { policy_json: string }>('SELECT policy_json FROM risk_policy WHERE id = 1')
      .get();

    if (!row) {
      throw new AppError(ErrorCode.NOT_FOUND, 'No risk policy has been configured yet');
    }

    try {
      return parseRiskPolicy(JSON.parse(row.policy_json));
    } catch (cause) {
      this.#log.error({ err: cause }, 'stored risk policy failed validation');
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'The stored risk policy is invalid; ATRA will not run with unverified limits',
        { cause },
      );
    }
  }

  /** Current policy plus its hash, which is stamped onto every decision. */
  getWithHash(): { policy: RiskPolicy; hash: string } {
    const policy = this.get();
    return { policy, hash: policyHash(policy) };
  }

  version(): number {
    const row = this.#db
      .prepare<[], { version: number }>('SELECT version FROM risk_policy WHERE id = 1')
      .get();
    return row?.version ?? 0;
  }

  /**
   * Replace the policy.
   *
   * The candidate is validated before anything is written, so a rejected update
   * leaves the previous limits in force. The audit row records both hashes and
   * which fields changed, never the whole policy.
   */
  update(candidate: unknown, actor: string): RiskPolicy {
    const next = parseRiskPolicy(candidate);
    const previous = this.exists() ? this.get() : undefined;
    const version = this.version() + 1;

    this.#write(next, version);

    this.#audit.append({
      category: 'risk',
      action: 'policy.updated',
      status: 'ok',
      summary: 'Risk policy updated',
      actor,
      detail: {
        version,
        previousHash: previous ? policyHash(previous) : null,
        newHash: policyHash(next),
        changed: previous ? changedFields(previous, next) : ['*'],
      },
    });

    this.#onChanged?.();
    return next;
  }

  #write(policy: RiskPolicy, version: number): void {
    this.#db
      .prepare(
        'INSERT INTO risk_policy (id, version, policy_json, updated_at) VALUES (1, ?, ?, ?)' +
          ' ON CONFLICT(id) DO UPDATE SET version = excluded.version,' +
          ' policy_json = excluded.policy_json, updated_at = excluded.updated_at',
      )
      .run(version, JSON.stringify(policy), new Date().toISOString());
  }
}

/** Top-level field names whose serialized value differs between two policies. */
function changedFields(before: RiskPolicy, after: RiskPolicy): string[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  const changed: string[] = [];
  for (const key of keys) {
    const a = JSON.stringify((before as Record<string, unknown>)[key]);
    const b = JSON.stringify((after as Record<string, unknown>)[key]);
    if (a !== b) changed.push(key);
  }
  return changed.sort();
}
