import { z } from 'zod';
import { CHAIN_IDS } from '../chains/registry.js';
import type { ChainId } from '../chains/registry.js';

/**
 * Types shared across the treasury module.
 *
 * The treasury is the part of ATRA that pays for ATRA. It is built to be the
 * least powerful subsystem in the runtime, and the types say so:
 *
 *  - there is no type here that could carry a private key, a signing context
 *    or a signed transaction. A {@link TreasuryAddress} is a watch-only
 *    address the project admin typed in;
 *  - a {@link PaymentProposal} is a reviewed instruction, and
 *    {@link ExportedInstruction} is what a human executes from the treasury
 *    wallet with their own signer. Neither is a transaction;
 *  - every USD amount is a canonical micro-USD decimal string
 *    (`"12.500000"`), never a float, the same rule the risk engine follows.
 */

export const PROVIDER_CATEGORIES = [
  'rpc',
  'hosting',
  'data',
  'model',
  'domain',
  'security',
  'other',
] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

/**
 * How a provider bills. Only `on-chain` providers can ever become a payment
 * proposal; the other three become manual payables, because a card or an
 * invoice is not something the runtime can pay, and the honest thing to do is
 * to record the obligation rather than invent a payment path.
 */
export const BILLING_MODES = ['on-chain', 'card', 'invoice', 'manual'] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

export const EXPENSE_KINDS = ['recurring', 'one-off', 'manual-payable'] as const;
export type ExpenseKind = (typeof EXPENSE_KINDS)[number];

export const EXPENSE_STATUSES = ['paid', 'due', 'payable'] as const;
export type ExpenseStatus = (typeof EXPENSE_STATUSES)[number];

export const EXPENSE_SOURCES = ['imported', 'manual'] as const;
export type ExpenseSource = (typeof EXPENSE_SOURCES)[number];

export const PROPOSAL_STATUSES = [
  'proposed',
  'approved',
  'rejected',
  'exported',
  'cancelled',
] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];

export const PROPOSAL_SOURCES = ['admin', 'agent'] as const;
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];

export const ALERT_KINDS = [
  'low_balance',
  'balance_unreadable',
  'price_unknown',
  'budget_exceeded',
  'runway_short',
  'frozen',
  'model_override',
] as const;
export type AlertKind = (typeof ALERT_KINDS)[number];

export const ALERT_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** A canonical USD string: integer part, optional fraction of up to six digits. */
export const usdString = z.string().regex(/^(0|[1-9]\d*)(\.\d{1,6})?$/, 'must be a USD amount');

/** A calendar month, `YYYY-MM`. */
export const periodString = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'must be YYYY-MM');

export const treasuryTokenSchema = z.object({
  address: z.string().min(1).max(64),
  symbol: z.string().min(1).max(16),
  decimals: z.number().int().min(0).max(18),
});
export type TreasuryToken = z.infer<typeof treasuryTokenSchema>;

/** A watch-only address the treasury reads. Nothing in the runtime can sign for it. */
export interface TreasuryAddress {
  chain: ChainId;
  address: string;
  label: string;
  tokens: TreasuryToken[];
  enabled: boolean;
  addedAt: string;
  updatedAt: string;
}

export interface TreasuryCaps {
  lowBalanceThresholdUsd: string;
  perPaymentCapUsd: string;
  monthlyCapUsd: string;
  approvalThresholdUsd: string;
}

export interface TreasuryConfig extends TreasuryCaps {
  currency: 'USD';
  adminConfigured: boolean;
  adminSetAt: string | null;
  frozen: boolean;
  frozenReason: string | null;
  frozenAt: string | null;
  frozenBy: string | null;
  addresses: TreasuryAddress[];
  createdAt: string;
  updatedAt: string;
}

export interface Provider {
  id: string;
  name: string;
  category: ProviderCategory;
  billingMode: BillingMode;
  monthlyBudgetUsd: string;
  /** The single allowlisted recipient. Null unless `billingMode` is `on-chain`. */
  recipient: { chain: ChainId; address: string } | null;
  active: boolean;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface Expense {
  id: string;
  providerId: string;
  period: string;
  amountUsd: string;
  kind: ExpenseKind;
  status: ExpenseStatus;
  source: ExpenseSource;
  note: string;
  recordedAt: string;
  recordedBy: string;
}

/**
 * One deterministic check a payment proposal was measured against, with what
 * was observed and the limit it was held to. The same shape as the risk
 * engine's `RiskCheck`, for the same reason: a decision must be re-derivable
 * from the row without the code that produced it.
 */
export interface CapCheck {
  name: string;
  code: CapCode;
  passed: boolean;
  observed: string;
  limit: string;
  skipped?: 'not-applicable' | 'short-circuit';
  detail?: string;
}

export const CAP_CODES = [
  'FROZEN',
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
] as const;
export type CapCode = (typeof CAP_CODES)[number];

export type CapStage = 'propose' | 'approve' | 'export';

export interface CapDecision {
  schemaVersion: 1;
  engineVersion: string;
  stage: CapStage;
  evaluatedAt: number;
  allowed: boolean;
  code: 'OK' | CapCode;
  reason: string;
  checks: CapCheck[];
}

export interface PaymentProposal {
  id: string;
  createdAt: string;
  providerId: string;
  chain: ChainId;
  recipient: string;
  /** Symbol of a token listed for the chain in the registry, e.g. `USDC`. */
  asset: string;
  amountUsd: string;
  /** The billing month the payment covers, YYYY-MM. */
  period: string;
  memo: string;
  proposedBy: string;
  source: ProposalSource;
  /** The cap evaluation at proposal time. */
  checks: CapDecision;
  status: ProposalStatus;
  creatorApproval: boolean;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  /** The cap evaluation the approval or rejection rested on. */
  decision: CapDecision | null;
  exportedAt: string | null;
  exportedBy: string | null;
  export: ExportedInstruction | null;
}

/**
 * What an approved proposal turns into when it is exported: a human-readable,
 * human-executable transfer instruction.
 *
 * It is deliberately not a transaction. There is no calldata, no nonce, no
 * fee, no serialized payload of any kind, because the runtime holds no key
 * for the treasury wallet and must never look as though it does. The person
 * holding the treasury wallet reads this, checks it against the proposal and
 * signs elsewhere.
 */
export interface ExportedInstruction {
  proposalId: string;
  exportedAt: string;
  chain: ChainId;
  chainDisplayName: string;
  evmChainId: number | null;
  /** The watch-only treasury address the transfer is expected to come from. */
  from: string;
  recipient: string;
  recipientExplorerUrl: string;
  asset: { symbol: string; address: string; decimals: number };
  amountUsd: string;
  /**
   * The asset amount in base units at the price observed at export time, or
   * null with a reason when no cross-checked price was available. A null
   * means the human converts the USD figure themselves; it never means zero.
   */
  amountBaseUnits: string | null;
  amountDecimal: string | null;
  price: { priceUsd: string; sources: string[]; observedAt: string } | null;
  priceReason: string | null;
  memo: string;
  provider: { id: string; name: string };
  approvedBy: string;
  approvedAt: string;
  creatorApproval: boolean;
  /** The checks the approval rested on, verbatim. */
  checks: CapCheck[];
  notice: string;
}

export interface TreasuryAlert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  summary: string;
  detail: Record<string, unknown>;
  raisedAt: string;
  acknowledgedAt: string | null;
}

/** One dated reading of one asset at one treasury address. */
export interface BalanceSnapshot {
  id: string;
  takenAt: string;
  chain: ChainId;
  address: string;
  asset: string;
  symbol: string;
  decimals: number;
  /** Base units, or null when the read failed. Never zero for a failed read. */
  amount: string | null;
  priceUsd: string | null;
  valueUsd: string | null;
  reason: string | null;
  source: string;
}

/** A balance reading as the dashboard shows it. */
export interface AssetBalanceView {
  chain: ChainId;
  address: string;
  label: string;
  asset: string;
  symbol: string;
  decimals: number;
  amount: string | null;
  amountDecimal: string | null;
  priceUsd: string | null;
  valueUsd: string | null;
  /** Why `amount` or `valueUsd` is null. Null when both are known. */
  reason: string | null;
  observedAt: string | null;
  source: string;
}

export interface BalanceReport {
  takenAt: string;
  assets: AssetBalanceView[];
  /** Sum of every priced asset. Partial when `complete` is false. */
  pricedValueUsd: string;
  /** True only when every enabled asset was read and priced. */
  complete: boolean;
  /** Which assets are missing from the total, and why. */
  incomplete: Array<{ chain: ChainId; symbol: string; reason: string }>;
}

export interface BurnRate {
  /** Average monthly spend over the periods used, or null with a reason. */
  monthlyUsd: string | null;
  /** The three calendar months considered, newest last. */
  windowPeriods: string[];
  /** The subset of the window that had at least one recorded expense. */
  usedPeriods: string[];
  totalUsd: string;
  basis: 'trailing-3' | 'trailing-2' | 'single-month' | 'none';
  reason: string | null;
}

export interface Runway {
  /** Months of runway to two decimals, or null with a reason. */
  months: string | null;
  balanceUsd: string | null;
  monthlyBurnUsd: string | null;
  reason: string | null;
}

export const CHAIN_ID_SCHEMA = z.enum(CHAIN_IDS);
