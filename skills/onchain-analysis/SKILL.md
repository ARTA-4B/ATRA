---
name: onchain-analysis
description: How ATRA reads chain state on Base, BNB Smart Chain, Robinhood Chain and Solana, verifies it is talking to the right chain, and treats what it cannot read.
phase: 2
---

# On-chain analysis

## What this skill does

Reads state directly from a chain: native balances, token balances, token
metadata, transaction status, block or slot height, and fee estimates. It is
the ground truth the market layer is checked against.

## The four chains, and only four

| Chain | Family | Identity | Native | Public endpoint |
|---|---|---|---|---|
| Base | EVM | chain id 8453 | ETH, 18 dec | `mainnet.base.org` |
| BNB Smart Chain | EVM | chain id 56 | BNB, 18 dec | `bsc-dataseed.bnbchain.org` |
| Robinhood Chain | EVM | chain id 4663 | ETH, 18 dec | `rpc.mainnet.chain.robinhood.com` |
| Solana | Solana | genesis `5eykt4Us…dw2N9d` | SOL, 9 dec | `api.mainnet-beta.solana.com` |

Anything else is rejected with `CHAIN_UNSUPPORTED`. ATRA never substitutes one
chain for another: a request for `robinhood` gets Robinhood Chain or an error.

## Identity is verified before anything is trusted

Every adapter's `health()` confirms the endpoint really serves the chain it
claims to:

- EVM: `eth_chainId` must equal the registry value;
- Solana: `getGenesisHash` must equal the mainnet-beta genesis.

A mismatch is a hard failure, not a warning. Pointing ATRA at the wrong RPC is
a realistic misconfiguration, and reading BNB balances while believing they
are Base balances would be worse than an outright outage.

## What "unreadable" looks like

**An RPC failure surfaces as an error, never as a zero.** A zero balance is
indistinguishable from an empty wallet, and it would flow straight into the
risk engine's balance check as if it were observed. So:

```
native: null
error: "base RPC call getBalance failed"
```

not

```
native: { amount: "0" }
```

The dashboard shows "unavailable". The risk engine, which requires a fresh
balance reading before any action, refuses with `DATA_STALE`.

## Chain-specific facts that bite

**BNB Smart Chain's pegged stablecoins use 18 decimals**, not the 6 they have
on other chains. USDT and USDC on BSC are both 18. Token decimals are always
read from the contract, never assumed from the symbol.

**Robinhood Chain's WETH is not at the OP-stack address.**
`0x4200…0006` is WETH on Base and returns empty code on Robinhood Chain. Its
WETH is `0x0bd7…ad73`. Nothing in the registry is derived by copying an address
from another chain.

**Solana token balances live in two programs.** A mint issued under Token-2022
is invisible to a Token-program-only lookup and would read as zero. Both
programs are queried and summed.

**Solana rent is queried, not hard-coded.** The rent-exempt minimum for a
165-byte account is 1,488,440 lamports today; the historical 2,039,280 figure
that appears in many examples is wrong.

**Robinhood Chain is an Arbitrum Orbit L2**, so fees include an L1 data
component. Its public endpoint is rate limited; production use wants a keyed
provider supplied by the operator.

## Every reading is dated and attributed

```
{ value, observedAt, source }
```

`source` is the endpoint that produced the reading. `observedAt` is when ATRA
received it. Nothing downstream may use a number whose age it cannot compute.

## Bring your own endpoint

Public endpoints are keyless, rate limited and fine for getting started. An
operator supplies their own through `ATRA_RPC_BASE`, `ATRA_RPC_BSC`,
`ATRA_RPC_ROBINHOOD` and `ATRA_RPC_SOLANA`. A URL containing an API key is a
secret and stays out of version control.

The identity check applies to a custom endpoint exactly as it does to a public
one.

## What this skill will not do

- read a balance from a cache and present it as current;
- guess a token's decimals from its symbol;
- accept an endpoint that reports the wrong chain;
- return a fabricated figure when the network is down.

## Related

- `skills/market-research/SKILL.md` — market data, cross-checked against this
- `skills/wallet/SKILL.md` — whose balances are being read
