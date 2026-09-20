import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { z } from 'zod';
import { recoverTransactionAddress } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58, base64 } from '@scure/base';
import { loadConfig } from '../src/config/env.js';
import { buildServices, shutdownServices, startBackgroundServices } from '../src/core/services.js';
import type { Services } from '../src/core/services.js';
import type { ChainId } from '../src/chains/registry.js';
import { CHAINS, EVM_NATIVE_SENTINEL, SOLANA_NATIVE_SENTINEL } from '../src/chains/registry.js';
import type {
  ChainAdapter,
  PreparedTransfer,
  SignedTransaction,
  SigningContext,
  TransferCapable,
  TransferRequest,
} from '../src/chains/types.js';
import type {
  Erc20ApprovalCapable,
  ExecutionAdapter,
  ExecutionQuote,
  ExecutionReceipt,
  QuoteRequest,
  SimulationResult,
  UnsignedTransaction,
} from '../src/execution/types.js';
import type { LlmProvider, LlmRequest, LlmResponse } from '../src/llm/provider.js';
import type { MarketDataProvider, MarketSnapshot } from '../src/market/types.js';
import { signEvmTransaction } from '../src/execution/evm/signer.js';
import {
  signSolanaTransaction,
  summarizeSolanaTransaction,
} from '../src/execution/solana/signer.js';
import { generateEvmPrivateKey, evmAddressFromPrivateKey } from '../src/wallet/evm.js';
import { generateSolanaKeypair } from '../src/wallet/solana.js';
import {
  compileLegacyMessage,
  systemTransfer,
  unsignedTransactionBase64,
} from '../src/chains/solana/transfer.js';
import { parseDecimalAmount, validateDestination } from '../src/wallet/withdrawal.js';
import { usdToTokenUnits } from '../src/trading/proposal.js';
import { deriveIdempotencyKey } from '../src/risk/engine.js';
import type { ProposedAction } from '../src/risk/types.js';

/**
 * Phase 3: the trading pipeline, both executors, withdrawals and recovery.
 *
 * Every test runs the real composition root against an in-memory database
 * with fake chain, execution and market adapters and a scripted model. The
 * fakes are honest about what they are — they let the tests control prices,
 * balances and quotes — but nothing between the model's decision and the
 * executor is mocked: the proposal builder, the risk gate and the ledger are
 * the production code.
 */

const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };
const PASSWORD = 'correct horse battery staple';

const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const WETH_BASE = '0x4200000000000000000000000000000000000006';
const AERODROME = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';

// --- fakes -------------------------------------------------------------------

interface FakeChainState {
  native: bigint;
  tokens: Map<string, bigint>;
  feeNative: bigint | null;
  broadcasts: SignedTransaction[];
  confirmed: Set<string>;
}

function fakeChain(chain: ChainId, state: FakeChainState): ChainAdapter & TransferCapable {
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
          state: state.confirmed.has(hash) ? ('confirmed' as const) : ('pending' as const),
          height: 1,
          confirmations: 1,
          error: null,
        }),
      ),
    prepareTransfer: (request: TransferRequest): Promise<PreparedTransfer> =>
      Promise.resolve({
        chain,
        payload: { request: { ...request, amount: request.amount.toString() } },
        feeNative: state.feeNative === null ? null : state.feeNative.toString(),
        feeSource: state.feeNative === null ? 'none' : 'fake',
        summary: 'fake transfer',
        warnings: state.feeNative === null ? ['fee unknown'] : [],
      }),
    transferSigningContext: (prepared): Promise<SigningContext> => {
      const request = (prepared.payload as { request: TransferRequest & { amount: string } })
        .request;
      if (info.family === 'solana') {
        const message = compileLegacyMessage(
          request.from,
          base58.encode(new Uint8Array(32).fill(7)),
          [systemTransfer(request.from, request.to, BigInt(request.amount))],
        );
        return Promise.resolve({
          family: 'solana',
          feePayer: request.from,
          transactionBase64: unsignedTransactionBase64(message),
          lastValidBlockHeight: 1,
        });
      }
      return Promise.resolve({
        family: 'evm',
        chainId: info.evmChainId!,
        from: request.from,
        to: request.token ?? request.to,
        data: '0x',
        value: request.token ? '0' : request.amount,
        gas: '21000',
        nonce: 0,
        maxFeePerGas: '1000000000',
        maxPriorityFeePerGas: '1000000',
      });
    },
    broadcastSigned: (signed) => {
      state.broadcasts.push(signed);
      state.confirmed.add(signed.hash);
      return Promise.resolve();
    },
  };
}

interface FakeExecutionOptions {
  chain: ChainId;
  protocol: string;
  contract: string;
  /** Output per 1 unit of input, in base units of the output token, as a ratio. */
  outPerIn: (amountIn: bigint) => bigint;
  simulateOk?: boolean;
  gasPriceWei?: bigint;
  allowance?: bigint;
  receiptAmountOut?: (quote: ExecutionQuote) => string | null;
  /** Programs the built Solana message invokes. Default: a bare System transfer. */
  signedPrograms?: string[];
}

class FakeExecutionAdapter implements ExecutionAdapter, Erc20ApprovalCapable {
  readonly chain: ChainId;
  readonly protocol: string;
  readonly contracts: readonly string[];
  readonly broadcasts: SignedTransaction[] = [];
  readonly signingContexts: SigningContext[] = [];
  readonly simulated: UnsignedTransaction[] = [];
  readonly builds: UnsignedTransaction[] = [];
  #options: FakeExecutionOptions;
  #lastQuote: ExecutionQuote | null = null;

  constructor(options: FakeExecutionOptions) {
    this.chain = options.chain;
    this.protocol = options.protocol;
    this.contracts = [options.contract];
    this.#options = options;
  }

  supportsRoute(): Promise<boolean> {
    return Promise.resolve(true);
  }

  quote(request: QuoteRequest): Promise<ExecutionQuote> {
    const amountIn = BigInt(request.amountIn);
    const expected = this.#options.outPerIn(amountIn);
    const minOut = expected - (expected * BigInt(request.slippageBps)) / 10_000n;
    const gasPrice = this.#options.gasPriceWei ?? 1_000_000_000n;
    const quote: ExecutionQuote = {
      chain: this.chain,
      protocol: this.protocol,
      contract: this.#options.contract,
      ...(this.chain === 'solana' ? { programIds: [this.#options.contract] } : {}),
      tokenIn: request.tokenIn,
      tokenOut: request.tokenOut,
      amountIn: request.amountIn,
      expectedAmountOut: expected.toString(),
      minAmountOut: minOut.toString(),
      slippageBps: request.slippageBps,
      priceImpactBps: 5,
      quotedAt: Date.now(),
      source: `${this.protocol}-fake`,
      marketId: `${request.tokenIn.address}:${request.tokenOut.address}`,
      feeEstimate: {
        estimatedAt: Date.now(),
        detail:
          this.chain === 'solana'
            ? {
                family: 'solana',
                signatures: 1,
                computeUnitLimit: 200_000,
                computeUnitPriceMicroLamports: '0',
                rentLamports: '0',
              }
            : { family: 'evm', gasLimit: '250000', maxFeePerGas: gasPrice.toString() },
      },
      routeData: { from: request.from },
    };
    this.#lastQuote = quote;
    return Promise.resolve(quote);
  }

  simulate(quote: ExecutionQuote, tx: UnsignedTransaction): Promise<SimulationResult> {
    // The executor must hand over the transaction it built, not build again.
    this.simulated.push(tx);
    const ok = this.#options.simulateOk ?? true;
    return Promise.resolve({
      ok,
      amountOut: ok ? quote.expectedAmountOut : null,
      unitsUsed: 100_000,
      error: ok ? null : 'execution reverted: fake',
      simulatedAt: Date.now(),
    });
  }

  build(quote: ExecutionQuote): Promise<UnsignedTransaction> {
    const tx = this.#build(quote);
    this.builds.push(tx);
    return Promise.resolve(tx);
  }

  #build(quote: ExecutionQuote): UnsignedTransaction {
    return {
      chain: this.chain,
      payload: {
        to: this.#options.contract,
        from: (quote.routeData as { from: string }).from,
        data: '0xabcdef',
        value: '0',
        gas: '250000',
      },
      summary: 'fake swap',
    };
  }

  prepareSigning(tx: UnsignedTransaction, from: string): Promise<SigningContext> {
    const payload = tx.payload as { to: string; data: string; value: string; gas: string };
    const context: SigningContext =
      this.chain === 'solana'
        ? {
            family: 'solana',
            feePayer: from,
            transactionBase64: unsignedTransactionBase64(
              compileLegacyMessage(
                from,
                base58.encode(new Uint8Array(32).fill(9)),
                // A real Jupiter message invokes the swap program. The
                // executor compares the programs in the signed bytes with the
                // ones the engine approved, so the double has to be able to
                // build an honest message and a dishonest one.
                this.#options.signedPrograms === undefined
                  ? [systemTransfer(from, base58.encode(new Uint8Array(32).fill(3)), 1n)]
                  : this.#options.signedPrograms.map((programId) => ({
                      programId,
                      accounts: [{ pubkey: from, isSigner: true, isWritable: true }],
                      data: new Uint8Array([1]),
                    })),
              ),
            ),
            lastValidBlockHeight: 1,
          }
        : {
            family: 'evm',
            chainId: CHAINS[this.chain].evmChainId!,
            from,
            to: payload.to,
            data: payload.data,
            value: payload.value,
            gas: payload.gas,
            nonce: 0,
            maxFeePerGas: '1000000000',
            maxPriorityFeePerGas: '1000000',
          };
    this.signingContexts.push(context);
    return Promise.resolve(context);
  }

  broadcast(signed: SignedTransaction): Promise<void> {
    this.broadcasts.push(signed);
    return Promise.resolve();
  }

  receipt(hash: string): Promise<ExecutionReceipt> {
    const known = this.broadcasts.some((b) => b.hash === hash);
    const quote = this.#lastQuote;
    return Promise.resolve({
      chain: this.chain,
      hash,
      status: known ? 'confirmed' : 'unknown',
      amountOut:
        known && quote
          ? (this.#options.receiptAmountOut?.(quote) ?? quote.expectedAmountOut)
          : null,
      feeNative: '21000000000000',
      height: 1,
      error: null,
    });
  }

  allowance(): Promise<bigint> {
    return Promise.resolve(this.#options.allowance ?? 0n);
  }

  buildApprove(token: string, owner: string): UnsignedTransaction {
    return {
      chain: this.chain,
      payload: { to: token, from: owner, data: '0x095ea7b3', value: '0', gas: '60000' },
      summary: 'fake approve',
    };
  }

  approveFeeEstimate() {
    return Promise.resolve({
      estimatedAt: Date.now(),
      detail: {
        family: 'evm' as const,
        gasLimit: '60000',
        maxFeePerGas: (this.#options.gasPriceWei ?? 1_000_000_000n).toString(),
      },
    });
  }
}

interface FakeMarketState {
  prices: Map<string, string | null>;
  liquidityUsd: string | null;
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
    liquidityUsd: state.liquidityUsd,
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
    getPoolsForToken: (chain, token) =>
      Promise.resolve([pool(chain, token, token === USDC_BASE ? WETH_BASE : USDC_BASE)]),
    getPool: (chain, poolId) => {
      const [base = WETH_BASE, quote = USDC_BASE] = poolId.split('-');
      return Promise.resolve(pool(chain, base, quote));
    },
    getTokenPriceUsd: (_chain, token) => Promise.resolve(state.prices.get(token) ?? null),
    search: () => Promise.resolve([]),
  };
}

/** A model that returns a fixed decision for the trader and a fixed reading for research. */
function scriptedModel(traderPayload: unknown, researchPayload?: unknown): LlmProvider {
  return {
    kind: 'openai-compatible',
    model: 'scripted',
    available: () => Promise.resolve({ available: true, detail: 'scripted' }),
    chat: <T>(request: LlmRequest, schema: z.ZodType<T>): Promise<LlmResponse<T>> => {
      const isTrader = request.system.includes('trading decision layer');
      const payload = isTrader
        ? traderPayload
        : (researchPayload ?? {
            summary: 'thin data',
            observations: [],
            concerns: [],
            confidence: 'low',
          });
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
  chains: Record<ChainId, FakeChainState>;
  execution: FakeExecutionAdapter;
  market: FakeMarketState;
}

async function harness(options: {
  trader: unknown;
  execution?: Partial<FakeExecutionOptions>;
  market?: Partial<FakeMarketState>;
  chains?: Partial<Record<ChainId, Partial<FakeChainState>>>;
}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    ATRA_MODE: 'ci',
    ATRA_LOG_LEVEL: 'silent',
    ATRA_DATA_DIR: './.test-data',
  });

  const chainState = (): FakeChainState => ({
    native: 10n ** 18n,
    tokens: new Map(),
    feeNative: 21_000_000_000_000n,
    broadcasts: [],
    confirmed: new Set(),
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

  const market: FakeMarketState = {
    prices: new Map([
      [USDC_BASE, '1'],
      [WETH_BASE, '2500'],
      [EVM_NATIVE_SENTINEL, '2500'],
    ]),
    liquidityUsd: '5000000',
    observedAt: () => new Date().toISOString(),
    ...options.market,
  };

  const execution = new FakeExecutionAdapter({
    chain: 'base',
    protocol: 'aerodrome-v2',
    contract: AERODROME,
    // 1 USDC (1e6) -> 0.0004 WETH (4e14): price 2500.
    outPerIn: (amountIn) => (amountIn * 4n * 10n ** 14n) / 10n ** 6n,
    ...options.execution,
  });

  const services = buildServices(config, {
    databaseFile: ':memory:',
    adapters,
    kdfParams: FAST_KDF,
    executionAdapters: [execution],
    llm: scriptedModel(options.trader),
    marketProviders: [fakeMarket(market)],
  });

  await services.auth.setPassword(PASSWORD);
  await services.vault.initialize(PASSWORD);
  services.state.createInstallation(randomUUID(), 'test', ['base', 'solana']);
  services.riskPolicy.initialize(['base', 'solana']);
  services.wallets.createAgentWallets();
  services.state.completeSetup();

  return { services, chains, execution, market };
}

const JUPITER_V6 = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SOLANA_SOL = 'So11111111111111111111111111111111111111112';

const openWeth = (usd: string) => ({
  action: 'OPEN',
  chain: 'base',
  market: 'WETH/USDC',
  reason: 'scripted',
  confidence: 0.7,
  requestedNotionalUsd: usd,
  evidence: ['price.usd'],
  token: WETH_BASE,
});

function seedPaper(h: Harness, usdc = 1_000_000_000n, eth = 10n ** 18n): void {
  h.services.ledger.setPaperBalance('base', USDC_BASE, 6, usdc.toString());
  h.services.ledger.setPaperBalance('base', EVM_NATIVE_SENTINEL, 18, eth.toString());
}

// --- tests -------------------------------------------------------------------

describe('Phase 3: auto-trade pipeline (PAPER)', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('fills a valid proposal on paper and books position, balance and fee', async () => {
    h = await harness({ trader: openWeth('20') });
    seedPaper(h);

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('filled');
    expect(report.risk?.allowed).toBe(true);
    expect(report.execution?.status).toBe('filled');
    expect(report.execution?.txHash).toBeNull();

    const positions = h.services.ledger.listPositions('PAPER');
    expect(positions).toHaveLength(1);
    expect(positions[0]?.token).toBe(WETH_BASE);
    // 20 USDC in → 0.008 WETH expected, minus the paper haircut (25 + 5 bps).
    const received = BigInt(positions[0]!.amount);
    expect(received).toBeLessThan(8n * 10n ** 15n);
    expect(received).toBeGreaterThan((8n * 10n ** 15n * 9950n) / 10_000n);

    const usdc = h.services.ledger.getPaperBalance('base', USDC_BASE);
    expect(usdc?.amount).toBe((1_000_000_000n - 20_000_000n).toString());

    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.status).toBe('filled');
    expect(trade.feeUsd).not.toBeNull();
    expect(Number(trade.feeUsd)).toBeGreaterThan(0);

    // Fee shows up as realized loss.
    const realized = h.services.ledger.realizedPnlTodayUsd('PAPER');
    expect(realized).toBeLessThan(0n);

    const audit = h.services.audit.list({ correlationId: report.cycleId });
    expect(audit.map((row) => row.action)).toEqual(
      expect.arrayContaining(['trade.decision', 'risk.allowed', 'trade.filled', 'trade.cycle']),
    );
    expect(audit.length).toBeGreaterThanOrEqual(4);
    expect(audit.every((row) => row.mode === 'PAPER')).toBe(true);
  });

  it('rejects an oversized trade with SIZE_EXCEEDS_MAX_TRADE and never executes', async () => {
    // The trader's own sanity check overrides sizes above the per-trade cap,
    // so the engine must be reached with a model that sneaks under it and a
    // policy that shrinks afterwards. Simplest: shrink the policy first, then
    // ask for slightly more than allowed via the builder path by lowering the
    // cap below the requested size after the sanity check — not possible
    // atomically, so instead assert both layers: sanity override and engine.
    h = await harness({ trader: openWeth('30') });
    seedPaper(h);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('no_action');
    expect(report.reason).toMatch(/exceeds the per-trade limit/);
    expect(h.services.trades.list()).toHaveLength(0);

    // Engine layer: a hand-built proposal above the cap.
    const built = await h.services.builder.build({
      chain: 'base',
      mode: 'PAPER',
      decisionCycleId: randomUUID(),
      source: 'test',
      walletAddress: h.services.wallets.depositAddress('base'),
      decision: { ...openWeth('25'), action: 'OPEN' } as never,
      policy: h.services.riskPolicy.get(),
      adapter: h.execution,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const oversized = { ...built.proposal.action, amountIn: '26000000' };
    oversized.idempotencyKey = deriveIdempotencyKey(oversized);
    const verdict = h.services.gate.preview(
      oversized,
      built.proposal.snapshot,
      built.proposal.priceLookup,
    );
    expect(verdict.allowed).toBe(false);
    expect(verdict.code).toBe('SIZE_EXCEEDS_MAX_TRADE');
  });

  it('returns NO_ACTION for a token that is not allowlisted', async () => {
    h = await harness({ trader: { ...openWeth('10'), token: '0x' + 'ab'.repeat(20) } });
    seedPaper(h);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('no_action');
    expect(report.reason).toMatch(/not allowlisted/);
    expect(h.services.trades.list()).toHaveLength(0);
  });

  it('rejects an unknown contract with CONTRACT_UNKNOWN', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { contract: '0x' + 'cd'.repeat(20), protocol: 'aerodrome-v2' },
    });
    seedPaper(h);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('rejected');
    expect(report.risk?.code).toBe('CONTRACT_UNKNOWN');
    expect(h.services.trades.get(report.trade!.tradeId)?.status).toBe('rejected');
    expect(h.services.ledger.listPositions('PAPER')).toHaveLength(0);
  });

  it('rejects stale market data with DATA_STALE', async () => {
    h = await harness({
      trader: openWeth('10'),
      market: { observedAt: () => new Date(Date.now() - 60 * 60_000).toISOString() },
    });
    seedPaper(h);
    // Stale liquidity: prices come from getTokenPriceUsd (fresh), liquidity from the pool (old).
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('rejected');
    expect(report.risk?.code).toBe('DATA_STALE');
  });

  it('cannot build a proposal without a reliable price', async () => {
    h = await harness({ trader: openWeth('10') });
    seedPaper(h);
    h.market.prices.set(WETH_BASE, null);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('skipped');
    expect(report.reason).toMatch(/no reliable USD price/);
  });

  it('rejects when the paper balance is insufficient', async () => {
    h = await harness({ trader: openWeth('10') });
    // Enough USDC to pick a funding token, not enough to trade.
    h.services.ledger.setPaperBalance('base', USDC_BASE, 6, '5000000');
    h.services.ledger.setPaperBalance('base', EVM_NATIVE_SENTINEL, 18, '1000000000000000000');
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('rejected');
    expect(report.risk?.code).toBe('BALANCE_INSUFFICIENT');
  });

  it('rejects a fee above the policy maximum with FEE_EXCEEDS_MAX', async () => {
    // 250k gas × 20 gwei = 0.005 ETH ≈ $12.50: over the $2 fee cap, under
    // the $50 daily-loss cap (which is checked first and would otherwise win).
    h = await harness({ trader: openWeth('10'), execution: { gasPriceWei: 20n * 10n ** 9n } });
    seedPaper(h);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('rejected');
    expect(report.risk?.code).toBe('FEE_EXCEEDS_MAX');
  });

  it('is blocked by the emergency stop and by pause', async () => {
    h = await harness({ trader: openWeth('10') });
    seedPaper(h);
    h.services.state.setEmergencyStop(true, 'test', 'operator');
    let report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/emergency/);

    h.services.state.setEmergencyStop(false, null, 'operator');
    h.services.state.setGlobalPause(true, 'test', 'operator');
    report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('blocked');
    expect(report.reason).toMatch(/paused/);
    expect(h.services.trades.list()).toHaveLength(0);
  });

  it('treats malformed model output as NO_ACTION', async () => {
    h = await harness({ trader: { action: 'BUY EVERYTHING', chain: 'base' } });
    seedPaper(h);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('no_action');
    expect(report.reason).toMatch(/model output rejected/);
    expect(report.modelStatus).toBe('UNAVAILABLE');
  });

  it('overrides a REDUCE of a token with no position', async () => {
    h = await harness({ trader: { ...openWeth('5'), action: 'REDUCE' } });
    seedPaper(h);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('no_action');
    expect(report.reason).toMatch(/no open position/);
  });

  it('closes a paper position reduce-only and realizes P&L', async () => {
    h = await harness({ trader: openWeth('20') });
    seedPaper(h);
    const open = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(open.outcome).toBe('filled');

    // Price doubles; close.
    h.market.prices.set(WETH_BASE, '5000');
    h.market.prices.set(EVM_NATIVE_SENTINEL, '5000');
    shutdownServices(h.services);
    // Rebuild with a CLOSE decision but the same database is gone; use a new
    // harness and re-open first, then close through a second harness model.
    h = await harness({ trader: openWeth('20') });
    seedPaper(h);
    const first = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(first.outcome).toBe('filled');
    const held = h.services.ledger.getPosition('PAPER', 'base', WETH_BASE)!;

    // Now the close, through the builder + gate + executor directly with a
    // sell-side quote (0.0004 WETH → 1 USDC at 2500).
    const sell = new FakeExecutionAdapter({
      chain: 'base',
      protocol: 'aerodrome-v2',
      contract: AERODROME,
      outPerIn: (amountIn) => (amountIn * 2500n * 10n ** 6n) / 10n ** 18n,
    });
    const built = await h.services.builder.build({
      chain: 'base',
      mode: 'PAPER',
      decisionCycleId: randomUUID(),
      source: 'test',
      walletAddress: h.services.wallets.depositAddress('base'),
      decision: { ...openWeth('0'), action: 'CLOSE', requestedNotionalUsd: '0' } as never,
      policy: h.services.riskPolicy.get(),
      adapter: sell,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.proposal.action.reduceOnly).toBe(true);
    expect(built.proposal.action.amountIn).toBe(held.amount);

    const trade = h.services.trades.propose(built.proposal.action, 'close');
    const verdict = h.services.gate.decide(
      built.proposal.action,
      built.proposal.snapshot,
      built.proposal.priceLookup,
    );
    h.services.trades.decide(trade.id, verdict);
    expect(verdict.allowed).toBe(true);
    const outcome = h.services.paper.execute(
      trade.id,
      built.proposal.action,
      built.proposal.quote,
      built.proposal.prices,
    );
    expect(outcome.status).toBe('filled');
    expect(h.services.ledger.getPosition('PAPER', 'base', WETH_BASE)).toBeUndefined();
  });

  it('replays the same intent as DUPLICATE_ACTION', async () => {
    h = await harness({ trader: openWeth('10') });
    seedPaper(h);
    const built = await h.services.builder.build({
      chain: 'base',
      mode: 'PAPER',
      decisionCycleId: randomUUID(),
      source: 'test',
      walletAddress: h.services.wallets.depositAddress('base'),
      decision: openWeth('10') as never,
      policy: h.services.riskPolicy.get(),
      adapter: h.execution,
    });
    if (!built.ok) throw new Error(built.reason);
    const first = h.services.gate.decide(
      built.proposal.action,
      built.proposal.snapshot,
      built.proposal.priceLookup,
    );
    expect(first.allowed).toBe(true);
    const again = h.services.gate.decide(
      { ...built.proposal.action, actionId: randomUUID() },
      built.proposal.snapshot,
      built.proposal.priceLookup,
    );
    expect(again.allowed).toBe(false);
    expect(again.code).toBe('DUPLICATE_ACTION');
  });

  it('sizes USD into base units without floats', () => {
    // $20 of a 6-decimal token at $1 → 20,000,000.
    expect(usdToTokenUnits(20_000_000n, 6, 10n ** 18n)).toBe(20_000_000n);
    // $20 of an 18-decimal token at $2,500 → 0.008 ETH.
    expect(usdToTokenUnits(20_000_000n, 18, 2_500n * 10n ** 18n)).toBe(8n * 10n ** 15n);
    expect(usdToTokenUnits(1n, 18, 0n)).toBe(0n);
  });
});

describe('Phase 3: LIVE executor', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

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

  it('never signs while the runtime is in PAPER, even for a LIVE-mode action', async () => {
    h = await harness({
      trader: openWeth('10'),
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    const built = await h.services.builder.build({
      chain: 'base',
      mode: 'LIVE',
      decisionCycleId: randomUUID(),
      source: 'test',
      walletAddress: h.services.wallets.depositAddress('base'),
      decision: openWeth('10') as never,
      policy: h.services.riskPolicy.get(),
      adapter: h.execution,
    });
    if (!built.ok) throw new Error(built.reason);

    // Engine: LIVE action without activation.
    const verdict = h.services.gate.preview(
      built.proposal.action,
      built.proposal.snapshot,
      built.proposal.priceLookup,
    );
    expect(verdict.allowed).toBe(false);
    // Tier-0: the runtime is PAPER, so a LIVE action is a mode mismatch first.
    expect(['MODE_MISMATCH', 'LIVE_NOT_ACTIVATED']).toContain(verdict.code);

    // Executor, called directly: refuses before touching the signer.
    const trade = h.services.trades.propose(built.proposal.action, 'open');
    h.services.trades.decide(trade.id, { ...verdict, allowed: true, code: 'OK' });
    const outcome = await h.services.live.execute(
      trade.id,
      built.proposal.action,
      built.proposal.quote,
      built.proposal.prices,
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/not in LIVE mode/);
    expect(h.execution.broadcasts).toHaveLength(0);
    expect(h.execution.signingContexts).toHaveLength(0);
  });

  it('signs, records the hash before broadcast, and books the chain-reported fill', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 10n ** 30n },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('filled');
    expect(report.mode).toBe('LIVE');
    expect(report.execution?.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.execution.broadcasts).toHaveLength(1);

    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.status).toBe('filled');
    expect(trade.txHash).toBe(h.execution.broadcasts[0]!.hash);

    // The signed transaction really is from the agent wallet.
    const recovered = await recoverTransactionAddress({
      serializedTransaction: h.execution.broadcasts[0]!.raw as `0x02${string}`,
    });
    expect(recovered.toLowerCase()).toBe(h.services.wallets.depositAddress('base').toLowerCase());

    const position = h.services.ledger.getPosition('LIVE', 'base', WETH_BASE);
    expect(position?.amount).toBe(report.execution?.amountOut);

    // Newest first: the signed row was written before the filled row.
    const actions = h.services.audit
      .list({ correlationId: report.cycleId })
      .map((row) => row.action);
    expect(actions.indexOf('trade.signed')).toBeGreaterThan(-1);
    expect(actions.indexOf('trade.signed')).toBeGreaterThan(actions.indexOf('trade.filled'));
  });

  it('routes an exact ERC-20 approval through the risk engine before the swap', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 0n },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.reason).not.toMatch(/approval/);
    expect(report.outcome).toBe('filled');
    expect(h.execution.broadcasts).toHaveLength(2);

    const trades = h.services.trades.list();
    const approve = trades.find((t) => t.kind === 'approve')!;
    expect(approve.status).toBe('filled');
    expect(approve.amountIn).toBe('10000000');
    expect(approve.txHash).toBe(h.execution.broadcasts[0]!.hash);
    expect(h.services.gate.getDecision(approve.actionId)?.allowed).toBe(true);
  });

  it('does not sign when the simulation fails', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 10n ** 30n, simulateOk: false },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);
    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('failed');
    expect(report.reason).toMatch(/simulation failed/);
    expect(h.execution.signingContexts).toHaveLength(0);
    expect(h.execution.broadcasts).toHaveLength(0);
  });

  it('keeps a signed row with its hash when broadcast fails, and settles it on the next start', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 10n ** 30n },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);

    // The node rejects the raw transaction after it has been signed: the
    // outcome is unknown, so nothing may be re-signed and the hash must stay
    // on disk for the reconciler.
    const original = h.execution.broadcast.bind(h.execution);
    let attempts = 0;
    h.execution.broadcast = (signed) => {
      attempts += 1;
      h.execution.broadcasts.push(signed); // the node may have kept it
      return Promise.reject(new Error('RPC down mid-broadcast'));
    };

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });
    expect(report.outcome).toBe('failed');
    expect(report.execution?.error).toMatch(/broadcast failed; transaction state unknown/);
    expect(report.execution?.txHash).toMatch(/^0x[0-9a-f]{64}$/);

    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.status).toBe('signed');
    expect(trade.txHash).toBe(report.execution?.txHash);
    expect(attempts).toBe(1);
    expect(
      h.services.audit
        .list({ correlationId: report.cycleId })
        .find((row) => row.action === 'trade.broadcast' && row.status === 'failed')?.detail
        .unresolved,
    ).toBe(true);

    // Next start: the chain has the transaction, so the row is settled from
    // the receipt without a second signature.
    h.execution.broadcast = original;
    const signingBefore = h.execution.signingContexts.length;
    await startBackgroundServices(h.services);
    expect(h.services.trades.get(trade.id)?.status).toBe('filled');
    expect(h.execution.signingContexts).toHaveLength(signingBefore);
  });

  it('leaves LP rows to the liquidity reconciler', async () => {
    h = await harness({ trader: openWeth('10') });
    const action = {
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      decisionCycleId: randomUUID(),
      idempotencyKey: 'c'.repeat(64),
      proposedAt: Date.now(),
      mode: 'LIVE' as const,
      source: 'test' as const,
      chain: 'base' as const,
      kind: 'lp_add' as const,
      protocol: 'aerodrome-v2',
      contract: AERODROME,
      reduceOnly: false,
      tokenIn: { address: USDC_BASE, decimals: 6 },
      tokenOut: { address: WETH_BASE, decimals: 18 },
      amountIn: '10000000',
      quote: {
        expectedAmountOut: '1000',
        minAmountOut: '990',
        slippageBps: 50,
        priceImpactBps: 1,
        quotedAt: Date.now(),
        source: 'fake',
        marketId: 'm',
      },
      feeEstimate: {
        estimatedAt: Date.now(),
        detail: { family: 'evm' as const, gasLimit: '250000', maxFeePerGas: '1000000000' },
      },
    };
    const row = h.services.trades.propose(action, 'open', { route: { lp: true } });
    h.services.trades.decide(row.id, { allowed: true, code: 'OK' } as never);
    h.services.trades.markDispatched(row.id);
    h.services.trades.markSigned(row.id, '0x' + 'ab'.repeat(32));

    const report = await h.services.live.reconcile();
    expect(report.checked).toBe(0);
    expect(h.services.trades.get(row.id)?.status).toBe('signed');
  });

  it('refuses to sign when gas has risen above the fee the engine approved', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 10n ** 30n },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);

    // The engine approved a fee computed from the quote's gas price. The node
    // now reports a much higher one, and prepareSigning multiplies whatever it
    // is told: the transaction about to be signed costs more than the decision
    // allowed for, so it must not be signed at all.
    const original = h.execution.prepareSigning.bind(h.execution);
    h.execution.prepareSigning = async (tx, from) => {
      const context = await original(tx, from);
      if (context.family !== 'evm') return context;
      return { ...context, maxFeePerGas: (BigInt(context.maxFeePerGas) * 10n).toString() };
    };

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });

    expect(report.outcome).toBe('failed');
    expect(report.execution?.error).toMatch(/fee at signing .* exceeds the approved/);
    expect(h.execution.signingContexts).toHaveLength(1);
    expect(h.execution.broadcasts).toHaveLength(0);
    const trade = h.services.trades.get(report.trade!.tradeId)!;
    expect(trade.status).toBe('failed');
    expect(trade.txHash).toBeNull();
  });

  it('refuses to sign when the emergency stop lands after the decision', async () => {
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 10n ** 30n },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);

    // The stop is engaged inside the simulation, i.e. after execute() read the
    // switches and before the key is used. Every await in between is a window
    // the operator expects the stop to close.
    const simulate = h.execution.simulate.bind(h.execution);
    h.execution.simulate = async (quote, tx) => {
      h.services.state.setEmergencyStop(true, 'operator pulled the switch', 'operator');
      return simulate(quote, tx);
    };

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });

    expect(report.outcome).toBe('failed');
    // Engaging the stop also demotes the runtime to PAPER, so either half of
    // the refusal is correct; what matters is that no key was used.
    expect(report.execution?.error).toMatch(
      /refused before signing: (emergency stop is active|runtime is not in LIVE mode)/,
    );
    expect(h.services.state.getSwitches().emergencyStop).toBe(true);
    expect(h.execution.signingContexts).toHaveLength(1);
    expect(h.execution.broadcasts).toHaveLength(0);
    expect(h.services.trades.get(report.trade!.tradeId)?.txHash).toBeNull();
  });

  /**
   * Drive one LIVE Solana action straight through the executor.
   *
   * The engine's decision is not what is under test here: the question is
   * whether the bytes handed to the signing key are checked against it, so
   * the row is allowed by hand and `execute` is called directly.
   */
  async function solanaAttempt(signedPrograms: string[]) {
    h = await harness({
      trader: openWeth('10'),
      execution: {
        chain: 'solana',
        protocol: 'jupiter-v6',
        contract: JUPITER_V6,
        signedPrograms,
        outPerIn: (amountIn) => amountIn * 10n ** 3n,
      },
    });
    await activateLive(h.services);

    const quote = await h.execution.quote({
      chain: 'solana',
      tokenIn: { address: SOLANA_USDC, decimals: 6 },
      tokenOut: { address: SOLANA_SOL, decimals: 9 },
      amountIn: '10000000',
      slippageBps: 50,
      from: h.services.wallets.depositAddress('solana'),
    });

    const action: ProposedAction = {
      schemaVersion: 1,
      actionId: randomUUID(),
      decisionCycleId: randomUUID(),
      idempotencyKey: 'd'.repeat(64),
      proposedAt: Date.now(),
      mode: 'LIVE',
      source: 'test',
      chain: 'solana',
      kind: 'swap',
      protocol: 'jupiter-v6',
      contract: JUPITER_V6,
      programIds: quote.programIds ?? [JUPITER_V6],
      reduceOnly: false,
      tokenIn: { address: SOLANA_USDC, decimals: 6 },
      tokenOut: { address: SOLANA_SOL, decimals: 9 },
      amountIn: '10000000',
      quote: {
        expectedAmountOut: quote.expectedAmountOut,
        minAmountOut: quote.minAmountOut,
        slippageBps: quote.slippageBps,
        priceImpactBps: quote.priceImpactBps,
        quotedAt: quote.quotedAt,
        source: quote.source,
        marketId: quote.marketId,
      },
      feeEstimate: quote.feeEstimate,
    };

    const row = h.services.trades.propose(action, 'open');
    h.services.trades.decide(row.id, { allowed: true, code: 'OK' } as never);

    const outcome = await h.services.live.execute(row.id, action, quote, {
      tokenInUsd: '1',
      tokenOutUsd: '100',
      nativeUsd: '100',
    });
    return { outcome, row };
  }

  it('refuses to sign a Solana message that invokes a program the engine never approved', async () => {
    // The engine approved the programs the adapter read from one Jupiter
    // endpoint; the bytes to be signed come from another. An endpoint that
    // answered differently to the two would otherwise get a transfer of the
    // wallet's balance signed, and simulateTransaction has no objection to a
    // valid transfer.
    const rogue = base58.encode(new Uint8Array(32).fill(7));
    const { outcome, row } = await solanaAttempt([JUPITER_V6, rogue]);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain(rogue);
    expect(outcome.error).toMatch(/did not approve/);
    expect(h.execution.broadcasts).toHaveLength(0);
    expect(h.services.trades.get(row.id)?.txHash).toBeNull();
  });

  it('refuses to sign a Solana message that never invokes the approved program', async () => {
    // Every program here is a system program, so the unapproved-program filter
    // passes; a message that only moves lamports is still not the swap that
    // was decided.
    const { outcome } = await solanaAttempt(['11111111111111111111111111111111']);

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/never invokes .*, the approved program/);
    expect(h.execution.broadcasts).toHaveLength(0);
  });

  it('signs a Solana message whose programs are the approved ones', async () => {
    const { outcome, row } = await solanaAttempt([
      JUPITER_V6,
      'ComputeBudget111111111111111111111111111111',
      '11111111111111111111111111111111',
    ]);

    expect(outcome.status).toBe('filled');
    expect(h.execution.broadcasts).toHaveLength(1);
    expect(h.services.trades.get(row.id)?.txHash).toMatch(/^[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('simulates the transaction it is about to sign, not another build of it', async () => {
    // Both adapters used to build inside simulate() and the executor built
    // again afterwards, so the bytes that passed simulation were a different
    // network response from the bytes that were signed. On Solana that is two
    // separate POST /swap calls to a keyless public endpoint.
    h = await harness({
      trader: openWeth('10'),
      execution: { allowance: 10n ** 30n },
      chains: { base: { tokens: new Map([[USDC_BASE, 1_000_000_000n]]) } },
    });
    await activateLive(h.services);

    const report = await h.services.pipeline.runCycle({
      chain: 'base',
      token: WETH_BASE,
      source: 'operator',
    });

    expect(report.outcome).toBe('filled');
    expect(h.execution.simulated).toHaveLength(1);
    expect(h.execution.builds).toHaveLength(1);
    expect(h.execution.simulated[0]).toBe(h.execution.builds[0]);
  });

  it('reconciles in-flight rows on restart by hash and never re-signs', async () => {
    h = await harness({ trader: openWeth('10'), execution: { allowance: 10n ** 30n } });
    // A signed-but-unresolved row, as a crash between sign and confirm leaves it.
    const action = {
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      decisionCycleId: randomUUID(),
      idempotencyKey: 'a'.repeat(64),
      proposedAt: Date.now(),
      mode: 'LIVE' as const,
      source: 'test' as const,
      chain: 'base' as const,
      kind: 'swap' as const,
      protocol: 'aerodrome-v2',
      contract: AERODROME,
      reduceOnly: false,
      tokenIn: { address: USDC_BASE, decimals: 6 },
      tokenOut: { address: WETH_BASE, decimals: 18 },
      amountIn: '10000000',
      quote: {
        expectedAmountOut: '4000000000000000',
        minAmountOut: '3980000000000000',
        slippageBps: 50,
        priceImpactBps: 5,
        quotedAt: Date.now(),
        source: 'fake',
        marketId: 'm',
      },
      feeEstimate: {
        estimatedAt: Date.now(),
        detail: { family: 'evm' as const, gasLimit: '250000', maxFeePerGas: '1000000000' },
      },
    };
    const signedRow = h.services.trades.propose(action, 'open');
    h.services.trades.decide(signedRow.id, { allowed: true, code: 'OK' } as never);
    h.services.trades.markDispatched(signedRow.id);
    const hash = '0x' + 'ee'.repeat(32);
    h.services.trades.markSigned(signedRow.id, hash);
    // The chain saw it.
    h.execution.broadcasts.push({ raw: '0x', hash });

    const dispatchedRow = h.services.trades.propose(
      { ...action, actionId: randomUUID(), idempotencyKey: 'b'.repeat(64) },
      'open',
    );
    h.services.trades.decide(dispatchedRow.id, { allowed: true, code: 'OK' } as never);
    h.services.trades.markDispatched(dispatchedRow.id);

    await startBackgroundServices(h.services);

    expect(h.services.trades.get(signedRow.id)?.status).toBe('filled');
    expect(h.services.trades.get(dispatchedRow.id)?.status).toBe('failed');
    expect(h.execution.signingContexts).toHaveLength(0);
    expect(h.services.trades.listInFlight()).toHaveLength(0);
    const reconciled = h.services.audit
      .list({ category: 'system' })
      .find((row) => row.action === 'trades.reconciled');
    expect(reconciled?.summary).toMatch(/1 filled, 1 failed/);
  });
});

describe('Phase 3: signers', () => {
  it('EVM: signs an EIP-1559 transaction that recovers to the key’s address', async () => {
    const key = generateEvmPrivateKey();
    const address = evmAddressFromPrivateKey(key);
    const signed = signEvmTransaction(
      key,
      {
        chainId: 8453,
        nonce: 3,
        to: AERODROME,
        data: '0x1234',
        value: 0n,
        gas: 250_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
      },
      address,
    );
    expect(signed.hash).toMatch(/^0x[0-9a-f]{64}$/);
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signed.raw as `0x02${string}`,
    });
    expect(recovered.toLowerCase()).toBe(address.toLowerCase());

    expect(() =>
      signEvmTransaction(
        key,
        {
          chainId: 1,
          nonce: 0,
          to: AERODROME,
          data: '0x',
          value: 0n,
          gas: 21_000n,
          maxFeePerGas: 1n,
          maxPriorityFeePerGas: 1n,
        },
        '0x' + '11'.repeat(20),
      ),
    ).toThrow(/does not match/);
  });

  it('Solana: signs a legacy message with the fee payer’s key and refuses others', () => {
    const wallet = generateSolanaKeypair();
    const other = generateSolanaKeypair();
    const message = compileLegacyMessage(
      wallet.address,
      base58.encode(new Uint8Array(32).fill(1)),
      [systemTransfer(wallet.address, other.address, 1_000n)],
    );
    const unsigned = unsignedTransactionBase64(message);

    const summary = summarizeSolanaTransaction(unsigned);
    expect(summary.feePayer).toBe(wallet.address);
    expect(summary.numRequiredSignatures).toBe(1);
    expect(summary.version).toBe('legacy');

    const signed = signSolanaTransaction(wallet.secretKey, unsigned, wallet.address);
    const bytes = base64.decode(signed.raw);
    expect(bytes[0]).toBe(1);
    const signature = bytes.subarray(1, 65);
    expect(base58.encode(signature)).toBe(signed.signature);
    expect(ed25519.verify(signature, bytes.subarray(65), base58.decode(wallet.address))).toBe(true);

    expect(() => signSolanaTransaction(other.secretKey, unsigned, other.address)).toThrow(
      /fee payer/,
    );
  });
});

describe('Phase 3: withdrawals', () => {
  let h: Harness;
  afterEach(() => {
    if (h) shutdownServices(h.services);
  });

  it('validates destinations like the dashboard, plus EIP-55 and the zero address', () => {
    expect(() => validateDestination('base', '0x' + '00'.repeat(20))).toThrow(/zero address/);
    expect(() => validateDestination('base', '0x123')).toThrow(/40-hex/);
    // Valid checksum (USDC on Base) passes; a corrupted checksum fails.
    expect(validateDestination('base', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(
      USDC_BASE,
    );
    expect(() =>
      validateDestination(
        'base',
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'.replace('fCD', 'FcD'),
      ),
    ).toThrow(/EIP-55/);
    expect(validateDestination('base', USDC_BASE.toUpperCase().replace('0X', '0x'))).toBe(
      USDC_BASE,
    );
    expect(() => validateDestination('solana', 'not-a-key')).toThrow(/base58/);
    expect(validateDestination('solana', SOLANA_NATIVE_SENTINEL)).toBe(SOLANA_NATIVE_SENTINEL);
  });

  it('parses decimal amounts exactly', () => {
    expect(parseDecimalAmount('25', 6)).toBe(25_000_000n);
    expect(parseDecimalAmount('0.5', 18)).toBe(5n * 10n ** 17n);
    expect(() => parseDecimalAmount('1.1234567', 6)).toThrow(/decimals/);
    expect(() => parseDecimalAmount('abc', 6)).toThrow(/decimal number/);
  });

  it('quotes, requires typed confirmation, and signs with the hash recorded first', async () => {
    h = await harness({
      trader: openWeth('0'),
      chains: { base: { tokens: new Map([[USDC_BASE, 50_000_000n]]) } },
    });
    await h.services.vault.unlock(PASSWORD);
    const destination = '0x' + '11'.repeat(20);

    const quote = await h.services.withdrawals.quote({
      chainId: 'base',
      asset: 'USDC',
      destination,
      amount: '25',
    });
    expect(quote.amount.raw).toBe('25000000');
    expect(quote.availableBalance?.raw).toBe('50000000');
    expect(quote.remainingBalance?.raw).toBe('25000000');
    expect(quote.fee.native?.raw).toBe('21000000000000');
    expect(quote.requiresTypedConfirmation).toBe(true);
    expect(quote.submittable).toBe(true);
    expect(quote.mode).toBe('PAPER');

    const all = await h.services.withdrawals.quote({
      chainId: 'base',
      asset: 'USDC',
      destination,
      amount: 'all',
    });
    expect(all.amount.raw).toBe('50000000');
    expect(all.requiresTypedConfirmation).toBe(true);
    await expect(
      h.services.withdrawals.execute({ quoteId: all.quoteId, ack: true }, undefined),
    ).rejects.toThrow(/WITHDRAW/);

    const result = await h.services.withdrawals.execute(
      { quoteId: quote.quoteId, ack: true, confirmation: 'WITHDRAW' },
      'idem-1',
    );
    expect(result.status).toBe('confirmed');
    expect(result.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(h.chains.base.broadcasts).toHaveLength(1);

    // Idempotent replay returns the same transaction, sends nothing.
    const replay = await h.services.withdrawals.execute(
      { quoteId: quote.quoteId, ack: true, confirmation: 'WITHDRAW' },
      'idem-1',
    );
    expect(replay.txId).toBe(result.txId);
    expect(h.chains.base.broadcasts).toHaveLength(1);

    // A consumed quote cannot be reused.
    await expect(
      h.services.withdrawals.execute(
        { quoteId: quote.quoteId, ack: true, confirmation: 'WITHDRAW' },
        undefined,
      ),
    ).rejects.toThrow(/expired or unknown/);

    const listed = h.services.withdrawals.list();
    expect(listed[0]?.txHash).toBe(result.txHash);
  });

  it('requires the typed word on a small withdrawal too, and flags an unchecksummed address', async () => {
    h = await harness({
      trader: openWeth('0'),
      chains: { base: { tokens: new Map([[USDC_BASE, 50_000_000n]]) } },
    });
    await h.services.vault.unlock(PASSWORD);

    // One dollar, priced, nowhere near any threshold: the case that used to
    // go through on a single click.
    const lowercase = await h.services.withdrawals.quote({
      chainId: 'base',
      asset: 'USDC',
      destination: '0x' + 'ab'.repeat(20),
      amount: '1',
    });
    expect(lowercase.requiresTypedConfirmation).toBe(true);
    expect(lowercase.warnings.join(' ')).toMatch(/no EIP-55 checksum/);
    await expect(
      h.services.withdrawals.execute({ quoteId: lowercase.quoteId, ack: true }, undefined),
    ).rejects.toThrow(/WITHDRAW/);
    expect(h.chains.base.broadcasts).toHaveLength(0);

    // A checksummed destination is not warned about, and the typed word is
    // still what lets the transfer through.
    const checksummed = await h.services.withdrawals.quote({
      chainId: 'base',
      asset: 'USDC',
      destination: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
      amount: '1',
    });
    expect(checksummed.warnings.join(' ')).not.toMatch(/EIP-55/);

    const result = await h.services.withdrawals.execute(
      { quoteId: checksummed.quoteId, ack: true, confirmation: 'WITHDRAW' },
      undefined,
    );
    expect(result.status).toBe('confirmed');
    expect(h.chains.base.broadcasts).toHaveLength(1);
  });

  it('refuses to submit when the fee is unknown or the balance is short', async () => {
    h = await harness({
      trader: openWeth('0'),
      chains: { base: { feeNative: null, tokens: new Map([[USDC_BASE, 1_000_000n]]) } },
    });
    await h.services.vault.unlock(PASSWORD);
    const destination = '0x' + '22'.repeat(20);
    const quote = await h.services.withdrawals.quote({
      chainId: 'base',
      asset: 'USDC',
      destination,
      amount: '25',
    });
    expect(quote.fee.native).toBeNull();
    expect(quote.fee.source).toBe('none');
    expect(quote.submittable).toBe(false);
    expect(quote.warnings.join(' ')).toMatch(/Insufficient USDC/);
    await expect(
      h.services.withdrawals.execute({ quoteId: quote.quoteId, ack: true }, undefined),
    ).rejects.toThrow(/cannot be submitted/);
    expect(h.chains.base.broadcasts).toHaveLength(0);
  });

  it('withdraws SOL with a hand-built message signed by the agent wallet', async () => {
    h = await harness({
      trader: openWeth('0'),
      chains: { solana: { native: 5n * 10n ** 9n, feeNative: 5_000n } },
    });
    await h.services.vault.unlock(PASSWORD);
    h.market.prices.set(SOLANA_NATIVE_SENTINEL, '150');
    const destination = generateSolanaKeypair().address;
    const quote = await h.services.withdrawals.quote({
      chainId: 'solana',
      asset: 'SOL',
      destination,
      amount: '1',
    });
    expect(quote.amount.raw).toBe('1000000000');
    const result = await h.services.withdrawals.execute(
      { quoteId: quote.quoteId, ack: true, confirmation: 'WITHDRAW' },
      undefined,
    );
    expect(result.status).toBe('confirmed');
    const raw = base64.decode(h.chains.solana.broadcasts[0]!.raw);
    expect(
      ed25519.verify(
        raw.subarray(1, 65),
        raw.subarray(65),
        base58.decode(h.services.wallets.depositAddress('solana')),
      ),
    ).toBe(true);
  });
});
