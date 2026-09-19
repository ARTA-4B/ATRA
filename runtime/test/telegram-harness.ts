import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/env.js';
import { buildServices } from '../src/core/services.js';
import type { Services } from '../src/core/services.js';
import type { ChainAdapter } from '../src/chains/types.js';
import type { ChainId } from '../src/chains/registry.js';
import { CHAINS, EVM_NATIVE_SENTINEL } from '../src/chains/registry.js';
import type { MarketDataProvider, MarketSnapshot } from '../src/market/types.js';
import { TelegramService } from '../src/telegram/service.js';
import type { TelegramServiceDeps } from '../src/telegram/service.js';
import type {
  TelegramTransport,
  TransportEvents,
  TransportStatus,
  Timers,
} from '../src/telegram/transport.js';
import type {
  InboundCommand,
  LiquiditySummary,
  TelegramIdentity,
  TransportKind,
} from '../src/telegram/types.js';

/**
 * Shared fixtures for the Telegram tests.
 *
 * The harness builds the real composition root against an in-memory database
 * (no network, no chain adapters unless a test injects stubs) and a Telegram
 * service driven by a fake transport that records everything sent and lets a
 * test inject frames as if the gateway had sent them.
 */

export const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };
export const PASSWORD = 'correct horse battery staple';
export const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
export const WETH_BASE = '0x4200000000000000000000000000000000000006';

export const OPERATOR: TelegramIdentity = {
  userId: 123456789,
  chatId: 123456789,
  displayName: 'Rizky',
};
export const STRANGER: TelegramIdentity = {
  userId: 987654321,
  chatId: 987654321,
  displayName: 'Mallory',
};

/** A transport that records outbound traffic and exposes the event hooks. */
export class FakeTransport implements TelegramTransport {
  readonly kind: TransportKind;
  readonly notifications: Array<{ kind: string; text: string }> = [];
  readonly offers: Array<{ codeHash: string; expiresAt: number }> = [];
  revokes = 0;
  started = false;
  stopped = false;
  connected = true;
  botUsername: string | null = 'atra_test_bot';
  failNotify: Error | null = null;
  events: TransportEvents | null = null;

  constructor(kind: TransportKind = 'gateway') {
    this.kind = kind;
  }

  start(events: TransportEvents): void {
    this.events = events;
    this.started = true;
  }

  stop(): Promise<void> {
    this.stopped = true;
    return Promise.resolve();
  }

  status(): TransportStatus {
    return {
      kind: this.kind,
      connected: this.connected,
      botUsername: this.botUsername,
      lastError: null,
      lastConnectedAt: null,
      reconnectAttempts: 0,
    };
  }

  notify(kind: string, text: string): Promise<void> {
    if (this.failNotify) return Promise.reject(this.failNotify);
    this.notifications.push({ kind, text });
    return Promise.resolve();
  }

  offerPairCode(codeHash: string, expiresAt: number): Promise<void> {
    this.offers.push({ codeHash, expiresAt });
    return Promise.resolve();
  }

  revokePairing(): Promise<void> {
    this.revokes += 1;
    return Promise.resolve();
  }

  /** Deliver a command as the gateway would and return the reply. */
  command(command: InboundCommand): Promise<string | null> {
    if (!this.events) throw new Error('transport not started');
    return this.events.onCommand(command);
  }
}

/** Deterministic timers: a test advances the clock and fires what is due. */
export class ManualTimers implements Timers {
  #now = 0;
  #seq = 0;
  readonly #queue = new Map<number, { at: number; fn: () => void; every: number | null }>();

  get now(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#queue.set(id, { at: this.#now + ms, fn, every: null });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.#queue.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): unknown {
    const id = ++this.#seq;
    this.#queue.set(id, { at: this.#now + ms, fn, every: ms });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.#queue.delete(handle as number);
  }

  pending(): number {
    return this.#queue.size;
  }

  /** Advance by `ms`, firing due timers in order. */
  advance(ms: number): void {
    const target = this.#now + ms;
    for (;;) {
      let next: [number, { at: number; fn: () => void; every: number | null }] | undefined;
      for (const entry of this.#queue) {
        if (entry[1].at <= target && (!next || entry[1].at < next[1].at)) next = entry;
      }
      if (!next) break;
      const [id, timer] = next;
      this.#now = timer.at;
      if (timer.every === null) this.#queue.delete(id);
      else timer.at += timer.every;
      timer.fn();
    }
    this.#now = target;
  }
}

export interface FakeMarketState {
  prices: Map<string, string | null>;
}

export function fakeMarket(state: FakeMarketState): MarketDataProvider {
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
    observedAt: new Date().toISOString(),
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

export function stubChain(
  chain: ChainId,
  state: { native: bigint; feeNative: bigint },
): ChainAdapter {
  const observe = <T>(value: T) => ({ value, observedAt: Date.now(), source: 'stub' });
  const info = CHAINS[chain];
  return {
    chain,
    health: () =>
      Promise.resolve({
        chain,
        healthy: true,
        height: 1,
        latencyMs: 1,
        endpoint: 'stub',
        error: null,
        identity: 'stub',
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
      Promise.resolve(observe({ chain, owner, token, amount: '0', symbol: null, decimals: 18 })),
    getTokenMetadata: (address) =>
      Promise.resolve(observe({ chain, address, symbol: null, name: null, decimals: null })),
    estimateTransferFee: () =>
      Promise.resolve(
        observe({
          chain,
          nativeAmount: state.feeNative.toString(),
          unitPrice: '1',
          units: 21_000,
        }),
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

export interface Harness {
  services: Services;
  telegram: TelegramService;
  transport: FakeTransport;
  market: FakeMarketState;
  clock: { now: number };
  timers: ManualTimers;
  /** Build a command from the given identity with a monotonically increasing update id. */
  command(
    text: string,
    identity?: TelegramIdentity,
    overrides?: Partial<InboundCommand>,
  ): InboundCommand;
}

export interface HarnessOptions {
  transport?: FakeTransport | null;
  liquidity?: LiquiditySummary;
  adapters?: Map<ChainId, ChainAdapter>;
  env?: Record<string, string>;
  serviceOverrides?: Partial<TelegramServiceDeps>;
  /** Skip installation + policy + wallets (for "fresh install" cases). */
  bare?: boolean;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const config = loadConfig({
    NODE_ENV: 'test',
    ATRA_MODE: 'ci',
    ATRA_LOG_LEVEL: 'silent',
    ATRA_DATA_DIR: './.test-data',
    ...options.env,
  });

  const market: FakeMarketState = {
    prices: new Map([
      [USDC_BASE, '1'],
      [WETH_BASE, '2500'],
      [EVM_NATIVE_SENTINEL, '2500'],
    ]),
  };

  const services = buildServices(config, {
    databaseFile: ':memory:',
    kdfParams: FAST_KDF,
    executionAdapters: [],
    marketProviders: [fakeMarket(market)],
    ...(options.adapters ? { adapters: options.adapters } : {}),
  });

  if (!options.bare) {
    await services.auth.setPassword(PASSWORD);
    await services.vault.initialize(PASSWORD);
    services.state.createInstallation(randomUUID(), 'test-install', ['base', 'solana']);
    services.riskPolicy.initialize(['base', 'solana']);
    services.wallets.createAgentWallets();
    services.state.completeSetup();
  }

  const clock = { now: Date.now() };
  const timers = new ManualTimers();
  const transport = options.transport === undefined ? new FakeTransport() : options.transport;

  const telegram = new TelegramService({
    db: services.db,
    audit: services.audit,
    state: services.state,
    ledger: services.ledger,
    trades: services.trades,
    riskPolicy: services.riskPolicy,
    wallets: services.wallets,
    market: services.market,
    scheduler: services.scheduler,
    config,
    liquidity: options.liquidity,
    llm: services.llm,
    transport,
    timers,
    now: () => clock.now,
    startedAt: new Date(clock.now - 90 * 60_000),
    ...options.serviceOverrides,
  });

  let updateId = 1_000;
  const command = (
    text: string,
    identity: TelegramIdentity = OPERATOR,
    overrides: Partial<InboundCommand> = {},
  ): InboundCommand => {
    updateId += 1;
    return {
      requestId: `req-${String(updateId)}`,
      updateId,
      telegram: identity,
      text,
      receivedAt: clock.now,
      source: 'gateway',
      ...overrides,
    };
  };

  return {
    services,
    telegram,
    transport: transport ?? new FakeTransport(),
    market,
    clock,
    timers,
    command,
  };
}

/** Pair the harness's operator through the gateway path. */
export async function pairOperator(
  h: Harness,
  identity: TelegramIdentity = OPERATOR,
): Promise<void> {
  h.telegram.issuePairCode();
  if (!h.transport.events) await h.telegram.start();
  h.transport.events!.onPaired(identity, h.clock.now);
}
