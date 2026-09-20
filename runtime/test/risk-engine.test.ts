import { describe, expect, it } from 'vitest';
import {
  ENGINE_VERSION,
  deriveIdempotencyKey,
  evaluate,
  feeInNativeUnits,
} from '../src/risk/engine.js';
import {
  canonicalJson,
  defaultRiskPolicy,
  parseRiskPolicy,
  policyHash,
} from '../src/risk/policy.js';
import { marketKey } from '../src/risk/types.js';
import type { ProposedAction, RiskDecision } from '../src/risk/types.js';
import {
  BASE_NATIVE,
  BASE_USDC,
  BASE_WETH,
  DAY_START,
  JUPITER_V6,
  NOW,
  PERMIT2,
  SOL_NATIVE,
  SOL_USDC,
  UNIVERSAL_ROUTER,
  makeAction,
  makeInput,
  makePolicy,
  makeSnapshot,
  makeSolanaAction,
  makeState,
} from './helpers/risk-fixtures.js';

/**
 * The risk engine is the component that stands between a language model and the
 * operator's money. These tests are written as adversarial cases: each one is a
 * way a model, a broken adapter or a corrupted proposal could try to get an
 * unsafe action executed, and each asserts the specific rejection code.
 */

function decide(overrides = {}): RiskDecision {
  return evaluate(makeInput(overrides));
}

describe('happy path', () => {
  it('allows a well-formed paper swap', () => {
    const decision = decide();
    expect(decision.code).toBe('OK');
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('all checks passed');
  });

  it('reports every check, including the ones that passed', () => {
    const decision = decide();
    expect(decision.checks.length).toBeGreaterThanOrEqual(28);
    expect(decision.checks.every((check) => typeof check.observed === 'string')).toBe(true);
  });

  it('records the engine version and policy hash for the audit trail', () => {
    const decision = decide();
    expect(decision.engineVersion).toBe(ENGINE_VERSION);
    expect(decision.policyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('computes derived values', () => {
    const decision = decide();
    expect(decision.derived).not.toBeNull();
    // 10 USDC at 1.000027 rounded up.
    expect(decision.derived?.amountInUsd).toBe('10.000270');
    // 250000 gas x 0.01 gwei at ETH 2500.123456.
    expect(decision.derived?.feeUsd).toBe('0.006251');
  });

  it('allows a well-formed Solana swap', () => {
    const decision = decide({ action: makeSolanaAction() });
    expect(decision.code).toBe('OK');
  });
});

describe('determinism', () => {
  it('returns byte-identical decisions for the same input', () => {
    const input = makeInput();
    const a = evaluate(input);
    const b = evaluate(input);
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it('is unaffected by key ordering in the input', () => {
    const input = makeInput();
    const shuffled = JSON.parse(
      JSON.stringify({ ...input, snapshot: { ...input.snapshot } }),
    ) as typeof input;
    expect(canonicalJson(evaluate(shuffled))).toBe(canonicalJson(evaluate(input)));
  });
});

describe('tier 0: stops and validity', () => {
  it('rejects when the emergency stop is active, without a model', () => {
    const decision = decide({
      state: makeState({
        emergencyStop: { active: true, since: NOW, reason: 'operator pressed stop', source: 'api' },
      }),
    });
    expect(decision.code).toBe('EMERGENCY_STOP');
    expect(decision.allowed).toBe(false);
  });

  it('rejects when the policy itself carries an emergency stop', () => {
    expect(decide({ policy: makePolicy({ emergencyStop: true }) }).code).toBe('EMERGENCY_STOP');
  });

  it('rejects when globally paused', () => {
    expect(decide({ state: makeState({ globalPause: true }) }).code).toBe('GLOBAL_PAUSE');
  });

  it('short-circuits the remaining checks after a tier 0 failure', () => {
    const decision = decide({ state: makeState({ globalPause: true }) });
    const sizeCheck = decision.checks.find((check) => check.name === 'size.amountInUsd');
    expect(sizeCheck?.skipped).toBe('short-circuit');
    expect(sizeCheck?.passed).toBe(false);
    expect(decision.derived).toBeNull();
  });

  it('rejects a LIVE action while the runtime is in PAPER', () => {
    expect(decide({ action: makeAction({ mode: 'LIVE' }) }).code).toBe('MODE_MISMATCH');
  });

  it('rejects LIVE without a completed activation', () => {
    const decision = decide({
      action: makeAction({ mode: 'LIVE' }),
      state: makeState({ mode: 'LIVE', activation: { state: 'PENDING', liveSession: null } }),
    });
    expect(decision.code).toBe('LIVE_NOT_ACTIVATED');
  });

  it('rejects LIVE when the activation session has expired', () => {
    const decision = decide({
      action: makeAction({ mode: 'LIVE' }),
      state: makeState({
        mode: 'LIVE',
        activation: { state: 'LIVE', liveSession: { startedAt: NOW - 10_000, expiresAt: NOW - 1 } },
      }),
    });
    expect(decision.code).toBe('LIVE_NOT_ACTIVATED');
  });

  it('allows LIVE with a valid activation session', () => {
    const decision = decide({
      action: makeAction({ mode: 'LIVE' }),
      state: makeState({
        mode: 'LIVE',
        activation: {
          state: 'LIVE',
          liveSession: { startedAt: NOW - 10_000, expiresAt: NOW + 60_000 },
        },
      }),
    });
    expect(decision.code).toBe('OK');
  });
});

describe('malformed proposals', () => {
  it('rejects a proposal that is not an object of the right shape', () => {
    const decision = decide({ action: { chain: 'base' } as never });
    expect(decision.code).toBe('SCHEMA_INVALID');
  });

  it('rejects a mixed-case EVM address instead of normalizing it', () => {
    const decision = decide({
      action: makeAction({ contract: UNIVERSAL_ROUTER.toUpperCase().replace('0X', '0x') }),
    });
    expect(decision.code).toBe('SCHEMA_INVALID');
  });

  it('rejects a zero amount', () => {
    expect(decide({ action: makeAction({ amountIn: '0' }) }).code).toBe('SCHEMA_INVALID');
  });

  it('rejects a swap with no quote', () => {
    expect(decide({ action: makeAction({ quote: null }) }).code).toBe('SCHEMA_INVALID');
  });

  it('rejects a quote whose minimum exceeds the expected output', () => {
    const action = makeAction();
    const decision = decide({
      action: makeAction({
        quote: { ...action.quote!, minAmountOut: '9999999999999999999' },
      }),
    });
    expect(decision.code).toBe('SCHEMA_INVALID');
  });

  it('rejects token decimals that disagree with the allowlist', () => {
    const decision = decide({
      action: makeAction({ tokenIn: { address: BASE_USDC, decimals: 18 } }),
    });
    expect(decision.code).toBe('SCHEMA_INVALID');
    expect(decision.checks.find((c) => c.name === 'schema.decimals')?.passed).toBe(false);
  });

  it('rejects a forged idempotency key', () => {
    const decision = decide({ action: makeAction({ idempotencyKey: 'a'.repeat(64) }) });
    expect(decision.code).toBe('SCHEMA_INVALID');
  });

  it('rejects a Solana action without program ids', () => {
    const action: Record<string, unknown> = { ...makeSolanaAction() };
    delete action['programIds'];
    expect(decide({ action }).code).toBe('SCHEMA_INVALID');
  });

  it('rejects an EVM action that carries program ids', () => {
    expect(decide({ action: makeAction({ programIds: [JUPITER_V6] }) }).code).toBe(
      'SCHEMA_INVALID',
    );
  });

  it('rejects a fee detail from the wrong chain family', () => {
    const decision = decide({
      action: makeAction({
        feeEstimate: {
          estimatedAt: NOW - 1_000,
          detail: {
            family: 'solana',
            signatures: 1,
            computeUnitLimit: 1,
            computeUnitPriceMicroLamports: '1',
            rentLamports: '0',
          },
        },
      }),
    });
    expect(decision.code).toBe('SCHEMA_INVALID');
  });
});

describe('chain support', () => {
  it('rejects a chain the operator has not enabled', () => {
    const decision = decide({
      policy: makePolicy({ enabledChains: ['base'] }),
      action: makeSolanaAction(),
    });
    expect(decision.code).toBe('CHAIN_UNSUPPORTED');
  });

  it('never substitutes a different chain', () => {
    const policy = defaultRiskPolicy(['base']);
    const decision = evaluate(
      makeInput({ policy, policyHash: policyHash(policy), action: makeSolanaAction() }),
    );
    expect(decision.checks.find((c) => c.name === 'chain.enabled')?.observed).toBe('solana');
  });
});

describe('stale data', () => {
  it('rejects a stale price', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_USDC}`] = {
      value: '1',
      at: NOW - 10 * 60_000,
      source: 'dexscreener',
    };
    expect(decide({ snapshot }).code).toBe('DATA_STALE');
  });

  it('rejects a missing price rather than assuming one', () => {
    const snapshot = makeSnapshot();
    delete snapshot.prices[`base:${BASE_USDC}`];
    const decision = decide({ snapshot });
    expect(decision.code).toBe('DATA_STALE');
    expect(decision.checks.find((c) => c.name === 'freshness.price.tokenIn')?.observed).toBe(
      'missing',
    );
  });

  it('rejects a timestamp from the future', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_USDC}`] = { value: '1', at: NOW + 60_000, source: 'bad-clock' };
    expect(decide({ snapshot }).code).toBe('DATA_STALE');
  });

  it('tolerates a timestamp inside the allowed clock skew', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_USDC}`] = { value: '1.000027', at: NOW + 1_000, source: 'rpc' };
    expect(decide({ snapshot }).code).toBe('OK');
  });

  it('rejects a stale quote', () => {
    const action = makeAction();
    expect(
      decide({ action: makeAction({ quote: { ...action.quote!, quotedAt: NOW - 120_000 } }) }).code,
    ).toBe('DATA_STALE');
  });

  it('rejects a stale proposal', () => {
    expect(decide({ action: makeAction({ proposedAt: NOW - 10 * 60_000 }) }).code).toBe(
      'DATA_STALE',
    );
  });

  it('rejects a ledger snapshot from a different UTC day', () => {
    const state = makeState();
    state.ledger.dayStartUtcMs = DAY_START - 86_400_000;
    expect(decide({ state }).code).toBe('DATA_STALE');
  });

  it('does not compute derived USD values from missing prices', () => {
    const snapshot = makeSnapshot();
    delete snapshot.prices[`base:${BASE_USDC}`];
    const decision = decide({ snapshot });
    expect(decision.derived?.amountInUsd).toBe('not-evaluated');
  });
});

describe('allowlists', () => {
  const UNKNOWN_TOKEN = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

  /**
   * An unknown token normally has no price either, and freshness is checked
   * before membership, so these tests supply market data for it. That isolates
   * the allowlist: the action is rejected because the token is not permitted,
   * not merely because ATRA happens to have no data for it.
   */
  function snapshotWithUnknownToken() {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${UNKNOWN_TOKEN}`] = { value: '1', at: NOW - 1_000, source: 'test' };
    snapshot.balances[`base:${UNKNOWN_TOKEN}`] = {
      value: '100000000000000000000',
      at: NOW - 1_000,
      source: 'test',
    };
    return snapshot;
  }

  it('rejects a token that is not allowlisted', () => {
    const decision = decide({
      action: makeAction({ tokenIn: { address: UNKNOWN_TOKEN, decimals: 18 } }),
      snapshot: snapshotWithUnknownToken(),
    });
    expect(decision.code).toBe('TOKEN_NOT_ALLOWLISTED');
  });

  it('rejects an output token that is not allowlisted', () => {
    const decision = decide({
      action: makeAction({ tokenOut: { address: UNKNOWN_TOKEN, decimals: 18 } }),
      snapshot: snapshotWithUnknownToken(),
    });
    expect(decision.code).toBe('TOKEN_NOT_ALLOWLISTED');
  });

  it('rejects an unknown token even when no market data exists for it', () => {
    // Freshness fails first here, which is the correct canonical order: ATRA
    // refuses rather than guessing a price for a token it has never seen.
    const decision = decide({
      action: makeAction({ tokenIn: { address: UNKNOWN_TOKEN, decimals: 18 } }),
    });
    expect(decision.allowed).toBe(false);
    expect(decision.code).toBe('DATA_STALE');
    expect(decision.checks.find((c) => c.name === 'allowlist.tokenIn')?.passed).toBe(false);
  });

  it('rejects an unknown protocol', () => {
    expect(decide({ action: makeAction({ protocol: 'rugpull-v1' }) }).code).toBe(
      'PROTOCOL_NOT_ALLOWLISTED',
    );
  });

  it('rejects a contract that is not in the protocol entry', () => {
    expect(decide({ action: makeAction({ contract: UNKNOWN_TOKEN }) }).code).toBe(
      'CONTRACT_UNKNOWN',
    );
  });

  it('rejects an approve to a spender that is not approved', () => {
    const decision = decide({
      action: makeAction({
        kind: 'approve',
        contract: UNIVERSAL_ROUTER,
        tokenOut: { address: BASE_USDC, decimals: 6 },
        quote: null,
      }),
    });
    expect(decision.code).toBe('CONTRACT_UNKNOWN');
  });

  it('allows an approve to Permit2, which is an approved spender', () => {
    const decision = decide({
      action: makeAction({
        kind: 'approve',
        contract: PERMIT2,
        tokenOut: { address: BASE_USDC, decimals: 6 },
        quote: null,
      }),
    });
    expect(decision.code).toBe('OK');
  });

  it('rejects a Solana transaction that touches an unlisted program', () => {
    const decision = decide({
      action: makeSolanaAction({
        programIds: [JUPITER_V6, 'BPFLoaderUpgradeab1e11111111111111111111111'],
      }),
    });
    expect(decision.code).toBe('CONTRACT_UNKNOWN');
  });

  it('allows the documented Solana system programs alongside the router', () => {
    const decision = decide({
      action: makeSolanaAction({
        programIds: [
          JUPITER_V6,
          '11111111111111111111111111111111',
          'ComputeBudget111111111111111111111111111111',
          'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
        ],
      }),
    });
    expect(decision.code).toBe('OK');
  });
});

describe('size and exposure limits', () => {
  it('rejects a trade larger than the per-trade cap', () => {
    // 100 USDC against a 25 USD cap.
    expect(decide({ action: makeAction({ amountIn: '100000000' }) }).code).toBe(
      'SIZE_EXCEEDS_MAX_TRADE',
    );
  });

  it('allows a trade exactly at the cap', () => {
    const policy = makePolicy({ maxAmountPerTradeUsd: '10.00027' });
    expect(decide({ policy, policyHash: policyHash(policy) }).code).toBe('OK');
  });

  it('rejects a trade one micro-dollar over the cap', () => {
    const policy = makePolicy({ maxAmountPerTradeUsd: '10.000269' });
    expect(decide({ policy, policyHash: policyHash(policy) }).code).toBe('SIZE_EXCEEDS_MAX_TRADE');
  });

  it('rejects when total deployed capital would be exceeded', () => {
    const state = makeState();
    state.ledger.deployedUsd = '245';
    expect(decide({ state }).code).toBe('TOTAL_DEPLOYED_BREACHED');
  });

  it('counts the worst case, not the expected case, against the daily loss limit', () => {
    const state = makeState();
    // 49.99 lost today plus the fee and full slippage tolerance crosses 50.
    state.ledger.realizedPnlTodayUsd = '-49.99';
    const decision = decide({ state });
    expect(decision.code).toBe('DAILY_LOSS_BREACHED');
  });

  it('treats an unrealized drawdown as a loss when configured to', () => {
    const state = makeState();
    state.ledger.unrealizedPnlUsd = '-60';
    expect(decide({ state }).code).toBe('DAILY_LOSS_BREACHED');
  });

  it('ignores unrealized moves when the operator opts out', () => {
    const policy = makePolicy({ dailyLoss: { includeUnrealized: false } });
    const state = makeState();
    state.ledger.unrealizedPnlUsd = '-60';
    expect(decide({ policy, policyHash: policyHash(policy), state }).code).toBe('OK');
  });

  it('does not count yesterday drawdown again today', () => {
    const state = makeState();
    state.ledger.unrealizedPnlUsd = '-60';
    state.ledger.unrealizedPnlAtDayStartUsd = '-60';
    expect(decide({ state }).code).toBe('OK');
  });

  it('lets gains today offset losses today', () => {
    const state = makeState();
    state.ledger.realizedPnlTodayUsd = '-40';
    state.ledger.unrealizedPnlUsd = '40';
    expect(decide({ state }).code).toBe('OK');
  });
});

describe('execution quality', () => {
  it('rejects slippage above the policy limit', () => {
    const action = makeAction();
    const decision = decide({
      action: makeAction({ quote: { ...action.quote!, slippageBps: 500 } }),
    });
    expect(decision.code).toBe('SLIPPAGE_EXCEEDS_MAX');
  });

  it('uses the implied slippage when it exceeds the requested slippage', () => {
    const action = makeAction();
    const decision = decide({
      action: makeAction({
        quote: {
          ...action.quote!,
          slippageBps: 1,
          expectedAmountOut: '1000000',
          minAmountOut: '900000',
        },
      }),
    });
    expect(decision.code).toBe('SLIPPAGE_EXCEEDS_MAX');
    expect(decision.checks.find((c) => c.name === 'slippage.implied')?.observed).toBe('1000');
  });

  it('rejects excessive price impact', () => {
    const action = makeAction();
    expect(
      decide({ action: makeAction({ quote: { ...action.quote!, priceImpactBps: 900 } }) }).code,
    ).toBe('SLIPPAGE_EXCEEDS_MAX');
  });

  it('rejects a fee above the cap', () => {
    const decision = decide({
      action: makeAction({
        feeEstimate: {
          estimatedAt: NOW - 1_000,
          detail: { family: 'evm', gasLimit: '250000', maxFeePerGas: '10000000000' },
        },
      }),
    });
    expect(decision.code).toBe('FEE_EXCEEDS_MAX');
  });

  it('rejects a market below the liquidity floor', () => {
    const snapshot = makeSnapshot();
    snapshot.liquidity['base:0xpool'] = { value: '1000', at: NOW - 1_000, source: 'dexscreener' };
    expect(decide({ snapshot }).code).toBe('LIQUIDITY_BELOW_MIN');
  });
});

describe('pacing', () => {
  it('rejects while the market cooldown is active', () => {
    const state = makeState();
    state.cooldowns[marketKey('base', BASE_USDC, BASE_WETH)] = NOW - 60_000;
    expect(decide({ state }).code).toBe('COOLDOWN_ACTIVE');
  });

  it('treats a market cooldown as order independent', () => {
    const forward = marketKey('base', BASE_USDC, BASE_WETH);
    const reverse = marketKey('base', BASE_WETH, BASE_USDC);
    expect(forward).toBe(reverse);
  });

  it('allows once the cooldown has elapsed', () => {
    const state = makeState();
    state.cooldowns[marketKey('base', BASE_USDC, BASE_WETH)] = NOW - 901_000;
    expect(decide({ state }).code).toBe('OK');
  });

  it('rejects while the global minimum interval is active', () => {
    expect(decide({ state: makeState({ lastAnyActionAt: NOW - 1_000 }) }).code).toBe(
      'COOLDOWN_ACTIVE',
    );
  });
});

describe('balances', () => {
  it('rejects when the wallet cannot cover the trade', () => {
    const snapshot = makeSnapshot();
    snapshot.balances[`base:${BASE_USDC}`] = { value: '1000', at: NOW - 1_000, source: 'rpc' };
    expect(decide({ snapshot }).code).toBe('BALANCE_INSUFFICIENT');
  });

  it('rejects when there is not enough native token for gas', () => {
    const snapshot = makeSnapshot();
    snapshot.balances[`base:${BASE_NATIVE}`] = { value: '1', at: NOW - 1_000, source: 'rpc' };
    expect(decide({ snapshot }).code).toBe('BALANCE_INSUFFICIENT');
  });

  it('requires a native trade to cover both the amount and the fee', () => {
    const snapshot = makeSnapshot();
    // Exactly the trade amount, nothing spare for gas.
    snapshot.balances[`base:${BASE_NATIVE}`] = {
      value: '1000000000000000',
      at: NOW - 1_000,
      source: 'rpc',
    };
    const decision = decide({
      action: makeAction({
        tokenIn: { address: BASE_NATIVE, decimals: 18 },
        tokenOut: { address: BASE_USDC, decimals: 6 },
        amountIn: '1000000000000000',
        quote: {
          expectedAmountOut: '2500000',
          minAmountOut: '2495000',
          slippageBps: 20,
          priceImpactBps: 5,
          quotedAt: NOW - 1_000,
          source: 'uniswap-v4-quoter',
          marketId: '0xpool',
        },
      }),
      snapshot,
    });
    expect(decision.code).toBe('BALANCE_INSUFFICIENT');
  });
});

describe('the quote against the wider market', () => {
  // slippage.implied compares the quote with itself and slippage.priceImpact
  // compares it with a probe on the same pool, so a venue whose price has
  // drifted from everywhere else passes both: its numbers are consistent,
  // just consistently wrong. This check is the one that looks outside.

  it('passes a quote that matches the cross-checked price', () => {
    const decision = decide({});
    const check = decision.checks.find((c) => c.name === 'quote.market');
    expect(check?.passed).toBe(true);
    expect(decision.code).toBe('OK');
  });

  it('rejects a quote thirty per cent below the market', () => {
    // 0.0028 WETH for 10 USDC: internally consistent, and about 30% short of
    // what the cross-checked price says 10 USDC is worth.
    const action = makeAction({
      quote: {
        expectedAmountOut: '2800000000000000',
        minAmountOut: '2791600000000000',
        slippageBps: 30,
        priceImpactBps: 5,
        quotedAt: NOW - 2_000,
        source: 'uniswap-v4-quoter',
        marketId: '0xpool',
      },
    });

    const decision = decide({ action });
    expect(decision.code).toBe('QUOTE_OFF_MARKET');
    const check = decision.checks.find((c) => c.name === 'quote.market');
    expect(check?.passed).toBe(false);
    expect(check?.detail).toMatch(/cross-checked price/);
  });

  it('is not evaluated, and fails, when the output price is unusable', () => {
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${BASE_WETH}`] = { value: '0', at: NOW - 1_000, source: 'dexscreener' };

    const decision = decide({ snapshot });
    const check = decision.checks.find((c) => c.name === 'quote.market');
    expect(check?.passed).toBe(false);
    expect(check?.observed).toBe('not-evaluated');
  });

  it('does not apply to an approval', () => {
    const decision = decide({
      action: makeAction({
        kind: 'approve',
        contract: PERMIT2,
        tokenOut: { address: BASE_USDC, decimals: 6 },
        quote: null,
        amountIn: '10000000',
      }),
    });
    expect(decision.checks.find((c) => c.name === 'quote.market')?.skipped).toBe('not-applicable');
  });
});

describe('reduce-only exits', () => {
  it('rejects an exit with no matching position', () => {
    expect(decide({ action: makeAction({ reduceOnly: true }) }).code).toBe('REDUCE_ONLY_MISMATCH');
  });

  it('rejects an exit larger than the position', () => {
    const state = makeState();
    state.ledger.positions = [
      { chain: 'base', token: BASE_USDC, amount: '1000000', costBasisUsd: '1', openedAt: NOW },
    ];
    expect(decide({ action: makeAction({ reduceOnly: true }), state }).code).toBe(
      'REDUCE_ONLY_MISMATCH',
    );
  });

  /** A real exit: sell part of a WETH holding back into USDC. */
  function exitAction(overrides: Partial<ProposedAction> = {}) {
    return makeAction({
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
      ...overrides,
    });
  }

  it('allows a partial exit and skips the exposure checks', () => {
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
    state.ledger.realizedPnlTodayUsd = '-1000';
    const snapshot = makeSnapshot();
    snapshot.balances[`base:${BASE_WETH}`] = {
      value: '20000000000000000',
      at: NOW - 1_000,
      source: 'rpc',
    };

    const decision = decide({ action: exitAction(), state, snapshot });
    expect(decision.code).toBe('OK');
    expect(decision.checks.find((c) => c.name === 'size.amountInUsd')?.skipped).toBe(
      'not-applicable',
    );
    expect(decision.checks.find((c) => c.name === 'loss.daily')?.skipped).toBe('not-applicable');
  });

  it('refuses a stablecoin "exit": selling USDC is a purchase, not a reduction', () => {
    // The funding stablecoin is a ledger position after any exit. Letting it
    // qualify as an exit would let a stable-to-stable swap of any size skip
    // the size, daily-loss, deployed and cooldown checks.
    const state = makeState({ lastAnyActionAt: NOW - 1_000 });
    state.ledger.positions = [
      { chain: 'base', token: BASE_USDC, amount: '50000000', costBasisUsd: '50', openedAt: NOW },
    ];
    state.ledger.realizedPnlTodayUsd = '-1000';

    const decision = decide({ action: makeAction({ reduceOnly: true }), state });
    expect(decision.code).toBe('REDUCE_ONLY_MISMATCH');
    expect(decision.checks.find((c) => c.name === 'position.reduceOnly')?.detail).toMatch(
      /cannot sell a stablecoin/,
    );
  });

  it('refuses an exit that does not return to a stablecoin', () => {
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
    // An operator-allowlisted non-stable token on the output side.
    const other = '0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf';
    snapshot.prices[`base:${other}`] = { value: '60000', at: NOW - 1_000, source: 'test' };
    const policy = makePolicy();
    policy.tokenAllowlist.base = [
      ...(policy.tokenAllowlist.base ?? []),
      { address: other, symbol: 'cbBTC', decimals: 8 },
    ];
    const action = exitAction({
      tokenOut: { address: other, decimals: 8 },
      quote: {
        expectedAmountOut: '41000',
        minAmountOut: '40877',
        slippageBps: 30,
        priceImpactBps: 5,
        quotedAt: NOW - 2_000,
        source: 'uniswap-v4-quoter',
        marketId: '0xpool',
      },
    });

    const decision = decide({ action, state, snapshot, policy });
    expect(decision.code).toBe('REDUCE_ONLY_MISMATCH');
    expect(decision.checks.find((c) => c.name === 'position.reduceOnly')?.detail).toMatch(
      /must return to a stablecoin/,
    );
  });

  it('still enforces allowlists on an exit', () => {
    const rogue = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    const state = makeState();
    state.ledger.positions = [
      { chain: 'base', token: rogue, amount: '50000000', costBasisUsd: '50', openedAt: NOW },
    ];
    const snapshot = makeSnapshot();
    snapshot.prices[`base:${rogue}`] = { value: '1', at: NOW - 1_000, source: 'test' };
    snapshot.balances[`base:${rogue}`] = { value: '50000000', at: NOW - 1_000, source: 'test' };

    const decision = decide({
      action: makeAction({ reduceOnly: true, tokenIn: { address: rogue, decimals: 6 } }),
      state,
      snapshot,
    });
    expect(decision.code).toBe('TOKEN_NOT_ALLOWLISTED');
  });
});

describe('fee arithmetic', () => {
  it('computes an EVM fee as gas limit times max fee per gas', () => {
    expect(feeInNativeUnits({ family: 'evm', gasLimit: '250000', maxFeePerGas: '10000000' })).toBe(
      2_500_000_000_000n,
    );
  });

  it('computes a Solana fee from signatures, compute units and rent', () => {
    expect(
      feeInNativeUnits({
        family: 'solana',
        signatures: 1,
        computeUnitLimit: 200_000,
        computeUnitPriceMicroLamports: '500',
        rentLamports: '0',
      }),
    ).toBe(5_100n);
  });

  it('includes rent exemption in a Solana fee', () => {
    expect(
      feeInNativeUnits({
        family: 'solana',
        signatures: 1,
        computeUnitLimit: 0,
        computeUnitPriceMicroLamports: '0',
        rentLamports: '1488440',
      }),
    ).toBe(1_493_440n);
  });
});

describe('idempotency keys', () => {
  it('matches the published vectors', () => {
    const action = makeAction({
      decisionCycleId: '0192f3a0-6b1e-7c2d-9a4b-1c2d3e4f5a6b',
      chain: 'base',
      kind: 'swap',
      protocol: 'uniswap-v4',
      tokenIn: { address: BASE_USDC, decimals: 6 },
      tokenOut: { address: BASE_WETH, decimals: 18 },
      amountIn: '10000000',
      reduceOnly: false,
    });
    expect(deriveIdempotencyKey(action)).toBe(
      '1a623ec2163f3a1e983061ac7078482a5ca5340d8c48dcdf57a758cb77a0b9d1',
    );
  });

  it('changes when the amount changes', () => {
    const base = makeAction({ decisionCycleId: '0192f3a0-6b1e-7c2d-9a4b-1c2d3e4f5a6b' });
    expect(deriveIdempotencyKey({ ...base, amountIn: '10000001' })).toBe(
      'e2c5f160d3531225d007f9f9d8b985d52c75596dcd09aa49d974eb9c63536920',
    );
  });

  it('changes when the direction changes', () => {
    const base = makeAction({ decisionCycleId: '0192f3a0-6b1e-7c2d-9a4b-1c2d3e4f5a6b' });
    expect(deriveIdempotencyKey({ ...base, reduceOnly: true })).toBe(
      '36fd99b1967bedc1a4a5a82d5fcada44a5d2215f74fb7207a80e57caccd85900',
    );
  });

  it('is independent of the proposal timestamp', () => {
    const a = makeAction({ proposedAt: NOW });
    const b = { ...a, proposedAt: NOW + 5_000 };
    expect(deriveIdempotencyKey(a)).toBe(deriveIdempotencyKey(b));
  });
});

describe('market keys', () => {
  it('matches the published vectors', () => {
    expect(marketKey('base', BASE_USDC, BASE_WETH)).toBe(`base:${BASE_WETH}:${BASE_USDC}`);
    expect(marketKey('solana', SOL_NATIVE, SOL_USDC)).toBe(`solana:${SOL_USDC}:${SOL_NATIVE}`);
  });
});

describe('policy validation', () => {
  it('accepts the shipped defaults', () => {
    expect(() => parseRiskPolicy(defaultRiskPolicy())).not.toThrow();
  });

  it('starts with LP automation disabled', () => {
    const policy = defaultRiskPolicy();
    expect(policy.lp.maxCapitalPerLpUsd).toBe('0');
    expect(policy.lp.allowedPools).toEqual([]);
  });

  it('starts unpaused and not stopped', () => {
    const policy = defaultRiskPolicy();
    expect(policy.globalPause).toBe(false);
    expect(policy.emergencyStop).toBe(false);
  });

  it('rejects a per-trade cap above the total deployment cap', () => {
    expect(() => parseRiskPolicy({ ...defaultRiskPolicy(), maxAmountPerTradeUsd: '1000' })).toThrow(
      /not valid/,
    );
  });

  it('rejects a zero per-trade cap', () => {
    expect(() => parseRiskPolicy({ ...defaultRiskPolicy(), maxAmountPerTradeUsd: '0' })).toThrow();
  });

  it('rejects an allowlist for a chain that is not enabled', () => {
    const policy = defaultRiskPolicy(['base']);
    expect(() =>
      parseRiskPolicy({
        ...policy,
        tokenAllowlist: {
          ...policy.tokenAllowlist,
          solana: [{ address: SOL_USDC, symbol: 'USDC', decimals: 6 }],
        },
      }),
    ).toThrow();
  });

  it('rejects an EVM address listed under Solana', () => {
    const policy = defaultRiskPolicy();
    expect(() =>
      parseRiskPolicy({
        ...policy,
        tokenAllowlist: {
          ...policy.tokenAllowlist,
          solana: [{ address: BASE_USDC, symbol: 'USDC', decimals: 6 }],
        },
      }),
    ).toThrow();
  });

  it('rejects an approve spender that is not one of the protocol contracts', () => {
    const policy = defaultRiskPolicy();
    expect(() =>
      parseRiskPolicy({
        ...policy,
        protocolAllowlist: {
          ...policy.protocolAllowlist,
          base: {
            'uniswap-v4': {
              contracts: [UNIVERSAL_ROUTER],
              approveSpenders: ['0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef'],
            },
          },
        },
      }),
    ).toThrow();
  });

  it('produces a stable policy hash', () => {
    const a = defaultRiskPolicy();
    const b = defaultRiskPolicy();
    expect(policyHash(a)).toBe(policyHash(b));
  });

  it('changes the hash when a limit changes', () => {
    const a = defaultRiskPolicy();
    const b = { ...a, maxAmountPerTradeUsd: '24' };
    expect(policyHash(a)).not.toBe(policyHash(b));
  });
});
