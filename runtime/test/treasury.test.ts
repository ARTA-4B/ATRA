import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { base58 } from '@scure/base';
import { loadConfig } from '../src/config/env.js';
import { buildServices, shutdownServices } from '../src/core/services.js';
import type { Services } from '../src/core/services.js';
import type { ChainId } from '../src/chains/registry.js';
import { CHAINS, EVM_NATIVE_SENTINEL, SOLANA_NATIVE_SENTINEL } from '../src/chains/registry.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/provider.js';
import type { MarketDataProvider, MarketSource } from '../src/market/types.js';
import { TreasuryService } from '../src/treasury/service.js';
import type { TreasuryServiceDeps } from '../src/treasury/service.js';
import { TreasuryAgent, deterministicSanity } from '../src/agents/treasury/agent.js';
import type { TreasuryAgentInput } from '../src/agents/treasury/agent.js';
import { evaluateCaps } from '../src/treasury/caps.js';
import { burnRate, periodOf, runway, trailingPeriods } from '../src/treasury/burn.js';
import type { Provider } from '../src/treasury/types.js';

/**
 * Phase 5: the treasury.
 *
 * Every test runs the real composition root against an in-memory database,
 * then builds a TreasuryService from the services the composition root would
 * hand it: the database, the audit log, fake chain adapters, the market
 * service over fake providers, and a scripted model. Nothing between the
 * admin's request and the database is mocked: the store, the cap engine,
 * the balance reader and the agent's override logic are the production code.
 */

const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const TREASURY_BASE = '0x1111111111111111111111111111111111111111';
const RECIPIENT_BASE = '0x2222222222222222222222222222222222222222';
const OTHER_BASE = '0x3333333333333333333333333333333333333333';
const TREASURY_SOLANA = base58.encode(new Uint8Array(32).fill(5));

// --- fakes -------------------------------------------------------------------

interface FakeChainState {
  native: bigint;
  tokens: Map<string, bigint>;
  /** When set, every balance read throws with this message. */
  failWith: string | null;
}

function fakeChain(chain: ChainId, state: FakeChainState): ChainAdapter {
  const observe = <T>(value: T) => ({ value, observedAt: Date.now(), source: 'https://fake.rpc' });
  const info = CHAINS[chain];
  const fail = () => Promise.reject(new Error(state.failWith ?? 'unreachable'));
  return {
    chain,
    health: () =>
      Promise.resolve({
        chain,
        healthy: true,
        height: 1,
        latencyMs: 1,
        endpoint: 'fake',
        error: null,
        identity: 'fake',
        identityMatches: true,
      }),
    getNativeBalance: (address) =>
      state.failWith !== null
        ? fail()
        : Promise.resolve(
            observe({
              chain,
              address,
              amount: state.native.toString(),
              symbol: info.nativeSymbol,
              decimals: info.nativeDecimals,
            }),
          ),
    getTokenBalance: (owner, token) =>
      state.failWith !== null
        ? fail()
        : Promise.resolve(
            observe({
              chain,
              owner,
              token,
              amount: (state.tokens.get(token) ?? 0n).toString(),
              symbol: info.tokens.find((t) => t.address === token)?.symbol ?? null,
              decimals: info.tokens.find((t) => t.address === token)?.decimals ?? 18,
            }),
          ),
    getTokenMetadata: (address) =>
      Promise.resolve(observe({ chain, address, symbol: null, name: null, decimals: null })),
    estimateTransferFee: () =>
      Promise.resolve(
        observe({ chain, nativeAmount: '21000000000000', unitPrice: '1000000000', units: 21_000 }),
      ),
    getTransactionStatus: (hash) =>
      Promise.resolve(
        observe({
          chain,
          hash,
          state: 'unknown' as const,
          height: null,
          confirmations: null,
          error: null,
        }),
      ),
  };
}

function fakeMarket(source: MarketSource, prices: Map<string, string | null>): MarketDataProvider {
  return {
    source,
    chains: ['base', 'bsc', 'robinhood', 'solana'],
    health: () =>
      Promise.resolve({ source, healthy: true, latencyMs: 1, error: null, chains: ['base'] }),
    getPoolsForToken: () => Promise.resolve([]),
    getPool: () => Promise.resolve(null),
    getTokenPriceUsd: (_chain, token) => Promise.resolve(prices.get(token) ?? null),
    search: () => Promise.resolve([]),
  };
}

/** A model that answers the treasury prompt with a fixed review, or is unavailable. */
function scriptedModel(payload: unknown): LlmProvider {
  return {
    kind: 'openai-compatible',
    model: 'scripted',
    available: () =>
      Promise.resolve(
        payload === null
          ? { available: false, detail: 'scripted: off' }
          : { available: true, detail: 'ok' },
      ),
    chat: <T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> => {
      expect(request.system).toContain('treasury review layer');
      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        return Promise.reject(
          new Error(`model output rejected: ${parsed.error.issues[0]?.message ?? 'invalid'}`),
        );
      }
      return Promise.resolve({
        data: parsed.data,
        toolCalls: [],
        model: 'scripted',
        latencyMs: 1,
        usage: { promptTokens: null, completionTokens: null },
        attempts: 1,
      });
    },
  };
}

// --- harness -----------------------------------------------------------------

interface Harness {
  services: Services;
  treasury: TreasuryService;
  chains: Record<ChainId, FakeChainState>;
  prices: Map<string, string | null>;
  file: string | null;
}

function harness(options: {
  /** The review the model returns; null for "no model available". */
  model?: unknown;
  prices?: Map<string, string | null>;
  chains?: Partial<Record<ChainId, Partial<FakeChainState>>>;
  file?: string;
  now?: () => number;
}): Harness {
  const config = loadConfig({
    NODE_ENV: 'test',
    ATRA_MODE: 'ci',
    ATRA_LOG_LEVEL: 'silent',
    ATRA_DATA_DIR: './.test-data',
  });

  const chainState = (): FakeChainState => ({
    native: 10n ** 18n,
    tokens: new Map([[USDC_BASE, 1_000_000_000n]]),
    failWith: null,
  });
  const chains: Record<ChainId, FakeChainState> = {
    base: { ...chainState(), ...options.chains?.base },
    bsc: { ...chainState(), ...options.chains?.bsc },
    robinhood: { ...chainState(), ...options.chains?.robinhood },
    solana: { ...chainState(), ...options.chains?.solana },
  };
  const adapters = new Map<ChainId, ChainAdapter>(
    (Object.keys(chains) as ChainId[]).map((chain) => [chain, fakeChain(chain, chains[chain])]),
  );

  const prices =
    options.prices ??
    new Map<string, string | null>([
      [USDC_BASE, '1'],
      [EVM_NATIVE_SENTINEL, '2500'],
      [SOLANA_NATIVE_SENTINEL, '150'],
    ]);

  const llm = scriptedModel(options.model === undefined ? null : options.model);
  const services = buildServices(config, {
    databaseFile: options.file ?? ':memory:',
    adapters,
    kdfParams: FAST_KDF,
    llm,
    marketProviders: [fakeMarket('dexscreener', prices), fakeMarket('geckoterminal', prices)],
  });

  const deps: TreasuryServiceDeps = {
    db: services.db,
    audit: services.audit,
    adapters: services.adapters,
    market: services.market,
    llm: services.llm,
    kdfParams: FAST_KDF,
    ...(options.now ? { now: options.now } : {}),
  };
  const treasury = new TreasuryService(deps);

  return { services, treasury, chains, prices, file: options.file ?? null };
}

/** Caps, a treasury address on Base and an on-chain provider, in one go. */
function configure(h: Harness, caps?: Partial<Record<string, string>>): Provider {
  h.treasury.updateConfig(
    {
      caps: {
        perPaymentCapUsd: '100',
        monthlyCapUsd: '250',
        approvalThresholdUsd: '50',
        lowBalanceThresholdUsd: '0',
        ...caps,
      },
      addresses: [
        {
          chain: 'base',
          address: TREASURY_BASE,
          label: 'ATRA treasury (Base)',
          tokens: [{ address: USDC_BASE, symbol: 'USDC', decimals: 6 }],
          enabled: true,
        },
      ],
    },
    'test',
  );
  return h.treasury.addProvider(
    {
      name: 'Keyed RPC',
      category: 'rpc',
      billingMode: 'on-chain',
      monthlyBudgetUsd: '200',
      recipient: { chain: 'base', address: RECIPIENT_BASE },
      note: '',
    },
    'test',
  );
}

const review = (actions: unknown[]) => ({
  summary: 'scripted review',
  concerns: [],
  recommendedActions: actions,
  confidence: 0.5,
});

// --- tests -------------------------------------------------------------------

describe('Phase 5: treasury separation from user funds', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('the service exposes no signing, broadcast or transfer path', () => {
    h = harness({});
    const names = Object.getOwnPropertyNames(TreasuryService.prototype).map((n) => n.toLowerCase());
    for (const forbidden of [
      'sign',
      'broadcast',
      'transfer',
      'withdraw',
      'usesigningkey',
      'send',
    ]) {
      expect(names.filter((name) => name.includes(forbidden))).toEqual([]);
    }
    // Nothing on the instance either: the private fields are inaccessible and
    // the only public property is the admin gate.
    expect(Object.keys(h.treasury)).toEqual(['admin']);
  });

  it('the dependency shape has no wallet, vault, ledger or state', () => {
    h = harness({});
    const deps: TreasuryServiceDeps = {
      db: h.services.db,
      audit: h.services.audit,
      adapters: h.services.adapters,
      market: h.services.market,
      llm: h.services.llm,
    };
    expect(Object.keys(deps).sort()).toEqual(['adapters', 'audit', 'db', 'llm', 'market']);

    // Compile-time proof: the deps object cannot carry the wallet service.
    // @ts-expect-error - wallets is not a treasury dependency, by design.
    const withWallet: TreasuryServiceDeps = { ...deps, wallets: h.services.wallets };
    // @ts-expect-error - nor is the ledger.
    const withLedger: TreasuryServiceDeps = { ...deps, ledger: h.services.ledger };
    // @ts-expect-error - nor is the vault.
    const withVault: TreasuryServiceDeps = { ...deps, vault: h.services.vault };
    expect(withWallet).toBeDefined();
    expect(withLedger).toBeDefined();
    expect(withVault).toBeDefined();
  });

  it('the agent is constructed from the model provider alone', () => {
    expect(TreasuryAgent.length).toBe(1);
    const agent = new TreasuryAgent(scriptedModel(null));
    expect(Object.keys(agent)).toEqual([]);
    const names = Object.getOwnPropertyNames(TreasuryAgent.prototype);
    expect(names.sort()).toEqual(['constructor', 'review']);
  });

  it('the treasury tables have no foreign key into the wallet or ledger tables', () => {
    h = harness({});
    const tables = h.services.db
      .prepare<[], { name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'treasury_%'",
      )
      .all()
      .map((row) => row.name);
    expect(tables.length).toBeGreaterThanOrEqual(7);
    for (const table of tables) {
      const keys = h.services.db
        .prepare<[], { table: string }>(`PRAGMA foreign_key_list(${table})`)
        .all();
      for (const key of keys) expect(key.table.startsWith('treasury_')).toBe(true);
    }
  });
});

describe('Phase 5: treasury caps', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('safe defaults: nothing can be proposed until the caps are configured', () => {
    h = harness({});
    const provider = h.treasury.addProvider(
      {
        name: 'RPC',
        category: 'rpc',
        billingMode: 'on-chain',
        monthlyBudgetUsd: '0',
        recipient: { chain: 'base', address: RECIPIENT_BASE },
        note: '',
      },
      'test',
    );
    expect(() =>
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '1', asset: 'USDC' },
        'test',
        'admin',
      ),
    ).toThrow(/CHAIN_NOT_ENABLED|PER_PAYMENT_CAP/);
  });

  it('refuses an amount over the per-payment cap and records every check', () => {
    h = harness({});
    const provider = configure(h);
    let caught: unknown;
    try {
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '100.000001', asset: 'USDC' },
        'test',
        'admin',
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();
    const error = caught as { code: string; errors: Array<{ path: string; message: string }> };
    expect(error.code).toBe('CONFLICT');
    expect(error.errors.map((issue) => issue.path)).toEqual(['amount.perPayment']);
    expect(error.errors[0]!.message).toContain('observed 100.000001, limit 100.000000');
    // No row was written; the refusal is in the audit trail with the decision.
    expect(h.treasury.listProposals()).toEqual([]);
    const refused = h.services.audit
      .list({ category: 'system' })
      .find((row) => row.action === 'treasury.proposal.refused');
    expect(refused?.status).toBe('rejected');
    expect((refused?.detail.decision as { code: string }).code).toBe('PER_PAYMENT_CAP');
  });

  it('refuses a recipient that is not the provider allowlist entry, at the engine', () => {
    h = harness({});
    const provider = configure(h);
    const decision = evaluateCaps({
      now: Date.now(),
      stage: 'propose',
      frozen: false,
      caps: h.treasury.getConfig(),
      provider,
      enabledChains: ['base'],
      proposal: {
        providerId: provider.id,
        chain: 'base',
        recipient: OTHER_BASE,
        asset: 'USDC',
        amountUsd: '10',
      },
      monthToDateApprovedUsd: '0',
      providerPeriodSpendUsd: '0',
      period: '2026-09',
      creatorApproval: false,
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('RECIPIENT_NOT_ALLOWLISTED');
    const check = decision.checks.find((c) => c.code === 'RECIPIENT_NOT_ALLOWLISTED')!;
    expect(check.observed).toBe(`base:${OTHER_BASE}`);
    expect(check.limit).toBe(`base:${RECIPIENT_BASE}`);
  });

  it('the service only ever proposes to the provider recipient; there is no recipient input', () => {
    h = harness({});
    const provider = configure(h);
    const proposal = h.treasury.propose(
      { providerId: provider.id, amountUsd: '10', asset: 'USDC' },
      'test',
      'admin',
    );
    expect(proposal.recipient).toBe(RECIPIENT_BASE);
    expect(proposal.chain).toBe('base');
    expect(proposal.status).toBe('proposed');
    expect(proposal.checks.allowed).toBe(true);
    expect(proposal.checks.checks.map((c) => c.code)).toEqual([
      'FROZEN',
      'PROVIDER_UNKNOWN',
      'PROVIDER_INACTIVE',
      'PROVIDER_NOT_ON_CHAIN',
      'RECIPIENT_NOT_ALLOWLISTED',
      'CHAIN_NOT_ENABLED',
      'ASSET_UNKNOWN',
      'AMOUNT_INVALID',
      'PER_PAYMENT_CAP',
      'MONTHLY_CAP',
      'PROVIDER_BUDGET',
      'CREATOR_APPROVAL_REQUIRED',
    ]);
  });

  it('refuses when the monthly cap would be exceeded by approvals this month', () => {
    h = harness({});
    const provider = configure(h, { monthlyCapUsd: '150', approvalThresholdUsd: '1000' });
    // Both are proposed while nothing is approved yet, so both pass at proposal
    // time; the second is refused at approval, because approval re-evaluates
    // against what was approved in between.
    const first = h.treasury.propose(
      { providerId: provider.id, amountUsd: '100', asset: 'USDC' },
      'test',
      'admin',
    );
    const second = h.treasury.propose(
      { providerId: provider.id, amountUsd: '60', asset: 'USDC' },
      'test',
      'admin',
    );
    expect(second.checks.allowed).toBe(true);
    h.treasury.approve(first.id, { creatorApproval: false, note: '' }, 'test');

    expect(() =>
      h.treasury.approve(second.id, { creatorApproval: false, note: '' }, 'test'),
    ).toThrow(/MONTHLY_CAP/);
    const rejected = h.treasury.getProposal(second.id);
    expect(rejected.status).toBe('rejected');
    expect(rejected.decision?.code).toBe('MONTHLY_CAP');
    const check = rejected.decision!.checks.find((c) => c.code === 'MONTHLY_CAP')!;
    expect(check.observed).toBe('100.000000 approved this month + 60.000000 = 160.000000');
    expect(check.limit).toBe('150.000000');

    // And a proposal that cannot fit the remaining cap is refused before a row exists.
    expect(() =>
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '51', asset: 'USDC' },
        'test',
        'admin',
      ),
    ).toThrow(/MONTHLY_CAP/);
  });

  it('refuses an amount at or above the approval threshold without the creator flag', () => {
    h = harness({});
    const provider = configure(h, { approvalThresholdUsd: '50' });
    const proposal = h.treasury.propose(
      { providerId: provider.id, amountUsd: '50', asset: 'USDC' },
      'test',
      'admin',
    );
    const preview = proposal.checks.checks.find((c) => c.code === 'CREATOR_APPROVAL_REQUIRED')!;
    expect(preview.skipped).toBe('not-applicable');
    expect(preview.observed).toBe('creator approval will be required');

    expect(() =>
      h.treasury.approve(proposal.id, { creatorApproval: false, note: '' }, 'test'),
    ).toThrow(/CREATOR_APPROVAL_REQUIRED/);
    expect(h.treasury.getProposal(proposal.id).status).toBe('rejected');

    const again = h.treasury.propose(
      { providerId: provider.id, amountUsd: '50', asset: 'USDC' },
      'test',
      'admin',
    );
    const approved = h.treasury.approve(
      again.id,
      { creatorApproval: true, note: 'creator said yes' },
      'test',
    );
    expect(approved.status).toBe('approved');
    expect(approved.creatorApproval).toBe(true);
    expect(
      approved.decision?.checks.find((c) => c.code === 'CREATOR_APPROVAL_REQUIRED')?.observed,
    ).toBe('required and asserted');
  });

  it('refuses a provider budget overrun and an inactive provider', () => {
    h = harness({});
    const provider = configure(h, { approvalThresholdUsd: '1000' });
    h.treasury.recordExpense(
      {
        providerId: provider.id,
        period: periodOf(Date.now()),
        amountUsd: '150',
        kind: 'recurring',
        status: 'paid',
        source: 'manual',
        note: '',
      },
      'test',
    );
    expect(() =>
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '60', asset: 'USDC' },
        'test',
        'admin',
      ),
    ).toThrow(/PROVIDER_BUDGET/);

    h.treasury.updateProvider(provider.id, { active: false }, 'test');
    expect(() =>
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '10', asset: 'USDC' },
        'test',
        'admin',
      ),
    ).toThrow(/PROVIDER_INACTIVE/);
  });

  it('a manual-billing provider produces a manual payable and never a payment proposal', async () => {
    h = harness({
      model: review([
        { action: 'PROPOSE_PAYMENT', provider: 'Card Host', amountUsd: '40', reason: 'bill due' },
      ]),
    });
    configure(h);
    const card = h.treasury.addProvider(
      {
        name: 'Card Host',
        category: 'hosting',
        billingMode: 'card',
        monthlyBudgetUsd: '100',
        recipient: null,
        note: '',
      },
      'test',
    );
    expect(card.recipient).toBeNull();

    // The admin cannot propose a payment to it.
    expect(() =>
      h.treasury.propose({ providerId: card.id, amountUsd: '10', asset: 'USDC' }, 'test', 'admin'),
    ).toThrow(/PROVIDER_NOT_ON_CHAIN/);

    // A card provider cannot be given a recipient address either.
    expect(() =>
      h.treasury.updateProvider(
        card.id,
        { recipient: { chain: 'base', address: OTHER_BASE } },
        'test',
      ),
    ).toThrow(/only on-chain providers/);

    // The agent recommending a payment to it yields a manual payable.
    const report = await h.treasury.run('test');
    expect(report.actions).toHaveLength(1);
    expect(report.actions[0]!.outcome).toBe('manual-payable-recorded');
    expect(report.actions[0]!.expenseId).toBeDefined();
    const expense = h.treasury.listExpenses({ providerId: card.id })[0]!;
    expect(expense.kind).toBe('manual-payable');
    expect(expense.status).toBe('payable');
    expect(expense.amountUsd).toBe('40.000000');
    expect(h.treasury.listProposals()).toEqual([]);
  });
});

describe('Phase 5: freeze', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('refuses approval and export while frozen, needs no model, and clearing is audited', async () => {
    h = harness({});
    const provider = configure(h, { approvalThresholdUsd: '1000' });
    const pending = h.treasury.propose(
      { providerId: provider.id, amountUsd: '10', asset: 'USDC' },
      'test',
      'admin',
    );
    const approved = h.treasury.approve(
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '20', asset: 'USDC' },
        'test',
        'admin',
      ).id,
      { creatorApproval: false, note: '' },
      'test',
    );

    h.treasury.freeze('suspicious login', 'test');
    expect(h.treasury.isFrozen()).toBe(true);

    expect(() =>
      h.treasury.approve(pending.id, { creatorApproval: true, note: '' }, 'test'),
    ).toThrow(/frozen/);
    expect(h.treasury.getProposal(pending.id).status).toBe('proposed'); // untouched
    await expect(h.treasury.exportProposal(approved.id, 'test')).rejects.toThrow(/frozen/);
    expect(h.treasury.getProposal(approved.id).status).toBe('approved');
    expect(() =>
      h.treasury.propose(
        { providerId: provider.id, amountUsd: '1', asset: 'USDC' },
        'test',
        'admin',
      ),
    ).toThrow(/FROZEN/);

    const alerts = h.treasury.listAlerts();
    expect(alerts.some((a) => a.kind === 'frozen' && a.severity === 'critical')).toBe(true);

    h.treasury.clearFreeze('investigated, false alarm', 'test');
    expect(h.treasury.isFrozen()).toBe(false);
    const actions = h.services.audit.list({ category: 'system', limit: 100 }).map((r) => r.action);
    expect(actions).toContain('treasury.frozen');
    expect(actions).toContain('treasury.freeze.cleared');
    expect(() => h.treasury.clearFreeze('again', 'test')).toThrow(/not frozen/);

    const instruction = await h.treasury.exportProposal(approved.id, 'test');
    expect(instruction.proposalId).toBe(approved.id);
  });

  it('survives a restart', () => {
    const file = `./.test-data/treasury-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    h = harness({ file });
    configure(h);
    h.treasury.freeze('before restart', 'test');
    shutdownServices(h.services);

    h = harness({ file });
    expect(h.treasury.isFrozen()).toBe(true);
    const config = h.treasury.getConfig();
    expect(config.frozenReason).toBe('before restart');
    expect(config.frozenBy).toBe('test');
    expect(config.perPaymentCapUsd).toBe('100.000000');
    expect(config.addresses).toHaveLength(1);
  });
});

describe('Phase 5: proposals, export and the state machine', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('export returns a human instruction with the price-derived amount and no transaction material', async () => {
    h = harness({});
    const provider = configure(h, { approvalThresholdUsd: '1000' });
    const proposal = h.treasury.propose(
      { providerId: provider.id, amountUsd: '12.5', asset: 'USDC', memo: 'September RPC' },
      'test',
      'admin',
    );
    h.treasury.approve(proposal.id, { creatorApproval: false, note: 'ok' }, 'test');

    const instruction = await h.treasury.exportProposal(proposal.id, 'test');
    expect(instruction.from).toBe(TREASURY_BASE);
    expect(instruction.recipient).toBe(RECIPIENT_BASE);
    expect(instruction.asset).toEqual({ symbol: 'USDC', address: USDC_BASE, decimals: 6 });
    expect(instruction.amountUsd).toBe('12.500000');
    expect(instruction.amountBaseUnits).toBe('12500000');
    expect(instruction.amountDecimal).toBe('12.5');
    expect(instruction.price?.priceUsd).toBe('1');
    expect(instruction.evmChainId).toBe(8453);
    expect(instruction.approvedBy).toBe('test');
    expect(instruction.creatorApproval).toBe(false);
    expect(instruction.checks.every((c) => c.passed)).toBe(true);
    expect(instruction.notice).toContain('watch-only');

    // Nothing that looks like a transaction.
    const keys = Object.keys(instruction);
    for (const forbidden of [
      'data',
      'calldata',
      'nonce',
      'gas',
      'signature',
      'raw',
      'payload',
      'privateKey',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
    expect(h.treasury.getProposal(proposal.id).status).toBe('exported');
    await expect(h.treasury.exportProposal(proposal.id, 'test')).rejects.toThrow(
      /must be approved/,
    );
  });

  it('export with an unpriced asset gives a null amount with a reason, never zero', async () => {
    h = harness({ prices: new Map([[EVM_NATIVE_SENTINEL, '2500']]) });
    const provider = configure(h, { approvalThresholdUsd: '1000' });
    const proposal = h.treasury.propose(
      { providerId: provider.id, amountUsd: '10', asset: 'USDC' },
      'test',
      'admin',
    );
    h.treasury.approve(proposal.id, { creatorApproval: false, note: '' }, 'test');
    const instruction = await h.treasury.exportProposal(proposal.id, 'test');
    expect(instruction.amountBaseUnits).toBeNull();
    expect(instruction.amountDecimal).toBeNull();
    expect(instruction.price).toBeNull();
    expect(instruction.priceReason).toContain('convert the USD amount manually');
    expect(instruction.amountUsd).toBe('10.000000');
  });

  it('reject and cancel follow the state machine; illegal transitions are refused by the trigger', () => {
    h = harness({});
    const provider = configure(h, { approvalThresholdUsd: '1000' });
    const a = h.treasury.propose(
      { providerId: provider.id, amountUsd: '1', asset: 'USDC' },
      'test',
      'admin',
    );
    const rejected = h.treasury.reject(a.id, 'not needed', 'test');
    expect(rejected.status).toBe('rejected');
    expect(() => h.treasury.approve(a.id, { creatorApproval: false, note: '' }, 'test')).toThrow(
      /must be proposed/,
    );

    const b = h.treasury.propose(
      { providerId: provider.id, amountUsd: '1', asset: 'USDC' },
      'test',
      'admin',
    );
    expect(() => h.treasury.cancel(b.id, 'x', 'test')).toThrow(/must be approved/);
    h.treasury.approve(b.id, { creatorApproval: false, note: '' }, 'test');
    expect(h.treasury.cancel(b.id, 'changed our mind', 'test').status).toBe('cancelled');

    // Straight at the database: rejected -> approved is not a legal edge.
    expect(() =>
      h.services.db
        .prepare("UPDATE treasury_payment_proposals SET status = 'approved' WHERE id = ?")
        .run(a.id),
    ).toThrow(/illegal treasury payment proposal transition/);
    // Nor is rewriting the amount of any proposal.
    expect(() =>
      h.services.db
        .prepare("UPDATE treasury_payment_proposals SET amount_usd = '999' WHERE id = ?")
        .run(b.id),
    ).toThrow(/immutable/);
    expect(() =>
      h.services.db.prepare('DELETE FROM treasury_payment_proposals WHERE id = ?').run(b.id),
    ).toThrow(/append-only/);
  });

  it('expenses, snapshots and alerts are append-only', async () => {
    h = harness({});
    const provider = configure(h);
    const expense = h.treasury.recordExpense(
      {
        providerId: provider.id,
        period: '2026-08',
        amountUsd: '10',
        kind: 'recurring',
        status: 'paid',
        source: 'imported',
        note: '',
      },
      'test',
    );
    expect(() =>
      h.services.db
        .prepare("UPDATE treasury_expenses SET amount_usd = '1' WHERE id = ?")
        .run(expense.id),
    ).toThrow(/append-only/);
    expect(() =>
      h.services.db.prepare('DELETE FROM treasury_expenses WHERE id = ?').run(expense.id),
    ).toThrow(/append-only/);

    await h.treasury.readBalances();
    expect(() => h.services.db.prepare("UPDATE treasury_snapshots SET amount = '0'").run()).toThrow(
      /append-only/,
    );
    expect(() => h.services.db.prepare('DELETE FROM treasury_snapshots').run()).toThrow(
      /append-only/,
    );

    h.treasury.freeze('x', 'test');
    const alert = h.treasury.listAlerts()[0]!;
    expect(() =>
      h.services.db
        .prepare("UPDATE treasury_alerts SET summary = 'edited' WHERE id = ?")
        .run(alert.id),
    ).toThrow(/immutable/);
    expect(h.treasury.acknowledgeAlert(alert.id, 'test').acknowledgedAt).not.toBeNull();
    expect(() => h.services.db.prepare('DELETE FROM treasury_alerts').run()).toThrow(/append-only/);
  });
});

describe('Phase 5: balances, burn and runway', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('prices the watch-only balances through the adapters and the market service', async () => {
    h = harness({});
    configure(h);
    const report = await h.treasury.readBalances();
    expect(report.complete).toBe(true);
    expect(report.assets.map((a) => [a.symbol, a.amountDecimal, a.valueUsd])).toEqual([
      ['ETH', '1', '2500.000000'],
      ['USDC', '1000', '1000.000000'],
    ]);
    expect(report.pricedValueUsd).toBe('3500.000000');
    expect(report.assets[0]!.source).toBe('fake.rpc');
    const snapshots = h.services.db
      .prepare<[], { symbol: string; amount: string | null }>(
        'SELECT symbol, amount FROM treasury_snapshots ORDER BY symbol',
      )
      .all();
    expect(snapshots).toEqual([
      { symbol: 'ETH', amount: '1000000000000000000' },
      { symbol: 'USDC', amount: '1000000000' },
    ]);
  });

  it('a failed RPC read is null with the error, raises an alert and blocks the runway', async () => {
    h = harness({ chains: { base: { failWith: 'rpc timeout' } } });
    configure(h);
    const report = await h.treasury.readBalances();
    expect(report.complete).toBe(false);
    expect(report.assets.every((a) => a.amount === null)).toBe(true);
    expect(report.assets[0]!.reason).toContain('rpc timeout');
    expect(report.pricedValueUsd).toBe('0.000000');
    expect(report.incomplete).toHaveLength(2);
    const alerts = h.treasury.listAlerts();
    expect(alerts.filter((a) => a.kind === 'balance_unreadable')).toHaveLength(2);
    // A second read does not duplicate the open alerts.
    await h.treasury.readBalances();
    expect(h.treasury.listAlerts().filter((a) => a.kind === 'balance_unreadable')).toHaveLength(2);

    const rw = h.treasury.runway(report, h.treasury.burn());
    expect(rw.months).toBeNull();
    expect(rw.reason).toContain('incomplete');
    expect(rw.reason).toContain('rpc timeout');
  });

  it('an unpriced asset gives a null runway with a reason, never zero', async () => {
    h = harness({ prices: new Map([[USDC_BASE, '1']]) });
    const provider = configure(h);
    for (const period of trailingPeriods(Date.now(), 3)) {
      h.treasury.recordExpense(
        {
          providerId: provider.id,
          period,
          amountUsd: '100',
          kind: 'recurring',
          status: 'paid',
          source: 'imported',
          note: '',
        },
        'test',
      );
    }
    const report = await h.treasury.readBalances();
    const eth = report.assets.find((a) => a.symbol === 'ETH')!;
    expect(eth.amount).toBe('1000000000000000000');
    expect(eth.valueUsd).toBeNull();
    expect(eth.reason).toContain('price unknown');
    expect(report.complete).toBe(false);
    expect(report.pricedValueUsd).toBe('1000.000000');

    const burn = h.treasury.burn();
    expect(burn.monthlyUsd).toBe('100.000000');
    expect(burn.basis).toBe('trailing-3');
    const rw = h.treasury.runway(report, burn);
    expect(rw.months).toBeNull();
    expect(rw.balanceUsd).toBeNull();
    expect(rw.reason).toContain('ETH');
    expect(h.treasury.listAlerts().some((a) => a.kind === 'price_unknown')).toBe(true);
  });

  it('burn averages the trailing three months and labels fewer months honestly', () => {
    const now = Date.UTC(2026, 8, 20);
    const periods = trailingPeriods(now, 3);
    expect(periods).toEqual(['2026-07', '2026-08', '2026-09']);

    expect(burnRate([], now)).toMatchObject({ monthlyUsd: null, basis: 'none' });

    const single = burnRate([{ period: '2026-09', amountUsd: '120' }], now);
    expect(single.monthlyUsd).toBe('120.000000');
    expect(single.basis).toBe('single-month');
    expect(single.reason).toContain('single month');
    expect(single.usedPeriods).toEqual(['2026-09']);

    const two = burnRate(
      [
        { period: '2026-08', amountUsd: '100' },
        { period: '2026-09', amountUsd: '50' },
        { period: '2026-05', amountUsd: '9999' }, // outside the window
      ],
      now,
    );
    expect(two.monthlyUsd).toBe('75.000000');
    expect(two.basis).toBe('trailing-2');
    expect(two.usedPeriods).toEqual(['2026-08', '2026-09']);

    const three = burnRate(
      [
        { period: '2026-07', amountUsd: '100' },
        { period: '2026-08', amountUsd: '100.5' },
        { period: '2026-09', amountUsd: '99.5' },
      ],
      now,
    );
    expect(three).toMatchObject({ monthlyUsd: '100.000000', basis: 'trailing-3', reason: null });

    expect(runway('3500', null, three).months).toBe('35.00');
    expect(runway('350.123456', null, three).months).toBe('3.50');
    expect(runway(null, 'unreadable', three)).toMatchObject({ months: null, reason: 'unreadable' });
    expect(runway('100', null, burnRate([], now))).toMatchObject({ months: null });
    expect(
      runway('100', null, burnRate([{ period: '2026-09', amountUsd: '0' }], now)).reason,
    ).toContain('zero');
  });

  it('the dashboard view carries balances, spend, burn, runway, providers, proposals and alerts', async () => {
    h = harness({});
    const provider = configure(h, { approvalThresholdUsd: '1000', lowBalanceThresholdUsd: '5000' });
    const period = periodOf(Date.now());
    h.treasury.recordExpense(
      {
        providerId: provider.id,
        period,
        amountUsd: '30',
        kind: 'recurring',
        status: 'due',
        source: 'manual',
        note: '',
      },
      'test',
    );
    const proposal = h.treasury.propose(
      { providerId: provider.id, amountUsd: '20', asset: 'USDC' },
      'test',
      'admin',
    );
    h.treasury.approve(proposal.id, { creatorApproval: false, note: '' }, 'test');

    const view = await h.treasury.view();
    expect(view.balances.pricedValueUsd).toBe('3500.000000');
    expect(view.spend.expensesThisPeriodUsd).toBe('30.000000');
    expect(view.spend.approvedProposalsThisMonthUsd).toBe('20.000000');
    expect(view.spend.remainingMonthlyCapUsd).toBe('230.000000');
    expect(view.burn.basis).toBe('single-month');
    // A single-month burn still yields a runway, but it is labelled as such.
    expect(view.runway.months).toBe('116.66');
    expect(view.runway.reason).toContain('single month');
    expect(view.providers[0]).toMatchObject({
      spentThisPeriodUsd: '50.000000',
      remainingBudgetUsd: '150.000000',
      overBudget: false,
    });
    expect(view.proposals.approved).toHaveLength(1);
    expect(view.alerts.some((a) => a.kind === 'low_balance')).toBe(true);
    expect(view.modelStatus).toBe('UNTRAINED');
    expect(view.notice).toContain('watch-only');
  });
});

describe('Phase 5: the Treasury Agent', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('returns NO_ACTION when no model is configured, and the review is audited', async () => {
    h = harness({ model: null });
    configure(h);
    const report = await h.treasury.run('test');
    expect(report.modelStatus).toBe('UNAVAILABLE');
    expect(report.fallback).toBe(true);
    expect(report.actions.map((a) => a.action)).toEqual(['NO_ACTION']);
    expect(h.treasury.listProposals()).toEqual([]);
    const row = h.services.audit
      .list({ category: 'system' })
      .find((r) => r.action === 'treasury.review');
    expect(row?.actor).toBe('test');
    expect(row?.status).toBe('hold');
  });

  it('a NO_ACTION review changes nothing', async () => {
    h = harness({
      model: review([{ action: 'NO_ACTION', provider: null, amountUsd: '0', reason: 'all fine' }]),
    });
    configure(h);
    const report = await h.treasury.run('test');
    expect(report.modelStatus).toBe('UNTRAINED');
    expect(report.overridden).toBeNull();
    expect(report.actions[0]!.outcome).toBe('none');
    expect(h.treasury.listProposals()).toEqual([]);
    expect(h.treasury.listExpenses()).toEqual([]);
  });

  it('a PROPOSE_PAYMENT within the caps becomes a proposal that still needs a human', async () => {
    h = harness({
      model: review([
        {
          action: 'PROPOSE_PAYMENT',
          provider: 'Keyed RPC',
          amountUsd: '25',
          reason: 'monthly bill',
        },
      ]),
    });
    configure(h);
    const report = await h.treasury.run('test');
    expect(report.actions[0]!.outcome).toBe('proposal-created');
    const proposal = h.treasury.getProposal(report.actions[0]!.proposalId!);
    expect(proposal.status).toBe('proposed');
    expect(proposal.source).toBe('agent');
    expect(proposal.proposedBy).toBe('agent:treasury');
    expect(proposal.asset).toBe('USDC');
    expect(proposal.recipient).toBe(RECIPIENT_BASE);
  });

  it('is overridden to NO_ACTION when it names an unlisted provider, and that is a model failure', async () => {
    h = harness({
      model: review([
        {
          action: 'PROPOSE_PAYMENT',
          provider: 'Some Exchange',
          amountUsd: '10',
          reason: 'buy tokens',
        },
      ]),
    });
    configure(h);
    const report = await h.treasury.run('test');
    expect(report.overridden).toContain('not registered');
    expect(report.actions.map((a) => a.action)).toEqual(['NO_ACTION']);
    expect(h.treasury.listProposals()).toEqual([]);
    expect(h.treasury.listAlerts().some((a) => a.kind === 'model_override')).toBe(true);
    const row = h.services.audit
      .list({ category: 'system' })
      .find((r) => r.action === 'treasury.review');
    expect(row?.status).toBe('rejected');
  });

  it('is overridden when the amount is over a cap or the treasury is frozen', () => {
    const input: TreasuryAgentInput = {
      period: '2026-09',
      balances: {
        takenAt: '',
        assets: [],
        pricedValueUsd: '0.000000',
        complete: true,
        incomplete: [],
      },
      burn: {
        monthlyUsd: null,
        windowPeriods: [],
        usedPeriods: [],
        totalUsd: '0.000000',
        basis: 'none',
        reason: null,
      },
      runway: { months: null, balanceUsd: null, monthlyBurnUsd: null, reason: null },
      caps: {
        lowBalanceThresholdUsd: '0',
        perPaymentCapUsd: '100',
        monthlyCapUsd: '250',
        approvalThresholdUsd: '50',
      },
      frozen: false,
      approvedThisMonthUsd: '200',
      providers: [
        {
          id: 'p',
          name: 'Keyed RPC',
          category: 'rpc',
          billingMode: 'on-chain',
          monthlyBudgetUsd: '200',
          spentThisPeriodUsd: '190',
          active: true,
        },
      ],
      pendingProposals: 0,
      openAlerts: [],
    };
    const propose = (amountUsd: string) =>
      review([
        { action: 'PROPOSE_PAYMENT', provider: 'keyed rpc', amountUsd, reason: 'r' },
      ]) as never;

    expect(deterministicSanity(propose('101'), input)).toContain('per-payment cap');
    expect(deterministicSanity(propose('60'), input)).toContain('remaining monthly cap');
    expect(deterministicSanity(propose('20'), input)).toContain('remaining budget');
    expect(deterministicSanity(propose('5'), input)).toBeNull();
    expect(deterministicSanity(propose('5'), { ...input, frozen: true })).toContain('frozen');
    expect(
      deterministicSanity(
        review([
          { action: 'NO_ACTION', provider: 'Keyed RPC', amountUsd: '0', reason: 'r' },
        ]) as never,
        input,
      ),
    ).toContain('naming a provider');
    expect(
      deterministicSanity(
        review([{ action: 'REVIEW_BUDGET', provider: null, amountUsd: '0', reason: 'r' }]) as never,
        input,
      ),
    ).toContain('without a provider');
  });

  it('malformed model output is NO_ACTION, never interpreted', async () => {
    h = harness({ model: { summary: 'x', recommendedActions: 'pay everyone' } });
    configure(h);
    const report = await h.treasury.run('test');
    expect(report.modelStatus).toBe('UNAVAILABLE');
    expect(report.actions.map((a) => a.action)).toEqual(['NO_ACTION']);
    expect(report.summary).toContain('model output rejected');
  });

  it('a REVIEW_BUDGET raises an alert and nothing else; a second identical one is deduplicated', async () => {
    h = harness({
      model: review([
        { action: 'REVIEW_BUDGET', provider: 'Keyed RPC', amountUsd: '300', reason: 'trend up' },
      ]),
    });
    configure(h);
    const first = await h.treasury.run('test');
    expect(first.actions[0]!.outcome).toBe('alert-raised');
    const second = await h.treasury.run('test');
    expect(second.actions[0]!.outcome).toBe('none');
    expect(h.treasury.listAlerts().filter((a) => a.kind === 'budget_exceeded')).toHaveLength(1);
    expect(h.treasury.listProposals()).toEqual([]);
  });

  it('the prompt never carries a treasury address that could be mistaken for a key, and no user data', async () => {
    let prompt = '';
    const spy: LlmProvider = {
      kind: 'openai-compatible',
      model: 'spy',
      available: () => Promise.resolve({ available: true, detail: 'ok' }),
      chat: <T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> => {
        prompt = request.messages.map((m) => m.content).join('\n');
        return Promise.resolve({
          data: schema.parse(
            review([{ action: 'NO_ACTION', provider: null, amountUsd: '0', reason: 'ok' }]),
          ),
          toolCalls: [],
          model: 'spy',
          latencyMs: 1,
          usage: { promptTokens: null, completionTokens: null },
          attempts: 1,
        });
      },
    };
    h = harness({});
    configure(h);
    const agent = new TreasuryAgent(spy);
    const balances = await h.treasury.readBalances();
    await agent.review({
      period: periodOf(Date.now()),
      balances,
      burn: h.treasury.burn(),
      runway: h.treasury.runway(balances, h.treasury.burn()),
      caps: h.treasury.getConfig(),
      frozen: false,
      approvedThisMonthUsd: '0',
      providers: [],
      pendingProposals: 0,
      openAlerts: [],
    });
    expect(prompt).toContain('CAPS');
    expect(prompt).toContain('base ETH: 1 = 2500.000000 USD');
    // The agent wallets never appear: the treasury does not know them.
    for (const wallet of h.services.wallets.list()) {
      expect(prompt).not.toContain(wallet.address);
    }
  });
});

describe('Phase 5: providers and expenses', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('validates recipient addresses and refuses duplicates', () => {
    h = harness({});
    expect(() =>
      h.treasury.addProvider(
        {
          name: 'Bad',
          category: 'rpc',
          billingMode: 'on-chain',
          monthlyBudgetUsd: '1',
          recipient: { chain: 'base', address: '0x0000000000000000000000000000000000000000' },
          note: '',
        },
        'test',
      ),
    ).toThrow(/zero address/);
    expect(() =>
      h.treasury.addProvider(
        {
          name: 'Bad',
          category: 'rpc',
          billingMode: 'on-chain',
          monthlyBudgetUsd: '1',
          recipient: { chain: 'solana', address: 'not-base58!' },
          note: '',
        },
        'test',
      ),
    ).toThrow(/base58/);
    expect(() =>
      h.treasury.addProvider(
        {
          name: 'NoRecipient',
          category: 'rpc',
          billingMode: 'on-chain',
          monthlyBudgetUsd: '1',
          recipient: null,
          note: '',
        },
        'test',
      ),
    ).toThrow(/allowlisted recipient/);

    const solana = h.treasury.addProvider(
      {
        name: 'Sol RPC',
        category: 'rpc',
        billingMode: 'on-chain',
        monthlyBudgetUsd: '1',
        recipient: { chain: 'solana', address: TREASURY_SOLANA },
        note: '',
      },
      'test',
    );
    expect(solana.recipient?.address).toBe(TREASURY_SOLANA);
    expect(() =>
      h.treasury.addProvider(
        {
          name: 'sol rpc',
          category: 'rpc',
          billingMode: 'card',
          monthlyBudgetUsd: '1',
          recipient: null,
          note: '',
        },
        'test',
      ),
    ).toThrow(/already exists/);
  });

  it('records expenses with canonical amounts and raises a budget alert when exceeded', () => {
    h = harness({});
    const provider = configure(h);
    const expense = h.treasury.recordExpense(
      {
        providerId: provider.id,
        period: '2026-09',
        amountUsd: '150.5',
        kind: 'recurring',
        status: 'paid',
        source: 'imported',
        note: 'invoice 42',
      },
      'test',
    );
    expect(expense.amountUsd).toBe('150.500000');
    expect(h.treasury.listAlerts().filter((a) => a.kind === 'budget_exceeded')).toHaveLength(0);
    h.treasury.recordExpense(
      {
        providerId: provider.id,
        period: '2026-09',
        amountUsd: '60',
        kind: 'one-off',
        status: 'paid',
        source: 'manual',
        note: '',
      },
      'test',
    );
    const alert = h.treasury.listAlerts().find((a) => a.kind === 'budget_exceeded');
    expect(alert?.summary).toContain('210.500000');
    expect(() =>
      h.treasury.recordExpense(
        {
          providerId: randomUUID(),
          period: '2026-09',
          amountUsd: '1',
          kind: 'recurring',
          status: 'paid',
          source: 'manual',
          note: '',
        },
        'test',
      ),
    ).toThrow(/No treasury provider/);
    expect(() =>
      h.treasury.recordExpense(
        {
          providerId: provider.id,
          period: '2026-09',
          amountUsd: '0',
          kind: 'recurring',
          status: 'paid',
          source: 'manual',
          note: '',
        },
        'test',
      ),
    ).toThrow(/greater than zero/);
  });
});
