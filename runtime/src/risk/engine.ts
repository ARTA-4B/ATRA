import { createHash } from 'node:crypto';
import { SOLANA_SYSTEM_PROGRAMS, isNativeToken } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
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
import { proposedActionSchema } from './types.js';
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
import { balanceKey, liquidityKey, marketKey, priceKey } from './types.js';

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
    for (const name of REMAINING_CHECK_NAMES) {
      ctx.skip(name.name, name.code, 'short-circuit');
    }
  }
  return failed;
}

interface CheckName {
  name: string;
  code: RejectionCode;
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

  ctx.check({
    name: 'chain.enabled',
    code: 'CHAIN_UNSUPPORTED',
    passed: policy.enabledChains.includes(chain),
    observed: chain,
    limit: policy.enabledChains.join(','),
  });

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

  const nativeToken = nativeTokenRef(chain);
  const priceIn = snapshot.prices[priceKey(chain, action.tokenIn.address)];
  const priceOut = snapshot.prices[priceKey(chain, action.tokenOut.address)];
  const priceNative = snapshot.prices[priceKey(chain, nativeToken.address)];

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

  ctx.check(
    freshnessCheck(
      'freshness.balance.tokenIn',
      balanceIn,
      now,
      policy.freshness.balanceMaxAgeMs,
      skew,
    ),
  );
  ctx.check(
    freshnessCheck(
      'freshness.balance.native',
      balanceNative,
      now,
      policy.freshness.balanceMaxAgeMs,
      skew,
    ),
  );

  const liquidity = action.quote
    ? snapshot.liquidity[liquidityKey(chain, action.quote.marketId)]
    : undefined;

  if (isApprove || !action.quote) {
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

  ctx.check({
    name: 'allowlist.tokenIn',
    code: 'TOKEN_NOT_ALLOWLISTED',
    passed: allowedTokens.has(action.tokenIn.address),
    observed: action.tokenIn.address,
    limit: 'n/a',
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
    ctx.check({
      name: 'position.reduceOnly',
      code: 'REDUCE_ONLY_MISMATCH',
      passed: held > 0n && wanted <= held,
      observed: action.amountIn,
      limit: held.toString(),
      ...(held === 0n ? { detail: 'no open position for this token' } : {}),
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
  const maxTrade = usdToMicros(policy.maxAmountPerTradeUsd);
  if (isExit) {
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
  const worstCase =
    amountInUsd !== undefined && feeUsd !== undefined
      ? isApprove
        ? feeUsd
        : feeUsd + bpsOf(amountInUsd, policy.maxSlippageBps)
      : undefined;
  const maxDailyLoss = usdToMicros(policy.maxDailyLossUsd);
  const projectedLoss = worstCase === undefined ? undefined : dailyLoss + worstCase;

  if (isExit) {
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
  const deployed = usdToMicros(state.ledger.deployedUsd);
  const maxDeployed = usdToMicros(policy.maxTotalDeployedUsd);
  const projectedDeployed = amountInUsd === undefined ? undefined : deployed + amountInUsd;

  if (isExit || isApprove) {
    ctx.skip('deployed.total', 'TOTAL_DEPLOYED_BREACHED', 'not-applicable');
  } else {
    ctx.check({
      name: 'deployed.total',
      code: 'TOTAL_DEPLOYED_BREACHED',
      passed: projectedDeployed !== undefined && projectedDeployed <= maxDeployed,
      observed: projectedDeployed === undefined ? NOT_EVALUATED : microsToUsd(projectedDeployed),
      limit: microsToUsd(maxDeployed),
    });
  }

  // --- execution quality ---------------------------------------------------
  let impliedBps = 0n;
  if (isApprove || !action.quote) {
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
  if (isApprove || !action.quote) {
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

  if (isExit || isApprove) {
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

  if (isExit) {
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

  if (isApprove) {
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

  return {
    amountInUsd: amountInUsd === undefined ? NOT_EVALUATED : microsToUsd(amountInUsd),
    feeUsd: feeUsd === undefined ? NOT_EVALUATED : microsToUsd(feeUsd),
    impliedSlippageBps: Number(impliedBps),
    dailyLossUsd: microsToUsd(dailyLoss),
    projectedDeployedUsd:
      projectedDeployed === undefined ? NOT_EVALUATED : microsToUsd(projectedDeployed),
  };
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

  const allowed =
    action.kind === 'approve'
      ? entry.approveSpenders.includes(action.contract)
      : entry.contracts.includes(action.contract);

  if (!allowed) {
    return {
      name: 'allowlist.contract',
      code: 'CONTRACT_UNKNOWN',
      passed: false,
      observed: action.contract,
      limit: 'n/a',
      ...(action.kind === 'approve' ? { detail: 'not an approved spender' } : {}),
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
