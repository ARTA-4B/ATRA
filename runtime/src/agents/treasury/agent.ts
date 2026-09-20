import { z } from 'zod';
import type { LlmProvider } from '../../llm/provider.js';
import { usdToMicros } from '../../risk/money.js';
import { childLogger } from '../../logging/logger.js';
import { errorMessage } from '../../util/errors.js';
import type {
  BalanceReport,
  BillingMode,
  BurnRate,
  Runway,
  TreasuryAlert,
  TreasuryCaps,
} from '../../treasury/types.js';

/**
 * The Treasury Agent.
 *
 * Reads the treasury's balances, burn rate, runway, provider budgets and open
 * alerts, and writes a short review: a summary, a list of concerns, and zero
 * or more recommended actions. That review is the *only* thing it produces.
 *
 * What it cannot do, by construction rather than by instruction:
 *
 *  - it has no wallet, no ledger, no vault and no chain adapter in its
 *    dependencies. Its constructor takes a model provider and nothing else,
 *    so there is no object on which a signing or transfer method could be
 *    called even if the model asked for one;
 *  - a `PROPOSE_PAYMENT` it returns becomes, at most, a *proposal* row that a
 *    human approves and then executes elsewhere. The agent never approves,
 *    never exports and never sees the admin credential;
 *  - a recommendation that names an unknown provider, an amount over a cap,
 *    or any action while the treasury is frozen is overridden to `NO_ACTION`
 *    and recorded as a model failure. The service then applies the same caps
 *    again before writing anything.
 *
 * `NO_ACTION` is the expected answer. A treasury that is funded and within
 * budget needs nothing from a model, and a model that proposes payments to
 * look useful is exactly the failure this design guards against.
 */

export const TREASURY_ACTIONS = ['NO_ACTION', 'REVIEW_BUDGET', 'PROPOSE_PAYMENT'] as const;
export type TreasuryAction = (typeof TREASURY_ACTIONS)[number];

const usd = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/);

export const treasuryRecommendationSchema = z.object({
  action: z.enum(TREASURY_ACTIONS),
  /** The provider's name as shown in the input, or null for NO_ACTION. */
  provider: z.string().min(1).max(64).nullable(),
  /** USD amount: the payment for PROPOSE_PAYMENT, the suggested budget for REVIEW_BUDGET, "0" otherwise. */
  amountUsd: usd,
  reason: z.string().min(1).max(400),
});

export const treasuryReviewSchema = z.object({
  summary: z.string().min(1).max(800),
  concerns: z.array(z.string().min(1).max(300)).max(12),
  recommendedActions: z.array(treasuryRecommendationSchema).max(6),
  confidence: z.number().min(0).max(1),
});

export type TreasuryRecommendation = z.infer<typeof treasuryRecommendationSchema>;
export type TreasuryReview = z.infer<typeof treasuryReviewSchema>;

export interface TreasuryAgentProvider {
  id: string;
  name: string;
  category: string;
  billingMode: BillingMode;
  monthlyBudgetUsd: string;
  /** Expenses plus approved proposals for the current billing period. */
  spentThisPeriodUsd: string;
  active: boolean;
}

export interface TreasuryAgentInput {
  period: string;
  balances: BalanceReport;
  burn: BurnRate;
  runway: Runway;
  caps: TreasuryCaps;
  frozen: boolean;
  /** Approved and exported proposals decided this calendar month, USD. */
  approvedThisMonthUsd: string;
  providers: TreasuryAgentProvider[];
  pendingProposals: number;
  openAlerts: TreasuryAlert[];
}

export interface TreasuryAgentOutput {
  review: TreasuryReview;
  model: string;
  modelStatus: 'UNTRAINED' | 'UNAVAILABLE';
  latencyMs: number;
  /** True when the review came from the fallback rather than a model. */
  fallback: boolean;
  /** Set when a well-formed review was overridden to NO_ACTION, with why. */
  overridden: string | null;
}

const SYSTEM_PROMPT = `You are ATRA's treasury review layer.

You are given the project treasury's balances, its recorded infrastructure
expenses, the burn rate and runway derived from them, the providers it pays,
the spending caps, and any open alerts. You write a short review.

You cannot move money. A PROPOSE_PAYMENT you recommend becomes a proposal that
a human must approve and then execute from the treasury wallet themselves.
Deterministic code checks every recommendation against the caps; you cannot
influence that check and a confident tone does not help.

Rules:
- NO_ACTION is the normal answer. Recommend it whenever the treasury is
  funded, spending is within budget, a balance is unreadable or unpriced, the
  treasury is frozen, or you are not sure. Say which condition applied.
- Never state a number that does not appear in the input.
- PROPOSE_PAYMENT names a provider exactly as listed, with billing mode
  on-chain, and an amount at or below the per-payment cap, within the
  remaining monthly cap and the provider's remaining budget. For a provider
  billed by card, invoice or manual transfer, a PROPOSE_PAYMENT is recorded as
  a manual payable for a human to settle; do not describe it as an on-chain
  payment.
- REVIEW_BUDGET names a provider whose spending looks out of line with its
  budget and suggests a budget figure derived from the input.
- If the treasury is frozen, every recommendation must be NO_ACTION.
- Reply only with JSON matching the schema.`;

export class TreasuryAgent {
  readonly #llm: LlmProvider;
  readonly #log = childLogger('treasury-agent');

  /**
   * The only dependency is the model provider. There is deliberately no
   * options object that could grow a wallet, a ledger or a signer later.
   */
  constructor(llm: LlmProvider) {
    this.#llm = llm;
  }

  async review(input: TreasuryAgentInput): Promise<TreasuryAgentOutput> {
    const started = Date.now();

    const availability = await this.#llm.available();
    if (!availability.available) {
      return this.#noAction(`no reasoning model: ${availability.detail}`, started, input);
    }

    try {
      const response = await this.#llm.chat(
        {
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: renderInput(input) }],
          responseSchema: jsonSchema(),
          temperature: 0.1,
        },
        treasuryReviewSchema,
      );

      const review = response.data;
      const violation = deterministicSanity(review, input);
      if (violation) {
        // Well-formed but off-policy: recorded as the model's failure, and the
        // recommendations are dropped wholesale rather than filtered, because
        // a model that got one of them wrong has not earned the benefit of the
        // doubt on the others.
        this.#log.warn({ violation }, 'treasury review overridden');
        return {
          review: {
            summary: review.summary,
            concerns: review.concerns,
            recommendedActions: [
              {
                action: 'NO_ACTION',
                provider: null,
                amountUsd: '0',
                reason: `overridden: ${violation}`,
              },
            ],
            confidence: review.confidence,
          },
          model: response.model,
          modelStatus: 'UNTRAINED',
          latencyMs: Date.now() - started,
          fallback: false,
          overridden: violation,
        };
      }

      return {
        review,
        model: response.model,
        modelStatus: 'UNTRAINED',
        latencyMs: Date.now() - started,
        fallback: false,
        overridden: null,
      };
    } catch (error) {
      return this.#noAction(`model output rejected: ${errorMessage(error)}`, started, input);
    }
  }

  #noAction(reason: string, started: number, input: TreasuryAgentInput): TreasuryAgentOutput {
    return {
      review: {
        summary: `No review available: ${reason}`,
        concerns: input.openAlerts.map((alert) => alert.summary).slice(0, 12),
        recommendedActions: [{ action: 'NO_ACTION', provider: null, amountUsd: '0', reason }],
        confidence: 0,
      },
      model: this.#llm.model,
      modelStatus: 'UNAVAILABLE',
      latencyMs: Date.now() - started,
      fallback: true,
      overridden: null,
    };
  }
}

/**
 * Deterministic checks on a well-formed review.
 *
 * These are not the cap engine — that runs in the service on the actual
 * proposal. They catch the model contradicting the input it was given, which
 * is recorded as a model failure rather than allowed to become a rejected
 * proposal that looks like a budget condition.
 */
export function deterministicSanity(
  review: TreasuryReview,
  input: TreasuryAgentInput,
): string | null {
  const perPayment = usdToMicros(input.caps.perPaymentCapUsd);
  const monthlyRemaining =
    usdToMicros(input.caps.monthlyCapUsd) - usdToMicros(input.approvedThisMonthUsd);

  for (const recommendation of review.recommendedActions) {
    if (recommendation.action === 'NO_ACTION') {
      if (recommendation.amountUsd !== '0') return 'NO_ACTION with a non-zero amount';
      if (recommendation.provider !== null) return 'NO_ACTION naming a provider';
      continue;
    }

    if (input.frozen) {
      return `${recommendation.action} while the treasury is frozen`;
    }
    if (recommendation.provider === null) {
      return `${recommendation.action} without a provider`;
    }
    const provider = input.providers.find(
      (candidate) => candidate.name.toLowerCase() === recommendation.provider?.toLowerCase(),
    );
    if (!provider) {
      return `provider ${JSON.stringify(recommendation.provider)} is not registered`;
    }
    if (!provider.active) {
      return `provider ${provider.name} is inactive`;
    }

    if (recommendation.action === 'PROPOSE_PAYMENT') {
      const amount = usdToMicros(recommendation.amountUsd);
      if (amount <= 0n) return 'PROPOSE_PAYMENT with a zero amount';
      if (amount > perPayment) {
        return `proposed ${recommendation.amountUsd} USD exceeds the per-payment cap ${input.caps.perPaymentCapUsd}`;
      }
      if (amount > monthlyRemaining) {
        return `proposed ${recommendation.amountUsd} USD exceeds the remaining monthly cap`;
      }
      const budget = usdToMicros(provider.monthlyBudgetUsd);
      if (budget > 0n && usdToMicros(provider.spentThisPeriodUsd) + amount > budget) {
        return `proposed ${recommendation.amountUsd} USD exceeds ${provider.name}'s remaining budget`;
      }
    }
  }

  return null;
}

function renderInput(input: TreasuryAgentInput): string {
  const lines: string[] = [
    `Billing period: ${input.period}`,
    `Treasury frozen: ${input.frozen ? 'YES — every recommendation must be NO_ACTION' : 'no'}`,
    '',
    'CAPS:',
    `- per payment: ${input.caps.perPaymentCapUsd} USD`,
    `- monthly: ${input.caps.monthlyCapUsd} USD (approved so far this month: ${input.approvedThisMonthUsd} USD)`,
    `- creator approval required at or above: ${input.caps.approvalThresholdUsd} USD`,
    `- low-balance alert threshold: ${input.caps.lowBalanceThresholdUsd} USD`,
    '',
    `BALANCES (priced total ${input.balances.pricedValueUsd} USD, ${input.balances.complete ? 'complete' : 'INCOMPLETE'}):`,
    ...(input.balances.assets.length === 0
      ? ['- no treasury address is configured']
      : input.balances.assets.map(
          (asset) =>
            `- ${asset.chain} ${asset.symbol}: ${asset.amountDecimal ?? 'unreadable'}${
              asset.valueUsd !== null
                ? ` = ${asset.valueUsd} USD`
                : ` (${asset.reason ?? 'unpriced'})`
            }`,
        )),
    '',
    'BURN AND RUNWAY:',
    `- monthly burn: ${input.burn.monthlyUsd ?? 'unknown'} USD (${input.burn.basis}${input.burn.reason ? `; ${input.burn.reason}` : ''})`,
    `- runway: ${input.runway.months ?? 'unknown'} months${input.runway.reason ? ` (${input.runway.reason})` : ''}`,
    '',
    'PROVIDERS (name | category | billing | budget | spent this period | status):',
    ...(input.providers.length === 0
      ? ['- none registered']
      : input.providers.map(
          (provider) =>
            `- ${provider.name} | ${provider.category} | ${provider.billingMode} | ${provider.monthlyBudgetUsd} USD | ${provider.spentThisPeriodUsd} USD | ${provider.active ? 'active' : 'inactive'}`,
        )),
    '',
    `PENDING PROPOSALS: ${String(input.pendingProposals)}`,
    '',
    'OPEN ALERTS:',
    ...(input.openAlerts.length === 0
      ? ['- none']
      : input.openAlerts.map((alert) => `- [${alert.severity}] ${alert.kind}: ${alert.summary}`)),
    '',
    'Review. Reply with JSON only.',
  ];
  return lines.join('\n');
}

function jsonSchema(): Record<string, unknown> {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['summary', 'concerns', 'recommendedActions', 'confidence'],
    properties: {
      summary: { type: 'string', maxLength: 800 },
      concerns: { type: 'array', maxItems: 12, items: { type: 'string', maxLength: 300 } },
      recommendedActions: {
        type: 'array',
        maxItems: 6,
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['action', 'provider', 'amountUsd', 'reason'],
          properties: {
            action: { type: 'string', enum: [...TREASURY_ACTIONS] },
            provider: { type: ['string', 'null'], maxLength: 64 },
            amountUsd: { type: 'string', pattern: '^(0|[1-9]\\d*)(\\.\\d{1,6})?$' },
            reason: { type: 'string', maxLength: 400 },
          },
        },
      },
      confidence: { type: 'number', minimum: 0, maximum: 1 },
    },
  };
}
