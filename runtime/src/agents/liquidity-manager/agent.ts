import { z } from 'zod';
import type { ChainId } from '../../chains/registry.js';
import { CHAIN_IDS, CHAINS } from '../../chains/registry.js';
import type { LlmProvider } from '../../llm/provider.js';
import type { RiskPolicy } from '../../risk/policy.js';
import { usdToMicros } from '../../risk/money.js';
import { LP_AGENT_ACTIONS } from '../../liquidity/types.js';
import type { LpAgentAction, LpPoolState, LpPositionState } from '../../liquidity/types.js';
import { childLogger } from '../../logging/logger.js';
import { errorMessage } from '../../util/errors.js';

/**
 * The Liquidity Manager Agent.
 *
 * Reads one pool, the wallet's position in it, the cross-checked prices and
 * the operator's LP limits, and proposes exactly one of six things: `HOLD`,
 * `ADD_LIQUIDITY`, `REMOVE_LIQUIDITY`, `REBALANCE`, `COLLECT_FEES` or
 * `EXIT`. That proposal is the only thing it produces. It does not size in
 * base units, does not build a transaction, does not see a key, and cannot
 * make the risk engine accept anything.
 *
 * `HOLD` is the expected answer most of the time and the answer to every
 * failure: an unavailable model, a reply that does not parse, or a reply
 * that contradicts its input. The last case is recorded as a model failure,
 * not as a market condition, because the evaluation suite scores it.
 *
 * `REBALANCE` is not applicable to a v2 pool: there is no price range to
 * move. The agent is told so and a `REBALANCE` on a v2 pool is overridden to
 * `HOLD`. The action exists so a future concentrated-liquidity adapter and the
 * engine's `lp.rebalanceCount` check have something to speak about.
 */

export const lpDecisionSchema = z.object({
  action: z.enum(LP_AGENT_ACTIONS),
  chain: z.enum(CHAIN_IDS),
  poolId: z.string().min(1).max(128),
  /** USD to commit for ADD_LIQUIDITY. "0" for every other action. */
  capitalUsd: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
  reason: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
  /** Keys of the input facts the decision rests on. */
  evidence: z.array(z.string().min(1).max(64)).max(12),
});

export type LpDecision = z.infer<typeof lpDecisionSchema>;

export interface LpEligibility {
  poolAllowlisted: boolean;
  protocolAllowlisted: boolean;
  rebalancesToday: number;
  maxRebalancePerDay: number;
  /** Claimable fees valued in USD, or null when unknown. */
  claimableFeesUsd: string | null;
  minFeeThresholdUsd: string;
  /** Whether the pool has a range that can be rebalanced. False on v2. */
  rangeApplicable: boolean;
  /** Whether fee accrual is being simulated (PAPER) or read from the chain. */
  feesSimulated: boolean;
}

export interface LpAgentInput {
  chain: ChainId;
  pool: LpPoolState;
  /** Null when the wallet holds nothing in this pool. */
  position: (LpPositionState & { capitalUsd: string | null; valueUsd: string | null }) | null;
  prices: { token0Usd: string | null; token1Usd: string | null; nativeUsd: string | null };
  poolLiquidityUsd: string | null;
  policy: RiskPolicy;
  eligibility: LpEligibility;
  executable: boolean;
  executableReason: string;
  mode: 'PAPER' | 'LIVE';
}

export interface LpAgentOutput {
  decision: LpDecision;
  model: string;
  modelStatus: 'UNTRAINED' | 'UNAVAILABLE';
  latencyMs: number;
  /** True when the decision was produced by the fallback rather than a model. */
  fallback: boolean;
  /** Set when a well-formed decision was overridden to HOLD. */
  overridden: string | null;
}

const SYSTEM_PROMPT = `You are ATRA's liquidity management layer.

You are given one liquidity pool, the wallet's position in it, cross-checked
prices and the operator's hard limits. You propose exactly one action.
Deterministic code then sizes, quotes and checks it; you cannot influence that
decision, and a confident tone does not help.

Rules:
- HOLD is the normal answer. Choose it whenever data is missing, the pool is
  not allowlisted, the pool is thin, a limit is close, fees are below the
  claim threshold, or you are not sure. Explain which condition applied.
- Never state a number that does not appear in the input.
- capitalUsd is the USD to commit for ADD_LIQUIDITY and must not exceed the
  per-position cap you are shown; it must be "0" for every other action.
- REMOVE_LIQUIDITY and EXIT apply only when a position exists. EXIT removes
  all of it; REMOVE_LIQUIDITY removes half.
- COLLECT_FEES applies only when the pool reports claimable fees at or above
  the threshold you are shown.
- REBALANCE applies only to a pool with a price range. A v2 pool has none.
- Reply only with JSON matching the schema.`;

export class LiquidityManagerAgent {
  readonly #llm: LlmProvider;
  readonly #log = childLogger('liquidity-manager');

  constructor(llm: LlmProvider) {
    this.#llm = llm;
  }

  async decide(input: LpAgentInput): Promise<LpAgentOutput> {
    const started = Date.now();

    if (!input.executable) {
      return this.#hold(input, `no LP adapter: ${input.executableReason}`, started, true);
    }

    const availability = await this.#llm.available();
    if (!availability.available) {
      return this.#hold(input, `no reasoning model: ${availability.detail}`, started, true);
    }

    try {
      const response = await this.#llm.chat(
        {
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: renderInput(input) }],
          responseSchema: jsonSchema(),
          temperature: 0.1,
        },
        lpDecisionSchema,
      );

      const decision = response.data;
      const violation = deterministicSanity(decision, input);
      if (violation) {
        this.#log.warn({ violation, action: decision.action }, 'lp decision overridden');
        return {
          decision: {
            ...decision,
            action: 'HOLD',
            capitalUsd: '0',
            reason: `overridden: ${violation} (model said: ${decision.reason.slice(0, 200)})`,
          },
          model: response.model,
          modelStatus: 'UNTRAINED',
          latencyMs: Date.now() - started,
          fallback: false,
          overridden: violation,
        };
      }

      return {
        decision,
        model: response.model,
        modelStatus: 'UNTRAINED',
        latencyMs: Date.now() - started,
        fallback: false,
        overridden: null,
      };
    } catch (error) {
      return this.#hold(input, `model output rejected: ${errorMessage(error)}`, started, true);
    }
  }

  #hold(input: LpAgentInput, reason: string, started: number, fallback: boolean): LpAgentOutput {
    return {
      decision: {
        action: 'HOLD',
        chain: input.chain,
        poolId: input.pool.poolId,
        capitalUsd: '0',
        reason,
        confidence: 0.9,
        evidence: [],
      },
      model: this.#llm.model,
      modelStatus: 'UNAVAILABLE',
      latencyMs: Date.now() - started,
      fallback,
      overridden: null,
    };
  }
}

/**
 * Cheap, deterministic checks on a well-formed decision.
 *
 * Not the risk engine — that runs later on the fully built proposal. These
 * catch the model contradicting the input it was given.
 */
export function deterministicSanity(decision: LpDecision, input: LpAgentInput): string | null {
  if (decision.chain !== input.chain) {
    return `decision names chain ${decision.chain}, input was ${input.chain}`;
  }
  if (decision.poolId.toLowerCase() !== input.pool.poolId.toLowerCase()) {
    return `decision names pool ${decision.poolId}, input was ${input.pool.poolId}`;
  }

  const action: LpAgentAction = decision.action;
  if (action === 'HOLD') {
    return decision.capitalUsd === '0' ? null : 'HOLD with a non-zero capital';
  }

  if (!input.eligibility.poolAllowlisted || !input.eligibility.protocolAllowlisted) {
    return `${action} on a pool that is not allowlisted`;
  }

  const hasPosition = input.position !== null && BigInt(input.position.lpTokens) > 0n;

  if (action === 'ADD_LIQUIDITY') {
    if (decision.capitalUsd === '0') return 'ADD_LIQUIDITY with zero capital';
    const requested = usdToMicros(decision.capitalUsd);
    const cap = usdToMicros(input.policy.lp.maxCapitalPerLpUsd);
    const existing = input.position?.capitalUsd ? usdToMicros(input.position.capitalUsd) : 0n;
    if (requested + existing > cap) {
      return `requested ${decision.capitalUsd} USD plus existing capital exceeds the per-position cap ${input.policy.lp.maxCapitalPerLpUsd}`;
    }
    return null;
  }

  if (decision.capitalUsd !== '0') {
    return `${action} with a non-zero capital`;
  }

  if (action === 'REMOVE_LIQUIDITY' || action === 'EXIT') {
    return hasPosition ? null : `${action} with no open position in this pool`;
  }

  if (action === 'COLLECT_FEES') {
    if (!hasPosition) return 'COLLECT_FEES with no open position in this pool';
    const claimable = input.eligibility.claimableFeesUsd;
    if (claimable === null) return 'COLLECT_FEES with unknown claimable fees';
    if (usdToMicros(claimable) < usdToMicros(input.eligibility.minFeeThresholdUsd)) {
      return `COLLECT_FEES below the claim threshold (${claimable} < ${input.eligibility.minFeeThresholdUsd} USD)`;
    }
    return null;
  }

  // REBALANCE
  if (!input.eligibility.rangeApplicable) {
    return 'REBALANCE is not applicable: a v2 pool has no price range';
  }
  if (!hasPosition) return 'REBALANCE with no open position in this pool';
  if (input.eligibility.rebalancesToday >= input.eligibility.maxRebalancePerDay) {
    return `REBALANCE limit reached (${String(input.eligibility.rebalancesToday)} of ${String(input.eligibility.maxRebalancePerDay)} today)`;
  }
  return null;
}

function renderInput(input: LpAgentInput): string {
  const { pool, position, policy, eligibility } = input;
  const lines: string[] = [
    `Chain: ${input.chain} (${CHAINS[input.chain].displayName})`,
    `Mode: ${input.mode}. Proposals are evaluated by a deterministic risk engine after you answer.`,
    '',
    'POOL:',
    `- protocol: ${pool.protocol} (${pool.kind}, ${pool.stable ? 'stable' : 'volatile'})`,
    `- pool: ${pool.poolId}`,
    `- token0: ${pool.token0.address} (${pool.token0.symbol ?? 'symbol unknown'}, ${String(pool.token0.decimals)} decimals) reserve ${pool.reserve0}`,
    `- token1: ${pool.token1.address} (${pool.token1.symbol ?? 'symbol unknown'}, ${String(pool.token1.decimals)} decimals) reserve ${pool.reserve1}`,
    `- totalSupply: ${pool.totalSupply}`,
    `- fee: ${pool.feeBps === null ? 'unknown' : `${String(pool.feeBps)} bps`}`,
    `- range: ${pool.range ? `${pool.range.lowerUsd}-${pool.range.upperUsd} (${pool.range.inRange ? 'in range' : 'out of range'})` : 'none (v2 pool, REBALANCE not applicable)'}`,
    `- liquidity: ${input.poolLiquidityUsd ?? 'unknown'} USD`,
    `- observed ${String(Math.max(0, Math.round((Date.now() - pool.observedAt) / 1000)))}s ago via ${pool.source}`,
    '',
    'PRICES (USD, cross-checked):',
    `- token0: ${input.prices.token0Usd ?? 'unknown'}`,
    `- token1: ${input.prices.token1Usd ?? 'unknown'}`,
    `- native: ${input.prices.nativeUsd ?? 'unknown'}`,
    '',
    'POSITION:',
    ...(position === null || BigInt(position.lpTokens) === 0n
      ? ['- none']
      : [
          `- lpTokens: ${position.lpTokens}`,
          `- share: ${position.amount0} token0 + ${position.amount1} token1`,
          `- cost basis: ${position.capitalUsd ?? 'unknown'} USD`,
          `- current value: ${position.valueUsd ?? 'unknown'} USD`,
          `- claimable fees: ${eligibility.claimableFeesUsd ?? 'unknown'} USD (${position.claimNote})`,
        ]),
    '',
    'LIMITS:',
    `- max capital per LP position: ${policy.lp.maxCapitalPerLpUsd} USD`,
    `- min pool liquidity: ${policy.lp.minPoolLiquidityUsd} USD`,
    `- max rebalances per day: ${String(policy.lp.maxRebalancePerDay)} (${String(eligibility.rebalancesToday)} used today)`,
    `- max slippage: ${String(policy.lp.maxRebalanceSlippageBps)} bps`,
    `- max gas per LP action: ${policy.lp.maxLpGasUsd} USD`,
    `- fee claim threshold: ${policy.lp.minFeeThresholdUsd} USD`,
    `- max total deployed: ${policy.maxTotalDeployedUsd} USD`,
    '',
    'ELIGIBILITY:',
    `- pool allowlisted: ${eligibility.poolAllowlisted ? 'yes' : 'no'}`,
    `- protocol allowlisted: ${eligibility.protocolAllowlisted ? 'yes' : 'no'}`,
    `- fees: ${eligibility.feesSimulated ? 'not simulated in PAPER (always 0)' : 'read from the chain'}`,
    '',
    'Decide. Reply with JSON only.',
  ];
  return lines.join('\n');
}

function jsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['action', 'chain', 'poolId', 'capitalUsd', 'reason', 'confidence', 'evidence'],
    properties: {
      action: { type: 'string', enum: [...LP_AGENT_ACTIONS] },
      chain: { type: 'string', enum: [...CHAIN_IDS] },
      poolId: { type: 'string', maxLength: 128 },
      capitalUsd: { type: 'string', pattern: '^(0|[1-9]\\d*)(\\.\\d{1,6})?$' },
      reason: { type: 'string', maxLength: 600 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      evidence: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 64 } },
    },
  };
}
