# PAPER versus LIVE

Written for: an operator deciding whether paper results mean anything, and an
engineer who needs the exact differences rather than the slogan. State of the
code on 2026-09-20.

**No live trade, live LP action or live withdrawal has ever been executed by
this project.** The live path is complete and tested against fake chains and
verified against mainnet up to, and not including, signing. Every number in
every phase report comes from PAPER runs against real market data, or from
tests.

## The short version

Same research, same model, same proposal builder, same risk engine, same
limits, same audit trail. The mode changes exactly three things: where the
balance comes from, what the executor does with an allowed action, and how
the fill is booked.

## What is identical

| Stage | PAPER and LIVE |
|---|---|
| Research | Real providers (DexScreener, GeckoTerminal), real chain reads, real staleness and dispute handling |
| Decision | The same model, the same schema, the same overrides for a contradicting reply |
| Proposal | Integer sizing from the cross-checked price, a **real quote** from the real router or aggregator (Jupiter, PancakeSwap v2, Aerodrome v2), the real contracts and programs the transaction would touch, the real fee estimate |
| Risk engine | The same 33 swap checks and LP checks, the same policy, the same rejection codes, the same idempotency keys and cooldowns |
| Allowlists and limits | The same numbers. PAPER and LIVE share one policy so paper results predict live behaviour |
| Audit trail | Every decision, every rejection, every fill, correlated by cycle id, with `mode` on every row |
| Emergency stop, pause, scheduler | Identical; the stop disarms both |
| Withdrawals | **Not simulated in either mode.** A withdrawal is the operator moving real funds out of the agent wallet; it signs and broadcasts in PAPER as in LIVE (`wallet/withdrawal.ts`). PAPER stops the agent, not the operator |

## What differs

| | PAPER | LIVE |
|---|---|---|
| Balance the engine checks | The **paper ledger**, seeded by the operator through `PUT /api/v1/trading/paper-balances`; never inferred from a real wallet | The real wallet, read from the chain immediately before the decision; an unreadable balance is `DATA_STALE`, never zero |
| Native token for gas | Paper balance of the native token | The real native balance; `BALANCE_INSUFFICIENT` if it cannot cover the fee |
| Simulation | None on the chain for swaps (the quote stands in) | `adapter.simulate(quote)` on the chain before anything is signed; a revert costs nothing and ends the action. **Exception: the LIVE LP executor has no simulation step** (Phase 4 report) |
| Signing | Nothing is signed. Zero signing contexts are created; a test asserts it | Inside `WalletService.useSigningKey`, synchronously, one operation, plaintext wiped on return |
| Broadcast | Nothing touches the network after the quote | The hash is written to the trade row **before** the transaction is sent; then broadcast; then a bounded poll for the receipt (90 s) |
| Fill amount | The quote's expected output **minus half the slippage tolerance minus 5 bps**: a deliberately pessimistic haircut (`execution/paper.ts`, `PAPER_EXTRA_SLIPPAGE_BPS`). Never the full expected amount. A paper fill below `minAmountOut` fails, as the chain would revert it | What the chain reports: ERC-20 `Transfer` logs to the wallet, or Solana pre/post token balances. Never the quote. If the receipt exposes no transfer, the fill is booked at `minAmountOut` and labelled `min-out-lower-bound` |
| Fee | The full estimated fee at the current native price, charged as realized loss the moment the fill lands | The fee the chain charged, from the receipt |
| Cost basis of the received asset | Booked at what was **paid**, so slippage shows as unrealized P&L from the first instant | Same rule, with the chain-reported amount |
| Position rows | `positions.mode = 'PAPER'`, dashboard `status: SIMULATED`, `source: paper-sim` | `mode = 'LIVE'`, `status: LIVE`, `source: chain`. PAPER and LIVE never share a row |
| Fill rows | `fills.simulated = 1`, `txHash = null` | `simulated = 0`, the real hash |
| ERC-20 approvals | Not needed; nothing is pulled from a wallet | An exact-amount `approve` is proposed, risk-checked, executed and confirmed before the swap; never unlimited |
| Restart | Nothing to reconcile | Rows in `signed` or `broadcast` are settled by asking the chain; a row that died in `dispatched` is failed; nothing is re-signed; a reconciled fill is booked with the chain-reported amount and no fill-time price, and the audit row says so |
| LP fee accrual | **Not simulated.** A paper LP position reports zero fees with a note; `COLLECT_FEES` is refused on paper before it reaches the engine | `claimFees` on the pool (Aerodrome); PancakeSwap v2 fees compound and cannot be claimed |
| LP mint and burn | The pair contract's own formula from the reserves as read (matched to Aerodrome's router at a pinned block; Phase 4 report) | The router's quote, then what the chain minted or returned |

## What PAPER results do and do not tell you

They tell you what the model proposes on real market data, which limits it
hits, how often the engine says no and why, what the fee drag looks like at
your position sizes, and whether the whole loop runs unattended.

They do not tell you what a real fill would have been. The haircut is a fixed
model, not an order-book simulation; a real fill lands somewhere inside the
slippage tolerance and can be worse in a thin market or during a sandwich.
They do not include failed transactions, which cost gas in LIVE and nothing
in PAPER, nor approval gas on EVM chains, nor the LP simulation gap above.

Nothing in a PAPER ledger is a claim about profit. No performance figure
exists for this project, in either mode, and none will be invented.

## How LIVE is entered, and left

Entering: six checklist steps within ten minutes, a re-authentication, then
`POST /api/v1/control/mode/live`. Every step is a timestamp; the steps are
consumed by the activation. Details: [security-model.md](security-model.md).

Leaving, automatically: a restart; a risk-policy change; the emergency stop;
twelve hours after activation. Leaving, deliberately:
`POST /api/v1/control/mode/paper`, always allowed, no checklist.

In LIVE the executor re-checks the mode, the pause and the stop immediately
before signing. A LIVE-mode action while the runtime is in PAPER is refused
by the engine (`MODE_MISMATCH`) and again by the executor.

## Which chains can execute

| Chain | Swap | LP |
|---|---|---|
| Solana | Jupiter v6 (`lite-api.jup.ag`, rate limited; keyed endpoint via config) | no adapter |
| BNB Smart Chain | PancakeSwap v2 router | PancakeSwap v2 pools |
| Base | Aerodrome v2 router | Aerodrome v2 pools |
| Robinhood Chain | no adapter (Uniswap v4 Universal Router not implemented) | no adapter |

A chain without an adapter is observable and the runtime says exactly why it
cannot execute there (`GET /api/v1/trading/execution`,
`GET /api/v1/liquidity/adapters`). The trader returns `NO_ACTION` and the
liquidity manager `HOLD` for those chains without consulting a model.

## Before your first LIVE cycle

Not advice, a list of what the code cannot check for you:

- run PAPER for long enough to see rejections you understand;
- fund the agent wallet with an amount you can lose entirely, and gas on top;
- point `ATRA_RPC_BASE` at a keyed endpoint if you trade on Base: the public
  endpoint rate-limits the LP adapter's pool reads (Phase 4 report);
- take a backup ([wallet-recovery.md](wallet-recovery.md));
- know where the emergency stop is, and that it does not sell anything.
