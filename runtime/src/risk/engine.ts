import { createHash } from 'node:crypto';
import {
  SOLANA_SYSTEM_PROGRAMS,
  canonicalizeAddress,
  isNativeToken,
  isStablecoin,
} from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import type { RiskPolicy } from './policy.js';
import {
  amountToBigint,
  bpsOf,
  ceilDiv,
  impliedSlippageBps,
  maxBigint,
  microsToUsd,
  nativeToUsdMicros,
  priceToAtto,
  usdToMicros,
} from './money.js';
import { isLpKind, proposedActionSchema } from './types.js';
import type {
  FeeDetail,
  ProposedAction,
  RejectionCode,
  RiskCheck,
  RiskDecision,
  RiskDerived,
  RiskInput,
  Stamped,
} from './types.js';
import { balanceKey, liquidityKey, lpPoolKey, marketKey, priceKey } from './types.js';

/**
 * The deterministic risk engine.
 *
 * This is the component that actually says no. It is a pure function: same
 * input, same decision, byte for byte. It never calls a model, never reads a
 * clock, never touches the network and never throws for a policy reason — an
 * unacceptable action comes back as a rejection with a machine-readable code,
 * so the caller cannot accidentally treat "refused" as "errored and retry".
 *
 * Two structural decisions worth stating:
 *
 *  - Checks run in a fixed canonical order and every check is reported, even
 *    the ones that passed. The dashboard shows the operator the whole picture
 *    rather than just the first problem.
 *  - Tier 0 (schema, emergency stop, pause, mode) short-circuits. Nothing below
 *    is meaningful once the runtime is stopped, and reporting "size OK" under
 *    an active emergency stop would be actively misleading.
 */

export const ENGINE_VERSION = 'risk-engine/1.0.0';

const NOT_EVALUATED = 'not-evaluated';
const SOLANA_SIGNATURE_LAMPORTS = 5_000n;

export function evaluate(input: RiskInput): RiskDecision {
  const checks: RiskCheck[] = [];
  const ctx = new EvaluationContext(input, checks);

  const tier0Failed = runTier0(ctx);
  if (tier0Failed) {
    return ctx.finish(null);
  }

  const derived = runRemainingChecks(ctx);
  return ctx.finish(derived);
}

/** Tier 0: validity and the global stop switches. Returns true when one fails. */
function runTier0(ctx: EvaluationContext): boolean {
  const { input } = ctx;
  const { action, policy, state } = input;

  ctx.check({
    name: 'schema.policy',
    code: 'SCHEMA_INVALID',
    passed: policy.schemaVersion === 1,
    observed: policy.schemaVersion === 1 ? 'valid' : 'invalid',
    limit: 'valid',
  });

  const parsed = proposedActionSchema.safeParse(action);
  ctx.check({
    name: 'schema.action',
    code: 'SCHEMA_INVALID',
    passed: parsed.success,
    observed: parsed.success ? 'valid' : (parsed.error.issues[0]?.path.join('.') ?? 'invalid'),
    limit: 'valid',
    ...(parsed.success
      ? {}
      : { detail: parsed.error.issues[0]?.message.slice(0, 200) ?? 'invalid action' }),
  });

  if (parsed.success) {
    // Token decimals must match the allowlist, because every USD conversion
    // downstream uses them. A wrong decimals field is the difference between
    // 25 dollars and 25 million.
    const mismatch = decimalsMismatch(action, policy.tokenAllowlist[action.chain] ?? []);
    ctx.check({
      name: 'schema.decimals',
      code: 'SCHEMA_INVALID',
      passed: mismatch === undefined,
      observed: mismatch?.observed ?? 'match',
      limit: mismatch?.expected ?? 'allowlist',
      ...(mismatch ? { detail: `${mismatch.address} decimals disagree with the allowlist` } : {}),
    });

    const expectedKey = deriveIdempotencyKey(action);
    ctx.check({
      name: 'schema.idempotency',
      code: 'SCHEMA_INVALID',
      passed: action.idempotencyKey === expectedKey,
      observed: action.idempotencyKey,
      limit: expectedKey,
    });
  } else {
    ctx.skip('schema.decimals', 'SCHEMA_INVALID', 'short-circuit');
    ctx.skip('schema.idempotency', 'SCHEMA_INVALID', 'short-circuit');
  }

  const emergency = policy.emergencyStop || state.emergencyStop.active;
  ctx.check({
    name: 'stop.emergency',
    code: 'EMERGENCY_STOP',
    passed: !emergency,
    observed: String(emergency),
    limit: 'false',
    ...(state.emergencyStop.reason ? { detail: state.emergencyStop.reason.slice(0, 200) } : {}),
  });

  const paused = policy.globalPause || state.globalPause;
  ctx.check({
    name: 'pause.global',
    code: 'GLOBAL_PAUSE',
    passed: !paused,
    observed: String(paused),
    limit: 'false',
  });

  ctx.check({
    name: 'live.modeMatch',
    code: 'MODE_MISMATCH',
    passed: action.mode === state.mode,
    observed: action.mode,
    limit: state.mode,
  });

  const liveOk =
    action.mode === 'PAPER' ||
    (state.activation.state === 'LIVE' &&
      state.activation.liveSession !== null &&
      state.activation.liveSession.expiresAt > input.now);
  ctx.check({
    name: 'live.activated',
    code: 'LIVE_NOT_ACTIVATED',
    passed: liveOk,
    observed: state.activation.state,
    limit: action.mode === 'PAPER' ? 'n/a' : 'LIVE',
  });

  const failed = checksFailed(ctx.checks);
  if (failed) {
    for (const name of remainingCheckNames(action)) {
      ctx.skip(name.name, name.code, 'short-circuit');
    }
  }
  return failed;
}

interface CheckName {
  name: string;
  code: RejectionCode;
}

/**
 * LP checks (Phase 4). `lp.pool` and, for an entry, `lp.capital` run right
 * after `chain.enabled`: whether the operator allowed the pool at all is a
 * structural question, like whether the chain is enabled, and it must decide
 * the rejection code before any data-freshness problem does. The rest run
 * after the shared checks. None of these names appear on a swap or a plain
 * approve, so those decisions are unchanged byte for byte.
 */
const LP_POOL_CHECK: CheckName = { name: 'lp.pool', code: 'POOL_NOT_ALLOWLISTED' };
const LP_CAPITAL_CHECK: CheckName = { name: 'lp.capital', code: 'LP_CAPITAL_EXCEEDS_MAX' };
const LP_LATE_CHECK_NAMES: CheckName[] = [
  { name: 'lp.position', code: 'REDUCE_ONLY_MISMATCH' },
  { name: 'lp.poolLiquidity', code: 'POOL_LIQUIDITY_BELOW_MIN' },
  { name: 'lp.rebalanceCount', code: 'REBALANCE_LIMIT_REACHED' },
  { name: 'lp.rebalanceSlippage', code: 'SLIPPAGE_EXCEEDS_MAX' },
  { name: 'lp.gas', code: 'FEE_EXCEEDS_MAX' },
  { name: 'lp.claimThreshold', code: 'FEE_BELOW_CLAIM_THRESHOLD' },
  { name: 'lp.freshness.balance.tokenB', code: 'DATA_STALE' },
  { name: 'lp.balance.tokenB', code: 'BALANCE_INSUFFICIENT' },
];

/** The canonical check order for this action's kind. */
function remainingCheckNames(action: ProposedAction): CheckName[] {
  const kind = typeof action.kind === 'string' ? action.kind : '';
  const isLp = isLpKind(kind);
  const isLpApprove = kind === 'approve' && action.lp !== undefined;
  if (!isLp && !isLpApprove) return REMAINING_CHECK_NAMES;

  const [chainEnabled, ...rest] = REMAINING_CHECK_NAMES;
  const isEntry = kind === 'lp_add' || kind === 'lp_rebalance';
  return [
    chainEnabled!,
    LP_POOL_CHECK,
    ...(isEntry ? [LP_CAPITAL_CHECK] : []),
    ...rest,
    ...(isLp ? LP_LATE_CHECK_NAMES : []),
  ];
}

/** Canonical order of everything after tier 0, used when short-circuiting. */
const REMAINING_CHECK_NAMES: CheckName[] = [
  { name: 'chain.enabled', code: 'CHAIN_UNSUPPORTED' },
  { name: 'freshness.action', code: 'DATA_STALE' },
  { name: 'freshness.ledger', code: 'DATA_STALE' },
  { name: 'freshness.price.tokenIn', code: 'DATA_STALE' },
  { name: 'freshness.price.tokenOut', code: 'DATA_STALE' },
  { name: 'freshness.price.native', code: 'DATA_STALE' },
  { name: 'freshness.quote', code: 'DATA_STALE' },
  { name: 'freshness.fee', code: 'DATA_STALE' },
  { name: 'freshness.balance.tokenIn', code: 'DATA_STALE' },
  { name: 'freshness.balance.native', code: 'DATA_STALE' },
  { name: 'freshness.liquidity', code: 'DATA_STALE' },
  { name: 'allowlist.tokenIn', code: 'TOKEN_NOT_ALLOWLISTED' },
  { name: 'allowlist.tokenOut', code: 'TOKEN_NOT_ALLOWLISTED' },
  { name: 'allowlist.protocol', code: 'PROTOCOL_NOT_ALLOWLISTED' },
  { name: 'allowlist.contract', code: 'CONTRACT_UNKNOWN' },
  { name: 'position.reduceOnly', code: 'REDUCE_ONLY_MISMATCH' },
  { name: 'size.amountInUsd', code: 'SIZE_EXCEEDS_MAX_TRADE' },
  { name: 'loss.daily', code: 'DAILY_LOSS_BREACHED' },
  { name: 'deployed.total', code: 'TOTAL_DEPLOYED_BREACHED' },
  { name: 'slippage.implied', code: 'SLIPPAGE_EXCEEDS_MAX' },
  { name: 'slippage.priceImpact', code: 'SLIPPAGE_EXCEEDS_MAX' },
  { name: 'fee.usd', code: 'FEE_EXCEEDS_MAX' },
  { name: 'liquidity.market', code: 'LIQUIDITY_BELOW_MIN' },
  { name: 'cooldown.market', code: 'COOLDOWN_ACTIVE' },
  { name: 'cooldown.global', code: 'COOLDOWN_ACTIVE' },
  { name: 'balance.tokenIn', code: 'BALANCE_INSUFFICIENT' },
  { name: 'balance.gas', code: 'BALANCE_INSUFFICIENT' },
];

function runRemainingChecks(ctx: EvaluationContext): RiskDerived | null {
  const { input } = ctx;
  const { action, policy, state, snapshot, now } = input;
  const chain = action.chain;
  const isApprove = action.kind === 'approve';
  // Defence in depth: the schema already refuses reduceOnly on anything but a
  // swap, so this can only differ from action.reduceOnly if the schema is
  // loosened later.
  const isExit = action.reduceOnly && action.kind === 'swap';

  // --- LP kinds (Phase 4) ---------------------------------------------------
  // An entry commits capital; a removal is a privileged exit in the spirit of
  // reduceOnly (it can only lower exposure, and is verified against the LP
  // ledger); a claim moves nothing in. An approve that carries an lp leg is
  // the LP-token approval ahead of a removal.
  const lp = action.lp;
  const isLp = isLpKind(action.kind);
  const isLpEntry = action.kind === 'lp_add' || action.kind === 'lp_rebalance';
  const isLpExit = action.kind === 'lp_remove';
  const isLpClaim = action.kind === 'lp_claim';
  const isLpApprove = isApprove && lp !== undefined;
  const poolKey = lp === undefined ? undefined : lpPoolKey(chain, lp.poolId);

  ctx.check({
    name: 'chain.enabled',
    code: 'CHAIN_UNSUPPORTED',
    passed: policy.enabledChains.includes(chain),
    observed: chain,
    limit: policy.enabledChains.join(','),
  });

  const nativeToken = nativeTokenRef(chain);
  const priceIn = snapshot.prices[priceKey(chain, action.tokenIn.address)];
  const priceOut = snapshot.prices[priceKey(chain, action.tokenOut.address)];
  const priceNative = snapshot.prices[priceKey(chain, nativeToken.address)];

  let poolAllowed = false;
  if (lp !== undefined && (isLp || isLpApprove)) {
    const check = poolAllowlistCheck(policy, chain, action.protocol, lp.poolId);
    poolAllowed = check.passed;
    ctx.check(check);
  }

  // Capital an entry commits: both legs valued at the snapshot prices, each
  // rounded up. Recomputed here; the proposal's capitalUsd is only a hint.
  const lpEntryCapital =
    isLpEntry && lp?.amountB !== undefined
      ? lpCapitalMicros(action, lp.amountB, usablePrice(priceIn), usablePrice(priceOut))
      : undefined;

  if (isLpEntry && lp !== undefined && poolKey !== undefined) {
    const existing = snapshot.lp?.positions[poolKey];
    const existingCapital = existing ? usdToMicros(existing.capitalUsd) : 0n;
    const total = lpEntryCapital === undefined ? undefined : existingCapital + lpEntryCapital;
    const maxCapital = usdToMicros(policy.lp.maxCapitalPerLpUsd);
    ctx.check({
      name: 'lp.capital',
      code: 'LP_CAPITAL_EXCEEDS_MAX',
      passed: total !== undefined && total <= maxCapital,
      observed: total === undefined ? NOT_EVALUATED : microsToUsd(total),
      limit: microsToUsd(maxCapital),
      detail: `existing ${microsToUsd(existingCapital)} plus new ${
        lpEntryCapital === undefined ? NOT_EVALUATED : microsToUsd(lpEntryCapital)
      }`,
    });
  }

  // --- freshness -----------------------------------------------------------
  const skew = policy.freshness.maxClockSkewMs;

  ctx.check(
    freshnessCheck(
      'freshness.action',
      { value: 'action', at: action.proposedAt, source: action.source },
      now,
      policy.freshness.actionMaxAgeMs,
      skew,
    ),
  );

  const expectedDayStart = Math.floor(now / 86_400_000) * 86_400_000;
  ctx.check({
    name: 'freshness.ledger',
    code: 'DATA_STALE',
    passed: state.ledger.dayStartUtcMs === expectedDayStart,
    observed: String(state.ledger.dayStartUtcMs),
    limit: String(expectedDayStart),
    ...(state.ledger.dayStartUtcMs === expectedDayStart
      ? {}
      : { detail: 'ledger snapshot belongs to a different UTC day' }),
  });

  ctx.check(
    priceCheck('freshness.price.tokenIn', priceIn, now, policy.freshness.priceMaxAgeMs, skew),
  );

  if (isApprove) {
    ctx.skip('freshness.price.tokenOut', 'DATA_STALE', 'not-applicable');
  } else {
    ctx.check(
      priceCheck('freshness.price.tokenOut', priceOut, now, policy.freshness.priceMaxAgeMs, skew),
    );
  }

  ctx.check(
    priceCheck('freshness.price.native', priceNative, now, policy.freshness.priceMaxAgeMs, skew),
  );

  if (isApprove || !action.quote) {
    ctx.skip('freshness.quote', 'DATA_STALE', 'not-applicable');
  } else {
    ctx.check(
      freshnessCheck(
        'freshness.quote',
        { value: action.quote.source, at: action.quote.quotedAt, source: action.quote.source },
        now,
        policy.freshness.quoteMaxAgeMs,
        skew,
      ),
    );
  }

  ctx.check(
    freshnessCheck(
      'freshness.fee',
      { value: 'fee', at: action.feeEstimate.estimatedAt, source: 'adapter' },
      now,
      policy.freshness.feeEstimateMaxAgeMs,
      skew,
    ),
  );

  const balanceIn = snapshot.balances[balanceKey(chain, action.tokenIn.address)];
  const balanceNative = snapshot.balances[balanceKey(chain, nativeToken.address)];

  // A removal or claim spends no tokenIn; the LP position is checked instead.
  if (isLpExit || isLpClaim) {
    ctx.skip('freshness.balance.tokenIn', 'DATA_STALE', 'not-applicable');
  } else {
    ctx.check(
      freshnessCheck(
        'freshness.balance.tokenIn',
        balanceIn,
        now,
        policy.freshness.balanceMaxAgeMs,
        skew,
      ),
    );
  }
  ctx.check(
    freshnessCheck(
      'freshness.balance.native',
      balanceNative,
      now,
      policy.freshness.balanceMaxAgeMs,
      skew,
    ),
  );

  // Swaps read the market's liquidity for the quoted pair; LP entries read
  // the pool's own TVL, which the pipeline derives from reserves and prices.
  const liquidity = isLp
    ? lp !== undefined && isLpEntry
      ? snapshot.poolLiquidity?.[liquidityKey(chain, lp.poolId)]
      : undefined
    : action.quote
      ? snapshot.liquidity[liquidityKey(chain, action.quote.marketId)]
      : undefined;

  if (isApprove || !action.quote || isLpExit) {
    ctx.skip('freshness.liquidity', 'DATA_STALE', 'not-applicable');
  } else {
    ctx.check(
      freshnessCheck(
        'freshness.liquidity',
        liquidity,
        now,
        policy.freshness.liquidityMaxAgeMs,
        skew,
      ),
    );
  }

  // --- allowlists ----------------------------------------------------------
  const tokens = policy.tokenAllowlist[chain] ?? [];
  const allowedTokens = new Set(tokens.map((token) => token.address));

  // The LP token approved ahead of a removal is not an allowlisted asset; it
  // is allowed exactly when the pool it belongs to is (lp.pool above).
  const tokenInViaPool = isLpApprove && poolAllowed;
  ctx.check({
    name: 'allowlist.tokenIn',
    code: 'TOKEN_NOT_ALLOWLISTED',
    passed: allowedTokens.has(action.tokenIn.address) || tokenInViaPool,
    observed: action.tokenIn.address,
    limit: 'n/a',
    ...(tokenInViaPool ? { detail: 'LP token of an allowlisted pool' } : {}),
  });

  if (isApprove) {
    ctx.skip('allowlist.tokenOut', 'TOKEN_NOT_ALLOWLISTED', 'not-applicable');
  } else {
    ctx.check({
      name: 'allowlist.tokenOut',
      code: 'TOKEN_NOT_ALLOWLISTED',
      passed: allowedTokens.has(action.tokenOut.address),
      observed: action.tokenOut.address,
      limit: 'n/a',
    });
  }

  const protocols = policy.protocolAllowlist[chain] ?? {};
  // Own-property lookup: a protocol named "constructor" or "toString" must not
  // resolve through Object.prototype into something that is not an entry.
  const protocolEntry = Object.hasOwn(protocols, action.protocol)
    ? protocols[action.protocol]
    : undefined;

  ctx.check({
    name: 'allowlist.protocol',
    code: 'PROTOCOL_NOT_ALLOWLISTED',
    passed: protocolEntry !== undefined,
    observed: action.protocol,
    limit: 'n/a',
  });

  ctx.check(contractCheck(action, protocolEntry));

  // --- position ------------------------------------------------------------
  if (isExit) {
    const held = state.ledger.positions
      .filter((p) => p.chain === chain && p.token === action.tokenIn.address)
      .reduce((total, p) => total + amountToBigint(p.amount), 0n);
    const wanted = amountToBigint(action.amountIn);
    // An exit sells a holding back into a stablecoin. Stablecoins become
    // ledger positions too (every fill books its output), so without this
    // shape check a stable-to-stable swap of any size would qualify as an
    // exit and skip the size, daily-loss, deployed and cooldown checks.
    const sellsHolding = !isStablecoin(chain, action.tokenIn.address);
    const returnsToStable = isStablecoin(chain, action.tokenOut.address);
    const detail =
      held === 0n
        ? 'no open position for this token'
        : !sellsHolding
          ? 'an exit cannot sell a stablecoin'
          : !returnsToStable
            ? 'an exit must return to a stablecoin'
            : undefined;
    ctx.check({
      name: 'position.reduceOnly',
      code: 'REDUCE_ONLY_MISMATCH',
      passed: held > 0n && wanted <= held && sellsHolding && returnsToStable,
      observed: action.amountIn,
      limit: held.toString(),
      ...(detail === undefined ? {} : { detail }),
    });
  } else {
    ctx.check({
      name: 'position.reduceOnly',
      code: 'REDUCE_ONLY_MISMATCH',
      passed: true,
      observed: 'false',
      limit: 'n/a',
      skipped: 'not-applicable',
    });
  }

  // --- derived amounts -----------------------------------------------------
  // Anything that depends on missing or stale data is reported as
  // not-evaluated and failed, rather than computed from a guess.
  const amountIn = amountToBigint(action.amountIn);
  // A price parses to undefined when absent, malformed or zero; all mean
  // "unknown", and everything valued at it is reported as not-evaluated and
  // fails.
  const priceInAtto = usablePrice(priceIn);
  const priceNativeAtto = usablePrice(priceNative);

  const amountInUsd =
    priceInAtto === undefined
      ? undefined
      : nativeToUsdMicros(amountIn, action.tokenIn.decimals, priceInAtto, 'ceil');

  const feeNative = feeInNativeUnits(action.feeEstimate.detail);
  const feeUsd =
    priceNativeAtto === undefined
      ? undefined
      : nativeToUsdMicros(feeNative, nativeToken.decimals, priceNativeAtto, 'ceil');

  // --- size ----------------------------------------------------------------
  // LP kinds are sized by lp.capital instead; the LP-token approval ahead of
  // a removal only enables burning the wallet's own LP tokens.
  const maxTrade = usdToMicros(policy.maxAmountPerTradeUsd);
  if (isExit || isLp || isLpApprove) {
    ctx.skip('size.amountInUsd', 'SIZE_EXCEEDS_MAX_TRADE', 'not-applicable');
  } else {
    ctx.check({
      name: 'size.amountInUsd',
      code: 'SIZE_EXCEEDS_MAX_TRADE',
      passed: amountInUsd !== undefined && amountInUsd <= maxTrade,
      observed: amountInUsd === undefined ? NOT_EVALUATED : microsToUsd(amountInUsd),
      limit: microsToUsd(maxTrade),
    });
  }

  // --- daily loss ----------------------------------------------------------
  const dailyLoss = computeDailyLoss(input);
  const worstCase = isLp
    ? isLpEntry
      ? lpEntryCapital !== undefined && feeUsd !== undefined
        ? feeUsd + bpsOf(lpEntryCapital, policy.lp.maxRebalanceSlippageBps)
        : undefined
      : feeUsd
    : amountInUsd !== undefined && feeUsd !== undefined
      ? isApprove
        ? feeUsd
        : feeUsd + bpsOf(amountInUsd, policy.maxSlippageBps)
      : undefined;
  const maxDailyLoss = usdToMicros(policy.maxDailyLossUsd);
  const projectedLoss = worstCase === undefined ? undefined : dailyLoss + worstCase;

  if (isExit || isLpExit) {
    ctx.skip('loss.daily', 'DAILY_LOSS_BREACHED', 'not-applicable');
  } else {
    ctx.check({
      name: 'loss.daily',
      code: 'DAILY_LOSS_BREACHED',
      passed: projectedLoss !== undefined && projectedLoss <= maxDailyLoss,
      observed: projectedLoss === undefined ? NOT_EVALUATED : microsToUsd(projectedLoss),
      limit: microsToUsd(maxDailyLoss),
      detail: `today ${microsToUsd(dailyLoss)} plus worst case ${
        worstCase === undefined ? NOT_EVALUATED : microsToUsd(worstCase)
      }`,
    });
  }

  // --- total deployed ------------------------------------------------------
  // Trading capital comes from the ledger; LP capital from the LP snapshot
  // (absent on a swap built by the trading pipeline, so nothing changes there).
  const deployed = usdToMicros(state.ledger.deployedUsd);
  const lpDeployed = snapshot.lp === undefined ? 0n : usdToMicros(snapshot.lp.deployedUsd);
  const maxDeployed = usdToMicros(policy.maxTotalDeployedUsd);
  const projectedDeployed = isLp
    ? isLpEntry && lpEntryCapital !== undefined
      ? deployed + lpDeployed + lpEntryCapital
      : undefined
    : amountInUsd === undefined
      ? undefined
      : deployed + lpDeployed + amountInUsd;

  if (isExit || isApprove || isLpExit || isLpClaim) {
    ctx.skip('deployed.total', 'TOTAL_DEPLOYED_BREACHED', 'not-applicable');
  } else {
    ctx.check({
      name: 'deployed.total',
      code: 'TOTAL_DEPLOYED_BREACHED',
      passed: projectedDeployed !== undefined && projectedDeployed <= maxDeployed,
      observed: projectedDeployed === undefined ? NOT_EVALUATED : microsToUsd(projectedDeployed),
      limit: microsToUsd(maxDeployed),
      ...(isLp
        ? {
            detail: `trading ${microsToUsd(deployed)} plus LP ${microsToUsd(lpDeployed)} plus new ${
              lpEntryCapital === undefined ? NOT_EVALUATED : microsToUsd(lpEntryCapital)
            }`,
          }
        : {}),
    });
  }

  // --- execution quality ---------------------------------------------------
  // LP quotes are LP tokens or pool assets, not a swap output; their slippage
  // is judged by lp.rebalanceSlippage against the LP-specific limit.
  let impliedBps = 0n;
  if (isApprove || !action.quote || isLp) {
    ctx.skip('slippage.implied', 'SLIPPAGE_EXCEEDS_MAX', 'not-applicable');
    ctx.skip('slippage.priceImpact', 'SLIPPAGE_EXCEEDS_MAX', 'not-applicable');
  } else {
    const expectedOut = amountToBigint(action.quote.expectedAmountOut);
    const minOut = amountToBigint(action.quote.minAmountOut);
    impliedBps = maxBigint(
      BigInt(action.quote.slippageBps),
      expectedOut > 0n && minOut <= expectedOut ? impliedSlippageBps(expectedOut, minOut) : 0n,
    );
    ctx.check({
      name: 'slippage.implied',
      code: 'SLIPPAGE_EXCEEDS_MAX',
      passed: impliedBps <= BigInt(policy.maxSlippageBps),
      observed: impliedBps.toString(),
      limit: String(policy.maxSlippageBps),
    });
    ctx.check({
      name: 'slippage.priceImpact',
      code: 'SLIPPAGE_EXCEEDS_MAX',
      passed: action.quote.priceImpactBps <= policy.maxPriceImpactBps,
      observed: String(action.quote.priceImpactBps),
      limit: String(policy.maxPriceImpactBps),
    });
  }

  const maxFee = usdToMicros(policy.maxTransactionFeeUsd);
  ctx.check({
    name: 'fee.usd',
    code: 'FEE_EXCEEDS_MAX',
    passed: feeUsd !== undefined && feeUsd <= maxFee,
    observed: feeUsd === undefined ? NOT_EVALUATED : microsToUsd(feeUsd),
    limit: microsToUsd(maxFee),
  });

  // --- liquidity -----------------------------------------------------------
  const minLiquidity = usdToMicros(policy.minLiquidityUsd);
  if (isApprove || !action.quote || isLp) {
    ctx.skip('liquidity.market', 'LIQUIDITY_BELOW_MIN', 'not-applicable');
  } else {
    const observed = liquidity ? usdToMicros(liquidity.value) : undefined;
    ctx.check({
      name: 'liquidity.market',
      code: 'LIQUIDITY_BELOW_MIN',
      passed: observed !== undefined && observed >= minLiquidity,
      observed: observed === undefined ? 'missing' : microsToUsd(observed),
      limit: microsToUsd(minLiquidity),
    });
  }

  // --- pacing --------------------------------------------------------------
  const key = marketKey(chain, action.tokenIn.address, action.tokenOut.address);
  const lastMarketAction = state.cooldowns[key];

  if (isExit || isApprove || isLpExit) {
    ctx.skip('cooldown.market', 'COOLDOWN_ACTIVE', 'not-applicable');
  } else {
    const elapsedMs =
      lastMarketAction === undefined ? Number.MAX_SAFE_INTEGER : now - lastMarketAction;
    ctx.check({
      name: 'cooldown.market',
      code: 'COOLDOWN_ACTIVE',
      passed: elapsedMs >= policy.cooldownSeconds * 1_000,
      observed: lastMarketAction === undefined ? 'never' : String(Math.floor(elapsedMs / 1_000)),
      limit: String(policy.cooldownSeconds),
    });
  }

  // The LP-token approval exists only to enable the removal that follows it;
  // pacing it would trap the exit it belongs to.
  if (isExit || isLpExit || isLpApprove) {
    ctx.skip('cooldown.global', 'COOLDOWN_ACTIVE', 'not-applicable');
  } else {
    const elapsedMs =
      state.lastAnyActionAt === null ? Number.MAX_SAFE_INTEGER : now - state.lastAnyActionAt;
    ctx.check({
      name: 'cooldown.global',
      code: 'COOLDOWN_ACTIVE',
      passed: elapsedMs >= policy.globalMinIntervalSeconds * 1_000,
      observed: state.lastAnyActionAt === null ? 'never' : String(Math.floor(elapsedMs / 1_000)),
      limit: String(policy.globalMinIntervalSeconds),
    });
  }

  // --- balances ------------------------------------------------------------
  const tokenInIsNative = isNativeToken(chain, action.tokenIn.address);

  if (isApprove || isLpExit || isLpClaim) {
    ctx.skip('balance.tokenIn', 'BALANCE_INSUFFICIENT', 'not-applicable');
  } else {
    const held = balanceIn ? amountToBigint(balanceIn.value) : undefined;
    const needed = tokenInIsNative ? amountIn + feeNative : amountIn;
    ctx.check({
      name: 'balance.tokenIn',
      code: 'BALANCE_INSUFFICIENT',
      passed: held !== undefined && held >= needed,
      observed: held === undefined ? 'missing' : held.toString(),
      limit: needed.toString(),
      ...(tokenInIsNative ? { detail: 'native trade must also cover the fee' } : {}),
    });
  }

  const nativeHeld = balanceNative ? amountToBigint(balanceNative.value) : undefined;
  ctx.check({
    name: 'balance.gas',
    code: 'BALANCE_INSUFFICIENT',
    passed: nativeHeld !== undefined && nativeHeld >= feeNative,
    observed: nativeHeld === undefined ? 'missing' : nativeHeld.toString(),
    limit: feeNative.toString(),
  });

  // --- LP-specific checks (Phase 4) ----------------------------------------
  if (isLp && lp !== undefined && poolKey !== undefined) {
    runLpChecks(ctx, {
      lp,
      poolKey,
      isLpEntry,
      isLpExit,
      isLpClaim,
      liquidity,
      feeUsd,
      priceIn: usablePrice(priceIn),
      priceOut: usablePrice(priceOut),
    });
  }

  return {
    amountInUsd: amountInUsd === undefined ? NOT_EVALUATED : microsToUsd(amountInUsd),
    feeUsd: feeUsd === undefined ? NOT_EVALUATED : microsToUsd(feeUsd),
    impliedSlippageBps: Number(impliedBps),
    dailyLossUsd: microsToUsd(dailyLoss),
    projectedDeployedUsd:
      projectedDeployed === undefined ? NOT_EVALUATED : microsToUsd(projectedDeployed),
  };
}

interface LpCheckContext {
  lp: NonNullable<ProposedAction['lp']>;
  poolKey: string;
  isLpEntry: boolean;
  isLpExit: boolean;
  isLpClaim: boolean;
  liquidity: Stamped<string> | undefined;
  feeUsd: bigint | undefined;
  priceIn: bigint | undefined;
  priceOut: bigint | undefined;
}

/**
 * The LP checks that follow the shared ones (spec section 12).
 *
 * Every USD figure is recomputed from base-unit amounts and snapshot prices;
 * `lp.capitalUsd` and `lp.claimableFeesUsd` on the proposal are hints the
 * engine does not read. Checks that do not apply to the kind are emitted as
 * not-applicable so the dashboard sees the whole list every time.
 */
function runLpChecks(ctx: EvaluationContext, c: LpCheckContext): void {
  const { input } = ctx;
  const { action, policy, state, snapshot, now } = input;
  const { lp, poolKey, isLpEntry, isLpExit, isLpClaim } = c;
  const chain = action.chain;

  // Exits and claims act on a position the ledger must know about, in the
  // same spirit as position.reduceOnly for a swap.
  if (isLpExit || isLpClaim) {
    const held = snapshot.lp?.positions[poolKey];
    const heldTokens = held ? amountToBigint(held.lpTokens) : 0n;
    const wanted = isLpExit ? amountToBigint(lp.lpTokens ?? '0') : 0n;
    const passed = isLpExit ? heldTokens > 0n && wanted <= heldTokens : heldTokens > 0n;
    ctx.check({
      name: 'lp.position',
      code: 'REDUCE_ONLY_MISMATCH',
      passed,
      observed: isLpExit ? wanted.toString() : heldTokens.toString(),
      limit: heldTokens.toString(),
      ...(heldTokens === 0n ? { detail: 'no open LP position in this pool' } : {}),
    });
  } else {
    ctx.skip('lp.position', 'REDUCE_ONLY_MISMATCH', 'not-applicable');
  }

  const minPoolLiquidity = usdToMicros(policy.lp.minPoolLiquidityUsd);
  if (isLpEntry) {
    const observed = c.liquidity ? usdToMicros(c.liquidity.value) : undefined;
    ctx.check({
      name: 'lp.poolLiquidity',
      code: 'POOL_LIQUIDITY_BELOW_MIN',
      passed: observed !== undefined && observed >= minPoolLiquidity,
      observed: observed === undefined ? 'missing' : microsToUsd(observed),
      limit: microsToUsd(minPoolLiquidity),
    });
  } else {
    ctx.skip('lp.poolLiquidity', 'POOL_LIQUIDITY_BELOW_MIN', 'not-applicable');
  }

  if (action.kind === 'lp_rebalance') {
    // Whichever store reports more counts: the ledger slice or the LP
    // snapshot. Both are zero when nothing rebalanced today.
    const fromLedger = state.ledger.lpRebalancesToday[poolKey] ?? 0;
    const fromSnapshot = snapshot.lp?.rebalancesToday[poolKey] ?? 0;
    const count = Math.max(fromLedger, fromSnapshot);
    ctx.check({
      name: 'lp.rebalanceCount',
      code: 'REBALANCE_LIMIT_REACHED',
      passed: count < policy.lp.maxRebalancePerDay,
      observed: String(count),
      limit: String(policy.lp.maxRebalancePerDay),
    });
  } else {
    ctx.skip('lp.rebalanceCount', 'REBALANCE_LIMIT_REACHED', 'not-applicable');
  }

  if (action.quote && !isLpClaim) {
    const expectedOut = amountToBigint(action.quote.expectedAmountOut);
    const minOut = amountToBigint(action.quote.minAmountOut);
    const implied = maxBigint(
      BigInt(action.quote.slippageBps),
      expectedOut > 0n && minOut <= expectedOut ? impliedSlippageBps(expectedOut, minOut) : 0n,
    );
    ctx.check({
      name: 'lp.rebalanceSlippage',
      code: 'SLIPPAGE_EXCEEDS_MAX',
      passed: implied <= BigInt(policy.lp.maxRebalanceSlippageBps),
      observed: implied.toString(),
      limit: String(policy.lp.maxRebalanceSlippageBps),
    });
  } else {
    ctx.skip('lp.rebalanceSlippage', 'SLIPPAGE_EXCEEDS_MAX', 'not-applicable');
  }

  const maxLpGas = usdToMicros(policy.lp.maxLpGasUsd);
  ctx.check({
    name: 'lp.gas',
    code: 'FEE_EXCEEDS_MAX',
    passed: c.feeUsd !== undefined && c.feeUsd <= maxLpGas,
    observed: c.feeUsd === undefined ? NOT_EVALUATED : microsToUsd(c.feeUsd),
    limit: microsToUsd(maxLpGas),
  });

  if (isLpClaim) {
    // Claimable fees valued at the snapshot prices, rounded down: a claim
    // that only just clears the threshold is treated as not clearing it.
    const claimable = lp.claimable;
    const value =
      claimable !== undefined && c.priceIn !== undefined && c.priceOut !== undefined
        ? nativeToUsdMicros(
            amountToBigint(claimable.amountA),
            action.tokenIn.decimals,
            c.priceIn,
            'floor',
          ) +
          nativeToUsdMicros(
            amountToBigint(claimable.amountB),
            action.tokenOut.decimals,
            c.priceOut,
            'floor',
          )
        : undefined;
    const threshold = usdToMicros(policy.lp.minFeeThresholdUsd);
    ctx.check({
      name: 'lp.claimThreshold',
      code: 'FEE_BELOW_CLAIM_THRESHOLD',
      passed: value !== undefined && value >= threshold,
      observed: value === undefined ? NOT_EVALUATED : microsToUsd(value),
      limit: microsToUsd(threshold),
    });
  } else {
    ctx.skip('lp.claimThreshold', 'FEE_BELOW_CLAIM_THRESHOLD', 'not-applicable');
  }

  // An entry spends the second pool asset too, so it gets the same freshness
  // and sufficiency treatment as tokenIn.
  if (isLpEntry && lp.amountB !== undefined) {
    const balanceB = snapshot.balances[balanceKey(chain, action.tokenOut.address)];
    ctx.check(
      freshnessCheck(
        'lp.freshness.balance.tokenB',
        balanceB,
        now,
        policy.freshness.balanceMaxAgeMs,
        policy.freshness.maxClockSkewMs,
      ),
    );
    const held = balanceB ? amountToBigint(balanceB.value) : undefined;
    const needed = amountToBigint(lp.amountB);
    ctx.check({
      name: 'lp.balance.tokenB',
      code: 'BALANCE_INSUFFICIENT',
      passed: held !== undefined && held >= needed,
      observed: held === undefined ? 'missing' : held.toString(),
      limit: needed.toString(),
    });
  } else {
    ctx.skip('lp.freshness.balance.tokenB', 'DATA_STALE', 'not-applicable');
    ctx.skip('lp.balance.tokenB', 'BALANCE_INSUFFICIENT', 'not-applicable');
  }
}

/**
 * `(chain, protocol, poolId)` must be in `lp.allowedPools` and the protocol in
 * `lp.allowedProtocols[chain]`. Pool ids are compared canonically (lowercase
 * on EVM chains) because the operator types the policy side by hand.
 */
function poolAllowlistCheck(
  policy: RiskPolicy,
  chain: ChainId,
  protocol: string,
  poolId: string,
): RiskCheck {
  const protocols = policy.lp.allowedProtocols[chain] ?? [];
  const protocolOk = protocols.includes(protocol);
  const canonicalPool = canonicalizeAddress(chain, poolId);
  const poolOk = policy.lp.allowedPools.some(
    (entry) =>
      entry.chain === chain &&
      entry.protocol === protocol &&
      canonicalizeAddress(chain, entry.poolId) === canonicalPool,
  );
  return {
    name: 'lp.pool',
    code: 'POOL_NOT_ALLOWLISTED',
    passed: protocolOk && poolOk,
    observed: `${protocol}:${poolId}`,
    limit: 'lp.allowedPools',
    ...(protocolOk
      ? poolOk
        ? {}
        : { detail: 'pool is not in lp.allowedPools' }
      : { detail: `protocol ${protocol} is not in lp.allowedProtocols[${chain}]` }),
  };
}

/** Both legs of an LP entry valued in micro-USD, each rounded up. */
function lpCapitalMicros(
  action: ProposedAction,
  amountB: string,
  priceIn: bigint | undefined,
  priceOut: bigint | undefined,
): bigint | undefined {
  if (priceIn === undefined || priceOut === undefined) return undefined;
  return (
    nativeToUsdMicros(amountToBigint(action.amountIn), action.tokenIn.decimals, priceIn, 'ceil') +
    nativeToUsdMicros(amountToBigint(amountB), action.tokenOut.decimals, priceOut, 'ceil')
  );
}

/**
 * The day's drawdown, as a positive number meaning "lost".
 *
 * Yesterday's underwater position does not count again today because its
 * day-start mark is the baseline; a position that falls further today does.
 * Gains today offset losses today, and the result is floored at zero.
 */
function computeDailyLoss(input: RiskInput): bigint {
  const { ledger } = input.state;
  const realizedLoss = -usdToMicros(ledger.realizedPnlTodayUsd);
  const unrealizedMove = input.policy.dailyLoss.includeUnrealized
    ? -(usdToMicros(ledger.unrealizedPnlUsd) - usdToMicros(ledger.unrealizedPnlAtDayStartUsd))
    : 0n;
  const total = realizedLoss + unrealizedMove;
  return total > 0n ? total : 0n;
}

/** Fee in the chain's native base units (wei or lamports). */
export function feeInNativeUnits(detail: FeeDetail): bigint {
  if (detail.family === 'evm') {
    return amountToBigint(detail.gasLimit) * amountToBigint(detail.maxFeePerGas);
  }
  const signatures = SOLANA_SIGNATURE_LAMPORTS * BigInt(detail.signatures);
  const priority = ceilDiv(
    BigInt(detail.computeUnitLimit) * amountToBigint(detail.computeUnitPriceMicroLamports),
    1_000_000n,
  );
  return signatures + priority + amountToBigint(detail.rentLamports);
}

function contractCheck(
  action: ProposedAction,
  entry: { contracts: string[]; approveSpenders: string[] } | undefined,
): RiskCheck {
  if (!entry) {
    return {
      name: 'allowlist.contract',
      code: 'CONTRACT_UNKNOWN',
      passed: false,
      observed: action.contract,
      limit: 'n/a',
      detail: 'protocol is not allowlisted, so no contract can be checked',
    };
  }

  // A fee claim is a call on the pool itself, never on the router; lp.pool
  // separately verifies that the pool is one the operator allowed.
  const allowed =
    action.kind === 'approve'
      ? entry.approveSpenders.includes(action.contract)
      : action.kind === 'lp_claim'
        ? action.lp !== undefined && action.contract === action.lp.poolId
        : entry.contracts.includes(action.contract);

  if (!allowed) {
    return {
      name: 'allowlist.contract',
      code: 'CONTRACT_UNKNOWN',
      passed: false,
      observed: action.contract,
      limit: 'n/a',
      ...(action.kind === 'approve'
        ? { detail: 'not an approved spender' }
        : action.kind === 'lp_claim'
          ? { detail: 'a claim must target the pool named in the lp leg' }
          : {}),
    };
  }

  // On Solana the top-level program set matters as much as the entry point: a
  // transaction may carry instructions the router never asked for.
  if (action.chain === 'solana') {
    const programIds = action.programIds ?? [];

    // The declared contract must actually be invoked. An empty list, or one
    // that omits the router, describes a transaction other than the one being
    // checked.
    if (!programIds.includes(action.contract)) {
      return {
        name: 'allowlist.contract',
        code: 'CONTRACT_UNKNOWN',
        passed: false,
        observed: action.contract,
        limit: 'n/a',
        detail: 'declared program is not among the transaction top-level programs',
      };
    }

    const permitted = new Set([...entry.contracts, ...SOLANA_SYSTEM_PROGRAMS]);
    const offending = programIds.find((id) => !permitted.has(id));
    if (offending) {
      return {
        name: 'allowlist.contract',
        code: 'CONTRACT_UNKNOWN',
        passed: false,
        observed: offending,
        limit: 'n/a',
        detail: 'transaction targets a program that is not allowlisted',
      };
    }
  }

  return {
    name: 'allowlist.contract',
    code: 'CONTRACT_UNKNOWN',
    passed: true,
    observed: action.contract,
    limit: 'n/a',
  };
}

/**
 * A freshness check that also refuses a zero price.
 *
 * A provider reporting "0" is saying "unknown" in the shape of a number. If
 * it were accepted, every USD-denominated limit would compare against zero and
 * pass, so a zero is treated exactly like a missing datum.
 */
function priceCheck(
  name: string,
  stamped: Stamped<string> | undefined,
  now: number,
  maxAgeMs: number,
  skewMs: number,
): RiskCheck {
  const fresh = freshnessCheck(name, stamped, now, maxAgeMs, skewMs);
  if (!fresh.passed || !stamped) return fresh;

  if (usablePrice(stamped) === undefined) {
    return {
      name,
      code: 'DATA_STALE',
      passed: false,
      observed: 'zero',
      limit: String(maxAgeMs),
      detail: 'provider reported a zero or unparseable price; treated as unknown',
    };
  }

  return fresh;
}

/** The parsed price, or undefined when it is absent, malformed or zero. */
function usablePrice(stamped: Stamped<string> | undefined): bigint | undefined {
  if (!stamped) return undefined;
  try {
    const atto = priceToAtto(stamped.value);
    return atto > 0n ? atto : undefined;
  } catch {
    return undefined;
  }
}

function freshnessCheck(
  name: string,
  stamped: Stamped<string> | undefined,
  now: number,
  maxAgeMs: number,
  skewMs: number,
): RiskCheck {
  if (!stamped) {
    return {
      name,
      code: 'DATA_STALE',
      passed: false,
      observed: 'missing',
      limit: String(maxAgeMs),
    };
  }

  const age = now - stamped.at;
  if (age < -skewMs) {
    return {
      name,
      code: 'DATA_STALE',
      passed: false,
      observed: String(age),
      limit: String(maxAgeMs),
      detail: 'timestamp is in the future beyond the allowed clock skew',
    };
  }

  return {
    name,
    code: 'DATA_STALE',
    passed: age <= maxAgeMs,
    observed: String(age),
    limit: String(maxAgeMs),
    ...(stamped.source ? { detail: `source ${stamped.source}` } : {}),
  };
}

function decimalsMismatch(
  action: ProposedAction,
  allowlist: Array<{ address: string; decimals: number }>,
): { address: string; observed: string; expected: string } | undefined {
  for (const ref of [action.tokenIn, action.tokenOut]) {
    const entry = allowlist.find((token) => token.address === ref.address);
    if (entry && entry.decimals !== ref.decimals) {
      return {
        address: ref.address,
        observed: String(ref.decimals),
        expected: String(entry.decimals),
      };
    }
  }
  return undefined;
}

function nativeTokenRef(chain: ChainId): { address: string; decimals: number } {
  const native = chain === 'solana' ? 9 : 18;
  return {
    address:
      chain === 'solana'
        ? 'So11111111111111111111111111111111111111112'
        : '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    decimals: native,
  };
}

function checksFailed(checks: RiskCheck[]): boolean {
  return checks.some((check) => !check.passed && check.skipped === undefined);
}

/**
 * The idempotency key for an intent.
 *
 * Derived from what the action *does*, not from when it was proposed, so a
 * retry inside the same decision cycle collapses onto the same key and cannot
 * execute twice.
 */
export function deriveIdempotencyKey(action: ProposedAction): string {
  const parts = [
    'atra-action-v1',
    action.decisionCycleId,
    action.chain,
    action.kind,
    action.protocol,
    action.tokenIn.address,
    action.tokenOut.address,
    action.amountIn,
    action.reduceOnly ? 'true' : 'false',
  ];
  return createHash('sha256').update(parts.join('|')).digest('hex');
}

class EvaluationContext {
  readonly input: RiskInput;
  readonly checks: RiskCheck[];

  constructor(input: RiskInput, checks: RiskCheck[]) {
    this.input = input;
    this.checks = checks;
  }

  check(check: RiskCheck): void {
    this.checks.push(check);
  }

  skip(name: string, code: RejectionCode, reason: 'not-applicable' | 'short-circuit'): void {
    this.checks.push({
      name,
      code,
      passed: reason === 'not-applicable',
      observed: reason === 'not-applicable' ? 'n/a' : NOT_EVALUATED,
      limit: 'n/a',
      skipped: reason,
    });
  }

  finish(derived: RiskDerived | null): RiskDecision {
    const firstFailure = this.checks.find((check) => !check.passed && check.skipped === undefined);

    return {
      schemaVersion: 1,
      engineVersion: ENGINE_VERSION,
      actionId: this.input.action.actionId,
      idempotencyKey: this.input.action.idempotencyKey,
      mode: this.input.state.mode,
      evaluatedAt: this.input.now,
      policyHash: this.input.policyHash,
      allowed: firstFailure === undefined,
      code: firstFailure?.code ?? 'OK',
      reason: firstFailure
        ? `${firstFailure.name}: observed ${firstFailure.observed} vs limit ${firstFailure.limit}`
        : 'all checks passed',
      checks: this.checks,
      derived,
    };
  }
}
