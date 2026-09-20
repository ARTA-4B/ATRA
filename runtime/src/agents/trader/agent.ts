import { isStablecoin } from '../../chains/registry.js';
import { z } from 'zod';
import type { ChainId } from '../../chains/registry.js';
import { CHAIN_IDS, CHAINS } from '../../chains/registry.js';
import type { LlmProvider } from '../../llm/provider.js';
import type { ResearchResult } from '../research/agent.js';
import type { RiskPolicy } from '../../risk/policy.js';
import type { PortfolioMark } from '../../trading/ledger.js';
import { childLogger } from '../../logging/logger.js';
import { errorMessage } from '../../util/errors.js';

/**
 * The Trader Agent.
 *
 * Reads a research report, the portfolio and the policy limits, and proposes
 * one of five things: `NO_ACTION`, `OPEN`, `REDUCE`, `CLOSE` or `SWAP`. That
 * proposal is the *only* thing it produces. It does not size the transaction
 * in base units, does not choose a route, does not see a key, and cannot make
 * the risk engine accept anything.
 *
 * The output is schema-validated. A reply that does not parse is a
 * `NO_ACTION` with the parse failure as its reason — never a best-effort
 * interpretation of what the model probably meant.
 *
 * `NO_ACTION` is the expected answer most of the time. The system prompt says
 * so, the training data says so, and the evaluation suite scores the model on
 * refusing correctly. An agent that trades whenever asked is not useful.
 */

export const TRADE_ACTIONS = ['NO_ACTION', 'OPEN', 'REDUCE', 'CLOSE', 'SWAP'] as const;
export type TradeAction = (typeof TRADE_ACTIONS)[number];

export const tradeDecisionSchema = z.object({
  action: z.enum(TRADE_ACTIONS),
  chain: z.enum(CHAIN_IDS),
  /** The pool or pair the decision is about. */
  market: z.string().min(1).max(128),
  reason: z.string().min(1).max(600),
  confidence: z.number().min(0).max(1),
  /** USD notional the model wants to commit. "0" for NO_ACTION. */
  requestedNotionalUsd: z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/),
  /** Fact keys from the research result the decision rests on. */
  evidence: z.array(z.string().min(1).max(64)).max(12),
  /** For OPEN/SWAP: which allowlisted token to buy. For REDUCE/CLOSE: which to sell. */
  token: z.string().min(1).max(64).nullable(),
});

export type TradeDecision = z.infer<typeof tradeDecisionSchema>;

export interface TraderInput {
  chain: ChainId;
  research: ResearchResult;
  portfolio: PortfolioMark;
  policy: RiskPolicy;
  /** Tokens the operator has allowlisted on this chain, with symbols. */
  allowlist: Array<{ address: string; symbol: string; decimals: number }>;
  /** What the runtime can actually execute on this chain. */
  executable: boolean;
  executableReason: string;
}

export interface TraderOutput {
  decision: TradeDecision;
  model: string;
  modelStatus: 'UNTRAINED' | 'UNAVAILABLE';
  latencyMs: number;
  /** True when the decision was produced by the fallback rather than a model. */
  fallback: boolean;
}

const SYSTEM_PROMPT = `You are ATRA's trading decision layer.

You are given a research report on one market, the current portfolio, and the
operator's hard limits. You propose exactly one action. Deterministic code then
decides whether it is allowed; you cannot influence that decision, and a
confident tone does not help.

Rules:
- NO_ACTION is the normal answer. Choose it whenever data is stale, missing,
  disputed, the market is thin, the token is not allowlisted, an exposure limit
  is close, or you are not sure. Explain which condition applied.
- Never state a number that does not appear in the report or the portfolio.
- requestedNotionalUsd must not exceed the per-trade limit you are shown, and
  must be "0" for NO_ACTION.
- REDUCE and CLOSE apply only to a position that exists in the portfolio.
- OPEN and SWAP name a token from the allowlist you are shown, by address.
- Reply only with JSON matching the schema.`;

export class TraderAgent {
  readonly #llm: LlmProvider;
  readonly #log = childLogger('trader');

  constructor(llm: LlmProvider) {
    this.#llm = llm;
  }

  async decide(input: TraderInput): Promise<TraderOutput> {
    const started = Date.now();

    // Nothing to decide on: the research already said the data is not there.
    if (input.research.status !== 'OK') {
      return this.#noAction(input, `research returned ${input.research.status}`, started, true);
    }

    if (!input.executable) {
      return this.#noAction(input, `no execution path: ${input.executableReason}`, started, true);
    }

    const availability = await this.#llm.available();
    if (!availability.available) {
      return this.#noAction(input, `no reasoning model: ${availability.detail}`, started, true);
    }

    try {
      const response = await this.#llm.chat(
        {
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: renderInput(input) }],
          responseSchema: jsonSchema(),
          temperature: 0.1,
        },
        tradeDecisionSchema,
      );

      const decision = response.data;
      const violation = deterministicSanity(decision, input);
      if (violation) {
        // The model produced something well-formed but off-policy. That is
        // recorded as its decision being overridden to NO_ACTION, which the
        // evaluation suite counts against it.
        this.#log.warn({ violation, action: decision.action }, 'trader decision overridden');
        return {
          decision: {
            ...decision,
            action: 'NO_ACTION',
            requestedNotionalUsd: '0',
            reason: `overridden: ${violation} (model said: ${decision.reason.slice(0, 200)})`,
          },
          model: response.model,
          modelStatus: 'UNTRAINED',
          latencyMs: Date.now() - started,
          fallback: false,
        };
      }

      return {
        decision,
        model: response.model,
        modelStatus: 'UNTRAINED',
        latencyMs: Date.now() - started,
        fallback: false,
      };
    } catch (error) {
      return this.#noAction(input, `model output rejected: ${errorMessage(error)}`, started, true);
    }
  }

  #noAction(input: TraderInput, reason: string, started: number, fallback: boolean): TraderOutput {
    return {
      decision: {
        action: 'NO_ACTION',
        chain: input.chain,
        market: input.research.poolId ?? input.research.token ?? 'unknown',
        reason,
        confidence: 0.9,
        requestedNotionalUsd: '0',
        evidence: [],
        token: null,
      },
      model: this.#llm.model,
      modelStatus: 'UNAVAILABLE',
      latencyMs: Date.now() - started,
      fallback,
    };
  }
}

/**
 * Cheap, deterministic checks on a well-formed decision.
 *
 * These are not the risk engine — that runs later on the fully built
 * proposal. They catch the model contradicting the input it was given, which
 * is worth recording as a model failure rather than letting it turn into a
 * rejected proposal that looks like a market condition.
 */
function deterministicSanity(decision: TradeDecision, input: TraderInput): string | null {
  if (decision.chain !== input.chain) {
    return `decision names chain ${decision.chain}, input was ${input.chain}`;
  }

  if (decision.action === 'NO_ACTION') {
    return decision.requestedNotionalUsd === '0' ? null : 'NO_ACTION with a non-zero notional';
  }

  if (decision.requestedNotionalUsd === '0') {
    return `${decision.action} with a zero notional`;
  }

  if (!decision.token) {
    return `${decision.action} without a token`;
  }

  const listed = input.allowlist.some((entry) => entry.address === decision.token);
  if (!listed) {
    return `token ${decision.token} is not allowlisted`;
  }

  if (decision.action === 'REDUCE' || decision.action === 'CLOSE') {
    const held = input.portfolio.positions.some(
      (position) => position.chain === input.chain && position.token === decision.token,
    );
    if (!held) return `${decision.action} of a token with no open position`;
    // The funding stablecoin is booked as a position after any exit; selling
    // it "back" would be a stable-to-stable swap dressed as an exit.
    if (isStablecoin(input.chain, decision.token)) {
      return `${decision.action} of a stablecoin is not an exit`;
    }
  }

  // Compare as micro-USD strings without floats.
  const [reqWhole = '0', reqFrac = ''] = decision.requestedNotionalUsd.split('.');
  const [maxWhole = '0', maxFrac = ''] = input.policy.maxAmountPerTradeUsd.split('.');
  const requested = BigInt(reqWhole) * 1_000_000n + BigInt(reqFrac.padEnd(6, '0') || '0');
  const maximum = BigInt(maxWhole) * 1_000_000n + BigInt(maxFrac.padEnd(6, '0') || '0');
  if (requested > maximum) {
    return `requested ${decision.requestedNotionalUsd} USD exceeds the per-trade limit ${input.policy.maxAmountPerTradeUsd}`;
  }

  return null;
}

function renderInput(input: TraderInput): string {
  const lines: string[] = [
    `Chain: ${input.chain} (${CHAINS[input.chain].displayName})`,
    `Mode: proposals are evaluated by a deterministic risk engine after you answer.`,
    '',
    'LIMITS:',
    `- max per trade: ${input.policy.maxAmountPerTradeUsd} USD`,
    `- max daily loss: ${input.policy.maxDailyLossUsd} USD`,
    `- max total deployed: ${input.policy.maxTotalDeployedUsd} USD`,
    `- min pool liquidity: ${input.policy.minLiquidityUsd} USD`,
    `- max slippage: ${input.policy.maxSlippageBps} bps`,
    '',
    'ALLOWLISTED TOKENS (address = symbol):',
    ...input.allowlist.map((entry) => `- ${entry.address} = ${entry.symbol}`),
    '',
    'PORTFOLIO:',
    `- deployed: ${input.portfolio.deployedUsd} USD`,
    `- realized today: ${input.portfolio.realizedPnlTodayUsd} USD`,
    `- unrealized: ${input.portfolio.unrealizedPnlUsd ?? 'unknown (a position is unpriced)'} USD`,
    ...(input.portfolio.positions.length === 0
      ? ['- no open positions']
      : input.portfolio.positions.map(
          (position) =>
            `- ${position.chain} ${position.token}: ${position.amount} units, cost ${position.costBasisUsd} USD, mark ${position.markUsd ?? 'unknown'} USD`,
        )),
    '',
    `RESEARCH (status ${input.research.status}, model ${input.research.modelStatus}):`,
    ...input.research.facts.map(
      (fact) =>
        `- ${fact.key} = ${fact.value} (${fact.source}, ${String(Math.round(fact.ageMs / 1000))}s old${fact.stale ? ', STALE' : ''})`,
    ),
    ...(input.research.staleInputs.length > 0
      ? ['', 'UNRELIABLE INPUTS:', ...input.research.staleInputs.map((line) => `- ${line}`)]
      : []),
    ...(input.research.interpretation.length > 0
      ? [
          '',
          'INTERPRETATION (opinion, not fact):',
          ...input.research.interpretation.map((line) => `- ${line}`),
        ]
      : []),
    '',
    'Decide. Reply with JSON only.',
  ];

  return lines.join('\n');
}

function jsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'action',
      'chain',
      'market',
      'reason',
      'confidence',
      'requestedNotionalUsd',
      'evidence',
      'token',
    ],
    properties: {
      action: { type: 'string', enum: [...TRADE_ACTIONS] },
      chain: { type: 'string', enum: [...CHAIN_IDS] },
      market: { type: 'string', maxLength: 128 },
      reason: { type: 'string', maxLength: 600 },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
      requestedNotionalUsd: { type: 'string', pattern: '^(0|[1-9]\\d*)(\\.\\d{1,6})?$' },
      evidence: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 64 } },
      token: { type: ['string', 'null'], maxLength: 64 },
    },
  };
}
