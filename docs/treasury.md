# Treasury (Phase 5, sections 5 and 6)

**Date:** 2026-09-20
**Scope:** the project treasury: watch-only balances, expense ledger, burn and
runway, capped payment proposals, a project-admin gate, the Treasury Agent.

Written for: the engineer maintaining `runtime/src/treasury/`, the dashboard
developer wiring the admin page, and anyone asking whether ATRA can spend
project money on its own. It cannot, and this document explains what was
built so that it cannot.

---

## The short version

The treasury is the least powerful subsystem in the runtime, on purpose.

- The treasury wallet is a **watch-only address** the project admin
  configures. It is not in the vault. The runtime holds no key for it and
  there is no code path from the treasury to `WalletService.useSigningKey`,
  because the treasury service is built without the wallet service, the
  vault, the ledger, the trade store or the runtime state.
- A **payment proposal** is a reviewed instruction. It passes a deterministic
  cap engine twice (at proposal and at approval), every check is stored on
  the row, and exporting an approved proposal yields a page of text that a
  human executes from the treasury wallet with their own signer. Nothing in
  the treasury path builds, signs or broadcasts a transaction.
- A provider billed by card, invoice or manual transfer gets a **manual
  payable** — an expense row a human settles — never a payment proposal.
- The **Treasury Agent** is LLM-backed and may only ever produce a proposal.
  Its constructor takes the model provider and nothing else. A review that
  names an unlisted provider, exceeds a cap, or acts while frozen is
  overridden to `NO_ACTION` and recorded as a model failure.
- **Treasury funds and user funds never mix.** Different tables with no
  foreign keys between them, a service that cannot read a user balance, a
  prompt that never contains an agent wallet address, and tests for each.

The model is ATRA-4B, **UNTRAINED**. A Kaggle run is in progress and has not
completed; nothing here claims otherwise.

---

## Funding model

```
launchpad creator fees -> creator wallet -> MANUAL transfer by the project creator
  -> ATRA treasury wallet -> project infrastructure expenses
```

There is no automatic extraction from the token or the launchpad. The
treasury reads the wallet; a human fills it and a human empties it.

---

## Files

| Path | What it is |
|---|---|
| `runtime/src/db/migrations/005_treasury.sql` | Eight `treasury_*` tables, append-only triggers, the proposal state machine |
| `runtime/src/treasury/types.ts` | Shared types; every USD amount a micro-USD decimal string |
| `runtime/src/treasury/caps.ts` | The cap engine: a pure function, every check reported |
| `runtime/src/treasury/burn.ts` | Burn rate and runway: pure functions over expense rows |
| `runtime/src/treasury/balances.ts` | Watch-only balance reader over the chain adapters and the market service |
| `runtime/src/treasury/admin.ts` | The project-admin credential and token gate |
| `runtime/src/treasury/store.ts` | SQL for the `treasury_*` tables only |
| `runtime/src/treasury/address.ts` | Address validation (EIP-55 on EVM, 32-byte base58 on Solana) |
| `runtime/src/treasury/service.ts` | `TreasuryService`: the facade the routes call |
| `runtime/src/agents/treasury/agent.ts` | The Treasury Agent |
| `runtime/src/http/routes/treasury.ts` | `treasuryRoutes(treasury)` and `requireTreasuryAdmin(treasury)` |
| `runtime/test/treasury.test.ts`, `treasury-routes.test.ts` | 46 tests |
| `skills/treasury/SKILL.md` | The operator-facing explanation |

---

## Data model

All money columns are canonical micro-USD strings (`"12.500000"`). Sums are
computed in JavaScript with `bigint`; SQL never adds text.

| Table | Purpose | Mutability |
|---|---|---|
| `treasury_config` | Singleton: admin Argon2id hash and parameters, caps, low-balance threshold, freeze flag with reason/at/by | Updated in place |
| `treasury_addresses` | One watch-only address per chain, its label, the extra tokens to read, enabled flag | Upsert per chain |
| `treasury_providers` | Who ATRA pays: name, category, billing mode, monthly budget, the single allowlisted recipient (chain + address, `on-chain` only, enforced by CHECK), active flag | Updated in place |
| `treasury_expenses` | Period (`YYYY-MM`), amount, kind (`recurring`, `one-off`, `manual-payable`), status (`paid`, `due`, `payable`), source (`imported`, `manual`), note | **Append-only** (triggers refuse UPDATE and DELETE) |
| `treasury_payment_proposals` | Recipient, chain, asset, amount, period, memo, proposer, source (`admin`, `agent`), `checks_json` (the proposal-time cap decision), status, creator-approval flag, decision columns (`decision_json` is the approval-time cap decision), export columns (`export_json` is the instruction) | Every column immutable except the status and the decision/export columns, each of which can be written **once**; status moves only along `proposed -> approved | rejected`, `approved -> exported | cancelled`; no DELETE |
| `treasury_alerts` | Kind, severity, summary, detail JSON, raised/acknowledged | Immutable except `acknowledged_at`; no DELETE |
| `treasury_snapshots` | One row per asset per reading, including failed reads (`amount NULL` with a reason) | **Append-only** |
| `treasury_admin_tokens` | SHA-256 of each admin token, bound to a session id, with expiry | Revocable; expired rows pruned |

None of these tables references `wallets`, `vault_secrets`, the ledger or
trade tables; a test walks `PRAGMA foreign_key_list` on each and asserts it.

---

## The cap engine

`evaluateCaps(input)` in `caps.ts` is a pure function: injected `now`, no
database, no network, no model. It reports every check in a fixed order with
`observed` and `limit` as strings, in the same shape as the risk engine's
`RiskCheck`, and the decision is stored on the proposal row so it can be
re-derived without the code.

| Order | Check | Code | Refuses when |
|---|---|---|---|
| 1 | `treasury.frozen` | `FROZEN` | frozen; every later check is reported as `short-circuit` |
| 2 | `provider.known` | `PROVIDER_UNKNOWN` | the provider id is not registered |
| 3 | `provider.active` | `PROVIDER_INACTIVE` | the provider is deactivated |
| 4 | `provider.billing` | `PROVIDER_NOT_ON_CHAIN` | billing mode is `card`, `invoice` or `manual` |
| 5 | `recipient.allowlisted` | `RECIPIENT_NOT_ALLOWLISTED` | chain or address differs from the provider's entry |
| 6 | `chain.enabled` | `CHAIN_NOT_ENABLED` | no enabled treasury address on that chain |
| 7 | `asset.known` | `ASSET_UNKNOWN` | the asset symbol is not in the chain registry |
| 8 | `amount.positive` | `AMOUNT_INVALID` | zero or malformed |
| 9 | `amount.perPayment` | `PER_PAYMENT_CAP` | amount > per-payment cap |
| 10 | `amount.monthly` | `MONTHLY_CAP` | approved+exported this **calendar month of the decision** + amount > monthly cap |
| 11 | `amount.providerBudget` | `PROVIDER_BUDGET` | expenses + approved proposals for the **billing period** + amount > the provider's budget; `not-applicable` when the budget is 0 |
| 12 | `approval.creator` | `CREATOR_APPROVAL_REQUIRED` | at approval: amount >= threshold and `creatorApproval` was not asserted; at proposal: reported as a preview, `not-applicable` |

Two months are involved and they are different on purpose: the monthly cap
is keyed by the month the approval happens in (it cannot be routed around by
labelling a payment with another period), while a provider's budget is keyed
by the billing period the payment covers (that is what a budget means).

The service calls the engine at `propose` (a failure is refused with the
checks in `errors[]` and an audit row; no proposal row is written) and again
at `approve` against the configuration and approvals of that moment (a
failure moves the row to `rejected` with `decision_json`). A freeze refuses
approval and export without touching the row.

Defaults on a fresh install are all zero, so nothing can be proposed until
the admin sets the caps; an approval threshold of zero means every payment
needs the creator's approval.

---

## Balances, burn and runway

`TreasuryBalanceReader.read()` walks every enabled address, reads the native
coin and each listed token through the chain adapter, prices each through
`MarketService.getCrossCheckedPrice`, and writes a snapshot per asset.

- A failed RPC read is `amount: null` with `reason: "balance unreadable: …"`.
  Never zero: a zero would be indistinguishable from an empty wallet and
  would become a runway of nothing.
- No price, or a disputed price, is `valueUsd: null` with the provider's
  reason. A single-provider price is used but its reason is kept.
- `pricedValueUsd` sums what was priced; `complete` is false and `incomplete`
  lists the missing assets whenever anything is missing.

`burnRate(expenses, now)` averages the trailing three calendar months (the
current month and the two before) that have any recorded expense, every
status counted, and labels the result: `trailing-3`, `trailing-2`,
`single-month` (with a reason saying it is an estimate), or `none`.

`runway(balance, reason, burn)` is `balance / burn` to two decimals, floored,
and `null` with a reason when the balance is incomplete, when there is no
burn, or when the burn is zero.

Alerts raised from these reads: `balance_unreadable` (warning),
`price_unknown` (info), `low_balance` (critical, when the total is complete
and below the threshold), `runway_short` (critical, under three months),
`budget_exceeded` (warning from expenses; info from an agent
`REVIEW_BUDGET`). Alerts are deduplicated on `kind` + a key while an identical
one is open.

---

## The Treasury Agent

`TreasuryAgent(llm)` renders the treasury's own data — balances, burn, runway,
caps, providers with their period spend, pending proposal count, open alerts
— and asks the model for `{ summary, concerns[], recommendedActions[],
confidence }`, where each action is one of `NO_ACTION`, `REVIEW_BUDGET` or
`PROPOSE_PAYMENT` with a provider name and a USD amount.

Deterministic checks after parsing (`deterministicSanity`): `NO_ACTION` must
carry no provider and `"0"`; any other action needs a registered, active
provider; a `PROPOSE_PAYMENT` must be positive, within the per-payment cap,
within the remaining monthly cap and within the provider's remaining budget;
and while frozen everything but `NO_ACTION` is a violation. One violation
overrides the whole recommendation list to a single `NO_ACTION` with the
reason, and the service raises a `model_override` alert and writes the review
audit row with status `rejected`.

What a surviving recommendation becomes, in `TreasuryService.run()`:

| Recommendation | Outcome |
|---|---|
| `NO_ACTION` | nothing |
| `REVIEW_BUDGET` | a `budget_exceeded` alert (info) naming the provider and the suggested figure |
| `PROPOSE_PAYMENT` to an `on-chain` provider | a proposal row, `source = 'agent'`, `status = 'proposed'`, through the same `propose()` and the same caps as an admin request |
| `PROPOSE_PAYMENT` to a card/invoice/manual provider | a manual payable expense row; never a proposal |

The agent never approves, never exports, never sees the admin credential,
and its prompt never contains an agent wallet address (tested).

---

## The admin gate

The treasury dashboard is for the project admin, not a normal user. The
operator password cannot be reused for it because it should not be: signing
into the dashboard lets someone watch the agent wallets; moving project money
should need something the operator's browser session does not carry.

`runtime/src/core/auth.ts` is not touched. The gate lives entirely in
`runtime/src/treasury/admin.ts` and `runtime/src/http/routes/treasury.ts`:

- **Setup** — `POST /admin/setup`, `localOnly()` + `requireSession()`, body
  `{ adminSecret }` (16–512 characters). Argon2id with the install's KDF
  parameters, stored in `treasury_config`; the store's conditional update
  makes it single-use even under a race. 409 `ALREADY_INITIALIZED` after.
  There is no reset route: whoever holds the database file resets it.
- **Login** — `POST /admin/login`, session required, same body. Five wrong
  secrets in fifteen minutes lock the check for five minutes (429 with
  `retryAfterSec`), before the KDF runs. Success returns
  `{ token: "tadm_…", expiresAt, header }`; the token is 32 random bytes,
  stored as SHA-256, bound to the session id, valid 30 minutes.
- **Gate** — `requireTreasuryAdmin(treasury)` runs after `requireSession()`
  on every other route and calls `admin.resolve(token, session.id)`. Missing
  header: `403 REAUTH_REQUIRED`, `errors[0] = { path: 'x-atra-treasury-admin',
  message: 'TREASURY_ADMIN_REQUIRED' }`. Unknown, expired, revoked or
  another session's token: `403 REAUTH_INVALID` / `TREASURY_ADMIN_INVALID`.
  Twenty invalid presentations from one session in five minutes: `429`.
- **Status** — `GET /admin/status` (session only) returns
  `{ configured, authenticated, frozen, header }` so the dashboard can pick
  the setup or login form. It reveals nothing else.
- **Logout** — `POST /admin/logout` revokes the session's tokens.

The existing error codes are reused because `runtime/src/util/errors.ts` is
not a treasury file; the sub-code is carried in `errors[0].message`, the same
convention the withdrawal route uses for `INVALID_ADDRESS`.

**Threat model, honestly.** This is a second factor for a single-operator
install. It defends against the realistic cases: a dashboard session left
open, a browser extension, a CSRF-shaped request, a bug elsewhere in the
runtime reaching a treasury route with only the operator's cookie. It does
not defend against code execution on the machine (the token hash and the
Argon2 hash are in the same database the vault is in) or against a weak
secret with unlimited offline time — the same limits the operator password
has, stated in `SECURITY.md`. The host and CSRF guards of the main server
apply to these routes as to every other.

---

## Routes

Mounted by the orchestrator at `/api/v1/treasury`. Every route below the
admin block requires the session cookie and `x-atra-treasury-admin`, and
writes an `audit_events` row with `category: 'system'`, `actor:
'treasury-admin'`. Errors are problem documents; successes are envelopes.

| Method | Path | Body / query | Returns |
|---|---|---|---|
| GET | `/admin/status` | — | `{ configured, authenticated, frozen, header }` |
| POST | `/admin/setup` | `{ adminSecret }` | 201; 409 after the first |
| POST | `/admin/login` | `{ adminSecret }` | `{ token, expiresAt, header }` |
| POST | `/admin/logout` | — | `{ revoked }` |
| GET | `/` | — | the dashboard (below); `meta.source: 'rpc'`, `meta.asOf` = reading time, `meta.reason` when incomplete |
| GET | `/config` | — | `TreasuryConfig` |
| PUT | `/config` | `{ caps?: {…}, addresses?: [{ chain, address, label, tokens?, enabled? }] }` | `TreasuryConfig` |
| GET | `/providers` | — | `ProviderView[]` (with period spend and remaining budget) |
| POST | `/providers` | `{ name, category, billingMode, monthlyBudgetUsd?, recipient?, note? }` | 201 `Provider`; 422 when an `on-chain` provider has no recipient or a non-on-chain one has one |
| PUT | `/providers/:id` | any subset plus `active` | `Provider` |
| GET | `/expenses` | `?period=YYYY-MM&providerId=&limit=` | `Expense[]` |
| POST | `/expenses` | `{ providerId, period, amountUsd, kind?, status?, source?, note? }` | 201 `Expense` |
| GET | `/proposals` | `?status=&limit=` | `PaymentProposal[]` |
| POST | `/proposals` | `{ providerId, amountUsd, asset, period?, memo? }` — **no recipient field** | 201 `PaymentProposal`; 409 with the failing checks in `errors[]` |
| POST | `/proposals/:id/approve` | `{ creatorApproval?, note? }` | `PaymentProposal`; 409 with checks when refused (row moves to `rejected`); 409 `FROZEN` untouched |
| POST | `/proposals/:id/reject` | `{ note }` | `PaymentProposal` |
| POST | `/proposals/:id/cancel` | `{ note }` | `PaymentProposal` (approved only) |
| POST | `/proposals/:id/export` | — | `ExportedInstruction` (below); 409 when frozen or not approved |
| POST | `/freeze` | `{ reason }` | `TreasuryConfig` |
| POST | `/freeze/clear` | `{ note }` | `TreasuryConfig`; 409 when not frozen |
| POST | `/run` | — | 202 `TreasuryReviewReport`; 409 while one runs |
| GET | `/alerts` | `?all=true&limit=` | `TreasuryAlert[]` (open ones by default) |
| POST | `/alerts/:id/ack` | — | `TreasuryAlert` |

### The dashboard (`GET /`)

```
notice                      the watch-only statement, verbatim
admin.configured, .setAt
frozen.active, .reason, .at, .by
caps                        { lowBalanceThresholdUsd, perPaymentCapUsd, monthlyCapUsd, approvalThresholdUsd }
addresses[]                 the watch-only addresses
balances                    { takenAt, assets[], pricedValueUsd, complete, incomplete[] }
spend                       { period, expensesThisPeriodUsd, approvedProposalsThisMonthUsd, remainingMonthlyCapUsd }
burn                        { monthlyUsd | null, windowPeriods, usedPeriods, totalUsd, basis, reason }
runway                      { months | null, balanceUsd, monthlyBurnUsd, reason }
providers[]                 Provider + { spentThisPeriodUsd, remainingBudgetUsd | null, overBudget }
proposals                   { pending[], approved[], rejected[], exported[], cancelled[] }
manualPayables[]            manual-payable expenses recorded, newest first (see below)
recentExpenses[]
alerts[]                    open alerts
modelStatus                 'UNTRAINED'
```

Every `null` above comes with a `reason` next to it. Render it as unknown.

`manualPayables` is a list of obligations recorded, not a queue the runtime
clears: expenses are append-only, so a payable is never marked paid in place.
The creator settles it by card or bank transfer and the row remains the
expense record for that period. Recording a second "paid" row for the same
bill would double-count the burn rate; do not.

### The exported instruction

```
proposalId, exportedAt
chain, chainDisplayName, evmChainId | null
from                        the watch-only treasury address on that chain
recipient, recipientExplorerUrl
asset                       { symbol, address, decimals }
amountUsd
amountBaseUnits | null      at the cross-checked price observed at export, floored
amountDecimal | null
price | null                { priceUsd, sources[], observedAt }
priceReason | null          why the amount is null, or a caveat on the price
memo, provider { id, name }
approvedBy, approvedAt, creatorApproval
checks[]                    the approval-time checks, verbatim
notice                      "The treasury wallet is watch-only. ATRA holds no key for it…"
```

There is no `data`, `nonce`, `gas`, `signature`, `raw` or `payload` field
and a test asserts their absence. A null `amountBaseUnits` means the price
was unknown or disputed at export; the USD figure stands and the human
converts it.

---

## Verification

### Tests (`runtime/test/treasury.test.ts`, `treasury-routes.test.ts`)

46 tests, all passing:

- the service exposes no method containing sign, broadcast, transfer,
  withdraw, send or useSigningKey; its deps type rejects `wallets`, `ledger`
  and `vault` at compile time (`@ts-expect-error`); the agent constructor
  takes one argument and its prototype is `constructor` and `review`; no
  `treasury_*` table has a foreign key outside `treasury_*`
- caps: safe zero defaults; per-payment over-limit refused with the check
  and no row; recipient mismatch at the engine; monthly cap refused at
  approval with the exact observed string; approval threshold without the
  creator flag refused, with it approved; provider budget and inactive
  provider refused; a card provider never yields a proposal (admin request
  refused, agent recommendation becomes a manual payable)
- freeze: refuses approval, export and new proposals; needs no model; alert
  raised; clearing audited and refused when not frozen; survives a restart
  on a file-backed database
- proposals: export instruction contents and the absence of transaction
  fields; unpriced export gives null with a reason; reject, cancel and the
  trigger-enforced transitions; UPDATE and DELETE refused on expenses,
  snapshots, alerts and proposals
- balances: priced through fake adapters and two fake providers; a failing
  RPC gives null with the error, an alert, no duplicate alert, and a null
  runway; an unpriced asset gives a null runway with the asset named
- burn: `none`, `single-month`, `trailing-2`, `trailing-3` with the months
  named; runway arithmetic; zero-burn runway is null
- agent: no model gives `NO_ACTION` (`UNAVAILABLE`); scripted `NO_ACTION`
  changes nothing; a within-cap `PROPOSE_PAYMENT` becomes a `proposed` row
  with `source: 'agent'`; an unlisted provider is overridden and alerted;
  over-cap, over-budget, frozen and malformed shapes are overridden; a
  `REVIEW_BUDGET` raises one alert and is deduplicated; the prompt contains
  no agent wallet address
- routes: setup is loopback-only, session-gated, length-checked, single-use,
  and the secret is nowhere in the database dump; login before setup is 409,
  five wrong secrets lock it; all nineteen admin routes refuse without a
  session (401), without the token (403 `TREASURY_ADMIN_REQUIRED`), with a
  bad token (403), and with another session's token (403
  `TREASURY_ADMIN_INVALID`), writing nothing; twenty bad tokens throttle a
  session; logout revokes; the dashboard shape; the full
  propose → reject → approve → export → 409 walk; strict schemas with no
  recipient field; a card provider's manual payable; freeze through the API;
  `POST /run` with a scripted `NO_ACTION`; treasury calls leave the agent
  wallets and the ledger untouched

### Live probe (2026-09-20, read-only, nothing signed)

Real adapters (`buildAdapters`), real market providers, in-memory database:

| What | Endpoint | Result |
|---|---|---|
| Native balance of the Base WETH contract `0x4200…0006` | `mainnet.base.org` | 239,554.967918 ETH read; priced at 2620.58 USD by one provider (the other returned nothing), value computed |
| USDC balance of the same address | `mainnet.base.org` | 167.551481 USDC; priced 1.000034 |
| SOL balance of the Jupiter program `JUP6…TaV4` | `api.mainnet-beta.solana.com` | 6.944115527 SOL; priced 110.11 |
| USDC balance of the same Solana address | `api.mainnet-beta.solana.com` | **failed**: `Invalid parameter: invalid value: map, expected map with a single key` — reported as `amount: null` with that reason; total flagged incomplete; runway `null` naming the asset |
| Direct JSON-RPC, same call with `{ mint, programId }` | same | same error, reproduced |
| Direct JSON-RPC, same call with `{ mint }` only | same | succeeds, returns the token account |
| Export pricing of 2.5 USD in USDC on Base | DexScreener via `MarketService` | `amountBaseUnits: 2499915` at 1.000034; the single-provider caveat carried in `priceReason` |

The Solana failure is a defect in `runtime/src/chains/solana/adapter.ts`
(`getTokenBalance` sends a two-key filter that the public RPC, apiVersion
4.2.1, rejects). It is outside the treasury's files and is reported to the
orchestrator with the fix; the treasury's handling of it — null, reason,
incomplete, no runway — is exactly the behaviour the design asks for.

---

## Honest limitations

| Limitation | Note |
|---|---|
| The runtime cannot execute a treasury payment | By design, and permanent for this build. The export is text. |
| The monthly cap is keyed by the approval month; the provider budget by the billing period | Documented above; both are recorded on the row |
| Budget alerts for a provider are raised on expense entry and on each review, not on a schedule | There is no treasury scheduler; `POST /run` is the review |
| `GET /` reads balances live and writes snapshots and alerts as a side effect of a read | Deliberate: the admin dashboard is the reading. A separate refresh endpoint can be added if the dashboard polls |
| A manual payable is never marked paid | Expenses are append-only by specification; the payable row is the expense record, and settlement is not tracked in the runtime |
| Single-provider prices are used, with the caveat kept | Refusing them would leave most assets unpriced with today's providers |
| The Treasury Agent is UNTRAINED and, in CI, absent | Every review is labelled; no review is required for anything to work |
| Solana token balances fail on the public RPC | Adapter defect, outside these files; see the probe |
| No treasury route exists in the dashboard yet | The frontend is another engineer's |
