import { afterEach, describe, expect, it } from 'vitest';
import { microsToUsd } from '../src/risk/money.js';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { recoverTransactionAddress } from 'viem';
import { loadConfig } from '../src/config/env.js';
import { buildServices, shutdownServices } from '../src/core/services.js';
import type { Services } from '../src/core/services.js';
import type { ChainId } from '../src/chains/registry.js';
import { CHAINS, EVM_NATIVE_SENTINEL } from '../src/chains/registry.js';
import type { ChainAdapter, SignedTransaction, SigningContext } from '../src/chains/types.js';
import type { SimulationResult, UnsignedTransaction } from '../src/execution/types.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/provider.js';
import type { MarketDataProvider, MarketSnapshot } from '../src/market/types.js';
import type { FeeDetail, ProposedAction } from '../src/risk/types.js';
import { lpPoolKey } from '../src/risk/types.js';
import { deriveIdempotencyKey, evaluate } from '../src/risk/engine.js';
import { policyHash } from '../src/risk/policy.js';
import type { RiskPolicy } from '../src/risk/policy.js';
import { LiquidityService } from '../src/liquidity/service.js';
import { LiquidityRegistry } from '../src/liquidity/registry.js';
import { v2AddQuote, shareOfReserves } from '../src/liquidity/evm/v2-pool.js';
import { LP_PROTOCOLS, VERIFIED_EXAMPLE_POOLS } from '../src/liquidity/protocols.js';
import type {
  LpAdapter,
  LpAddQuote,
  LpAddQuoteRequest,
  LpClaimPlan,
  LpPoolState,
  LpPositionState,
  LpReceipt,
  LpRemoveQuote,
  LpRemoveQuoteRequest,
} from '../src/liquidity/types.js';
import { deterministicSanity } from '../src/agents/liquidity-manager/agent.js';
import type { LpAgentInput, LpDecision } from '../src/agents/liquidity-manager/agent.js';

/**
 * Phase 4: liquidity management.
 *
 * Every test runs the real composition root against an in-memory database
 * with fake chain and market adapters, a fake LP adapter over an in-memory
 * pool, and a scripted model. Nothing between the model's decision and the
 * executor is mocked: the LP proposal builder, the risk gate, the LP ledger
 * and the paper/live executors are the production code, constructed exactly
 * as the composition root will construct them.
 */

const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';

const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH = '0x4200000000000000000000000000000000000006';
const AERODROME = LP_PROTOCOLS.base!.router;
const POOL = '0xcdac0d6c6c59727a65f871236188350531885c43';

// --- fakes -------------------------------------------------------------------

interface FakeChainState {
  native: bigint;
  tokens: Map<string, bigint>;
}

function fakeChain(chain: ChainId, state: FakeChainState): ChainAdapter {
  const observe = <T>(value: T) => ({ value, observedAt: Date.now(), source: 'fake' });
  const info = CHAINS[chain];
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
      Promise.resolve(
        observe({
          chain,
          address,
          amount: state.native.toString(),
          symbol: info.nativeSymbol,
          decimals: info.nativeDecimals,
        }),
      ),
    getTokenBalance: (owner, token) =>
      Promise.resolve(
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
          state: 'confirmed' as const,
          height: 1,
          confirmations: 1,
          error: null,
        }),
      ),
  };
}

interface FakeMarketState {
  prices: Map<string, string | null>;
  observedAt: () => string;
}

function fakeMarket(state: FakeMarketState): MarketDataProvider {
  const pool = (chain: ChainId, base: string, quote: string): MarketSnapshot => ({
    chain,
    poolId: `${base}-${quote}`,
    dexId: 'fake',
    base: { address: base, symbol: 'BASE', name: null, decimals: null },
    quote: { address: quote, symbol: 'QUOTE', name: null, decimals: null },
    priceUsd: state.prices.get(base) ?? null,
    priceNative: null,
    liquidityUsd: '5000000',
    volume24hUsd: '100000',
    change: { m5: null, h1: null, h6: null, h24: 10 },
    observedAt: state.observedAt(),
    fetchedAt: new Date().toISOString(),
    source: 'dexscreener',
    freshnessMs: 1_000,
  });
  return {
    source: 'dexscreener',
    chains: ['base', 'bsc', 'robinhood', 'solana'],
    health: () =>
      Promise.resolve({
        source: 'dexscreener',
        healthy: true,
        latencyMs: 1,
        error: null,
        chains: ['base'],
      }),
    getPoolsForToken: (chain, token) => Promise.resolve([pool(chain, token, USDC)]),
    getPool: (chain, poolId) => Promise.resolve(pool(chain, poolId, USDC)),
    getTokenPriceUsd: (_chain, token) => Promise.resolve(state.prices.get(token) ?? null),
    search: () => Promise.resolve([]),
  };
}

/** A model that answers the liquidity manager from a queue; the last answer repeats. */
function scriptedLpModel(payloads: unknown[]): LlmProvider {
  const queue = [...payloads];
  return {
    kind: 'openai-compatible',
    model: 'scripted',
    available: () => Promise.resolve({ available: true, detail: 'scripted' }),
    chat: <T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> => {
      if (!request.system.includes('liquidity management layer')) {
        return Promise.reject(new Error('unexpected agent'));
      }
      const payload = queue.length > 1 ? queue.shift() : queue[0];
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

interface FakePool {
  reserve0: bigint;
  reserve1: bigint;
  totalSupply: bigint;
  lpBalances: Map<string, bigint>;
  claimable0: Map<string, bigint>;
  claimable1: Map<string, bigint>;
}

interface FakeLpOptions {
  chain?: ChainId;
  protocol?: string;
  router?: string;
  gasPriceWei?: bigint;
  allowance?: bigint;
  /** Whether broadcast mutates the pool as a real fill would. */
  settle?: boolean;
  /** Make every simulation revert with this message, as a moved pool would. */
  simulationError?: string;
}

interface Prepared {
  kind: 'add' | 'remove' | 'claim' | 'approve';
  add?: LpAddQuote;
  remove?: LpRemoveQuote;
  from: string;
}

class FakeLpAdapter implements LpAdapter {
  readonly chain: ChainId;
  readonly protocol: string;
  readonly kind = 'v2' as const;
  readonly contracts: readonly string[];
  readonly claimsFees = true;
  readonly pool: FakePool;
  readonly broadcasts: SignedTransaction[] = [];
  readonly signingContexts: SigningContext[] = [];
  readonly simulations: UnsignedTransaction[] = [];
  /** Every simulate/prepare/broadcast, in order, so the executor's order is testable. */
  readonly calls: string[] = [];
  readonly receipts = new Map<string, LpReceipt>();
  /** Park a cycle inside its first chain read, for the cycle-lock tests. */
  beforeReadPool: (() => Promise<void>) | null = null;
  #options: FakeLpOptions;
  #lastPrepared: Prepared | null = null;

  constructor(pool: FakePool, options: FakeLpOptions = {}) {
    this.pool = pool;
    this.chain = options.chain ?? 'base';
    this.protocol = options.protocol ?? 'aerodrome-v2';
    this.contracts = [options.router ?? AERODROME];
    this.#options = options;
  }

  #state(): LpPoolState {
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: POOL,
      kind: 'v2',
      stable: false,
      token0: { address: WETH, decimals: 18, symbol: 'WETH' },
      token1: { address: USDC, decimals: 6, symbol: 'USDC' },
      reserve0: this.pool.reserve0.toString(),
      reserve1: this.pool.reserve1.toString(),
      totalSupply: this.pool.totalSupply.toString(),
      lpTokenDecimals: 18,
      feeBps: 30,
      range: null,
      observedAt: Date.now(),
      source: 'fake-lp',
    };
  }

  #fee(gas: bigint): { estimatedAt: number; detail: FeeDetail } {
    return {
      estimatedAt: Date.now(),
      detail: {
        family: 'evm',
        gasLimit: gas.toString(),
        maxFeePerGas: (this.#options.gasPriceWei ?? 1_000_000_000n).toString(),
      },
    };
  }

  async readPool(poolId: string): Promise<LpPoolState> {
    if (this.beforeReadPool) await this.beforeReadPool();
    if (poolId.toLowerCase() !== POOL) {
      throw new Error(`${poolId} is not a pool according to the factory`);
    }
    return this.#state();
  }

  async readPosition(owner: string, poolId: string): Promise<LpPositionState> {
    const pool = await this.readPool(poolId);
    const lpTokens = this.pool.lpBalances.get(owner.toLowerCase()) ?? 0n;
    const share = shareOfReserves(pool, lpTokens);
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: POOL,
      owner: owner.toLowerCase(),
      lpTokens: lpTokens.toString(),
      amount0: share.amount0.toString(),
      amount1: share.amount1.toString(),
      claimable0: (this.pool.claimable0.get(owner.toLowerCase()) ?? 0n).toString(),
      claimable1: (this.pool.claimable1.get(owner.toLowerCase()) ?? 0n).toString(),
      claimNote: 'fake claimable',
      observedAt: Date.now(),
      source: 'fake-lp',
    };
  }

  async quoteAdd(request: LpAddQuoteRequest): Promise<LpAddQuote> {
    const pool = await this.readPool(request.poolId);
    const local = v2AddQuote(pool, BigInt(request.amount0Desired), BigInt(request.amount1Desired));
    const haircut = (v: bigint) => v - (v * BigInt(request.slippageBps)) / 10_000n;
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: POOL,
      contract: this.contracts[0]!,
      amount0: local.amount0.toString(),
      amount1: local.amount1.toString(),
      min0: haircut(local.amount0).toString(),
      min1: haircut(local.amount1).toString(),
      expectedLpTokens: local.liquidity.toString(),
      minLpTokens: haircut(local.liquidity).toString(),
      slippageBps: request.slippageBps,
      quotedAt: Date.now(),
      source: 'fake-quoteAdd',
      feeEstimate: this.#fee(260_000n),
      routeData: { recipient: request.from },
    };
  }

  async quoteRemove(request: LpRemoveQuoteRequest): Promise<LpRemoveQuote> {
    const pool = await this.readPool(request.poolId);
    const share = shareOfReserves(pool, BigInt(request.lpTokens));
    const haircut = (v: bigint) => v - (v * BigInt(request.slippageBps)) / 10_000n;
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: POOL,
      contract: this.contracts[0]!,
      lpTokens: request.lpTokens,
      expected0: share.amount0.toString(),
      expected1: share.amount1.toString(),
      min0: haircut(share.amount0).toString(),
      min1: haircut(share.amount1).toString(),
      slippageBps: request.slippageBps,
      quotedAt: Date.now(),
      source: 'fake-quoteRemove',
      feeEstimate: this.#fee(220_000n),
      routeData: { recipient: request.from },
    };
  }

  async claimPlan(owner: string, poolId: string): Promise<LpClaimPlan> {
    const position = await this.readPosition(owner, poolId);
    return {
      chain: this.chain,
      protocol: this.protocol,
      poolId: POOL,
      contract: POOL,
      claimable0: position.claimable0!,
      claimable1: position.claimable1!,
      quotedAt: Date.now(),
      feeEstimate: this.#fee(150_000n),
    };
  }

  /**
   * The gas limit travels in the payload and comes back out in
   * prepareSigning, exactly as V2PoolAdapter does it. The executor compares
   * the signed fee with the one the engine approved, so a double that quotes
   * one limit and signs another is not a faithful double.
   */
  #tx(
    to: string,
    from: string,
    prepared: Prepared,
    summary: string,
    gasLimit: bigint,
  ): UnsignedTransaction {
    return {
      chain: this.chain,
      payload: { to, from, data: '0xabcdef', value: '0', gasLimit: gasLimit.toString(), prepared },
      summary,
    };
  }

  buildAdd(quote: LpAddQuote): UnsignedTransaction {
    const from = (quote.routeData as { recipient: string }).recipient;
    return this.#tx(
      this.contracts[0]!,
      from,
      { kind: 'add', add: quote, from },
      'fake addLiquidity',
      260_000n,
    );
  }

  buildRemove(quote: LpRemoveQuote): UnsignedTransaction {
    const from = (quote.routeData as { recipient: string }).recipient;
    return this.#tx(
      this.contracts[0]!,
      from,
      { kind: 'remove', remove: quote, from },
      'fake removeLiquidity',
      220_000n,
    );
  }

  buildClaim(_plan: LpClaimPlan, owner: string): UnsignedTransaction {
    return this.#tx(POOL, owner, { kind: 'claim', from: owner }, 'fake claimFees', 150_000n);
  }

  allowance(): Promise<bigint> {
    return Promise.resolve(this.#options.allowance ?? 0n);
  }

  buildApprove(token: string, owner: string, amount: bigint): UnsignedTransaction {
    return this.#tx(
      token,
      owner,
      { kind: 'approve', from: owner },
      `fake approve ${amount.toString()}`,
      60_000n,
    );
  }

  approveFeeEstimate(): Promise<{ estimatedAt: number; detail: FeeDetail }> {
    return Promise.resolve(this.#fee(60_000n));
  }

  /**
   * The executor asks for this structurally (LpAdapter does not declare it),
   * so the double offers it exactly as V2PoolLpAdapter does: the transaction
   * that was built, answered from the same payload that will be signed.
   */
  simulate(tx: UnsignedTransaction): Promise<SimulationResult> {
    this.calls.push('simulate');
    this.simulations.push(tx);
    const error = this.#options.simulationError ?? null;
    return Promise.resolve({
      ok: error === null,
      amountOut: null,
      unitsUsed: error === null ? Number((tx.payload as { gasLimit: string }).gasLimit) : null,
      error,
      simulatedAt: Date.now(),
    });
  }

  prepareSigning(tx: UnsignedTransaction, from: string): Promise<SigningContext> {
    this.calls.push('prepare');
    const payload = tx.payload as {
      to: string;
      data: string;
      gasLimit: string;
      prepared: Prepared;
    };
    this.#lastPrepared = payload.prepared;
    const context: SigningContext = {
      family: 'evm',
      chainId: CHAINS[this.chain].evmChainId!,
      from,
      to: payload.to,
      data: payload.data,
      value: '0',
      gas: payload.gasLimit,
      nonce: this.broadcasts.length,
      maxFeePerGas: '1000000000',
      maxPriorityFeePerGas: '1000000',
    };
    this.signingContexts.push(context);
    return Promise.resolve(context);
  }

  broadcast(signed: SignedTransaction): Promise<void> {
    this.calls.push('broadcast');
    this.broadcasts.push(signed);
    const prepared = this.#lastPrepared;
    const received: Record<string, string> = {};
    const sent: Record<string, string> = {};
    if (prepared && (this.#options.settle ?? true)) {
      const wallet = prepared.from.toLowerCase();
      if (prepared.kind === 'add' && prepared.add) {
        const local = v2AddQuote(
          this.#state(),
          BigInt(prepared.add.amount0),
          BigInt(prepared.add.amount1),
        );
        this.pool.reserve0 += local.amount0;
        this.pool.reserve1 += local.amount1;
        this.pool.totalSupply += local.liquidity;
        this.pool.lpBalances.set(
          wallet,
          (this.pool.lpBalances.get(wallet) ?? 0n) + local.liquidity,
        );
        received[POOL] = local.liquidity.toString();
        sent[WETH] = local.amount0.toString();
        sent[USDC] = local.amount1.toString();
      } else if (prepared.kind === 'remove' && prepared.remove) {
        const burned = BigInt(prepared.remove.lpTokens);
        const share = shareOfReserves(this.#state(), burned);
        this.pool.reserve0 -= share.amount0;
        this.pool.reserve1 -= share.amount1;
        this.pool.totalSupply -= burned;
        this.pool.lpBalances.set(wallet, (this.pool.lpBalances.get(wallet) ?? 0n) - burned);
        received[WETH] = share.amount0.toString();
        received[USDC] = share.amount1.toString();
      } else if (prepared.kind === 'claim') {
        received[WETH] = (this.pool.claimable0.get(wallet) ?? 0n).toString();
        received[USDC] = (this.pool.claimable1.get(wallet) ?? 0n).toString();
        this.pool.claimable0.set(wallet, 0n);
        this.pool.claimable1.set(wallet, 0n);
      }
    }
    this.receipts.set(signed.hash, {
      chain: this.chain,
      hash: signed.hash,
      status: 'confirmed',
      feeNative: '21000000000000',
      height: 1,
      error: null,
      received,
      sent,
    });
    return Promise.resolve();
  }

  receipt(hash: string): Promise<LpReceipt> {
    return Promise.resolve(
      this.receipts.get(hash) ?? {
        chain: this.chain,
        hash,
        status: 'unknown',
        feeNative: null,
        height: null,
        error: null,
        received: {},
        sent: {},
      },
    );
  }
}

// --- harness -----------------------------------------------------------------

interface Harness {
  services: Services;
  liquidity: LiquidityService;
  lp: FakeLpAdapter;
  chains: Record<ChainId, FakeChainState>;
  market: FakeMarketState;
}

function freshPool(): FakePool {
  return {
    // 1,000 WETH and 2,500,000 USDC: the pool price is 2,500, matching the market.
    reserve0: 1_000n * 10n ** 18n,
    reserve1: 2_500_000n * 10n ** 6n,
    totalSupply: 50_000n * 10n ** 18n,
    lpBalances: new Map(),
    claimable0: new Map(),
    claimable1: new Map(),
  };
}

const LP_POLICY: RiskPolicy['lp'] = {
  maxCapitalPerLpUsd: '50',
  allowedPools: [{ chain: 'base', protocol: 'aerodrome-v2', poolId: POOL }],
  allowedProtocols: { base: ['aerodrome-v2'] },
  minPoolLiquidityUsd: '500000',
  maxRebalancePerDay: 4,
  maxRebalanceSlippageBps: 50,
  maxLpGasUsd: '2',
  minFeeThresholdUsd: '5',
};

async function harness(options: {
  model: unknown[];
  lp?: FakeLpOptions;
  pool?: Partial<FakePool>;
  policy?: Omit<Partial<RiskPolicy>, 'lp'> & { lp?: Partial<RiskPolicy['lp']> };
  /** Leave the default (LP disabled) policy in place. */
  defaultPolicy?: boolean;
  chains?: Partial<Record<ChainId, Partial<FakeChainState>>>;
}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    ATRA_MODE: 'ci',
    ATRA_LOG_LEVEL: 'silent',
    ATRA_DATA_DIR: './.test-data',
  });

  const chainState = (): FakeChainState => ({ native: 10n ** 18n, tokens: new Map() });
  const chains: Record<ChainId, FakeChainState> = {
    base: { ...chainState(), ...options.chains?.base },
    bsc: { ...chainState(), ...options.chains?.bsc },
    robinhood: { ...chainState(), ...options.chains?.robinhood },
    solana: { ...chainState(), ...options.chains?.solana },
  };
  const adapters = new Map<ChainId, ChainAdapter>(
    (Object.keys(chains) as ChainId[]).map((chain) => [chain, fakeChain(chain, chains[chain])]),
  );
  const market: FakeMarketState = {
    prices: new Map([
      [USDC, '1'],
      [WETH, '2500'],
      [EVM_NATIVE_SENTINEL, '2500'],
    ]),
    observedAt: () => new Date().toISOString(),
  };
  const llm = scriptedLpModel(options.model);

  const services = buildServices(config, {
    databaseFile: ':memory:',
    adapters,
    kdfParams: FAST_KDF,
    executionAdapters: [],
    llm,
    marketProviders: [fakeMarket(market)],
  });

  await services.auth.setPassword(PASSWORD);
  await services.vault.initialize(PASSWORD);
  services.state.createInstallation(randomUUID(), 'test', ['base', 'solana']);
  services.riskPolicy.initialize(['base', 'solana']);
  services.wallets.createAgentWallets();
  services.state.completeSetup();

  if (!options.defaultPolicy) {
    const current = services.riskPolicy.get();
    services.riskPolicy.update(
      {
        ...current,
        ...options.policy,
        lp: { ...LP_POLICY, ...options.policy?.lp },
      },
      'operator',
    );
  }

  const lp = new FakeLpAdapter({ ...freshPool(), ...options.pool }, options.lp);
  const liquidity = new LiquidityService({
    db: services.db,
    audit: services.audit,
    state: services.state,
    ledger: services.ledger,
    trades: services.trades,
    gate: services.gate,
    policy: services.riskPolicy,
    wallets: services.wallets,
    market: services.market,
    llm,
    registry: new LiquidityRegistry([lp]),
    sleep: () => Promise.resolve(),
  });
  // The composition root shares one cycle lock between the trade pipeline and
  // the liquidity pipeline; this harness builds its own LiquidityService over
  // the fake adapter, so it repeats that wiring rather than losing it.
  liquidity.pipeline.shareLock(services.lock);
  services.state.onEmergencyStop((active, reason) => {
    liquidity.onEmergencyStop(active, reason);
  });

  return { services, liquidity, lp, chains, market };
}

const decide = (action: string, capitalUsd = '0', extra: Record<string, unknown> = {}) => ({
  action,
  chain: 'base',
  poolId: POOL,
  capitalUsd,
  reason: 'scripted',
  confidence: 0.8,
  evidence: ['pool.reserves'],
  ...extra,
});

function seedPaper(h: Harness, usdc = 1_000_000_000n, weth = 10n ** 18n, eth = 10n ** 18n): void {
  h.services.ledger.setPaperBalance('base', USDC, 6, usdc.toString());
  h.services.ledger.setPaperBalance('base', WETH, 18, weth.toString());
  h.services.ledger.setPaperBalance('base', EVM_NATIVE_SENTINEL, 18, eth.toString());
}

const run = (h: Harness) =>
  h.liquidity.pipeline.runCycle({ chain: 'base', poolId: POOL, source: 'operator' });

async function activateLive(services: Services): Promise<void> {
  for (const step of [
    'acknowledged',
    'reauthenticated',
    'riskReviewed',
    'walletFunded',
    'gasChecked',
    'adapterChecked',
  ] as const) {
    services.state.recordActivationStep(step, 'operator');
  }
  services.state.activateLive('operator');
  await services.vault.unlock(PASSWORD);
}

/** A hand-built LP action for engine-level tests, defaulting to a valid paper lp_add. */
function lpAction(
  h: Harness,
  kind: 'lp_add' | 'lp_remove' | 'lp_rebalance' | 'lp_claim',
  overrides: Partial<ProposedAction> = {},
): ProposedAction {
  const now = Date.now();
  const base: ProposedAction = {
    schemaVersion: 1,
    actionId: randomUUID(),
    decisionCycleId: randomUUID(),
    idempotencyKey: '0'.repeat(64),
    proposedAt: now,
    mode: 'PAPER',
    source: 'test',
    chain: 'base',
    kind,
    protocol: 'aerodrome-v2',
    contract: kind === 'lp_claim' ? POOL : AERODROME,
    reduceOnly: false,
    tokenIn: { address: WETH, decimals: 18 },
    tokenOut: { address: USDC, decimals: 6 },
    amountIn: kind === 'lp_claim' ? '0' : '4000000000000000',
    quote:
      kind === 'lp_claim'
        ? null
        : {
            expectedAmountOut: kind === 'lp_remove' ? '10000000' : '200000000000000000',
            minAmountOut: kind === 'lp_remove' ? '9950000' : '199000000000000000',
            slippageBps: 50,
            priceImpactBps: 0,
            quotedAt: now,
            source: 'test',
            marketId: POOL,
          },
    feeEstimate: {
      estimatedAt: now,
      detail: { family: 'evm', gasLimit: '260000', maxFeePerGas: '1000000000' },
    },
    lp: {
      poolId: POOL,
      capitalUsd: '20',
      rebalanceIndexToday: 0,
      claimableFeesUsd: '0',
      ...(kind === 'lp_add' || kind === 'lp_rebalance'
        ? { amountB: '10000000', minAmountA: '3980000000000000', minAmountB: '9950000' }
        : {}),
      ...(kind === 'lp_remove'
        ? { lpTokens: '200000000000000000', minAmountA: '3980000000000000', minAmountB: '9950000' }
        : {}),
      ...(kind === 'lp_claim'
        ? { claimable: { amountA: '1000000000000000', amountB: '1000000' } }
        : {}),
    },
    ...overrides,
  };
  void h;
  return { ...base, idempotencyKey: deriveIdempotencyKey(base) };
}

/** A snapshot that satisfies every freshness and balance check for `lpAction`. */
function lpSnapshot(
  _h: Harness,
  lp: { lpTokens?: string; capitalUsd?: string; rebalancesToday?: number } = {},
) {
  const at = Date.now() - 1_000;
  const key = lpPoolKey('base', POOL);
  return {
    prices: {
      [`base:${WETH}`]: { value: '2500', at, source: 'fake' },
      [`base:${USDC}`]: { value: '1', at, source: 'fake' },
      [`base:${EVM_NATIVE_SENTINEL}`]: { value: '2500', at, source: 'fake' },
    },
    liquidity: {},
    balances: {
      [`base:${WETH}`]: { value: '1000000000000000000', at, source: 'paper-ledger' },
      [`base:${USDC}`]: { value: '1000000000', at, source: 'paper-ledger' },
      [`base:${EVM_NATIVE_SENTINEL}`]: { value: '1000000000000000000', at, source: 'paper-ledger' },
    },
    poolLiquidity: { [`base:${POOL}`]: { value: '5000000', at, source: 'fake' } },
    lp: {
      deployedUsd: lp.capitalUsd ?? '0',
      rebalancesToday: lp.rebalancesToday ? { [key]: lp.rebalancesToday } : {},
      positions: lp.lpTokens
        ? { [key]: { lpTokens: lp.lpTokens, capitalUsd: lp.capitalUsd ?? '20' } }
        : {},
    },
  };
}

const priceLookup = (chain: ChainId, token: string): string | null =>
  chain === 'base'
    ? ({ [WETH]: '2500', [USDC]: '1', [EVM_NATIVE_SENTINEL]: '2500' }[token] ?? null)
    : null;

// --- tests -------------------------------------------------------------------

describe('Phase 4: LP pipeline (PAPER)', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('fills an ADD on paper: books the position, spends both paper balances, records the fee', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);

    const report = await run(h);
    expect(report.outcome).toBe('filled');
    expect(report.risk?.allowed).toBe(true);
    expect(report.execution?.status).toBe('filled');
    expect(report.execution?.txHash).toBeNull();
    // 10 USD of each side at 2,500: 0.004 WETH + 10 USDC → 0.2 LP of 50,000.
    expect(report.execution?.amount0).toBe('4000000000000000');
    expect(report.execution?.amount1).toBe('10000000');
    expect(report.execution?.lpTokens).toBe('200000000000000000');

    const positions = h.liquidity.store.listPositions('PAPER');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.lpTokens).toBe('200000000000000000');
    expect(positions[0]?.capitalUsd).toBe('20.000000');
    expect(positions[0]?.lastAction).toBe('ADD');

    expect(h.services.ledger.getPaperBalance('base', WETH)?.amount).toBe(
      (10n ** 18n - 4n * 10n ** 15n).toString(),
    );
    expect(h.services.ledger.getPaperBalance('base', USDC)?.amount).toBe(
      (1_000_000_000n - 10_000_000n).toString(),
    );

    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.kind).toBe('lp_add');
    expect(trade.status).toBe('filled');
    expect(Number(trade.feeUsd)).toBeGreaterThan(0);

    const actions = h.liquidity.store.listActions();
    expect(actions[0]?.action).toBe('ADD');
    expect(actions[0]?.status).toBe('filled');

    const audit = h.services.audit.list({ correlationId: report.cycleId });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        'liquidity.decision',
        'risk.allowed',
        'liquidity.filled',
        'liquidity.cycle',
      ]),
    );
    expect(audit.every((row) => row.mode === 'PAPER')).toBe(true);

    // The dashboard view labels paper positions as simulated.
    const view = h.liquidity.view();
    expect(view.summary.activePositions).toBe(1);
    expect(view.positions[0]?.status).toBe('SIMULATED');
    expect(view.positions[0]?.source).toBe('paper-sim');
    expect(view.positions[0]?.range).toBeNull();
    expect(view.positions[0]?.feesNote).toMatch(/not simulated/);
  });

  it('marks an open position on the next cycle and shows impermanent loss against the cost basis', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20'), decide('HOLD')] });
    seedPaper(h);
    expect((await run(h)).outcome).toBe('filled');

    // WETH doubles and the pool re-prices: reserves move along x·y = k.
    h.market.prices.set(WETH, '5000');
    h.market.prices.set(EVM_NATIVE_SENTINEL, '5000');
    const k = h.lp.pool.reserve0 * h.lp.pool.reserve1;
    // New reserve0 = sqrt(k / 5000e-12) — done with integers: r0² = k · 1e6 / (5000 · 1e18)·1e18 …
    // Simpler: halve reserve0 and double reserve1 (same k, price ×4) is too far; use exact 2×:
    // price = r1·1e12 / r0 must equal 5000 → r0 = sqrt(k·1e12/5000).
    const target = (k * 10n ** 12n) / 5000n;
    let r0 = 10n ** 21n;
    for (let i = 0; i < 100; i += 1) r0 = (r0 + target / r0) / 2n;
    h.lp.pool.reserve0 = r0;
    h.lp.pool.reserve1 = k / r0;

    const hold = await run(h);
    expect(hold.outcome).toBe('hold');
    const [position] = h.liquidity.positions('PAPER');
    expect(position?.valueUsd).not.toBeNull();
    expect(position?.markedAt).not.toBeNull();
    // Holding 0.004 WETH + 10 USDC would be worth 30; the LP share is worth
    // less than that and more than the 20 paid: impermanent loss, visibly.
    expect(Number(position!.valueUsd)).toBeGreaterThan(20);
    expect(Number(position!.valueUsd)).toBeLessThan(30);
    expect(Number(position!.unrealizedUsd)).toBeGreaterThan(0);
  });

  it('HOLD is the default and a parse failure is a HOLD with the reason', async () => {
    h = await harness({ model: [decide('HOLD')] });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('hold');
    expect(report.decision?.action).toBe('HOLD');
    expect(h.services.trades.list()).toHaveLength(0);
    expect(h.liquidity.store.listActions()[0]?.action).toBe('HOLD');
    shutdownServices(h.services);

    h = await harness({ model: [{ action: 'ADD EVERYTHING', chain: 'base' }] });
    seedPaper(h);
    const garbage = await run(h);
    expect(garbage.outcome).toBe('hold');
    expect(garbage.reason).toMatch(/model output rejected/);
    expect(garbage.modelStatus).toBe('UNAVAILABLE');
    expect(h.services.trades.list()).toHaveLength(0);
  });

  it('cannot execute on a chain without an LP adapter, and the registry says why', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);
    for (const chain of ['solana', 'robinhood', 'bsc'] as const) {
      const status = h.liquidity.registry.status(chain);
      expect(status.available).toBe(false);
      expect(status.reason.length).toBeGreaterThan(20);
    }
    expect(h.liquidity.registry.status('solana').reason).toMatch(/concentrated-liquidity/);
    expect(h.liquidity.registry.status('robinhood').reason).toMatch(/Uniswap v4/);

    const report = await h.liquidity.pipeline.runCycle({
      chain: 'solana',
      poolId: 'pool',
      source: 'operator',
    });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toMatch(/no LP adapter/);
    expect(h.liquidity.store.listActions()[0]?.action).toBe('HOLD');
    expect(h.services.trades.list()).toHaveLength(0);

    // Engine layer: an LP action on an enabled chain the policy lists no
    // pools for. The pool allowlist decides before any market data is read.
    const bsc = lpAction(h, 'lp_add', {
      chain: 'bsc',
      protocol: 'pancakeswap-v2',
      contract: LP_PROTOCOLS.bsc!.router,
    });
    const policy: RiskPolicy = {
      ...h.services.riskPolicy.get(),
      enabledChains: ['base', 'solana', 'bsc'],
    };
    const verdict = evaluate({
      now: Date.now(),
      policy,
      policyHash: policyHash(policy),
      action: bsc,
      state: h.services.gate.runtimeState(priceLookup),
      snapshot: lpSnapshot(h),
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('POOL_NOT_ALLOWLISTED');
    expect(verdict.checks.find((c) => c.name === 'lp.pool')?.detail).toMatch(/allowedProtocols/);
  });

  it('rejects every lp_* kind under the default policy and the agent holds on an unlisted pool', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')], defaultPolicy: true });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('hold');
    expect(report.reason).toMatch(/not allowlisted/);
    expect(h.services.trades.list()).toHaveLength(0);

    for (const kind of ['lp_add', 'lp_remove', 'lp_rebalance', 'lp_claim'] as const) {
      const verdict = h.services.gate.preview(
        lpAction(h, kind),
        lpSnapshot(h, { lpTokens: '200000000000000000' }),
        priceLookup,
      );
      expect(verdict.allowed).toBe(false);
      expect(verdict.code).toBe('POOL_NOT_ALLOWLISTED');
    }
  });

  it('caps capital per position: the agent is overridden and the engine rejects', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '60')] });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('hold');
    expect(report.reason).toMatch(/exceeds the per-position cap/);

    const verdict = h.services.gate.preview(
      lpAction(h, 'lp_add', {
        amountIn: '12000000000000000',
        lp: { ...lpAction(h, 'lp_add').lp!, amountB: '30000000' },
      }),
      lpSnapshot(h),
      priceLookup,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('LP_CAPITAL_EXCEEDS_MAX');
    expect(verdict.checks.find((c) => c.name === 'lp.capital')?.observed).toBe('60.000000');

    // An add on top of an existing position counts the existing capital.
    const stacked = h.services.gate.preview(
      lpAction(h, 'lp_add'),
      lpSnapshot(h, { lpTokens: '400000000000000000', capitalUsd: '40' }),
      priceLookup,
    );
    expect(stacked.code).toBe('LP_CAPITAL_EXCEEDS_MAX');
  });

  it('rejects a thin pool with POOL_LIQUIDITY_BELOW_MIN', async () => {
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20')],
      policy: { lp: { minPoolLiquidityUsd: '10000000' } },
    });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('rejected');
    expect(report.risk?.code).toBe('POOL_LIQUIDITY_BELOW_MIN');
    expect(h.services.trades.get(report.trade!.tradeId)?.status).toBe('rejected');
    expect(h.liquidity.store.listPositions('PAPER')).toHaveLength(0);
    expect(h.liquidity.store.listActions()[0]?.status).toBe('rejected');
  });

  it('REBALANCE on a v2 pool is overridden to HOLD; the engine enforces the daily limit', async () => {
    h = await harness({ model: [decide('REBALANCE')] });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('hold');
    expect(report.reason).toMatch(/no price range/);

    const verdict = h.services.gate.preview(
      lpAction(h, 'lp_rebalance'),
      lpSnapshot(h, { lpTokens: '200000000000000000', rebalancesToday: 4 }),
      priceLookup,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('REBALANCE_LIMIT_REACHED');

    const under = h.services.gate.preview(
      lpAction(h, 'lp_rebalance'),
      lpSnapshot(h, { lpTokens: '200000000000000000', rebalancesToday: 3 }),
      priceLookup,
    );
    expect(under.checks.find((c) => c.name === 'lp.rebalanceCount')?.passed).toBe(true);
  });

  it('COLLECT_FEES below the threshold is overridden; the engine rejects FEE_BELOW_CLAIM_THRESHOLD', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20'), decide('COLLECT_FEES')] });
    seedPaper(h);

    // Engine layer first, before any fill starts the market cooldown:
    // 0.001 WETH + 1 USDC = 3.5 USD against a 5 USD threshold.
    const verdict = h.services.gate.preview(
      lpAction(h, 'lp_claim'),
      lpSnapshot(h, { lpTokens: '200000000000000000' }),
      priceLookup,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('FEE_BELOW_CLAIM_THRESHOLD');
    expect(verdict.checks.find((c) => c.name === 'lp.claimThreshold')?.observed).toBe('3.500000');

    const enough = h.services.gate.preview(
      lpAction(h, 'lp_claim', {
        lp: {
          ...lpAction(h, 'lp_claim').lp!,
          claimable: { amountA: '2000000000000000', amountB: '1000000' },
        },
      }),
      lpSnapshot(h, { lpTokens: '200000000000000000' }),
      priceLookup,
    );
    expect(enough.allowed).toBe(true);
    expect(enough.checks.find((c) => c.name === 'allowlist.contract')?.passed).toBe(true);

    // Pipeline layer: on paper fees are never simulated, so the agent's
    // COLLECT_FEES is overridden before anything is built.
    expect((await run(h)).outcome).toBe('filled');
    const report = await run(h);
    expect(report.outcome).toBe('hold');
    expect(report.reason).toMatch(/below the claim threshold/);
  });

  it('rejects gas above lp.maxLpGasUsd with FEE_EXCEEDS_MAX from the lp.gas rule', async () => {
    // 260k gas × 5 gwei = 0.0013 ETH ≈ 3.25 USD: over the 2 USD LP gas cap,
    // under the 5 USD transaction fee cap, so lp.gas is what fails.
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20')],
      lp: { gasPriceWei: 5n * 10n ** 9n },
      policy: { maxTransactionFeeUsd: '5' },
    });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('rejected');
    expect(report.risk?.code).toBe('FEE_EXCEEDS_MAX');
    const decision = h.services.gate.getDecision(report.trade!.actionId)!;
    const failing = decision.checks.filter((c) => !c.passed && c.skipped === undefined);
    expect(failing.map((c) => c.name)).toEqual(['lp.gas']);
  });

  it('is blocked by the emergency stop and by pause, and the stop disarms LP automation', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);
    h.liquidity.configureAutomation(true, 600, 'operator');
    expect(h.liquidity.automation().enabled).toBe(true);

    h.services.state.setEmergencyStop(true, 'test', 'operator');
    expect(h.liquidity.automation().enabled).toBe(false);
    let report = await run(h);
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/emergency/);
    await expect(h.liquidity.run('base', POOL)).rejects.toThrow(/Emergency stop/);
    expect(() => h.liquidity.configureAutomation(true, 600, 'operator')).toThrow(/emergency stop/i);

    h.services.state.setEmergencyStop(false, null, 'operator');
    h.services.state.setGlobalPause(true, 'test', 'operator');
    report = await run(h);
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/paused/);
    await expect(h.liquidity.run('base', POOL)).rejects.toThrow(/paused/);
    expect(h.services.trades.list()).toHaveLength(0);
    h.liquidity.stop();
  });

  it('overrides REMOVE_LIQUIDITY and EXIT when there is no position', async () => {
    h = await harness({ model: [decide('EXIT')] });
    seedPaper(h);
    const report = await run(h);
    expect(report.outcome).toBe('hold');
    expect(report.reason).toMatch(/no open position/);
    shutdownServices(h.services);

    h = await harness({ model: [decide('REMOVE_LIQUIDITY')] });
    seedPaper(h);
    expect((await run(h)).reason).toMatch(/no open position/);

    // Engine layer: lp_remove with no position in the LP ledger.
    const verdict = h.services.gate.preview(lpAction(h, 'lp_remove'), lpSnapshot(h), priceLookup);
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('REDUCE_ONLY_MISMATCH');
    expect(verdict.checks.find((c) => c.name === 'lp.position')?.detail).toMatch(
      /no open LP position/,
    );
  });

  it('EXIT on paper returns both assets, closes the position and realizes the fee as loss', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20'), decide('EXIT')] });
    seedPaper(h);
    expect((await run(h)).outcome).toBe('filled');

    const exit = await run(h);
    expect(exit.outcome).toBe('filled');
    expect(exit.decision?.action).toBe('EXIT');
    const trade = h.services.trades.get(exit.trade!.tradeId)!;
    expect(trade.kind).toBe('lp_remove');
    expect(trade.side).toBe('close');
    expect(trade.status).toBe('filled');

    // Exits skip the exposure caps but not the position check.
    const decision = h.services.gate.getDecision(exit.trade!.actionId)!;
    expect(decision.checks.find((c) => c.name === 'size.amountInUsd')?.skipped).toBe(
      'not-applicable',
    );
    expect(decision.checks.find((c) => c.name === 'deployed.total')?.skipped).toBe(
      'not-applicable',
    );
    expect(decision.checks.find((c) => c.name === 'lp.position')?.passed).toBe(true);

    expect(h.liquidity.store.listPositions('PAPER')).toHaveLength(0);
    expect(h.services.ledger.getPaperBalance('base', WETH)?.amount).toBe((10n ** 18n).toString());
    expect(h.services.ledger.getPaperBalance('base', USDC)?.amount).toBe('1000000000');
    const record = h.liquidity.store.listActions()[0]!;
    expect(record.action).toBe('EXIT');
    expect(record.status).toBe('filled');
    expect(Number(record.feeUsd)).toBeGreaterThan(0);
  });

  it('counts LP impermanent loss and gas in the day, so the next add meets the cap', async () => {
    h = await harness({
      model: [
        decide('ADD_LIQUIDITY', '20'),
        decide('REMOVE_LIQUIDITY'),
        decide('EXIT'),
        decide('ADD_LIQUIDITY', '20'),
      ],
      // Pacing off, so the last cycle is judged on the day's loss alone.
      policy: { maxDailyLossUsd: '10', cooldownSeconds: 0, globalMinIntervalSeconds: 0 },
    });
    seedPaper(h);
    expect((await run(h)).outcome).toBe('filled');

    // The pool loses 60% of its depth at an unchanged price: the 0.2 LP that
    // 20 USD bought is now a share worth 8.
    h.lp.pool.reserve0 = 400n * 10n ** 18n;
    h.lp.pool.reserve1 = 1_000_000n * 10n ** 6n;

    expect((await run(h)).outcome).toBe('filled');
    expect((await run(h)).outcome).toBe('filled');
    expect(h.liquidity.store.listPositions('PAPER')).toHaveLength(0);

    // Twice 4 USD returned against a 10 USD basis is 12 of impermanent loss,
    // plus 0.65 of gas on the add and 0.55 on each exit.
    expect(h.services.ledger.realizedPnlTodayUsd('PAPER')).toBe(-13_750_000n);
    expect(h.services.ledger.toRiskLedger('PAPER', priceLookup).realizedPnlTodayUsd).toBe(
      '-13.750000',
    );

    // Which is the figure the engine reads: 13.75 lost is past a 10 USD cap,
    // so the next add is refused rather than waved through on "today 0".
    const blocked = await run(h);
    expect(blocked.outcome).toBe('rejected');
    expect(blocked.risk?.code).toBe('DAILY_LOSS_BREACHED');
    expect(h.liquidity.store.listPositions('PAPER')).toHaveLength(0);
  });

  it('rolls back a paper add that overdraws the second asset', async () => {
    h = await harness({ model: [decide('HOLD')] });
    // Enough WETH for the first debit; the second wants 10 USDC and finds 1.
    h.services.ledger.setPaperBalance('base', WETH, 18, (10n ** 18n).toString());
    h.services.ledger.setPaperBalance('base', USDC, 6, '1000000');

    const action = lpAction(h, 'lp_add');
    const decision = h.services.gate.preview(action, lpSnapshot(h), priceLookup);
    expect(decision.allowed).toBe(true);
    const trade = h.services.trades.propose(action, 'open');
    h.services.trades.decide(trade.id, decision);

    const quote = await h.lp.quoteAdd({
      poolId: POOL,
      amount0Desired: '4000000000000000',
      amount1Desired: '10000000',
      slippageBps: 50,
      from: h.services.wallets.depositAddress('base'),
    });
    const outcome = h.liquidity.paper.execute(
      trade.id,
      action,
      { kind: 'add', quote },
      await h.lp.readPool(POOL),
      { token0Usd: '2500', token1Usd: '1', nativeUsd: '2500' },
    );

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/negative/);
    // The first debit goes back with the rest: no assets spent, no position,
    // nothing realized.
    expect(h.services.ledger.getPaperBalance('base', WETH)?.amount).toBe((10n ** 18n).toString());
    expect(h.services.ledger.getPaperBalance('base', USDC)?.amount).toBe('1000000');
    expect(h.liquidity.store.listPositions('PAPER')).toEqual([]);
    expect(h.services.ledger.realizedPnlTodayUsd('PAPER')).toBe(0n);
    expect(h.services.trades.get(trade.id)?.status).toBe('failed');
  });

  it('REMOVE_LIQUIDITY on paper takes half and keeps the rest', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20'), decide('REMOVE_LIQUIDITY')] });
    seedPaper(h);
    expect((await run(h)).outcome).toBe('filled');
    const half = await run(h);
    expect(half.outcome).toBe('filled');
    expect(h.services.trades.get(half.trade!.tradeId)?.side).toBe('reduce');
    const [position] = h.liquidity.store.listPositions('PAPER');
    expect(position?.lpTokens).toBe('100000000000000000');
    expect(position?.capitalUsd).toBe('10.000000');
    expect(position?.lastAction).toBe('REMOVE');
  });

  it('refuses to add into a pool whose price disagrees with the market', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);
    // The pool says 2,600 while the cross-checked market says 2,500: 400 bps.
    h.lp.pool.reserve1 = 2_600_000n * 10n ** 6n;
    const report = await run(h);
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toMatch(/deviates from the cross-checked market price/);
    expect(h.services.trades.list()).toHaveLength(0);
  });

  it('replays the same LP intent as DUPLICATE_ACTION', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);
    const action = lpAction(h, 'lp_add');
    const first = h.services.gate.decide(action, lpSnapshot(h), priceLookup);
    expect(first.allowed).toBe(true);
    const again = h.services.gate.decide(
      { ...action, actionId: randomUUID() },
      lpSnapshot(h),
      priceLookup,
    );
    expect(again.code).toBe('DUPLICATE_ACTION');
  });
});

describe('Phase 4: LIVE LP executor', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  const liveChains = {
    base: {
      tokens: new Map([
        [USDC, 1_000_000_000n],
        [WETH, 10n ** 18n],
      ]),
    },
  };

  it('never signs while the runtime is in PAPER, even for a LIVE-mode action', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')], chains: liveChains });
    const action = lpAction(h, 'lp_add', { mode: 'LIVE' });
    const verdict = h.services.gate.preview(action, lpSnapshot(h), priceLookup);
    expect(verdict.allowed).toBe(false);
    expect(['MODE_MISMATCH', 'LIVE_NOT_ACTIVATED']).toContain(verdict.code);

    const trade = h.services.trades.propose(action, 'open');
    h.services.trades.decide(trade.id, { ...verdict, allowed: true, code: 'OK' });
    const quote = await h.lp.quoteAdd({
      poolId: POOL,
      amount0Desired: action.amountIn,
      amount1Desired: action.lp!.amountB!,
      slippageBps: 50,
      from: h.services.wallets.depositAddress('base'),
    });
    const outcome = await h.liquidity.live.execute(
      trade.id,
      action,
      { kind: 'add', quote },
      await h.lp.readPool(POOL),
      { token0Usd: '2500', token1Usd: '1', nativeUsd: '2500' },
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/not in LIVE mode/);
    expect(h.lp.signingContexts).toHaveLength(0);
    expect(h.lp.broadcasts).toHaveLength(0);
  });

  it('signs an ADD, records the hash before broadcast, and books the chain-reported LP tokens', async () => {
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20')],
      lp: { allowance: 10n ** 30n },
      chains: liveChains,
    });
    await activateLive(h.services);

    const report = await run(h);
    expect(report.outcome).toBe('filled');
    expect(report.mode).toBe('LIVE');
    expect(report.execution?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.lp.broadcasts).toHaveLength(1);

    // Built, then simulated, then signed — and what was simulated is the
    // transaction that was signed, not a second one built for the occasion.
    expect(h.lp.calls).toEqual(['simulate', 'prepare', 'broadcast']);
    expect(h.lp.simulations[0]?.summary).toBe('fake addLiquidity');

    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.kind).toBe('lp_add');
    expect(trade.status).toBe('filled');
    expect(trade.txHash).toBe(h.lp.broadcasts[0]!.hash);

    // The signed transaction really is from the agent wallet.
    const recovered = await recoverTransactionAddress({
      serializedTransaction: h.lp.broadcasts[0]!.raw as `0x02${string}`,
    });
    expect(recovered.toLowerCase()).toBe(h.services.wallets.depositAddress('base').toLowerCase());

    // Booked from the receipt, which the fake pool settled.
    const [position] = h.liquidity.store.listPositions('LIVE');
    expect(position?.lpTokens).toBe('200000000000000000');
    expect(position?.lpTokens).toBe(
      h.lp.pool.lpBalances.get(h.services.wallets.depositAddress('base').toLowerCase())!.toString(),
    );
    expect(h.liquidity.positions('LIVE')[0]?.status).toBe('ACTIVE');

    // Newest first: the signed row was written before the filled row.
    const actions = h.services.audit
      .list({ correlationId: report.cycleId })
      .map((row) => row.action);
    expect(actions.indexOf('liquidity.signed')).toBeGreaterThan(
      actions.indexOf('liquidity.filled'),
    );
  });

  it('never signs an ADD whose simulation reverts', async () => {
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20')],
      lp: {
        allowance: 10n ** 30n,
        simulationError: 'execution reverted: INSUFFICIENT_B_AMOUNT',
      },
      chains: liveChains,
    });
    await activateLive(h.services);

    const report = await run(h);
    expect(report.outcome).toBe('failed');
    expect(report.reason).toMatch(/INSUFFICIENT_B_AMOUNT/);

    // The reserves moved under the quote: the key is never used, no gas is
    // spent, and the LP ledger is untouched.
    expect(h.lp.calls).toEqual(['simulate']);
    expect(h.lp.signingContexts).toHaveLength(0);
    expect(h.lp.broadcasts).toHaveLength(0);
    expect(h.liquidity.store.listPositions('LIVE')).toHaveLength(0);

    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.status).toBe('failed');
    expect(trade.txHash).toBeNull();
    expect(h.liquidity.store.listActions()[0]?.status).toBe('failed');
  });

  it('routes an exact approval of each pool asset through the risk engine before the add', async () => {
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20')],
      lp: { allowance: 0n },
      chains: liveChains,
    });
    await activateLive(h.services);
    const report = await run(h);
    expect(report.outcome).toBe('filled');
    expect(h.lp.broadcasts).toHaveLength(3);

    const approvals = h.services.trades.list().filter((t) => t.kind === 'approve');
    expect(approvals).toHaveLength(2);
    expect(approvals.map((t) => t.tokenIn).sort()).toEqual([WETH, USDC].sort());
    expect(approvals.map((t) => t.amountIn).sort()).toEqual(
      ['10000000', '4000000000000000'].sort(),
    );
    for (const approval of approvals) {
      expect(approval.status).toBe('filled');
      expect(h.services.gate.getDecision(approval.actionId)?.allowed).toBe(true);
    }
  });

  it('EXIT in LIVE approves the LP token, burns, and books what the chain returned', async () => {
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20'), decide('EXIT')],
      lp: { allowance: 0n },
      chains: liveChains,
    });
    await activateLive(h.services);
    expect((await run(h)).outcome).toBe('filled');

    const exit = await run(h);
    expect(exit.outcome).toBe('filled');
    const approvals = h.services.trades
      .list()
      .filter((t) => t.kind === 'approve' && t.tokenIn === POOL);
    expect(approvals).toHaveLength(1);
    const decision = h.services.gate.getDecision(approvals[0]!.actionId)!;
    expect(decision.allowed).toBe(true);
    expect(decision.checks.find((c) => c.name === 'allowlist.tokenIn')?.detail).toMatch(/LP token/);
    expect(decision.checks.find((c) => c.name === 'lp.pool')?.passed).toBe(true);

    expect(h.liquidity.store.listPositions('LIVE')).toHaveLength(0);
    expect(h.lp.pool.lpBalances.get(h.services.wallets.depositAddress('base').toLowerCase())).toBe(
      0n,
    );
    const removal = h.services.trades.get(exit.trade!.tradeId)!;
    expect(removal.kind).toBe('lp_remove');
    expect(removal.status).toBe('filled');
  });

  it('counts what a LIVE exit realized, gas included, in the day', async () => {
    // The paper path records LP P&L; for a while the live path did not, so
    // impermanent loss and gas on real money were invisible to the daily-loss
    // check — the one place they matter most.
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20'), decide('EXIT')],
      lp: { allowance: 0n },
      chains: liveChains,
    });
    await activateLive(h.services);
    expect((await run(h)).outcome).toBe('filled');

    // The entry realizes only its gas.
    const afterAdd = h.services.ledger.realizedPnlTodayUsd('LIVE');
    expect(afterAdd).toBeLessThan(0n);

    expect((await run(h)).outcome).toBe('filled');

    // The exit releases the position's basis against what the burn returned,
    // so the day moves again and stays negative: nothing here was profitable.
    const afterExit = h.services.ledger.realizedPnlTodayUsd('LIVE');
    expect(afterExit).toBeLessThan(afterAdd);
    expect(h.services.ledger.toRiskLedger('LIVE', priceLookup).realizedPnlTodayUsd).toBe(
      microsToUsd(afterExit),
    );
    // PAPER is a separate book and must not have moved.
    expect(h.services.ledger.realizedPnlTodayUsd('PAPER')).toBe(0n);
  });

  it('collects fees in LIVE when the pool reports enough claimable', async () => {
    // The claim follows the add in the same market, so the test policy has
    // no cooldowns; the production default would space them 15 minutes apart.
    h = await harness({
      model: [decide('ADD_LIQUIDITY', '20'), decide('COLLECT_FEES')],
      lp: { allowance: 10n ** 30n },
      chains: liveChains,
      policy: { cooldownSeconds: 0, globalMinIntervalSeconds: 0 },
    });
    await activateLive(h.services);
    expect((await run(h)).outcome).toBe('filled');
    const wallet = h.services.wallets.depositAddress('base').toLowerCase();
    // 0.002 WETH + 1 USDC = 6 USD claimable, above the 5 USD threshold.
    h.lp.pool.claimable0.set(wallet, 2n * 10n ** 15n);
    h.lp.pool.claimable1.set(wallet, 1_000_000n);

    const claim = await run(h);
    expect(claim.outcome).toBe('filled');
    const trade = h.services.trades.get(claim.trade!.tradeId)!;
    expect(trade.kind).toBe('lp_claim');
    const signed = h.lp.signingContexts.at(-1);
    expect(signed?.family).toBe('evm');
    expect(signed?.family === 'evm' ? signed.to : null).toBe(POOL);
    expect(claim.execution?.amount0).toBe('2000000000000000');
    expect(claim.execution?.amount1).toBe('1000000');
    expect(h.liquidity.store.listActions()[0]?.action).toBe('COLLECT_FEES');
  });

  it('reconciles an LP row left in flight by a crash without re-signing', async () => {
    h = await harness({
      model: [decide('HOLD')],
      lp: { allowance: 10n ** 30n },
      chains: liveChains,
    });
    const action = lpAction(h, 'lp_add', { mode: 'LIVE' });
    const row = h.services.trades.propose(action, 'open', { route: { lp: true, poolId: POOL } });
    h.services.trades.decide(row.id, { allowed: true, code: 'OK' } as never);
    h.services.trades.markDispatched(row.id);
    const hash = '0x' + 'ee'.repeat(32);
    h.services.trades.markSigned(row.id, hash);
    h.lp.receipts.set(hash, {
      chain: 'base',
      hash,
      status: 'confirmed',
      feeNative: '21000000000000',
      height: 1,
      error: null,
      received: { [POOL]: '200000000000000000' },
      sent: { [WETH]: '4000000000000000', [USDC]: '10000000' },
    });

    const report = await h.liquidity.start();
    expect(report).toEqual({ checked: 1, filled: 1, failed: 0, stillPending: 0 });
    expect(h.services.trades.get(row.id)?.status).toBe('filled');
    expect(h.lp.signingContexts).toHaveLength(0);
    const [position] = h.liquidity.store.listPositions('LIVE');
    expect(position?.lpTokens).toBe('200000000000000000');
    expect(position?.capitalUsd).toBe('0.000000');
    h.liquidity.stop();
  });
});

describe('Phase 4: the runtime cycle lock', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  /** A promise the test opens by hand, to park a cycle inside a chain read. */
  function gate(): { promise: Promise<void>; open: () => void } {
    let open!: () => void;
    const promise = new Promise<void>((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  it('does not let a trade cycle interleave with a liquidity cycle', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);
    const parked = gate();
    h.lp.beforeReadPool = () => parked.promise;

    const finished: string[] = [];
    const lpCycle = run(h);
    const tradeCycle = h.services.pipeline
      .runCycle({ chain: 'base', token: WETH, source: 'operator' })
      .then((report) => {
        finished.push(report.outcome);
        return report;
      });

    // The liquidity cycle is parked in its first chain read and holds the
    // lock. Without it the trade cycle would research, decide and write its
    // own rows here, against balances the LP cycle is about to spend.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(finished).toEqual([]);
    expect(h.services.audit.list({ category: 'trade' })).toHaveLength(0);

    parked.open();
    expect((await lpCycle).outcome).toBe('filled');
    await tradeCycle;
    expect(finished).toHaveLength(1);

    // Newest first: every row of the liquidity cycle was written before the
    // first row of the trade cycle.
    const lastLpRow = h.services.audit.list({ category: 'liquidity' })[0]!;
    const firstTradeRow = h.services.audit.list({ category: 'trade' }).at(-1)!;
    expect(firstTradeRow.id).toBeGreaterThan(lastLpRow.id);
  });

  it('hands the next holder the capital the liquidity cycle just deployed', async () => {
    h = await harness({ model: [decide('ADD_LIQUIDITY', '20')] });
    seedPaper(h);

    const seen: Array<string | undefined> = [];
    const cycle = run(h);
    // Queued the instant the cycle took the lock. Whatever runs next — the
    // trade pipeline, in the runtime — reads a ledger that already has the
    // add in it, instead of sizing itself against capital that is spent.
    const next = h.services.lock.run(() => {
      seen.push(h.liquidity.store.listPositions('PAPER')[0]?.capitalUsd);
      return Promise.resolve();
    });

    expect((await cycle).outcome).toBe('filled');
    await next;
    const booked = h.liquidity.store.listPositions('PAPER')[0]!.capitalUsd;
    expect(seen[0]).toBeDefined();
    expect(seen).toEqual([booked]);
  });
});

describe('Phase 4: agent sanity and adapter math', () => {
  const pool: LpPoolState = {
    chain: 'base',
    protocol: 'aerodrome-v2',
    poolId: POOL,
    kind: 'v2',
    stable: false,
    token0: { address: WETH, decimals: 18, symbol: 'WETH' },
    token1: { address: USDC, decimals: 6, symbol: 'USDC' },
    // Aerodrome vAMM-WETH/USDC reserves and supply, read live at Base block
    // 51534237 on 2026-09-19 in the same block as the router quotes below.
    reserve0: '1711281313524914807830',
    reserve1: '4495229627039',
    totalSupply: '85824709810217496',
    lpTokenDecimals: 18,
    feeBps: 30,
    range: null,
    observedAt: Date.now(),
    source: 'test',
  };

  it('reproduces the router quotes observed live from the reserves alone', () => {
    // router.quoteAddLiquidity(WETH, USDC, false, factory, 4e15, 10e6) returned
    // (3806882974857355, 10000000, 190923972590) at Base block 51534237.
    const add = v2AddQuote(pool, 4_000_000_000_000_000n, 10_000_000n);
    expect(add.amount1).toBe(10_000_000n);
    expect(add.amount0).toBe(3_806_882_974_857_355n);
    expect(add.liquidity).toBe(190_923_972_590n);
    // router.quoteRemoveLiquidity(WETH, USDC, false, factory, 1e12) returned
    // (19939261283947685 WETH, 52376869 USDC) in the same block.
    const remove = shareOfReserves(pool, 1_000_000_000_000n);
    expect(remove.amount0).toBe(19_939_261_283_947_685n);
    expect(remove.amount1).toBe(52_376_869n);
  });

  it('overrides decisions that contradict the input', () => {
    const base: LpAgentInput = {
      chain: 'base',
      pool,
      position: null,
      prices: { token0Usd: '2500', token1Usd: '1', nativeUsd: '2500' },
      poolLiquidityUsd: '5000000',
      policy: { lp: LP_POLICY, maxTotalDeployedUsd: '250' } as RiskPolicy,
      eligibility: {
        poolAllowlisted: true,
        protocolAllowlisted: true,
        rebalancesToday: 0,
        maxRebalancePerDay: 4,
        claimableFeesUsd: '0',
        minFeeThresholdUsd: '5',
        rangeApplicable: false,
        feesSimulated: true,
      },
      executable: true,
      executableReason: 'fake',
      mode: 'PAPER',
    };
    const d = (action: string, capitalUsd = '0') =>
      ({ ...decide(action, capitalUsd), action }) as unknown as LpDecision;
    expect(deterministicSanity(d('HOLD'), base)).toBeNull();
    expect(deterministicSanity(d('HOLD', '5'), base)).toMatch(/non-zero/);
    expect(deterministicSanity(d('ADD_LIQUIDITY', '0'), base)).toMatch(/zero capital/);
    expect(deterministicSanity(d('ADD_LIQUIDITY', '51'), base)).toMatch(/per-position cap/);
    expect(deterministicSanity(d('ADD_LIQUIDITY', '50'), base)).toBeNull();
    expect(deterministicSanity(d('EXIT'), base)).toMatch(/no open position/);
    expect(deterministicSanity(d('COLLECT_FEES'), base)).toMatch(/no open position/);
    expect(deterministicSanity(d('REBALANCE'), base)).toMatch(/no price range/);
    expect(
      deterministicSanity(d('ADD_LIQUIDITY', '10'), {
        ...base,
        eligibility: { ...base.eligibility, poolAllowlisted: false },
      }),
    ).toMatch(/not allowlisted/);
    expect(deterministicSanity({ ...d('HOLD'), chain: 'bsc' }, base)).toMatch(/names chain/);
  });

  it('documents the verified example pools without putting them in the default policy', () => {
    expect(VERIFIED_EXAMPLE_POOLS.map((p) => p.poolId)).toEqual([
      POOL,
      '0x16b9a82891338f9ba80e2d6970fdda79d1eb0dae',
    ]);
    expect(LP_PROTOCOLS.base?.router).toBe('0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43');
    expect(LP_PROTOCOLS.bsc?.router).toBe('0x10ed43c718714eb63d5aa57b78b54704e256024e');
  });
});
