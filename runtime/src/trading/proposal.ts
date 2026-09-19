import { randomUUID } from 'node:crypto';
import type { ChainId } from '../chains/registry.js';
import { CHAINS, isNativeToken } from '../chains/registry.js';
import type { MarketService } from '../market/service.js';
import type { ExecutionAdapter, ExecutionQuote } from '../execution/types.js';
import type { LedgerService, PriceLookup } from './ledger.js';
import type { TradeSide } from './trades.js';
import type { WalletService } from '../wallet/service.js';
import type { RiskPolicy } from '../risk/policy.js';
import type { ActionSource, MarketSnapshot, Mode, ProposedAction, Stamped } from '../risk/types.js';
import { balanceKey, liquidityKey, priceKey, proposedActionSchema } from '../risk/types.js';
import { deriveIdempotencyKey } from '../risk/engine.js';
import { amountToBigint, floorDiv, priceToAtto, usdToMicros } from '../risk/money.js';
import type { TradeDecision } from '../agents/trader/agent.js';
import { childLogger } from '../logging/logger.js';
import { errorMessage } from '../util/errors.js';

/**
 * The proposal builder.
 *
 * Takes the trader agent's decision — a direction, a token and a USD size —
 * and turns it into the fully specified action the risk engine evaluates:
 * exact base-unit amounts, the contract the adapter will call, a live quote
 * with a minimum output, the fee estimate, and a market snapshot whose every
 * entry is dated and attributed.
 *
 * Everything here is deterministic code. The model chose *what*; this decides
 * *how much of which token through which contract*, and the engine decides
 * *whether*. Neither the model nor this file can skip the engine.
 *
 * The funding asset is always a stablecoin from the chain's allowlist: OPEN
 * and SWAP spend it to buy the named token, REDUCE and CLOSE sell the named
 * token back into it. A native-coin leg is deliberately not supported in this
 * build; the routers here trade ERC-20/SPL pairs, and wrapping would add a
 * second transaction the engine has not seen.
 */

const STABLE_SYMBOLS = /^(USDC|USDT|USDG|USDbC|DAI)$/i;
/** How much of a REDUCE is allowed to overshoot the position. None. */
const PRICE_SCALE = 10n ** 18n;

export interface ProposalRequest {
  chain: ChainId;
  mode: Mode;
  decisionCycleId: string;
  source: ActionSource;
  walletAddress: string;
  decision: TradeDecision;
  policy: RiskPolicy;
  adapter: ExecutionAdapter;
}

export interface BuiltProposal {
  action: ProposedAction;
  quote: ExecutionQuote;
  snapshot: MarketSnapshot;
  priceLookup: PriceLookup;
  /** Decimal USD prices for the fill record. */
  prices: { tokenInUsd: string; tokenOutUsd: string; nativeUsd: string };
  side: TradeSide;
  notes: string[];
}

export type BuildResult =
  { ok: true; proposal: BuiltProposal } | { ok: false; reason: string; notes: string[] };

export interface ProposalBuilderDeps {
  market: MarketService;
  ledger: LedgerService;
  wallets: WalletService;
  now?: () => number;
}

export class ProposalBuilder {
  readonly #market: MarketService;
  readonly #ledger: LedgerService;
  readonly #wallets: WalletService;
  readonly #now: () => number;
  readonly #log = childLogger('proposal');

  constructor(deps: ProposalBuilderDeps) {
    this.#market = deps.market;
    this.#ledger = deps.ledger;
    this.#wallets = deps.wallets;
    this.#now = deps.now ?? (() => Date.now());
  }

  async build(request: ProposalRequest): Promise<BuildResult> {
    const notes: string[] = [];
    const { chain, decision, policy } = request;

    if (decision.action === 'NO_ACTION' || !decision.token) {
      return { ok: false, reason: 'nothing to build for NO_ACTION', notes };
    }

    const allowlist = policy.tokenAllowlist[chain] ?? [];
    const named = allowlist.find((entry) => entry.address === decision.token);
    if (!named) {
      return { ok: false, reason: `${decision.token} is not allowlisted on ${chain}`, notes };
    }
    if (isNativeToken(chain, named.address)) {
      return { ok: false, reason: 'native-coin legs are not supported in this build', notes };
    }

    const funding = await this.#pickFundingToken(request, allowlist, named.address);
    if (!funding) {
      return {
        ok: false,
        reason: `no allowlisted stablecoin with a balance on ${chain} to fund the trade`,
        notes,
      };
    }

    const isExit = decision.action === 'REDUCE' || decision.action === 'CLOSE';
    const tokenIn = isExit ? named : funding;
    const tokenOut = isExit ? funding : named;
    const side: TradeSide =
      decision.action === 'OPEN'
        ? 'open'
        : decision.action === 'SWAP'
          ? 'swap'
          : decision.action === 'REDUCE'
            ? 'reduce'
            : 'close';

    // --- prices, cross-checked --------------------------------------------
    const native = CHAINS[chain].tokens.find((token) => isNativeToken(chain, token.address))!;
    const priced = await this.#prices(chain, [tokenIn.address, tokenOut.address, native.address]);

    const priceIn = priced.get(tokenIn.address);
    const priceOut = priced.get(tokenOut.address);
    const priceNative = priced.get(native.address);
    for (const [label, entry] of [
      ['tokenIn', priceIn],
      ['tokenOut', priceOut],
      ['native', priceNative],
    ] as const) {
      if (!entry) {
        return { ok: false, reason: `no reliable USD price for ${label}`, notes };
      }
      notes.push(`${label} price ${entry.value} USD via ${entry.source}`);
    }

    // --- size ----------------------------------------------------------------
    let amountIn: bigint;
    if (decision.action === 'CLOSE') {
      const position = this.#ledger.getPosition(request.mode, chain, tokenIn.address);
      if (!position) return { ok: false, reason: 'CLOSE without an open position', notes };
      amountIn = amountToBigint(position.amount);
    } else if (decision.action === 'REDUCE') {
      const position = this.#ledger.getPosition(request.mode, chain, tokenIn.address);
      if (!position) return { ok: false, reason: 'REDUCE without an open position', notes };
      const wanted = usdToTokenUnits(
        usdToMicros(decision.requestedNotionalUsd),
        tokenIn.decimals,
        priceToAtto(priceIn!.value),
      );
      const held = amountToBigint(position.amount);
      amountIn = wanted > held ? held : wanted;
      if (wanted > held) notes.push('REDUCE capped at the position size');
    } else {
      amountIn = usdToTokenUnits(
        usdToMicros(decision.requestedNotionalUsd),
        tokenIn.decimals,
        priceToAtto(priceIn!.value),
      );
    }

    if (amountIn <= 0n) {
      return { ok: false, reason: 'requested size rounds to zero base units', notes };
    }

    // --- balances ------------------------------------------------------------
    const balances = await this.#balances(request, [tokenIn.address, native.address]);

    // --- quote ---------------------------------------------------------------
    let quote: ExecutionQuote;
    try {
      quote = await request.adapter.quote({
        chain,
        tokenIn: { address: tokenIn.address, decimals: tokenIn.decimals },
        tokenOut: { address: tokenOut.address, decimals: tokenOut.decimals },
        amountIn: amountIn.toString(),
        slippageBps: policy.maxSlippageBps,
        from: request.walletAddress,
      });
    } catch (error) {
      return { ok: false, reason: `quote failed: ${errorMessage(error)}`, notes };
    }
    notes.push(
      `quote ${quote.source}: ${quote.expectedAmountOut} expected, ${quote.minAmountOut} minimum`,
    );

    // --- liquidity -----------------------------------------------------------
    const liquidity = await this.#liquidity(chain, tokenIn.address, tokenOut.address);
    if (liquidity) notes.push(`liquidity ${liquidity.value} USD via ${liquidity.source}`);
    else notes.push('no pool liquidity figure could be read');

    // --- assemble --------------------------------------------------------------
    const now = this.#now();
    const snapshot: MarketSnapshot = {
      prices: {
        [priceKey(chain, tokenIn.address)]: priceIn!,
        [priceKey(chain, tokenOut.address)]: priceOut!,
        [priceKey(chain, native.address)]: priceNative!,
      },
      liquidity: liquidity ? { [liquidityKey(chain, quote.marketId)]: liquidity } : {},
      balances,
    };

    const candidate = {
      schemaVersion: 1 as const,
      actionId: randomUUID(),
      decisionCycleId: request.decisionCycleId,
      idempotencyKey: '0'.repeat(64),
      proposedAt: now,
      mode: request.mode,
      source: request.source,
      chain,
      kind: 'swap' as const,
      protocol: quote.protocol,
      contract: quote.contract,
      ...(chain === 'solana' ? { programIds: quote.programIds ?? [] } : {}),
      reduceOnly: isExit,
      tokenIn: { address: tokenIn.address, decimals: tokenIn.decimals },
      tokenOut: { address: tokenOut.address, decimals: tokenOut.decimals },
      amountIn: amountIn.toString(),
      quote: {
        expectedAmountOut: quote.expectedAmountOut,
        minAmountOut: quote.minAmountOut,
        slippageBps: quote.slippageBps,
        priceImpactBps: quote.priceImpactBps,
        quotedAt: quote.quotedAt,
        source: quote.source,
        marketId: quote.marketId,
      },
      feeEstimate: quote.feeEstimate,
      rationale: decision.reason.slice(0, 2_000),
    };
    candidate.idempotencyKey = deriveIdempotencyKey(candidate);

    const parsed = proposedActionSchema.safeParse(candidate);
    if (!parsed.success) {
      // The builder produced something the engine's schema refuses. That is a
      // bug here, not a market condition, and it is reported as such.
      const issue = parsed.error.issues[0];
      this.#log.error({ issue }, 'built an invalid proposal');
      return {
        ok: false,
        reason: `internal: proposal failed schema (${issue?.path.join('.') ?? '?'}: ${issue?.message ?? 'invalid'})`,
        notes,
      };
    }

    const priceLookup: PriceLookup = (lookupChain, token) =>
      lookupChain === chain ? (priced.get(token)?.value ?? null) : null;

    return {
      ok: true,
      proposal: {
        action: parsed.data,
        quote,
        snapshot,
        priceLookup,
        prices: {
          tokenInUsd: priceIn!.value,
          tokenOutUsd: priceOut!.value,
          nativeUsd: priceNative!.value,
        },
        side,
        notes,
      },
    };
  }

  /**
   * The stablecoin that funds the trade: the allowlisted one with the largest
   * balance in the current mode. For an exit the funding token is what the
   * position is sold into, so any allowlisted stablecoin will do and balance
   * does not matter.
   */
  async #pickFundingToken(
    request: ProposalRequest,
    allowlist: RiskPolicy['tokenAllowlist'][ChainId] & object,
    exclude: string,
  ): Promise<{ address: string; decimals: number; symbol: string } | undefined> {
    const stables = allowlist.filter(
      (entry) => STABLE_SYMBOLS.test(entry.symbol) && entry.address !== exclude,
    );
    if (stables.length === 0) return undefined;

    const isExit = request.decision.action === 'REDUCE' || request.decision.action === 'CLOSE';
    if (isExit) return stables[0];

    const balances = await this.#balances(
      request,
      stables.map((entry) => entry.address),
    );
    let best: { entry: (typeof stables)[number]; held: bigint } | undefined;
    for (const entry of stables) {
      const reading = balances[balanceKey(request.chain, entry.address)];
      const held = reading ? amountToBigint(reading.value) : 0n;
      if (!best || held > best.held) best = { entry, held };
    }
    return best && best.held > 0n ? best.entry : undefined;
  }

  async #prices(chain: ChainId, tokens: string[]): Promise<Map<string, Stamped<string>>> {
    const out = new Map<string, Stamped<string>>();
    await Promise.all(
      [...new Set(tokens)].map(async (token) => {
        try {
          const result = await this.#market.getCrossCheckedPrice(chain, token);
          if (result.priceUsd === null || result.disputed) return;
          const observedAt = result.sources
            .map((source) => Date.parse(source.observedAt))
            .reduce((oldest, at) => Math.min(oldest, at), Number.POSITIVE_INFINITY);
          out.set(token, {
            value: result.priceUsd,
            at: Number.isFinite(observedAt) ? observedAt : this.#now(),
            source: result.sources.map((source) => source.source).join('+'),
          });
        } catch (error) {
          this.#log.warn({ chain, token, err: error }, 'price lookup failed');
        }
      }),
    );
    return out;
  }

  /**
   * Balances for the mode: the paper ledger in PAPER, the chain in LIVE.
   *
   * A paper balance that was never seeded is reported as zero with the
   * current time, which the engine turns into BALANCE_INSUFFICIENT — the
   * operator must state a bankroll before the agent can pretend to spend it.
   * A LIVE balance that cannot be read is simply absent, which is DATA_STALE.
   */
  async #balances(
    request: ProposalRequest,
    tokens: string[],
  ): Promise<Record<string, Stamped<string>>> {
    const { chain } = request;
    const out: Record<string, Stamped<string>> = {};

    if (request.mode === 'PAPER') {
      const now = this.#now();
      for (const token of tokens) {
        const paper = this.#ledger.getPaperBalance(chain, token);
        out[balanceKey(chain, token)] = {
          value: paper?.amount ?? '0',
          at: now,
          source: 'paper-ledger',
        };
      }
      return out;
    }

    try {
      const reading = await this.#wallets.readBalances(
        chain,
        tokens.filter((token) => !isNativeToken(chain, token)),
      );
      if (reading.error || reading.observedAt === null) return out;
      const at = Date.parse(reading.observedAt);
      const source = reading.source ?? 'rpc';
      if (reading.native) {
        out[balanceKey(chain, CHAINS[chain].nativeSentinel)] = {
          value: reading.native.amount,
          at,
          source,
        };
      }
      for (const token of reading.tokens) {
        out[balanceKey(chain, token.address)] = { value: token.amount, at, source };
      }
    } catch (error) {
      this.#log.warn({ chain, err: error }, 'live balance read failed');
    }
    return out;
  }

  /** The deepest pool that trades exactly this pair, as the providers see it. */
  async #liquidity(chain: ChainId, a: string, b: string): Promise<Stamped<string> | undefined> {
    try {
      const pools = await this.#market.getPoolsForToken(chain, a);
      const matching = pools.filter((pool) => {
        const pair = [pool.base.address.toLowerCase(), pool.quote.address.toLowerCase()];
        return (
          pair.includes(a.toLowerCase()) &&
          pair.includes(b.toLowerCase()) &&
          pool.liquidityUsd !== null
        );
      });
      const deepest = matching.sort((x, y) => Number(y.liquidityUsd) - Number(x.liquidityUsd))[0];
      if (!deepest?.liquidityUsd) return undefined;
      return {
        value: deepest.liquidityUsd,
        at: Date.parse(deepest.observedAt),
        source: `${deepest.source}:${deepest.poolId}`,
      };
    } catch (error) {
      this.#log.warn({ chain, a, b, err: error }, 'liquidity lookup failed');
      return undefined;
    }
  }
}

/** USD (micro) → token base units at a price in atto-USD, rounded down. */
export function usdToTokenUnits(usdMicros: bigint, decimals: number, priceAtto: bigint): bigint {
  if (priceAtto <= 0n) return 0n;
  // micros × 1e12 = atto-USD; × 10^decimals / price = base units.
  return floorDiv(usdMicros * (PRICE_SCALE / 1_000_000n) * 10n ** BigInt(decimals), priceAtto);
}
