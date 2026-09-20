---
name: auto-lp
description: How one liquidity-management cycle runs from reading a pool to booking a fill, what each stage may and may not do, which protocols exist and why the others do not, and how paper and live execution differ.
phase: 4
---

# Auto-LP

## The rule this skill exists to state

**The Liquidity Manager proposes one word. Deterministic code decides
everything else, and only against a pool the operator listed on a protocol
the registry knows.**

```
read pool + position ──> agent proposes ──> proposal built ──> risk engine ──> executor
        │                     │                  │                 │              │
   chain facts,          HOLD is the        deterministic       the only       PAPER sim
   cross-checked         default            sizing/quoting      authority      or LIVE sign
   prices
```

No stage can skip the next. The executor acts only on a trade row in the
`allowed` state, and only the risk gate writes that state. There is no
route, flag or prompt that adds liquidity from a pool address and an amount:
the dashboard's one operator action is "run a cycle now", which walks the
same path. An LP adapter is a closed set of operations — read, quote, build
add, build remove, build claim, build an exact approval — against a router
the swap registry already trusts and a pool that router's factory owns. It
has no `call(contract, data)`.

## The workflow

The spec lists eleven steps. This is where each one lives.

| # | Step | Where | What it does and what ends the cycle |
|---|---|---|---|
| 1 | Read supported pool | `LpAdapter.readPool` | `token0`, `token1`, `stable`, reserves, `totalSupply`, fee. The protocol's factory must report the pool (`getPool` / `getPair`); a pool it disowns is refused here, whatever the policy says. No adapter for the chain → `HOLD` recorded with the registry's reason, no model consulted. |
| 2 | Read current LP position | `LpAdapter.readPosition` (LIVE) or the LP ledger with the share recomputed from live reserves (PAPER) | LP tokens held, share of each reserve, claimable fees where the protocol tracks them. |
| 3 | Assess state | `LiquidityPipeline` | Cross-checked USD prices for both assets and the native coin (a disputed or missing price leaves the position unpriced, never guessed); pool TVL; the position marked against its cost basis; eligibility facts (allowlisted, rebalances used today, claimable fees against the threshold, whether a range exists). |
| 4 | Propose action | `agents/liquidity-manager` | Exactly one of `HOLD`, `ADD_LIQUIDITY` (with `capitalUsd`), `REMOVE_LIQUIDITY`, `REBALANCE`, `COLLECT_FEES`, `EXIT`. `HOLD` on an unavailable model, on output that does not parse, and on output that contradicts its input. |
| 5 | Validate | `deterministicSanity` | Wrong chain or pool, capital on a non-add, an add over the per-position cap, an exit or claim of nothing, a claim below the threshold, a rebalance on a pool without a range: overridden to `HOLD` and recorded as a model failure. |
| 6 | Simulate | PAPER: `PaperLpExecutor`, step 9 | The paper executor *is* the simulation: the pair's mint formula against live reserves. **In LIVE there is no simulation step before signing**; a reverting `addLiquidity` is discovered on chain. |
| 7 | Risk checks | `LpProposalBuilder` then `RiskGate.decide` | The builder turns the word into exact base-unit legs, a router quote with floors, a fee estimate and a dated snapshot; the engine runs its shared checks plus the LP checks below. First failure names the rule. |
| 8 | Protocol allowlist | `lp.pool` in the engine, `poolAllowlisted` in the pipeline | `(chain, protocol, poolId)` must be in `lp.allowedPools` and the protocol in `lp.allowedProtocols[chain]`. Runs right after `chain.enabled` so "not allowed" is reported before "stale". |
| 9 | Execute | `PaperLpExecutor` or `LiveLpExecutor` | Below. |
| 10 | Verify | receipt parsing | LIVE amounts are what the chain reports: ERC-20 `Transfer` logs to and from the wallet, summed per token. Never the quote. |
| 11 | Audit | every stage | `liquidity.decision` (`hold` or `ok`), `liquidity.proposal` when a build fails, `risk.allowed` / `risk.rejected` with the failing rule, `liquidity.signed`, `liquidity.broadcast`, `liquidity.filled` / `liquidity.failed`, and a closing `liquidity.cycle`, all correlated by the cycle id. An `lp_actions` row records every ending, including "the agent looked and held". |

## The normalized LP state

What the pipeline hands the agent and the dashboard, whatever the protocol:

| Field | Source |
|---|---|
| `chain`, `protocol`, `poolId` | the registry and the adapter; pool ids are canonical lowercase |
| assets: `token0` / `token1` address, decimals, symbol | the chain (`decimals()` and `symbol()` on each token) |
| deposited amounts: `amount0`, `amount1`, `lpTokens` | LIVE: `balanceOf` and the share of reserves; PAPER: the ledger |
| position identifier | the pool address — on v2 the LP token *is* the pool |
| `range` and in-range / out-of-range | `null` on every v2 pool; a concentrated-liquidity adapter would fill it |
| unclaimed fees: `claimable0`, `claimable1`, `feesUsd`, `feesNote` | Aerodrome: `claimable0/1` as the pool reports them; PancakeSwap: `null` with "fees compound into the reserves"; PAPER: `0` with "not simulated" |
| estimated value: `valueUsd`, `capitalUsd`, `unrealizedUsd` | share of reserves at cross-checked prices, floor-rounded, against the average cost basis; `null` until a cycle has observed the position |
| `lastAction`, `lastActionAt`, `lastRebalanceAt`, `rebalance.today/max/nextEligibleAt` | the LP ledger |
| `status`, `source` | `SIMULATED` / `paper-sim` in PAPER, `ACTIVE` / `chain` in LIVE |

Money is base-unit strings and micro-USD decimal strings. Nothing here is a
float, and nothing is estimated where the chain or the ledger has not spoken.

## LP risk controls and their codes

The policy's `lp` block, and the check that enforces each field:

| Control | Policy field | Check | Code |
|---|---|---|---|
| Allowed pools | `lp.allowedPools[]` | `lp.pool` | `POOL_NOT_ALLOWLISTED` |
| Allowed protocols | `lp.allowedProtocols[chain][]` | `lp.pool` (and `allowlist.protocol`) | `POOL_NOT_ALLOWLISTED` / `PROTOCOL_NOT_ALLOWLISTED` |
| Max capital per LP position | `lp.maxCapitalPerLpUsd` | `lp.capital` (entries only; capital recomputed from both legs at snapshot prices, never from the proposal's hint) | `LP_CAPITAL_EXCEEDS_MAX` |
| Minimum pool liquidity | `lp.minPoolLiquidityUsd` | `lp.poolLiquidity` (TVL from reserves at cross-checked prices) | `POOL_LIQUIDITY_BELOW_MIN` |
| Max rebalance frequency | `lp.maxRebalancePerDay` | `lp.rebalanceCount` (per pool per UTC day) | `REBALANCE_LIMIT_REACHED` |
| Max rebalance slippage | `lp.maxRebalanceSlippageBps` | `lp.rebalanceSlippage` (the greater of the quote's slippage and the implied min-out gap) | `SLIPPAGE_EXCEEDS_MAX` |
| Max gas / fee | `lp.maxLpGasUsd` | `lp.gas` (worst case at `maxFeePerGas`) | `FEE_EXCEEDS_MAX` |
| Minimum fee before collection | `lp.minFeeThresholdUsd` | `lp.claimThreshold` (claimable valued at snapshot prices, floor-rounded) | `FEE_BELOW_CLAIM_THRESHOLD` |
| Position must exist for an exit or claim | — | `lp.position` | `REDUCE_ONLY_MISMATCH` |
| Second leg fresh and sufficient | `freshness.balanceMaxAgeMs` | `lp.freshness.balance.tokenB`, `lp.balance.tokenB` | `DATA_STALE`, `BALANCE_INSUFFICIENT` |
| Total deployed (LP capital counts), daily loss, cooldowns, contract registry, duplicate intent | shared fields | the shared checks, unchanged | `TOTAL_DEPLOYED_BREACHED`, `DAILY_LOSS_BREACHED`, `COOLDOWN_ACTIVE`, `CONTRACT_UNKNOWN`, `DUPLICATE_ACTION`, … |

The default policy lists no pools and caps LP capital at zero. Every `lp_*`
action is rejected until the operator lists a pool on an enabled chain and
sets a non-zero `maxCapitalPerLpUsd`. Two verified pools are offered on the
dashboard as examples; they are not in the policy.

Two refusals happen before the engine, in the builder: an add into a
volatile pool whose own price (the ratio of its reserve values) differs from
the cross-checked market price by more than `lp.maxRebalanceSlippageBps` —
either a feed is stale or the pool is mid-arbitrage, and adding at that
moment is a loss the operator did not ask for — and a `REBALANCE` on a v2
pool, which has no range to move.

## Protocols

| Chain | LP adapter | Fees | Notes |
|---|---|---|---|
| Base | Aerodrome v2 — router `0xcf77…e43`, factory `0x420d…40da` | tracked per holder; `COLLECT_FEES` calls `claimFees()` on the pool | volatile and stable pools; quotes from the router's own `quoteAddLiquidity` / `quoteRemoveLiquidity`; `feeBps` from the factory |
| BNB Smart Chain | PancakeSwap v2 — router `0x10ed…24e`, factory `0xca14…c73` | compound into the reserves; there is nothing to claim and `COLLECT_FEES` is refused | quotes from the reserves with the router's ratio adjustment and the pair's mint formula |
| Solana | **none** | | Orca, Raydium and Meteora are concentrated-liquidity protocols with position accounts and price ranges; none of that is implemented. Observable and tradeable, not LP-manageable. |
| Robinhood Chain | **none** | | Its only DEX is Uniswap v4, whose position manager and hook model are not implemented. Observable only. |

Each router must already be a registered swap contract for its chain; the
adapter refuses to construct otherwise, so the LP and swap registries cannot
drift apart. The factory is only ever read. The pool itself is a transaction
target only for `claimFees`, and the engine checks that a claim's contract
equals the allowlisted pool.

## What paper simulates, and what it does not

PAPER (`liquidity/paper`) touches no chain. It reads the live pool and:

- an **add** debits both paper balances at the ratio-adjusted amounts the
  quote produced and mints `min(amount0 × totalSupply / reserve0, amount1 ×
  totalSupply / reserve1)` LP tokens — the pair contract's own formula, from
  the reserves as read — refusing if that is below the quote's minimum;
- a **remove** or **exit** returns the position's share of the reserves as
  read now, so a price move since the add shows up as impermanent loss
  against the cost basis, and books the realized result;
- the **fee** is the full estimated gas at the current native price, charged
  as a realized loss on the action row.

**Fee accrual is not simulated.** A paper position reports `feesUsd: 0` with
the note "fee accrual is not simulated in PAPER"; `COLLECT_FEES` is refused
in the builder before it reaches the engine. Paper LP positions are marked
from the real pool, so they move with the market, but they earn nothing.
Everything is recorded with mode `PAPER`, `simulated: true` and no
transaction hash. Paper balances are seeded by the operator and never
inferred from a real wallet.

## LIVE, in this order and no other

`liquidity/live` is the only liquidity code that signs.

1. **refuse** unless the runtime is LIVE, not paused, not stopped — checked
   again here, after the engine, because the state can change in between;
2. **build** the transaction from the plan the engine approved; the
   adapter's `to` must equal the contract the engine approved (the router,
   the pool for a claim, or the token for an approval) or nothing is signed;
3. fetch nonce and fee caps;
4. **sign** inside the vault's synchronous callback — the key exists in
   memory for one ECDSA operation;
5. **write the hash to the trade row before anything is sent**
   (`liquidity.signed` in the audit log precedes `liquidity.filled`);
6. broadcast; poll the receipt for a bounded time (90 s);
7. **book** from what the chain reports: LP tokens received, assets sent or
   returned, fees claimed, summed from the `Transfer` logs — never from the
   quote. A leg the receipt does not expose is booked at the quote's floor
   and the audit row says `chain-with-fallbacks`.

There is no simulation between steps 1 and 4. The router's minimum amounts
and 300-second deadline are what protects the transaction; a revert costs
gas.

**Exact-amount approvals.** On EVM chains the router must be allowed to pull
what it moves: both pool assets for an add, the LP token for a removal,
nothing for a claim. Before proposing the LP action, the pipeline reads each
allowance and, when short, routes an `approve` for exactly that amount
through the risk engine as its own action with its own fee and contract
checks, executes it, waits for confirmation, and only then proposes the LP
action. Never unlimited. An approval starts no cooldown. The LP token
approval ahead of a removal is judged by the same `lp.pool` check as the
removal, since the LP token is the pool.

## Recovery

A trade row that was `signed` or `broadcast` when the process died names its
hash. On the next start the LP executor asks the chain what happened to each
LP row (`lp_*` kinds and approvals with `route.lp`), moves a `signed` row
through `broadcast`, marks it filled or failed, and books an add from the
transfers alone with a zero cost basis and an audit row saying the
valuation is missing — never with a guessed price. A row that was
`dispatched` but never reached the signer is failed. Nothing is re-signed.

Known defect at the time of writing (`docs/PHASE_4_REPORT.md`): the
composition root runs the swap executor's reconcile before the LP one, and
the swap reconcile settles LP rows too, so in production the LP booking
above does not happen. The chain still holds the LP tokens and a LIVE cycle
still reads them; the ledger and the dashboard do not.

## The scheduler

Off by default; a stored setting (`lp_scheduler_state`), not a process
flag, so a container restart cannot turn it on. When enabled it walks the
policy's `lp.allowedPools` on the installation's enabled chains every N
seconds and runs one cycle per pool, sequentially. It checks the pause and
emergency switches before each pass and between pools. An emergency stop
disables it outright through the state hook; the operator re-enables it
deliberately after clearing the stop. With no pools listed an enabled
schedule runs nothing and says so in the log.

The interval is validated to 60–86,400 s, but at the time of writing only
whole minutes up to an hour are scheduled correctly (see the Phase 4
report).

## What the dashboard sees

`GET /api/v1/liquidity` — the summary (`null` totals when a position is
unpriced, with the reason), positions for the current mode, the last 50
actions, supported protocols, adapter status per chain with the reason,
the verified example pools, the automation switch and `modelStatus:
"UNTRAINED"`. `POST /api/v1/liquidity/run` runs one cycle now through the
same path. `PUT /api/v1/liquidity/automation` is the pause switch. There is
no "add liquidity" route. `docs/api.md` has the shapes.

Telegram's `/lp` answers from the same view.

## What this skill does not do

- It does not rebalance anything. `REBALANCE` exists in the vocabulary and
  in the engine so a future concentrated-liquidity adapter has something to
  say; on a v2 pool it is overridden to `HOLD`.
- It does not choose how much to remove: `REMOVE_LIQUIDITY` is half,
  `EXIT` is all.
- It does not handle native coins. Pools are `WETH/USDC` and `USDT/WBNB`;
  wrapping would be a second transaction the engine has not seen.
- It does not notify Telegram of LP outcomes in this build.
- It does not claim any performance. No LP position has been opened with
  real funds in the course of building this, and no figure in this
  repository says otherwise.
