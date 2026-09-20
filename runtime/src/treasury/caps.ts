import { CHAINS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';
import { microsToUsd, usdToMicros } from '../risk/money.js';
import type { CapCheck, CapCode, CapDecision, CapStage, Provider, TreasuryCaps } from './types.js';

/**
 * The treasury cap engine.
 *
 * A pure function, in the same spirit as the risk engine: same input, same
 * decision, no clock, no database, no network, no model. It is the only thing
 * standing between a payment proposal and an approval, so it is small enough
 * to read in one sitting and every check is reported with what was observed
 * and what the limit was.
 *
 * Checks run in a fixed order and all of them are reported, except after the
 * freeze: nothing below a freeze is meaningful, and reporting "amount OK"
 * under a freeze would be misleading.
 *
 * What this engine does *not* know about: user funds, the agent wallets, the
 * risk policy, the ledger. Treasury money and user money are measured by
 * different rules on purpose, and this file imports nothing from either side.
 */

export const CAP_ENGINE_VERSION = 'treasury-caps/1.0.0';

export interface CapInput {
  /** Epoch milliseconds; injected, never read from a clock here. */
  now: number;
  stage: CapStage;
  frozen: boolean;
  caps: TreasuryCaps;
  /** The provider the proposal names, resolved by id, or null when unknown. */
  provider: Provider | null;
  /** Chains with an enabled watch-only treasury address. */
  enabledChains: ChainId[];
  proposal: {
    providerId: string;
    chain: ChainId;
    recipient: string;
    asset: string;
    amountUsd: string;
  };
  /** Approved and exported proposals decided in the current calendar month, USD. */
  monthToDateApprovedUsd: string;
  /** This provider's expenses plus approved proposals for the billing period, USD. */
  providerPeriodSpendUsd: string;
  /** The billing period the proposal covers, for the record. */
  period: string;
  /** Whether the approver asserted the creator's approval. Only meaningful at `approve`. */
  creatorApproval: boolean;
}

const NOT_EVALUATED = 'not-evaluated';

export function evaluateCaps(input: CapInput): CapDecision {
  const checks: CapCheck[] = [];
  const push = (check: CapCheck) => checks.push(check);

  // --- freeze: short-circuits everything ---------------------------------
  push({
    name: 'treasury.frozen',
    code: 'FROZEN',
    passed: !input.frozen,
    observed: input.frozen ? 'frozen' : 'active',
    limit: 'active',
  });
  if (input.frozen) {
    for (const code of REMAINING_AFTER_FREEZE) {
      push({
        name: NAMES[code],
        code,
        passed: false,
        observed: NOT_EVALUATED,
        limit: NOT_EVALUATED,
        skipped: 'short-circuit',
      });
    }
    return finish(input, checks);
  }

  // --- the recipient must be an allowlisted provider address -------------
  const provider = input.provider;
  push({
    name: NAMES.PROVIDER_UNKNOWN,
    code: 'PROVIDER_UNKNOWN',
    passed: provider !== null,
    observed: provider ? provider.id : `unknown provider ${input.proposal.providerId}`,
    limit: 'a registered provider',
  });
  push({
    name: NAMES.PROVIDER_INACTIVE,
    code: 'PROVIDER_INACTIVE',
    passed: provider?.active === true,
    observed: provider ? (provider.active ? 'active' : 'inactive') : NOT_EVALUATED,
    limit: 'active',
    ...(provider ? {} : { skipped: 'short-circuit' as const }),
  });
  push({
    name: NAMES.PROVIDER_NOT_ON_CHAIN,
    code: 'PROVIDER_NOT_ON_CHAIN',
    passed: provider?.billingMode === 'on-chain',
    observed: provider ? provider.billingMode : NOT_EVALUATED,
    limit: 'on-chain',
    ...(provider ? {} : { skipped: 'short-circuit' as const }),
    ...(provider && provider.billingMode !== 'on-chain'
      ? {
          detail: `${provider.name} bills by ${provider.billingMode}; record a manual payable instead`,
        }
      : {}),
  });

  const recipientMatches =
    provider?.recipient !== null &&
    provider?.recipient !== undefined &&
    provider.recipient.chain === input.proposal.chain &&
    provider.recipient.address === input.proposal.recipient;
  push({
    name: NAMES.RECIPIENT_NOT_ALLOWLISTED,
    code: 'RECIPIENT_NOT_ALLOWLISTED',
    passed: recipientMatches,
    observed: `${input.proposal.chain}:${input.proposal.recipient}`,
    limit: provider?.recipient
      ? `${provider.recipient.chain}:${provider.recipient.address}`
      : 'no allowlisted recipient',
  });

  push({
    name: NAMES.CHAIN_NOT_ENABLED,
    code: 'CHAIN_NOT_ENABLED',
    passed: input.enabledChains.includes(input.proposal.chain),
    observed: input.proposal.chain,
    limit:
      input.enabledChains.length > 0
        ? input.enabledChains.join(', ')
        : 'no enabled treasury address',
  });

  const assetKnown = CHAINS[input.proposal.chain].tokens.some(
    (token) => token.symbol === input.proposal.asset,
  );
  push({
    name: NAMES.ASSET_UNKNOWN,
    code: 'ASSET_UNKNOWN',
    passed: assetKnown,
    observed: input.proposal.asset,
    limit: CHAINS[input.proposal.chain].tokens.map((token) => token.symbol).join(', '),
  });

  // --- the amount against the caps ----------------------------------------
  let amount: bigint | null;
  try {
    amount = usdToMicros(input.proposal.amountUsd);
  } catch {
    amount = null;
  }
  push({
    name: NAMES.AMOUNT_INVALID,
    code: 'AMOUNT_INVALID',
    passed: amount !== null && amount > 0n,
    observed: input.proposal.amountUsd,
    limit: '> 0',
  });

  const safeAmount = amount !== null && amount > 0n ? amount : null;
  const perPayment = usdToMicros(input.caps.perPaymentCapUsd);
  push({
    name: NAMES.PER_PAYMENT_CAP,
    code: 'PER_PAYMENT_CAP',
    passed: safeAmount !== null && safeAmount <= perPayment,
    observed: safeAmount === null ? NOT_EVALUATED : microsToUsd(safeAmount),
    limit: microsToUsd(perPayment),
    ...(perPayment === 0n ? { detail: 'the per-payment cap is 0; configure it first' } : {}),
  });

  const monthly = usdToMicros(input.caps.monthlyCapUsd);
  const mtd = usdToMicros(input.monthToDateApprovedUsd);
  push({
    name: NAMES.MONTHLY_CAP,
    code: 'MONTHLY_CAP',
    passed: safeAmount !== null && mtd + safeAmount <= monthly,
    observed:
      safeAmount === null
        ? NOT_EVALUATED
        : `${microsToUsd(mtd)} approved this month + ${microsToUsd(safeAmount)} = ${microsToUsd(mtd + safeAmount)}`,
    limit: microsToUsd(monthly),
    detail: `calendar month of the decision, evaluated at ${new Date(input.now).toISOString()}`,
  });

  const budget = provider ? usdToMicros(provider.monthlyBudgetUsd) : 0n;
  if (provider && budget > 0n) {
    const spent = usdToMicros(input.providerPeriodSpendUsd);
    push({
      name: NAMES.PROVIDER_BUDGET,
      code: 'PROVIDER_BUDGET',
      passed: safeAmount !== null && spent + safeAmount <= budget,
      observed:
        safeAmount === null
          ? NOT_EVALUATED
          : `${microsToUsd(spent)} spent for ${input.period} + ${microsToUsd(safeAmount)} = ${microsToUsd(spent + safeAmount)}`,
      limit: microsToUsd(budget),
      detail: `billing period ${input.period}`,
    });
  } else {
    push({
      name: NAMES.PROVIDER_BUDGET,
      code: 'PROVIDER_BUDGET',
      passed: true,
      observed: provider ? 'no budget set' : NOT_EVALUATED,
      limit: 'none',
      skipped: 'not-applicable',
    });
  }

  // --- creator approval above the threshold --------------------------------
  const threshold = usdToMicros(input.caps.approvalThresholdUsd);
  const required = safeAmount !== null && safeAmount >= threshold;
  if (input.stage === 'propose') {
    push({
      name: NAMES.CREATOR_APPROVAL_REQUIRED,
      code: 'CREATOR_APPROVAL_REQUIRED',
      passed: true,
      observed: required ? 'creator approval will be required' : 'below threshold',
      limit: microsToUsd(threshold),
      skipped: 'not-applicable',
      detail: 'checked at approval time',
    });
  } else {
    push({
      name: NAMES.CREATOR_APPROVAL_REQUIRED,
      code: 'CREATOR_APPROVAL_REQUIRED',
      passed: !required || input.creatorApproval,
      observed: required
        ? input.creatorApproval
          ? 'required and asserted'
          : 'required and missing'
        : 'not required',
      limit: `required at or above ${microsToUsd(threshold)}`,
    });
  }

  return finish(input, checks);
}

function finish(input: CapInput, checks: CapCheck[]): CapDecision {
  const failed = checks.find((check) => !check.passed && check.skipped !== 'short-circuit');
  const firstFailed = failed ?? checks.find((check) => !check.passed);
  return {
    schemaVersion: 1,
    engineVersion: CAP_ENGINE_VERSION,
    stage: input.stage,
    evaluatedAt: input.now,
    allowed: firstFailed === undefined,
    code: firstFailed ? firstFailed.code : 'OK',
    reason: firstFailed
      ? `${firstFailed.code} (${firstFailed.name}): observed ${firstFailed.observed}, limit ${firstFailed.limit}`
      : 'every cap check passed',
    checks,
  };
}

const NAMES: Record<CapCode, string> = {
  FROZEN: 'treasury.frozen',
  PROVIDER_UNKNOWN: 'provider.known',
  PROVIDER_INACTIVE: 'provider.active',
  PROVIDER_NOT_ON_CHAIN: 'provider.billing',
  RECIPIENT_NOT_ALLOWLISTED: 'recipient.allowlisted',
  CHAIN_NOT_ENABLED: 'chain.enabled',
  ASSET_UNKNOWN: 'asset.known',
  AMOUNT_INVALID: 'amount.positive',
  PER_PAYMENT_CAP: 'amount.perPayment',
  MONTHLY_CAP: 'amount.monthly',
  PROVIDER_BUDGET: 'amount.providerBudget',
  CREATOR_APPROVAL_REQUIRED: 'approval.creator',
};

const REMAINING_AFTER_FREEZE: CapCode[] = [
  'PROVIDER_UNKNOWN',
  'PROVIDER_INACTIVE',
  'PROVIDER_NOT_ON_CHAIN',
  'RECIPIENT_NOT_ALLOWLISTED',
  'CHAIN_NOT_ENABLED',
  'ASSET_UNKNOWN',
  'AMOUNT_INVALID',
  'PER_PAYMENT_CAP',
  'MONTHLY_CAP',
  'PROVIDER_BUDGET',
  'CREATOR_APPROVAL_REQUIRED',
];
