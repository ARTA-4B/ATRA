import { randomUUID } from 'node:crypto';
import type { Db } from '../db/database.js';
import type { AuditLog } from '../audit/audit.js';
import type { ChainId } from '../chains/registry.js';
import { CHAINS } from '../chains/registry.js';
import type { ChainAdapter } from '../chains/types.js';
import type { MarketService } from '../market/service.js';
import type { LlmProvider } from '../llm/provider.js';
import type { KdfParams } from '../wallet/crypto.js';
import { microsToUsd, nativeToUsdMicros, priceToAtto, usdToMicros } from '../risk/money.js';
import { AppError, ErrorCode, errorMessage } from '../util/errors.js';
import type { FieldIssue } from '../util/errors.js';
import { childLogger } from '../logging/logger.js';
import { TreasuryAgent } from '../agents/treasury/agent.js';
import type { TreasuryAgentInput, TreasuryAgentOutput } from '../agents/treasury/agent.js';
import { TreasuryStore } from './store.js';
import type { ExpenseInput, ProviderInput } from './store.js';
import { TreasuryAdminAuth } from './admin.js';
import { TreasuryBalanceReader, formatUnits } from './balances.js';
import { evaluateCaps } from './caps.js';
import { burnRate, periodOf, runway, sumUsd, trailingPeriods } from './burn.js';
import { canonicalTreasuryAddress } from './address.js';
import type {
  AlertKind,
  AlertSeverity,
  BalanceReport,
  BurnRate,
  CapDecision,
  Expense,
  ExportedInstruction,
  PaymentProposal,
  Provider,
  ProposalSource,
  ProposalStatus,
  Runway,
  TreasuryAddress,
  TreasuryAlert,
  TreasuryCaps,
  TreasuryConfig,
  TreasuryToken,
} from './types.js';

/**
 * The treasury service: what the composition root constructs and the
 * project-admin routes call.
 *
 * Read the dependency list before anything else. It contains the database,
 * the audit log, the chain adapters (for reading balances), the market
 * service (for prices) and the model provider. It does not contain the
 * wallet service, the vault, the ledger, the trade store, the risk gate or
 * the runtime state. That is not an oversight to be fixed later: the
 * treasury cannot sign, cannot broadcast and cannot see a user balance
 * because it was never handed the objects that could, and a test asserts the
 * shape.
 *
 * Everything that looks like moving money is a *proposal*: a row that a human
 * approves against deterministic caps and then exports as a transfer
 * instruction to execute from the treasury wallet with their own signer,
 * somewhere that is not this process.
 */

export interface TreasuryServiceDeps {
  db: Db;
  audit: AuditLog;
  adapters: Map<ChainId, ChainAdapter>;
  market: MarketService;
  llm: LlmProvider;
  /** Weaker Argon2 parameters for tests; production leaves it undefined. */
  kdfParams?: KdfParams;
  now?: () => number;
}

export const TREASURY_ADMIN_ACTOR = 'treasury-admin';
export const TREASURY_AGENT_ACTOR = 'agent:treasury';

export const WATCH_ONLY_NOTICE =
  'The treasury wallet is watch-only. ATRA holds no key for it and cannot sign or broadcast ' +
  'on its behalf. Execute this transfer from the treasury wallet with your own signer, ' +
  'after checking every field against the approved proposal.';

/** Runway below this many months raises a `runway_short` alert. */
const RUNWAY_SHORT_MONTHS = 3n;

export interface ConfigUpdate {
  caps?: { [K in keyof TreasuryCaps]?: string | undefined } | undefined;
  addresses?:
    | Array<{
        chain: ChainId;
        address: string;
        label: string;
        tokens: TreasuryToken[];
        enabled: boolean;
      }>
    | undefined;
}

export interface ProviderUpdate {
  name?: string | undefined;
  category?: ProviderInput['category'] | undefined;
  billingMode?: ProviderInput['billingMode'] | undefined;
  monthlyBudgetUsd?: string | undefined;
  recipient?: ProviderInput['recipient'] | undefined;
  note?: string | undefined;
  active?: boolean | undefined;
}

export interface ExpenseRecord {
  providerId: string;
  period: string;
  amountUsd: string;
  kind: Expense['kind'];
  status: Expense['status'];
  source: Expense['source'];
  note: string;
}

export interface ProposalRequest {
  providerId: string;
  amountUsd: string;
  asset: string;
  period?: string | undefined;
  memo?: string | undefined;
}

export interface ProviderView extends Provider {
  spentThisPeriodUsd: string;
  remainingBudgetUsd: string | null;
  overBudget: boolean;
}

export interface TreasuryDashboard {
  notice: string;
  admin: { configured: boolean; setAt: string | null };
  frozen: { active: boolean; reason: string | null; at: string | null; by: string | null };
  caps: TreasuryCaps;
  addresses: TreasuryAddress[];
  balances: BalanceReport;
  spend: {
    period: string;
    expensesThisPeriodUsd: string;
    approvedProposalsThisMonthUsd: string;
    remainingMonthlyCapUsd: string;
  };
  burn: BurnRate;
  runway: Runway;
  providers: ProviderView[];
  proposals: {
    pending: PaymentProposal[];
    approved: PaymentProposal[];
    rejected: PaymentProposal[];
    exported: PaymentProposal[];
    cancelled: PaymentProposal[];
  };
  /**
   * Manual-payable expenses, newest first. Expenses are append-only, so a
   * payable is never marked paid in place: this is the list of obligations
   * recorded for a human to settle, not a queue the runtime clears.
   */
  manualPayables: Expense[];
  recentExpenses: Expense[];
  alerts: TreasuryAlert[];
  modelStatus: 'UNTRAINED';
}

export interface ReviewActionOutcome {
  action: string;
  provider: string | null;
  amountUsd: string;
  reason: string;
  outcome: 'none' | 'proposal-created' | 'manual-payable-recorded' | 'alert-raised' | 'refused';
  detail: string;
  proposalId?: string;
  expenseId?: string;
}

export interface TreasuryReviewReport {
  cycleId: string;
  startedAt: string;
  finishedAt: string;
  model: string;
  modelStatus: 'UNTRAINED' | 'UNAVAILABLE';
  fallback: boolean;
  overridden: string | null;
  summary: string;
  concerns: string[];
  confidence: number;
  actions: ReviewActionOutcome[];
  alertsRaised: number;
  balances: BalanceReport;
  burn: BurnRate;
  runway: Runway;
}

export class TreasuryService {
  readonly admin: TreasuryAdminAuth;
  readonly #db: Db;
  readonly #audit: AuditLog;
  readonly #market: MarketService;
  readonly #store: TreasuryStore;
  readonly #balances: TreasuryBalanceReader;
  readonly #agent: TreasuryAgent;
  readonly #now: () => number;
  readonly #log = childLogger('treasury');
  #running = false;

  constructor(deps: TreasuryServiceDeps) {
    this.#db = deps.db;
    this.#audit = deps.audit;
    this.#market = deps.market;
    this.#now = deps.now ?? (() => Date.now());
    this.#store = new TreasuryStore(deps.db);
    this.admin = new TreasuryAdminAuth(this.#store, deps.audit, deps.kdfParams, this.#now);
    this.#balances = new TreasuryBalanceReader({
      adapters: deps.adapters,
      market: deps.market,
      store: this.#store,
      now: this.#now,
    });
    // The agent gets the model and nothing else.
    this.#agent = new TreasuryAgent(deps.llm);
  }

  // --- audit helper for read routes ---------------------------------------

  /** Record that an admin read something. Every treasury route leaves a row. */
  noteRead(what: string, actor: string): void {
    this.#audit.append({
      category: 'system',
      action: `treasury.${what}.read`,
      status: 'ok',
      summary: `Treasury ${what} read`,
      actor,
      mode: 'NONE',
    });
  }

  // --- config ---------------------------------------------------------------

  getConfig(): TreasuryConfig {
    return this.#store.getConfig();
  }

  isFrozen(): boolean {
    return this.#store.isFrozen();
  }

  updateConfig(update: ConfigUpdate, actor: string): TreasuryConfig {
    const caps: Partial<TreasuryCaps> = {};
    for (const key of [
      'lowBalanceThresholdUsd',
      'perPaymentCapUsd',
      'monthlyCapUsd',
      'approvalThresholdUsd',
    ] as const) {
      const value = update.caps?.[key];
      if (value !== undefined) caps[key] = canonicalUsd(value, key);
    }

    const addresses = (update.addresses ?? []).map((entry) => ({
      chain: entry.chain,
      address: canonicalTreasuryAddress(
        entry.chain,
        entry.address,
        `addresses.${entry.chain}.address`,
      ),
      label: entry.label,
      tokens: entry.tokens.map((token) => ({
        ...token,
        address: canonicalTreasuryAddress(
          entry.chain,
          token.address,
          `addresses.${entry.chain}.tokens.${token.symbol}`,
        ),
      })),
      enabled: entry.enabled,
    }));

    const before = this.#store.getConfig();
    this.#db.transaction(() => {
      if (Object.keys(caps).length > 0) this.#store.updateCaps(caps);
      for (const entry of addresses) this.#store.upsertAddress(entry);
    })();
    const after = this.#store.getConfig();

    this.#audit.append({
      category: 'system',
      action: 'treasury.config.updated',
      status: 'ok',
      summary: 'Treasury configuration updated',
      actor,
      mode: 'NONE',
      detail: {
        caps: {
          before: pickCaps(before),
          after: pickCaps(after),
        },
        addresses: addresses.map((entry) => ({
          chain: entry.chain,
          address: entry.address,
          enabled: entry.enabled,
          tokens: entry.tokens.map((token) => token.symbol),
        })),
      },
    });
    return after;
  }

  // --- freeze --------------------------------------------------------------------

  /**
   * Freeze the treasury. One row, effective on the next read; needs no model
   * and no network. Refuses approval and export while set. Idempotent: a
   * second freeze updates the reason and is audited again.
   */
  freeze(reason: string, actor: string): TreasuryConfig {
    this.#store.setFrozen(true, reason, actor);
    this.#audit.append({
      category: 'system',
      action: 'treasury.frozen',
      status: 'ok',
      summary: `Treasury frozen: ${reason}`,
      actor,
      mode: 'NONE',
      detail: { reason },
    });
    this.#raiseAlert('frozen', 'critical', 'freeze', `Treasury frozen: ${reason}`, {
      reason,
      by: actor,
    });
    this.#log.error({ actor, reason }, 'treasury frozen');
    return this.#store.getConfig();
  }

  /** Clearing a freeze is a separate, audited admin action. */
  clearFreeze(note: string, actor: string): TreasuryConfig {
    const config = this.#store.getConfig();
    if (!config.frozen) {
      throw new AppError(ErrorCode.CONFLICT, 'The treasury is not frozen');
    }
    this.#store.setFrozen(false, null, actor);
    this.#audit.append({
      category: 'system',
      action: 'treasury.freeze.cleared',
      status: 'ok',
      summary: `Treasury freeze cleared: ${note}`,
      actor,
      mode: 'NONE',
      detail: { note, previousReason: config.frozenReason, frozenAt: config.frozenAt },
    });
    this.#log.warn({ actor }, 'treasury freeze cleared');
    return this.#store.getConfig();
  }

  // --- providers ------------------------------------------------------------------

  listProviders(): ProviderView[] {
    const period = periodOf(this.#now());
    return this.#store.listProviders().map((provider) => this.#providerView(provider, period));
  }

  getProvider(id: string): Provider {
    const provider = this.#store.getProvider(id);
    if (!provider) {
      throw new AppError(ErrorCode.NOT_FOUND, `No treasury provider with id ${id}`);
    }
    return provider;
  }

  addProvider(input: ProviderInput, actor: string): Provider {
    const clean = normalizeProvider(input);
    if (this.#store.findProviderByName(clean.name)) {
      throw new AppError(ErrorCode.CONFLICT, `A provider named ${clean.name} already exists`);
    }
    const provider = this.#store.insertProvider(clean);
    this.#audit.append({
      category: 'system',
      action: 'treasury.provider.added',
      status: 'ok',
      summary: `Provider ${provider.name} added (${provider.billingMode})`,
      actor,
      mode: 'NONE',
      ...(provider.recipient ? { chain: provider.recipient.chain } : {}),
      detail: {
        providerId: provider.id,
        category: provider.category,
        billingMode: provider.billingMode,
        monthlyBudgetUsd: provider.monthlyBudgetUsd,
        recipient: provider.recipient,
      },
    });
    return provider;
  }

  updateProvider(id: string, update: ProviderUpdate, actor: string): Provider {
    const current = this.getProvider(id);
    const merged = normalizeProvider({
      name: update.name ?? current.name,
      category: update.category ?? current.category,
      billingMode: update.billingMode ?? current.billingMode,
      monthlyBudgetUsd: update.monthlyBudgetUsd ?? current.monthlyBudgetUsd,
      recipient: update.recipient === undefined ? current.recipient : update.recipient,
      note: update.note ?? current.note,
    });
    const clash = this.#store.findProviderByName(merged.name);
    if (clash && clash.id !== id) {
      throw new AppError(ErrorCode.CONFLICT, `A provider named ${merged.name} already exists`);
    }
    const provider = this.#store.updateProvider(id, {
      ...merged,
      active: update.active ?? current.active,
    });
    this.#audit.append({
      category: 'system',
      action: 'treasury.provider.updated',
      status: 'ok',
      summary: `Provider ${provider.name} updated`,
      actor,
      mode: 'NONE',
      detail: { providerId: id, before: current, after: provider },
    });
    return provider;
  }

  #providerView(provider: Provider, period: string): ProviderView {
    const spent = this.#providerPeriodSpend(provider.id, period);
    const budget = usdToMicros(provider.monthlyBudgetUsd);
    const spentMicros = usdToMicros(spent);
    return {
      ...provider,
      spentThisPeriodUsd: spent,
      remainingBudgetUsd: budget > 0n ? microsToUsd(budget - spentMicros) : null,
      overBudget: budget > 0n && spentMicros > budget,
    };
  }

  /** Expenses plus approved/exported proposals for a provider in a billing period. */
  #providerPeriodSpend(providerId: string, period: string): string {
    const expenses = this.#store.listExpenses({ providerId, period, limit: 2_000 });
    const proposals = this.#store.approvedForProviderPeriod(providerId, period);
    return sumUsd([
      ...expenses.map((expense) => expense.amountUsd),
      ...proposals.map((proposal) => proposal.amountUsd),
    ]);
  }

  // --- expenses ---------------------------------------------------------------------

  listExpenses(query: { period?: string; providerId?: string; limit?: number } = {}): Expense[] {
    return this.#store.listExpenses(query);
  }

  recordExpense(record: ExpenseRecord, actor: string): Expense {
    const provider = this.getProvider(record.providerId);
    const input: ExpenseInput = {
      providerId: provider.id,
      period: record.period,
      amountUsd: canonicalUsd(record.amountUsd, 'amountUsd'),
      kind: record.kind,
      status: record.status,
      source: record.source,
      note: record.note,
      recordedBy: actor,
    };
    if (usdToMicros(input.amountUsd) <= 0n) {
      throw new AppError(ErrorCode.SCHEMA_INVALID, 'An expense must be greater than zero', {
        errors: [{ path: 'amountUsd', message: 'must be greater than zero' }],
      });
    }
    const expense = this.#store.insertExpense(input);
    this.#audit.append({
      category: 'system',
      action: 'treasury.expense.recorded',
      status: 'ok',
      summary: `Expense recorded: ${provider.name} ${expense.period} ${expense.amountUsd} USD (${expense.kind}, ${expense.status})`,
      actor,
      mode: 'NONE',
      detail: {
        expenseId: expense.id,
        ...record,
        providerId: provider.id,
        amountUsd: expense.amountUsd,
      },
    });
    this.#checkProviderBudget(provider, expense.period);
    return expense;
  }

  /**
   * Record a bill that cannot be paid on-chain. This is what a card, invoice
   * or manual provider gets instead of a proposal; it is an obligation for the
   * project creator to settle, not a payment path.
   */
  recordManualPayable(
    input: { providerId: string; period: string; amountUsd: string; note: string },
    actor: string,
  ): Expense {
    return this.recordExpense(
      {
        providerId: input.providerId,
        period: input.period,
        amountUsd: input.amountUsd,
        kind: 'manual-payable',
        status: 'payable',
        source: 'manual',
        note: input.note,
      },
      actor,
    );
  }

  // --- proposals ------------------------------------------------------------------------

  listProposals(query: { status?: ProposalStatus; limit?: number } = {}): PaymentProposal[] {
    return this.#store.listProposals(query);
  }

  getProposal(id: string): PaymentProposal {
    const proposal = this.#store.getProposal(id);
    if (!proposal) {
      throw new AppError(ErrorCode.NOT_FOUND, `No payment proposal with id ${id}`);
    }
    return proposal;
  }

  /**
   * Create a proposal. The caps are evaluated now and recorded on the row;
   * a request that fails them is refused outright, with every check in the
   * response and in the audit row, and no row is written.
   */
  propose(request: ProposalRequest, actor: string, source: ProposalSource): PaymentProposal {
    const now = this.#now();
    const period = request.period ?? periodOf(now);
    const provider = this.#store.getProvider(request.providerId) ?? null;
    const chain = provider?.recipient?.chain ?? null;
    const recipient = provider?.recipient?.address ?? null;
    const amountUsd = canonicalUsd(request.amountUsd, 'amountUsd');

    // A proposal for a provider with no on-chain recipient has no chain to be
    // evaluated on. The cap engine reports PROVIDER_NOT_ON_CHAIN for it; the
    // placeholder chain only exists so the engine has a well-typed input.
    const decision = this.#evaluate({
      stage: 'propose',
      provider,
      chain: chain ?? 'base',
      recipient: recipient ?? 'none',
      asset: request.asset,
      amountUsd,
      period,
      creatorApproval: false,
      excludeProposalId: null,
      now,
    });

    if (!decision.allowed) {
      this.#audit.append({
        category: 'system',
        action: 'treasury.proposal.refused',
        status: 'rejected',
        summary: `Payment proposal refused: ${decision.code} (${provider?.name ?? request.providerId}, ${amountUsd} USD)`,
        actor,
        mode: 'NONE',
        ...(chain ? { chain } : {}),
        detail: { request: { ...request, amountUsd }, source, decision },
      });
      throw capsRefused(decision, 'The payment proposal does not pass the treasury caps');
    }

    const proposal = this.#store.insertProposal({
      providerId: provider!.id,
      chain: chain!,
      recipient: recipient!,
      asset: request.asset,
      amountUsd,
      period,
      memo: request.memo ?? '',
      proposedBy: actor,
      source,
      checks: decision,
    });

    this.#audit.append({
      category: 'system',
      action: 'treasury.proposal.created',
      status: 'pending',
      summary: `Payment proposal ${proposal.id.slice(0, 8)}: ${provider!.name} ${amountUsd} ${request.asset} on ${chain!} (awaiting approval)`,
      actor,
      mode: 'NONE',
      chain: chain!,
      detail: { proposalId: proposal.id, source, decision },
      correlationId: proposal.id,
    });
    return proposal;
  }

  /**
   * Approve a proposal. The caps are evaluated again, now, against the
   * current configuration and this month's approvals, and that evaluation is
   * what the row records as its decision. A proposal that fails is moved to
   * `rejected` with the failing checks; the admin can propose again. A freeze
   * refuses without touching the row.
   */
  approve(
    id: string,
    input: { creatorApproval: boolean; note: string },
    actor: string,
  ): PaymentProposal {
    // The rejection write must survive the throw that reports it, so the
    // transaction returns an outcome and the throw happens outside it.
    const outcome = this.#db.transaction(
      (): { proposal: PaymentProposal; decision: CapDecision | null } => {
        const proposal = this.getProposal(id);
        this.#assertTransition(proposal, 'proposed', 'approve');
        this.#assertNotFrozen('approve a payment proposal');

        const provider = this.#store.getProvider(proposal.providerId) ?? null;
        const decision = this.#evaluate({
          stage: 'approve',
          provider,
          chain: proposal.chain,
          recipient: proposal.recipient,
          asset: proposal.asset,
          amountUsd: proposal.amountUsd,
          period: proposal.period,
          creatorApproval: input.creatorApproval,
          excludeProposalId: proposal.id,
          now: this.#now(),
        });

        if (!decision.allowed) {
          const rejected = this.#store.decideProposal(
            id,
            'rejected',
            actor,
            `refused by caps: ${decision.reason}${input.note ? ` (${input.note})` : ''}`,
            decision,
            input.creatorApproval,
          );
          this.#audit.append({
            category: 'system',
            action: 'treasury.proposal.rejected',
            status: 'rejected',
            summary: `Payment proposal ${id.slice(0, 8)} rejected by caps: ${decision.code}`,
            actor,
            mode: 'NONE',
            chain: proposal.chain,
            detail: { proposalId: id, decision, creatorApproval: input.creatorApproval },
            correlationId: id,
          });
          return { proposal: rejected, decision };
        }

        const approved = this.#store.decideProposal(
          id,
          'approved',
          actor,
          input.note,
          decision,
          input.creatorApproval,
        );
        this.#audit.append({
          category: 'system',
          action: 'treasury.proposal.approved',
          status: 'ok',
          summary: `Payment proposal ${id.slice(0, 8)} approved: ${provider?.name ?? proposal.providerId} ${proposal.amountUsd} ${proposal.asset} on ${proposal.chain}`,
          actor,
          mode: 'NONE',
          chain: proposal.chain,
          detail: {
            proposalId: id,
            decision,
            creatorApproval: input.creatorApproval,
            note: input.note,
          },
          correlationId: id,
        });
        return { proposal: approved, decision: null };
      },
    )();

    if (outcome.decision) {
      throw capsRefused(outcome.decision, 'The payment proposal does not pass the treasury caps');
    }
    return outcome.proposal;
  }

  reject(id: string, note: string, actor: string): PaymentProposal {
    return this.#db.transaction(() => {
      const proposal = this.getProposal(id);
      this.#assertTransition(proposal, 'proposed', 'reject');
      const decision: CapDecision = {
        ...proposal.checks,
        stage: 'approve',
        evaluatedAt: this.#now(),
        allowed: false,
        code: proposal.checks.code,
        reason: `rejected by ${actor}: ${note}`,
      };
      const rejected = this.#store.decideProposal(id, 'rejected', actor, note, decision, false);
      this.#audit.append({
        category: 'system',
        action: 'treasury.proposal.rejected',
        status: 'rejected',
        summary: `Payment proposal ${id.slice(0, 8)} rejected: ${note}`,
        actor,
        mode: 'NONE',
        chain: proposal.chain,
        detail: { proposalId: id, note },
        correlationId: id,
      });
      return rejected;
    })();
  }

  cancel(id: string, note: string, actor: string): PaymentProposal {
    return this.#db.transaction(() => {
      const proposal = this.getProposal(id);
      this.#assertTransition(proposal, 'approved', 'cancel');
      const cancelled = this.#store.cancelProposal(id);
      this.#audit.append({
        category: 'system',
        action: 'treasury.proposal.cancelled',
        status: 'ok',
        summary: `Approved payment proposal ${id.slice(0, 8)} cancelled: ${note}`,
        actor,
        mode: 'NONE',
        chain: proposal.chain,
        detail: { proposalId: id, note },
        correlationId: id,
      });
      return cancelled;
    })();
  }

  /**
   * Export an approved proposal as a human-executable instruction.
   *
   * This is the end of the treasury's involvement. The instruction names the
   * chain, the watch-only source address, the allowlisted recipient, the
   * asset and the amount, and carries the checks the approval rested on. It
   * contains no calldata, no nonce and no signature, because the runtime has
   * nothing to sign with. If the asset cannot be priced right now the base
   * unit amount is null with a reason; the USD figure stands and the human
   * converts it.
   */
  async exportProposal(id: string, actor: string): Promise<ExportedInstruction> {
    const proposal = this.getProposal(id);
    this.#assertTransition(proposal, 'approved', 'export');
    this.#assertNotFrozen('export a payment proposal');

    const provider = this.getProvider(proposal.providerId);
    const info = CHAINS[proposal.chain];
    const token = info.tokens.find((candidate) => candidate.symbol === proposal.asset);
    if (!token) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Asset ${proposal.asset} is not listed for ${proposal.chain}`,
      );
    }
    const from = this.#store.getAddress(proposal.chain);
    if (!from || !from.enabled) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `No enabled treasury address is configured for ${proposal.chain}`,
      );
    }

    let amountBaseUnits: string | null = null;
    let amountDecimal: string | null = null;
    let price: ExportedInstruction['price'] = null;
    let priceReason: string | null = null;
    try {
      const quote = await this.#market.getCrossCheckedPrice(proposal.chain, token.address);
      if (quote.priceUsd === null) {
        priceReason = `asset price unknown: ${quote.reason ?? 'no provider returned a price'}; convert the USD amount manually`;
      } else if (quote.disputed) {
        priceReason = `asset price disputed: ${quote.reason ?? 'providers disagree'}; convert the USD amount manually`;
      } else {
        const units = usdToBaseUnits(proposal.amountUsd, token.decimals, quote.priceUsd);
        amountBaseUnits = units.toString();
        amountDecimal = formatUnits(units, token.decimals);
        price = {
          priceUsd: quote.priceUsd,
          sources: quote.sources.map((source) => source.source),
          observedAt: quote.sources[0]?.observedAt ?? new Date(this.#now()).toISOString(),
        };
        if (quote.reason) priceReason = quote.reason;
      }
    } catch (cause) {
      priceReason = `price lookup failed: ${errorMessage(cause)}; convert the USD amount manually`;
    }

    const instruction: ExportedInstruction = {
      proposalId: proposal.id,
      exportedAt: new Date(this.#now()).toISOString(),
      chain: proposal.chain,
      chainDisplayName: info.displayName,
      evmChainId: info.evmChainId ?? null,
      from: from.address,
      recipient: proposal.recipient,
      recipientExplorerUrl: explorerAddressUrl(proposal.chain, proposal.recipient),
      asset: { symbol: token.symbol, address: token.address, decimals: token.decimals },
      amountUsd: proposal.amountUsd,
      amountBaseUnits,
      amountDecimal,
      price,
      priceReason,
      memo: proposal.memo,
      provider: { id: provider.id, name: provider.name },
      approvedBy: proposal.decidedBy ?? 'unknown',
      approvedAt: proposal.decidedAt ?? 'unknown',
      creatorApproval: proposal.creatorApproval,
      checks: proposal.decision?.checks ?? proposal.checks.checks,
      notice: WATCH_ONLY_NOTICE,
    };

    // Re-check inside the write: the freeze may have been engaged during the
    // price lookup, and the status trigger refuses a double export.
    this.#db.transaction(() => {
      this.#assertNotFrozen('export a payment proposal');
      const fresh = this.getProposal(id);
      this.#assertTransition(fresh, 'approved', 'export');
      this.#store.exportProposal(id, actor, instruction);
    })();

    this.#audit.append({
      category: 'system',
      action: 'treasury.proposal.exported',
      status: 'ok',
      summary: `Payment proposal ${id.slice(0, 8)} exported as a manual transfer instruction: ${proposal.amountUsd} USD in ${token.symbol} on ${proposal.chain}`,
      actor,
      mode: 'NONE',
      chain: proposal.chain,
      detail: { proposalId: id, instruction },
      correlationId: id,
    });
    return instruction;
  }

  #assertTransition(proposal: PaymentProposal, expected: ProposalStatus, verb: string): void {
    if (proposal.status !== expected) {
      throw new AppError(
        ErrorCode.CONFLICT,
        `Cannot ${verb} a proposal in status ${proposal.status}; it must be ${expected}`,
        { errors: [{ path: 'status', message: `ILLEGAL_TRANSITION:${proposal.status}` }] },
      );
    }
  }

  #assertNotFrozen(verb: string): void {
    if (this.#store.isFrozen()) {
      throw new AppError(ErrorCode.CONFLICT, `The treasury is frozen; cannot ${verb}`, {
        errors: [{ path: 'treasury.frozen', message: 'FROZEN' }],
      });
    }
  }

  #evaluate(input: {
    stage: 'propose' | 'approve';
    provider: Provider | null;
    chain: ChainId;
    recipient: string;
    asset: string;
    amountUsd: string;
    period: string;
    creatorApproval: boolean;
    excludeProposalId: string | null;
    now: number;
  }): CapDecision {
    const config = this.#store.getConfig();
    const monthToDate = sumUsd(
      this.#store
        .approvedInMonth(input.now)
        .filter((proposal) => proposal.id !== input.excludeProposalId)
        .map((proposal) => proposal.amountUsd),
    );
    const providerSpend = input.provider
      ? this.#providerPeriodSpend(input.provider.id, input.period)
      : '0.000000';

    return evaluateCaps({
      now: input.now,
      stage: input.stage,
      frozen: config.frozen,
      caps: pickCaps(config),
      provider: input.provider,
      enabledChains: this.#store.enabledChains(),
      proposal: {
        providerId: input.provider?.id ?? 'unknown',
        chain: input.chain,
        recipient: input.recipient,
        asset: input.asset,
        amountUsd: input.amountUsd,
      },
      monthToDateApprovedUsd: monthToDate,
      providerPeriodSpendUsd: providerSpend,
      period: input.period,
      creatorApproval: input.creatorApproval,
    });
  }

  // --- balances, burn, runway ----------------------------------------------------------

  /** Read every enabled address now, write snapshots, raise balance alerts. */
  async readBalances(): Promise<BalanceReport> {
    const config = this.#store.getConfig();
    const report = await this.#balances.read(config.addresses);

    for (const asset of report.assets) {
      const key = `${asset.chain}:${asset.asset}`;
      if (asset.amount === null) {
        this.#raiseAlert(
          'balance_unreadable',
          'warning',
          key,
          `${asset.chain} ${asset.symbol} balance could not be read: ${asset.reason ?? 'unknown'}`,
          { chain: asset.chain, symbol: asset.symbol, reason: asset.reason },
        );
      } else if (asset.valueUsd === null) {
        this.#raiseAlert(
          'price_unknown',
          'info',
          key,
          `${asset.chain} ${asset.symbol} balance is unpriced: ${asset.reason ?? 'unknown'}`,
          { chain: asset.chain, symbol: asset.symbol, reason: asset.reason },
        );
      }
    }

    const threshold = usdToMicros(config.lowBalanceThresholdUsd);
    if (report.complete && threshold > 0n && usdToMicros(report.pricedValueUsd) < threshold) {
      this.#raiseAlert(
        'low_balance',
        'critical',
        'total',
        `Treasury balance ${report.pricedValueUsd} USD is below the ${config.lowBalanceThresholdUsd} USD threshold`,
        { balanceUsd: report.pricedValueUsd, thresholdUsd: config.lowBalanceThresholdUsd },
      );
    }
    return report;
  }

  burn(): BurnRate {
    const now = this.#now();
    return burnRate(this.#store.expensesInPeriods(trailingPeriods(now, 3)), now);
  }

  runway(balances: BalanceReport, burn: BurnRate): Runway {
    if (!balances.complete) {
      const missing = balances.incomplete
        .map((entry) => `${entry.chain} ${entry.symbol} (${entry.reason})`)
        .join('; ');
      return runway(
        null,
        balances.assets.length === 0
          ? 'no treasury address is configured'
          : `the balance is incomplete: ${missing}`,
        burn,
      );
    }
    return runway(balances.pricedValueUsd, null, burn);
  }

  // --- dashboard ------------------------------------------------------------------------

  async view(): Promise<TreasuryDashboard> {
    const config = this.#store.getConfig();
    const balances = await this.readBalances();
    const burn = this.burn();
    const runwayEstimate = this.runway(balances, burn);
    const now = this.#now();
    const period = periodOf(now);

    const approvedThisMonth = sumUsd(
      this.#store.approvedInMonth(now).map((proposal) => proposal.amountUsd),
    );
    const monthlyCap = usdToMicros(config.monthlyCapUsd);
    const remaining = monthlyCap - usdToMicros(approvedThisMonth);

    const proposals = this.#store.listProposals({ limit: 500 });
    const byStatus = (status: ProposalStatus) =>
      proposals.filter((proposal) => proposal.status === status).slice(0, 100);

    return {
      notice: WATCH_ONLY_NOTICE,
      admin: { configured: config.adminConfigured, setAt: config.adminSetAt },
      frozen: {
        active: config.frozen,
        reason: config.frozenReason,
        at: config.frozenAt,
        by: config.frozenBy,
      },
      caps: pickCaps(config),
      addresses: config.addresses,
      balances,
      spend: {
        period,
        expensesThisPeriodUsd: sumUsd(
          this.#store.listExpenses({ period, limit: 2_000 }).map((expense) => expense.amountUsd),
        ),
        approvedProposalsThisMonthUsd: approvedThisMonth,
        remainingMonthlyCapUsd: microsToUsd(remaining < 0n ? 0n : remaining),
      },
      burn,
      runway: runwayEstimate,
      providers: this.listProviders(),
      proposals: {
        pending: byStatus('proposed'),
        approved: byStatus('approved'),
        rejected: byStatus('rejected'),
        exported: byStatus('exported'),
        cancelled: byStatus('cancelled'),
      },
      manualPayables: this.#store
        .listExpenses({ limit: 2_000 })
        .filter((expense) => expense.kind === 'manual-payable')
        .slice(0, 100),
      recentExpenses: this.#store.listExpenses({ limit: 50 }),
      alerts: this.#store.listAlerts({ limit: 100 }),
      modelStatus: 'UNTRAINED',
    };
  }

  // --- alerts -------------------------------------------------------------------------------

  listAlerts(query: { includeAcknowledged?: boolean; limit?: number } = {}): TreasuryAlert[] {
    return this.#store.listAlerts(query);
  }

  acknowledgeAlert(id: string, actor: string): TreasuryAlert {
    const alert = this.#store.acknowledgeAlert(id);
    if (!alert) {
      throw new AppError(ErrorCode.NOT_FOUND, `No treasury alert with id ${id}`);
    }
    this.#audit.append({
      category: 'system',
      action: 'treasury.alert.acknowledged',
      status: 'ok',
      summary: `Treasury alert acknowledged: ${alert.summary}`,
      actor,
      mode: 'NONE',
      detail: { alertId: id, kind: alert.kind },
    });
    return alert;
  }

  /** Raise an alert unless an identical open one exists. Returns the alert, or null when deduplicated. */
  #raiseAlert(
    kind: AlertKind,
    severity: AlertSeverity,
    key: string,
    summary: string,
    detail: Record<string, unknown>,
  ): TreasuryAlert | null {
    if (this.#store.findOpenAlert(kind, key)) return null;
    const alert = this.#store.insertAlert(kind, severity, summary, { ...detail, key });
    // An alert is something awaiting the admin's acknowledgement.
    this.#audit.append({
      category: 'system',
      action: 'treasury.alert.raised',
      status: 'pending',
      summary,
      actor: 'system',
      mode: 'NONE',
      detail: { alertId: alert.id, kind, severity, ...detail },
    });
    return alert;
  }

  /** Raise a budget alert when a provider's period spend exceeds its budget. True when one was raised. */
  #checkProviderBudget(provider: Provider, period: string): boolean {
    const budget = usdToMicros(provider.monthlyBudgetUsd);
    if (budget <= 0n) return false;
    const spent = this.#providerPeriodSpend(provider.id, period);
    if (usdToMicros(spent) <= budget) return false;
    return (
      this.#raiseAlert(
        'budget_exceeded',
        'warning',
        `${provider.id}:${period}`,
        `${provider.name} spent ${spent} USD in ${period}, over its ${provider.monthlyBudgetUsd} USD budget`,
        { providerId: provider.id, period, spentUsd: spent, budgetUsd: provider.monthlyBudgetUsd },
      ) !== null
    );
  }

  // --- the review cycle -----------------------------------------------------------------------

  /**
   * One Treasury Agent review: read balances, compute burn and runway, ask
   * the model for a review, then apply the deterministic rules to whatever it
   * recommended. A recommendation can become an alert, a manual payable, or
   * a *proposal* awaiting human approval. Nothing here approves or exports.
   */
  async run(actor: string): Promise<TreasuryReviewReport> {
    if (this.#running) {
      throw new AppError(ErrorCode.CONFLICT, 'A treasury review is already running');
    }
    this.#running = true;
    const cycleId = randomUUID();
    const startedAt = new Date(this.#now()).toISOString();
    let alertsRaised = 0;

    try {
      const config = this.#store.getConfig();
      const balances = await this.readBalances();
      const burn = this.burn();
      const runwayEstimate = this.runway(balances, burn);
      const now = this.#now();
      const period = periodOf(now);

      if (runwayEstimate.months !== null) {
        const [whole = '0'] = runwayEstimate.months.split('.');
        if (BigInt(whole) < RUNWAY_SHORT_MONTHS) {
          if (
            this.#raiseAlert(
              'runway_short',
              'critical',
              'runway',
              `Estimated runway is ${runwayEstimate.months} months (${burn.basis})`,
              { months: runwayEstimate.months, burn },
            )
          ) {
            alertsRaised += 1;
          }
        }
      }
      for (const provider of this.#store.listProviders()) {
        if (this.#checkProviderBudget(provider, period)) alertsRaised += 1;
      }

      const providers = this.listProviders();
      const input: TreasuryAgentInput = {
        period,
        balances,
        burn,
        runway: runwayEstimate,
        caps: pickCaps(config),
        frozen: config.frozen,
        approvedThisMonthUsd: sumUsd(
          this.#store.approvedInMonth(now).map((proposal) => proposal.amountUsd),
        ),
        providers: providers.map((provider) => ({
          id: provider.id,
          name: provider.name,
          category: provider.category,
          billingMode: provider.billingMode,
          monthlyBudgetUsd: provider.monthlyBudgetUsd,
          spentThisPeriodUsd: provider.spentThisPeriodUsd,
          active: provider.active,
        })),
        pendingProposals: this.#store.listProposals({ status: 'proposed', limit: 1_000 }).length,
        openAlerts: this.#store.listAlerts({ limit: 50 }),
      };

      const output = await this.#agent.review(input);
      const actions = this.#applyReview(output, providers, period, cycleId);
      alertsRaised += actions.filter((action) => action.outcome === 'alert-raised').length;

      if (output.overridden) {
        if (
          this.#raiseAlert(
            'model_override',
            'warning',
            cycleId,
            `Treasury Agent recommendation overridden: ${output.overridden}`,
            { cycleId, model: output.model },
          )
        ) {
          alertsRaised += 1;
        }
      }

      this.#audit.append({
        category: 'system',
        action: 'treasury.review',
        status: output.overridden ? 'rejected' : output.fallback ? 'hold' : 'ok',
        summary: output.overridden
          ? `Treasury review: model overridden to NO_ACTION (${output.overridden})`
          : `Treasury review: ${output.review.recommendedActions.map((action) => action.action).join(', ') || 'NO_ACTION'}`,
        actor,
        mode: 'NONE',
        detail: {
          cycleId,
          model: output.model,
          modelStatus: output.modelStatus,
          fallback: output.fallback,
          overridden: output.overridden,
          summary: output.review.summary,
          concerns: output.review.concerns,
          actions,
          balances: { pricedValueUsd: balances.pricedValueUsd, complete: balances.complete },
          burn,
          runway: runwayEstimate,
        },
        correlationId: cycleId,
      });

      return {
        cycleId,
        startedAt,
        finishedAt: new Date(this.#now()).toISOString(),
        model: output.model,
        modelStatus: output.modelStatus,
        fallback: output.fallback,
        overridden: output.overridden,
        summary: output.review.summary,
        concerns: output.review.concerns,
        confidence: output.review.confidence,
        actions,
        alertsRaised,
        balances,
        burn,
        runway: runwayEstimate,
      };
    } finally {
      this.#running = false;
    }
  }

  #applyReview(
    output: TreasuryAgentOutput,
    providers: ProviderView[],
    period: string,
    cycleId: string,
  ): ReviewActionOutcome[] {
    const outcomes: ReviewActionOutcome[] = [];

    for (const recommendation of output.review.recommendedActions) {
      const base = {
        action: recommendation.action,
        provider: recommendation.provider,
        amountUsd: recommendation.amountUsd,
        reason: recommendation.reason,
      };

      if (recommendation.action === 'NO_ACTION') {
        outcomes.push({ ...base, outcome: 'none', detail: 'nothing to do' });
        continue;
      }

      const provider = providers.find(
        (candidate) => candidate.name.toLowerCase() === recommendation.provider?.toLowerCase(),
      );
      if (!provider) {
        // The agent's own sanity check should have caught this; the service
        // refuses again because "should have" is not a control.
        outcomes.push({ ...base, outcome: 'refused', detail: 'provider is not registered' });
        continue;
      }

      if (recommendation.action === 'REVIEW_BUDGET') {
        const alert = this.#raiseAlert(
          'budget_exceeded',
          'info',
          `review:${provider.id}:${period}`,
          `Treasury Agent suggests reviewing ${provider.name}'s budget (${provider.monthlyBudgetUsd} USD; suggested ${recommendation.amountUsd} USD): ${recommendation.reason}`,
          { providerId: provider.id, suggestedBudgetUsd: recommendation.amountUsd, cycleId },
        );
        outcomes.push({
          ...base,
          outcome: alert ? 'alert-raised' : 'none',
          detail: alert ? 'budget review alert raised' : 'an identical alert is already open',
        });
        continue;
      }

      // PROPOSE_PAYMENT
      if (provider.billingMode !== 'on-chain') {
        try {
          const expense = this.recordManualPayable(
            {
              providerId: provider.id,
              period,
              amountUsd: recommendation.amountUsd,
              note: `Treasury Agent (${cycleId.slice(0, 8)}): ${recommendation.reason}`,
            },
            TREASURY_AGENT_ACTOR,
          );
          outcomes.push({
            ...base,
            outcome: 'manual-payable-recorded',
            detail: `${provider.name} bills by ${provider.billingMode}; recorded as a manual payable, not a payment proposal`,
            expenseId: expense.id,
          });
        } catch (error) {
          outcomes.push({ ...base, outcome: 'refused', detail: errorMessage(error) });
        }
        continue;
      }

      try {
        const proposal = this.propose(
          {
            providerId: provider.id,
            amountUsd: recommendation.amountUsd,
            asset: defaultAssetFor(provider.recipient!.chain),
            period,
            memo: `Treasury Agent (${cycleId.slice(0, 8)}): ${recommendation.reason}`,
          },
          TREASURY_AGENT_ACTOR,
          'agent',
        );
        outcomes.push({
          ...base,
          outcome: 'proposal-created',
          detail: 'proposal awaits project-admin approval; nothing has been paid',
          proposalId: proposal.id,
        });
      } catch (error) {
        outcomes.push({ ...base, outcome: 'refused', detail: errorMessage(error) });
      }
    }

    return outcomes;
  }
}

// --- helpers -----------------------------------------------------------------------

function pickCaps(config: TreasuryConfig): TreasuryCaps {
  return {
    lowBalanceThresholdUsd: config.lowBalanceThresholdUsd,
    perPaymentCapUsd: config.perPaymentCapUsd,
    monthlyCapUsd: config.monthlyCapUsd,
    approvalThresholdUsd: config.approvalThresholdUsd,
  };
}

function canonicalUsd(value: string, field: string): string {
  try {
    const micros = usdToMicros(value);
    if (micros < 0n) throw new Error('negative');
    return microsToUsd(micros);
  } catch {
    throw new AppError(ErrorCode.SCHEMA_INVALID, `${field} must be a non-negative USD amount`, {
      errors: [{ path: field, message: 'must be a USD amount with at most six decimals' }],
    });
  }
}

function normalizeProvider(input: ProviderInput): ProviderInput {
  const name = input.name.trim();
  if (name.length === 0) {
    throw new AppError(ErrorCode.SCHEMA_INVALID, 'A provider needs a name', {
      errors: [{ path: 'name', message: 'must not be empty' }],
    });
  }
  const monthlyBudgetUsd = canonicalUsd(input.monthlyBudgetUsd, 'monthlyBudgetUsd');

  if (input.billingMode === 'on-chain') {
    if (!input.recipient) {
      throw new AppError(
        ErrorCode.SCHEMA_INVALID,
        'An on-chain provider needs an allowlisted recipient address',
        { errors: [{ path: 'recipient', message: 'required for billingMode on-chain' }] },
      );
    }
    return {
      name,
      category: input.category,
      billingMode: input.billingMode,
      monthlyBudgetUsd,
      recipient: {
        chain: input.recipient.chain,
        address: canonicalTreasuryAddress(
          input.recipient.chain,
          input.recipient.address,
          'recipient.address',
        ),
      },
      note: input.note,
    };
  }

  if (input.recipient) {
    throw new AppError(
      ErrorCode.SCHEMA_INVALID,
      `A ${input.billingMode} provider cannot carry a recipient address; only on-chain providers are paid from the treasury wallet`,
      { errors: [{ path: 'recipient', message: 'must be null unless billingMode is on-chain' }] },
    );
  }
  return {
    name,
    category: input.category,
    billingMode: input.billingMode,
    monthlyBudgetUsd,
    recipient: null,
    note: input.note,
  };
}

function capsRefused(decision: CapDecision, message: string): AppError {
  const errors: FieldIssue[] = decision.checks
    .filter((check) => !check.passed && check.skipped !== 'short-circuit')
    .map((check) => ({
      path: check.name,
      message: `${check.code}: observed ${check.observed}, limit ${check.limit}`,
    }));
  return new AppError(ErrorCode.CONFLICT, `${message}: ${decision.reason}`, {
    errors,
    details: { decision },
  });
}

/** The stablecoin the registry lists for a chain, for agent-created proposals. */
function defaultAssetFor(chain: ChainId): string {
  const preferred = ['USDC', 'USDT', 'USDG'];
  const tokens = CHAINS[chain].tokens;
  for (const symbol of preferred) {
    if (tokens.some((token) => token.symbol === symbol)) return symbol;
  }
  return tokens[0]?.symbol ?? CHAINS[chain].nativeSymbol;
}

/** USD to base units at a price, rounded down so the instruction never overpays. */
function usdToBaseUnits(amountUsd: string, decimals: number, priceUsd: string): bigint {
  const usdMicros = usdToMicros(amountUsd);
  const priceAtto = priceToAtto(priceUsd);
  if (priceAtto <= 0n) throw new Error('non-positive price');
  // units = usd / price; usdMicros / 1e6 * 10^decimals / (priceAtto / 1e18)
  const numerator = usdMicros * 10n ** BigInt(decimals) * 10n ** 12n;
  const units = numerator / priceAtto;
  // Sanity: the value of the computed units must not exceed the USD amount.
  const back = nativeToUsdMicros(units, decimals, priceAtto, 'ceil');
  return back > usdMicros ? units - 1n : units;
}

function explorerAddressUrl(chain: ChainId, address: string): string {
  const base = CHAINS[chain].explorerUrl;
  return chain === 'solana' ? `${base}/account/${address}` : `${base}/address/${address}`;
}
