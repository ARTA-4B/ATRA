---
name: treasury
description: How the project treasury works — watch-only balances, expense tracking, burn and runway, capped payment proposals that a human executes elsewhere — and why nothing in it can sign, trade, or touch user funds.
phase: 5
---

# Treasury

## What the treasury is

The treasury is the money that pays for ATRA's own infrastructure: RPC
providers, hosting, data, the model endpoint, a domain. It is funded by hand:

```
launchpad creator fees
  -> creator wallet
    -> MANUAL transfer by the project creator
      -> ATRA treasury wallet
        -> infrastructure expenses
```

There is no automatic extraction from the token or the launchpad, and there is
no code in this repository that could perform one.

## What the treasury is not

It is not an agent wallet, it is not the operator's money, and it is not
something the runtime can spend.

- **The treasury wallet is watch-only.** The project admin types its address
  into the treasury configuration. The address is not in the vault; the
  runtime holds no key for it; nothing under `runtime/src/treasury/` can reach
  `WalletService.useSigningKey`, because the treasury service is constructed
  without the wallet service, the vault, the ledger or the trade store. A test
  asserts that dependency shape and refuses to compile if a wallet is added.
- **A payment proposal is an instruction, not a transaction.** Approving a
  proposal records a decision; exporting it produces a page of text — chain,
  source address, allowlisted recipient, asset, USD amount, the base-unit
  amount at the observed price, the checks it passed, who approved it — that a
  human reads and executes from the treasury wallet with their own signer,
  somewhere that is not this process. There is no calldata, no nonce, no
  signature and no broadcast anywhere in the treasury path.
- **Treasury funds and user funds never mix.** The treasury tables have no
  foreign key into the wallet, ledger or trade tables; the treasury service
  cannot read a user balance; the Treasury Agent's prompt is assembled from
  the treasury's own data and never contains an agent wallet address.

## What the Treasury Agent may and may not do

It may: read the treasury balances, track the infrastructure budget, keep the
expense ledger, estimate burn rate and runway, raise low-balance alerts, and
*propose* a payment to an allowlisted provider.

It must not, and cannot: trade, add liquidity, speculate, buy tokens,
transfer to an arbitrary recipient, bypass a cap, or mix treasury and user
funds. Its constructor takes the model provider and nothing else; there is no
object in its reach on which any of those could be invoked.

`NO_ACTION` is the expected answer. A review that names a provider not on the
list, an amount over a cap, or any action while the treasury is frozen is
overridden to `NO_ACTION` wholesale and recorded as a model failure
(`treasury_alerts.kind = 'model_override'`, audit status `rejected`). A
`PROPOSE_PAYMENT` that survives becomes a *proposal* row awaiting a human;
the agent never approves, never exports, and never sees the admin credential.

The model behind it is ATRA-4B, which is **UNTRAINED**. A Kaggle training run
is in progress and has not completed; until a run finishes and `evaluate.py`
passes, every review is labelled `modelStatus: UNTRAINED`.

## The caps

Every proposal is measured by a pure function (`runtime/src/treasury/caps.ts`)
in a fixed order, and every check is stored on the proposal row with what was
observed and what the limit was, so an approval can be re-derived from the row
months later:

| Check | Refuses when |
|---|---|
| `treasury.frozen` | the freeze flag is set (short-circuits everything below) |
| `provider.known` / `provider.active` | the provider is unknown or inactive |
| `provider.billing` | the provider is not billed `on-chain` |
| `recipient.allowlisted` | the recipient is not the provider's one allowlisted address on its chain |
| `chain.enabled` | no enabled treasury address exists on that chain |
| `asset.known` | the asset is not a token the registry lists for the chain |
| `amount.positive` | the amount is zero or malformed |
| `amount.perPayment` | amount > `perPaymentCapUsd` |
| `amount.monthly` | approved this calendar month + amount > `monthlyCapUsd` |
| `amount.providerBudget` | provider spend for the billing period + amount > its budget (skipped when no budget is set) |
| `approval.creator` | amount >= `approvalThresholdUsd` and the approver did not assert the creator's approval (checked at approval time) |

The caps are evaluated at proposal time (a request that fails is refused and
no row is written) and again at approval time against the configuration and
approvals of *that* moment; a proposal that fails at approval moves to
`rejected` with the failing checks recorded. A fresh install has every cap at
zero, so nothing can be proposed until the admin sets them.

There is no recipient field on a proposal request. The recipient is always
the provider's allowlisted address, and a provider billed by card, invoice or
manual transfer has no address at all: its bills are recorded as **manual
payables** (`treasury_expenses.kind = 'manual-payable'`), an obligation for a
human to settle, never a payment path.

## The freeze

`POST /api/v1/treasury/freeze` writes one row. It takes effect on the next
read, needs no model and no network, refuses approval, export and new
proposals while set, and survives a restart. Clearing it is a separate,
audited action (`POST /freeze/clear`). It is independent of the runtime's
emergency stop: the emergency stop is about user funds and the agents that
move them; the freeze is about project money. Neither depends on the other.

## The admin gate

Treasury routes are not part of the operator dashboard. They need the
operator's session **and** a second credential:

1. `POST /api/v1/treasury/admin/setup` — loopback only, session required,
   sets the admin secret once (Argon2id, parameters stored beside the hash).
   409 forever after; there is no reset route.
2. `POST /api/v1/treasury/admin/login` — exchanges the secret for a token
   (`tadm_…`, 30 minutes, SHA-256 stored, bound to the session that obtained
   it). Five wrong secrets in fifteen minutes lock the check for five minutes.
3. Every other treasury route requires `x-atra-treasury-admin: <token>` on
   top of the session cookie. A missing token is `403 REAUTH_REQUIRED` with
   `errors[0].message = TREASURY_ADMIN_REQUIRED`; a wrong, expired or
   other-session token is `403 REAUTH_INVALID` / `TREASURY_ADMIN_INVALID`;
   twenty invalid tokens from one session in five minutes are throttled with
   `429`.

The threat model, honestly: this is a second factor for a single-operator
install, not a multi-user permission system. It defends against a dashboard
session left open, a browser extension, a CSRF-shaped request, or a bug
elsewhere in the runtime reaching a treasury route with only the operator's
cookie. It does not defend against code execution on the machine or against
a weak secret with unlimited offline time, the same limits the operator
password has.

## Burn rate and runway

- Burn = average of the trailing three calendar months (the current month and
  the two before) that have recorded expenses, every status counted. The
  result names the months used. One month is labelled `single-month` with a
  reason; two are `trailing-2`; none is `null` with a reason.
- Runway = priced balance / burn, to two decimals, floored. It is `null` with
  a reason when any enabled asset could not be read or priced, when there is
  no burn, or when the burn is zero. It is never zero, never infinite and
  never built on a partial balance.
- A failed RPC read is reported with the error and stored as a snapshot with a
  null amount; it is never a zero balance. A price the market layer cannot
  cross-check, or that its providers dispute, leaves the asset unpriced.

## Reading the audit trail

Every treasury route, reads included, writes an `audit_events` row with
`category = 'system'` and `actor = 'treasury-admin'`; agent-created proposals
carry `actor = 'agent:treasury'`. Proposal rows share their id as the
`correlationId` of every audit row about them, so one query shows a payment's
whole life: `treasury.proposal.created` → `.approved` or `.rejected` →
`.exported` or `.cancelled`.

## For the person holding the treasury wallet

- The runtime cannot spend your money. If a screen or a message ever offers to
  sign or send for the treasury, that is a bug or a fake; report it.
- An exported instruction is a request. Check the recipient against the
  provider's allowlist entry, check the amount, then execute it yourself.
- Freeze first, ask questions later. Freezing costs nothing and stops nothing
  that was already yours to do by hand.

## Related

- `docs/treasury.md` — the routes, the data model and the design decisions
- `skills/emergency-exit/SKILL.md` — the operator-side stop, which the freeze
  does not replace
- `SECURITY.md` — property 10: user funds and project treasury funds never mix
