import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { evaluate } from '../src/risk/engine.js';
import { nativeToUsdMicros, priceToAtto } from '../src/risk/money.js';
import { MarketService } from '../src/market/service.js';
import { DexScreenerProvider } from '../src/market/providers/dexscreener.js';
import { GeckoTerminalProvider } from '../src/market/providers/geckoterminal.js';
import { ResearchAgent } from '../src/agents/research/agent.js';
import { NullLlmProvider } from '../src/llm/provider.js';
import { AuditLog } from '../src/audit/audit.js';
import { AuthService, LOGIN_FAILURE_LIMIT } from '../src/core/auth.js';
import { StateStore } from '../src/core/state.js';
import { closeDatabase, openDatabase } from '../src/db/database.js';
import type { Db } from '../src/db/database.js';
import type { MarketDataProvider, MarketSnapshot } from '../src/market/types.js';
import {
  BASE_NATIVE,
  BASE_USDC,
  BASE_WETH,
  JUPITER_V6,
  NOW,
  PERMIT2,
  makeAction,
  makeInput,
  makePolicy,
  makeSnapshot,
  makeSolanaAction,
  makeState,
} from './helpers/risk-fixtures.js';

/**
 * Regression tests for the findings of the 2026-09-20 adversarial review.
 *
 * Each block names the finding it pins down. The point of keeping them
 * together is that a future refactor which reintroduces one of these fails
 * with the review's own description in the test name.
 */

const FAST_KDF = { memoryKib: 1024, iterations: 1, parallelism: 1 };

describe('review: a zero price is unknown data, not a number', () => {
  it('rejects a trade priced at zero instead of passing every USD cap', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_USDC}`] = { value: '0', at: NOW - 1_000, source: 'dexscreener' };

    // 100 USDC against a $25 cap: at a real price this is SIZE_EXCEEDS_MAX_TRADE.
    const decision = evaluate(
      makeInput({ action: makeAction({ amountIn: '100000000' }), snapshot }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DATA_STALE');
    expect(decision.checks.find((c) => c.name === 'freshness.price.tokenIn')?.observed).toBe(
      'zero',
    );
    expect(decision.derived?.amountInUsd).toBe('not-evaluated');
  });

  it('rejects a fee priced at zero instead of passing the fee cap', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_NATIVE}`] = { value: '0', at: NOW - 1_000, source: 'dexscreener' };

    const decision = evaluate(
      makeInput({
        action: makeAction({
          feeEstimate: {
            estimatedAt: NOW - 1_000,
            // 0.25 ETH of gas: hundreds of dollars against a $2 cap.
            detail: { family: 'evm', gasLimit: '250000', maxFeePerGas: '1000000000000' },
          },
        }),
        snapshot,
      }),
    );

    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DATA_STALE');
    expect(decision.derived?.feeUsd).toBe('not-evaluated');
  });

  it('treats "0.0" the same as "0"', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_USDC}`] = { value: '0.0', at: NOW - 1_000, source: 'x' };
    expect(evaluate(makeInput({ snapshot })).code).toBe('DATA_STALE');
  });

  it('refuses to value an amount at a non-positive price, as defence in depth', () => {
    expect(() => nativeToUsdMicros(1n, 18, 0n, 'ceil')).toThrow(/non-positive price/);
    expect(() => nativeToUsdMicros(1n, 18, -1n, 'ceil')).toThrow(/non-positive price/);
    expect(priceToAtto('0')).toBe(0n); // parsing still works; valuing does not
  });
});

describe('review: exit privileges belong to swaps only', () => {
  it('refuses reduceOnly on an approve', () => {
    const decision = evaluate(
      makeInput({
        action: makeAction({
          kind: 'approve',
          reduceOnly: true,
          contract: PERMIT2,
          tokenOut: { address: BASE_USDC, decimals: 6 },
          quote: null,
          amountIn: '100000000',
        }),
      }),
    );

    expect(decision.code).toBe('SCHEMA_INVALID');
    expect(decision.checks.find((c) => c.name === 'schema.action')?.observed).toBe('reduceOnly');
  });

  it('still allows reduceOnly on a swap with a matching position', () => {
    // A real exit: sell part of a WETH holding back into the funding
    // stablecoin. The position being sold must not itself be a stablecoin —
    // every fill books its output, so the funding stable is a position too,
    // and without that shape rule a stable-to-stable swap of any size would
    // inherit an exit's exemption from the size, loss and cooldown checks.
    const state = makeState({ lastAnyActionAt: NOW - 1_000 });
    state.ledger.positions = [
      {
        chain: 'base',
        token: BASE_WETH,
        amount: '20000000000000000',
        costBasisUsd: '50',
        openedAt: NOW,
      },
    ];
    const snapshot = makeSnapshot();
    snapshot.balances[`base:${BASE_WETH}`] = {
      value: '20000000000000000',
      at: NOW - 1_000,
      source: 'rpc',
    };
    const action = makeAction({
      reduceOnly: true,
      tokenIn: { address: BASE_WETH, decimals: 18 },
      tokenOut: { address: BASE_USDC, decimals: 6 },
      amountIn: '10000000000000000',
      quote: {
        expectedAmountOut: '25000000',
        minAmountOut: '24925000',
        slippageBps: 30,
        priceImpactBps: 5,
        quotedAt: NOW - 2_000,
        source: 'uniswap-v4-quoter',
        marketId: '0xpool',
      },
    });

    expect(evaluate(makeInput({ action, state, snapshot })).code).toBe('OK');
  });

  it('refuses a stable-to-stable swap dressed as an exit', () => {
    const state = makeState({ lastAnyActionAt: NOW - 1_000 });
    state.ledger.positions = [
      { chain: 'base', token: BASE_USDC, amount: '50000000', costBasisUsd: '50', openedAt: NOW },
    ];
    const decision = evaluate(makeInput({ action: makeAction({ reduceOnly: true }), state }));
    expect(decision.code).toBe('REDUCE_ONLY_MISMATCH');
  });
});

describe('review: LP kinds are never evaluated as swaps', () => {
  // Phase 4 replaced the blanket "lp actions are not enabled" refusal with
  // real LP checks. The invariant the review pinned down still holds: with
  // the default policy (LP disabled: no pools, zero capital) every lp_* kind
  // is rejected, and it is rejected by an LP check, not approved by the swap
  // checks.
  const AERODROME = '0xcf77a3ba9a5ca399b7c97c74d54e5b1beb874e43';
  const POOL = '0xcdac0d6c6c59727a65f871236188350531885c43';

  function lpAction(kind: 'lp_add' | 'lp_remove' | 'lp_rebalance' | 'lp_claim') {
    const base = {
      kind,
      protocol: 'aerodrome-v2',
      contract: kind === 'lp_claim' ? POOL : AERODROME,
      quote:
        kind === 'lp_claim'
          ? null
          : {
              expectedAmountOut: '1000000000000',
              minAmountOut: '995000000000',
              slippageBps: 50,
              priceImpactBps: 0,
              quotedAt: NOW - 2_000,
              source: 'test',
              marketId: POOL,
            },
      amountIn: kind === 'lp_claim' ? '0' : '10000000',
      lp: {
        poolId: POOL,
        capitalUsd: '20',
        rebalanceIndexToday: 0,
        claimableFeesUsd: '0',
        ...(kind === 'lp_add' || kind === 'lp_rebalance' ? { amountB: '4000000000000000' } : {}),
        ...(kind === 'lp_remove' ? { lpTokens: '1000000000000' } : {}),
        ...(kind === 'lp_claim' ? { claimable: { amountA: '1000000', amountB: '0' } } : {}),
      },
    };
    return makeAction(base);
  }

  it.each(['lp_add', 'lp_remove', 'lp_rebalance', 'lp_claim'] as const)(
    'rejects %s under the default policy with POOL_NOT_ALLOWLISTED',
    (kind) => {
      const decision = evaluate(makeInput({ action: lpAction(kind) }));
      expect(decision.allowed).toBe(false);
      expect(decision.code).toBe('POOL_NOT_ALLOWLISTED');
      expect(decision.checks.find((c) => c.name === 'schema.action')?.passed).toBe(true);
      // The swap-only exposure checks were not what decided this.
      expect(decision.checks.find((c) => c.name === 'size.amountInUsd')?.skipped).toBe(
        'not-applicable',
      );
    },
  );

  it('still refuses an lp_* kind that carries no lp leg', () => {
    const decision = evaluate(makeInput({ action: makeAction({ kind: 'lp_add' }) }));
    expect(decision.code).toBe('SCHEMA_INVALID');
    expect(decision.checks.find((c) => c.name === 'schema.action')?.detail).toContain(
      'requires the lp leg',
    );
  });

  it('rejects an entry with LP_CAPITAL_EXCEEDS_MAX once the pool is listed but capital is zero', () => {
    const policy = makePolicy();
    policy.lp = {
      ...policy.lp,
      allowedPools: [{ chain: 'base', protocol: 'aerodrome-v2', poolId: POOL }],
      allowedProtocols: { base: ['aerodrome-v2'] },
    };
    const decision = evaluate(makeInput({ policy, action: lpAction('lp_add') }));
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('LP_CAPITAL_EXCEEDS_MAX');
  });
});

describe('review: prototype-named protocols and Solana program lists', () => {
  it('does not resolve a protocol through Object.prototype', () => {
    const decision = evaluate(makeInput({ action: makeAction({ protocol: 'constructor' }) }));
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('PROTOCOL_NOT_ALLOWLISTED');
  });

  it('requires the declared Solana program to appear in the transaction', () => {
    const decision = evaluate(
      makeInput({
        action: makeSolanaAction({ programIds: ['11111111111111111111111111111111'] }),
      }),
    );
    expect(decision.code).toBe('CONTRACT_UNKNOWN');
  });

  it('rejects an empty Solana program list', () => {
    const decision = evaluate(makeInput({ action: makeSolanaAction({ programIds: [] }) }));
    expect(decision.code).toBe('CONTRACT_UNKNOWN');
  });

  it('accepts the router plus documented system programs', () => {
    const decision = evaluate(
      makeInput({
        action: makeSolanaAction({
          programIds: [JUPITER_V6, 'ComputeBudget111111111111111111111111111111'],
        }),
      }),
    );
    expect(decision.code).toBe('OK');
  });
});

describe('review: the LIVE checklist is consumed and reset', () => {
  let db: Db;
  let state: StateStore;

  const STEPS = [
    'acknowledged',
    'reauthenticated',
    'riskReviewed',
    'walletFunded',
    'gasChecked',
    'adapterChecked',
  ] as const;

  function walkChecklist(): void {
    for (const step of STEPS) state.recordActivationStep(step, 'operator');
  }

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
    const audit = new AuditLog(db);
    state = new StateStore(db, audit);
    state.createInstallation('install', 'test', ['base']);
  });

  afterEach(() => closeDatabase(db));

  it('goes live after a complete walk', () => {
    walkChecklist();
    expect(state.activateLive('operator').mode).toBe('LIVE');
  });

  it('needs the whole checklist again after an emergency stop is cleared', () => {
    walkChecklist();
    state.activateLive('operator');
    state.setEmergencyStop(true, 'halt', 'operator');
    state.setEmergencyStop(false, null, 'operator');

    expect(state.getActivation().missing).toHaveLength(STEPS.length);
    expect(() => state.activateLive('operator')).toThrow(/incomplete/);
  });

  it('needs the whole checklist again after reverting to paper', () => {
    walkChecklist();
    state.activateLive('operator');
    state.revertToPaper('operator', 'done for today');

    expect(() => state.activateLive('operator')).toThrow(/incomplete/);
  });

  it('cannot go live twice on one walk', () => {
    walkChecklist();
    state.activateLive('operator');
    state.revertToPaper('operator', 'x');
    expect(state.getActivation().missing).toHaveLength(STEPS.length);
  });

  it('refuses to go live while paused', () => {
    walkChecklist();
    state.setGlobalPause(true, 'maintenance', 'operator');
    expect(() => state.activateLive('operator')).toThrow(/pause/i);
  });

  it('does not resume LIVE across a restart', () => {
    walkChecklist();
    state.activateLive('operator');
    expect(state.getMode()).toBe('LIVE');

    // A second store over the same database is what a new process sees.
    const restarted = new StateStore(db, new AuditLog(db));
    expect(restarted.getMode()).toBe('PAPER');
    expect(restarted.getActivation().missing).toHaveLength(STEPS.length);
  });
});

describe('review: password guessing is throttled', () => {
  let db: Db;

  beforeEach(() => {
    db = openDatabase({ file: ':memory:' });
  });

  afterEach(() => closeDatabase(db));

  it('locks out after repeated failures and unlocks after the window', async () => {
    let clock = 1_000_000;
    const auth = new AuthService(db, new AuditLog(db), FAST_KDF, () => clock);
    await auth.setPassword('correct horse battery staple');

    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      await expect(auth.login('wrong password here')).rejects.toThrow(/Incorrect/);
    }

    // The right password is refused too: the check itself is locked.
    await expect(auth.login('correct horse battery staple')).rejects.toThrow(/Too many/);

    clock += 6 * 60_000;
    await expect(auth.login('correct horse battery staple')).resolves.toBeDefined();
  });

  it('evaluates at most the limit even when every guess arrives at once', async () => {
    const auth = new AuthService(db, new AuditLog(db), FAST_KDF);
    await auth.setPassword('correct horse battery staple');

    // The counter used to be read before the ~1.5 s key derivation and written
    // after it, so ten simultaneous guesses were all evaluated against a count
    // of zero. Each rejection says which happened: "Incorrect" means the KDF
    // ran, "Too many" means the attempt was refused without it.
    const settled = await Promise.allSettled(
      Array.from({ length: 10 }, () => auth.login('wrong password here')),
    );
    const reasons = settled.map((result) =>
      result.status === 'rejected' ? String((result.reason as Error).message) : 'accepted',
    );

    expect(reasons.filter((message) => /Incorrect/.test(message))).toHaveLength(
      LOGIN_FAILURE_LIMIT,
    );
    expect(reasons.filter((message) => /Too many/.test(message))).toHaveLength(
      10 - LOGIN_FAILURE_LIMIT,
    );
  });

  it('keeps the lockout when the service is rebuilt on the same database', async () => {
    const clock = 2_000_000;
    const auth = new AuthService(db, new AuditLog(db), FAST_KDF, () => clock);
    await auth.setPassword('correct horse battery staple');

    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i += 1) {
      await expect(auth.login('wrong password here')).rejects.toThrow(/Incorrect/);
    }

    // A second service over the same database is what a restarted process
    // sees; an in-memory counter would have handed it a fresh budget.
    const restarted = new AuthService(db, new AuditLog(db), FAST_KDF, () => clock);
    await expect(restarted.login('correct horse battery staple')).rejects.toThrow(/Too many/);
  });

  it('a success clears the failure count', async () => {
    const auth = new AuthService(db, new AuditLog(db), FAST_KDF);
    await auth.setPassword('correct horse battery staple');

    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i += 1) {
      await expect(auth.login('wrong password here')).rejects.toThrow(/Incorrect/);
    }
    await auth.login('correct horse battery staple');

    // Another run of failures starts from zero rather than tripping at once.
    await expect(auth.login('wrong password here')).rejects.toThrow(/Incorrect/);
  });
});

describe('review: the database is not readable by other accounts', () => {
  // POSIX only. Windows ignores the mode bits and inherits the parent ACL, so
  // there is nothing here to assert on the author's machine; CI runs Linux.
  it.skipIf(process.platform === 'win32')(
    'creates the data directory 0700 and the database files 0600',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'atra-perms-'));
      const dir = join(root, 'data');
      const file = join(dir, 'atra.db');

      const db = openDatabase({ file });
      try {
        expect(statSync(dir).mode & 0o777).toBe(0o700);
        for (const path of [file, `${file}-wal`, `${file}-shm`]) {
          if (!existsSync(path)) continue;
          expect([path, statSync(path).mode & 0o777]).toEqual([path, 0o600]);
        }
      } finally {
        closeDatabase(db);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe('review: providers never emit a zero price', () => {
  function dex(payload: unknown): DexScreenerProvider {
    return new DexScreenerProvider({
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(payload), { status: 200 })),
    });
  }

  const pair = {
    chainId: 'base',
    dexId: 'x',
    pairAddress: '0xabc',
    baseToken: { address: '0xtok', symbol: 'T', name: 'T' },
    quoteToken: { address: '0xusd', symbol: 'USDC', name: 'USDC' },
    liquidity: { usd: 1 },
  };

  it('DexScreener: "0" becomes null with a reason', async () => {
    const [pool] = await dex([{ ...pair, priceUsd: '0' }]).getPoolsForToken('base', '0xtok');
    expect(pool?.priceUsd).toBeNull();
    expect(pool?.reason).toContain('no usable USD price');
  });

  it('DexScreener: a zero price is not a token price', async () => {
    const price = await dex([{ ...pair, priceUsd: '0.000' }]).getTokenPriceUsd('base', '0xtok');
    expect(price).toBeNull();
  });

  it('GeckoTerminal: "0" from the token-price endpoint becomes null', async () => {
    const gecko = new GeckoTerminalProvider({
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({ data: { attributes: { token_prices: { '0xtok': '0' } } } }),
            { status: 200 },
          ),
        ),
    });
    expect(await gecko.getTokenPriceUsd('base', '0xtok')).toBeNull();
  });

  it('GeckoTerminal: an empty percentage is unknown, not zero', async () => {
    const gecko = new GeckoTerminalProvider({
      fetchImpl: () =>
        Promise.resolve(
          new Response(
            JSON.stringify({
              data: [
                {
                  id: 'base_0xpool',
                  type: 'pool',
                  attributes: {
                    name: 'T / USDC',
                    address: '0xpool',
                    base_token_price_usd: '1',
                    price_change_percentage: { h24: '' },
                  },
                },
              ],
            }),
            { status: 200 },
          ),
        ),
    });
    const [pool] = await gecko.getPoolsForToken('base', '0xtok');
    expect(pool?.change.h24).toBeNull();
  });

  it('a zero from one provider cannot hide a real disagreement', async () => {
    const snapshot = (source: MarketSnapshot['source']): MarketSnapshot => ({
      chain: 'base',
      poolId: '0xpool',
      dexId: null,
      base: { address: '0xtok', symbol: null, name: null, decimals: null },
      quote: { address: '0xusd', symbol: null, name: null, decimals: null },
      priceUsd: null,
      priceNative: null,
      liquidityUsd: null,
      volume24hUsd: null,
      change: { m5: null, h1: null, h6: null, h24: null },
      observedAt: new Date(NOW).toISOString(),
      fetchedAt: new Date(NOW).toISOString(),
      source,
      freshnessMs: 0,
    });
    const provider = (source: 'dexscreener' | 'geckoterminal', price: string | null) =>
      ({
        source,
        chains: ['base'] as const,
        health: () =>
          Promise.resolve({ source, healthy: true, latencyMs: 1, error: null, chains: ['base'] }),
        getPoolsForToken: () => Promise.resolve([snapshot(source)]),
        getPool: () => Promise.resolve(snapshot(source)),
        getTokenPriceUsd: () => Promise.resolve(price),
        search: () => Promise.resolve([]),
      }) as MarketDataProvider;

    // The provider layer already nulls zeros; the service must cope with one
    // provider having nothing to say without treating that as agreement.
    const service = new MarketService(
      [provider('dexscreener', '2500'), provider('geckoterminal', null)],
      undefined,
      { now: () => NOW, cacheTtlMs: 0 },
    );
    const result = await service.getCrossCheckedPrice('base', '0xtok');
    expect(result.priceUsd).toBe('2500');
    expect(result.sources).toHaveLength(1);
    expect(result.reason).toContain('could not be cross-checked');
  });
});

describe('review: INSUFFICIENT_DATA is reachable', () => {
  it('registry facts alone do not make a report OK', async () => {
    const db = openDatabase({ file: ':memory:' });
    const empty: MarketDataProvider = {
      source: 'dexscreener',
      chains: ['base'] as const,
      health: () =>
        Promise.resolve({
          source: 'dexscreener',
          healthy: true,
          latencyMs: 1,
          error: null,
          chains: ['base'],
        }),
      getPoolsForToken: () => Promise.resolve([]),
      getPool: () => Promise.resolve(null),
      getTokenPriceUsd: () => Promise.resolve(null),
      search: () => Promise.resolve([]),
    };

    const agent = new ResearchAgent(
      new MarketService([empty], undefined, { now: () => NOW, cacheTtlMs: 0 }),
      new NullLlmProvider(),
      { db, audit: new AuditLog(db), now: () => NOW },
    );

    const result = await agent.research({ chain: 'base', token: '0xnobody' });
    expect(result.status).toBe('INSUFFICIENT_DATA');
    // The chain facts are still reported; they just do not count as evidence.
    expect(result.facts.some((fact) => fact.key === 'chain.id')).toBe(true);

    closeDatabase(db);
  });
});
