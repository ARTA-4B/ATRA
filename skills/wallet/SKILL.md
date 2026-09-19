---
name: wallet
description: How ATRA creates, holds, reads and exports agent wallet keys, and the boundaries the agent must never cross.
phase: 1
---

# Wallet

## What this covers

The agent wallets ATRA creates during setup, the keys behind them, and every
operation that reads or reveals those keys.

ATRA creates **two** wallets:

| Wallet | Curve | Serves |
|---|---|---|
| EVM | secp256k1 | Base, BNB Smart Chain, Robinhood Chain |
| Solana | ed25519 | Solana |

One EVM key covers all three EVM chains because they share address derivation.
The operator funds one address per chain, not one per key.

## Hard constraints

These are enforced in code, not by convention. An agent cannot talk its way
past them.

1. **The model never sees a private key.** No prompt, tool result, research
   input or log line contains key material. The reasoning layer works with
   addresses, balances and amounts.
2. **Keys never leave the machine.** There is no upload, no backup service, no
   telemetry. ATRA has no server that could receive one.
3. **Keys are never sent through Telegram.** The Telegram gateway has no export
   command and no code path that reads a secret.
4. **Export requires a fresh re-authentication.** A valid dashboard session is
   not enough: the operator re-enters the password, receives a single-use token
   scoped to `wallet.export`, and the request must come from the machine
   itself.
5. **ATRA never asks for a seed phrase.** It creates new agent wallets. Any
   prompt asking an operator to type a recovery phrase into ATRA is not ATRA.
6. **Plaintext lifetime is bounded.** A decrypted secret exists inside one
   synchronous callback and is overwritten when it returns. It is never
   converted to a string except at the export boundary.

## How keys are protected at rest

```
operator password
  → Argon2id (46 MiB, t=2, p=1, per-install salt)
    → key-encryption key
      → XChaCha20-Poly1305 unwraps the data-encryption key
        → XChaCha20-Poly1305 decrypts one secret, bound by AAD to its own row
```

Only the data-encryption key is held in memory, only while the vault is
unlocked, and it is dropped after 30 idle minutes or on shutdown. Changing the
password rewraps that one key; the per-secret ciphertexts are untouched.

The AAD binds each ciphertext to its row identity, so a secret copied into
another row fails to decrypt instead of silently authenticating.

## Operations

| Operation | Needs | Notes |
|---|---|---|
| Create agent wallets | session, unlocked vault, loopback | Idempotent. Returns addresses only. |
| List wallets | session | Addresses, families, creation time. |
| Deposit address | session | One per enabled chain, each with a network warning. |
| Read balances | session | Native plus allowlisted tokens. |
| Transaction history | session | Local records, not a chain scan. |
| Export | session + re-auth token + loopback + typed confirmation | The only path that returns key material. |

### Export formats

| Format | Produces | Imports into |
|---|---|---|
| `evm-private-key` | `0x` + 64 hex characters | any EVM wallet |
| `evm-keystore` | Web3 Secret Storage v3 JSON | geth, ethers, MetaMask |
| `solana-id-json` | 64-byte JSON array | `solana-keygen`, Solana CLI |
| `solana-base58` | base58 of the 64-byte secret | Phantom, Solflare |

Every export response carries this warning, and the dashboard shows it before
the value:

> Anyone holding this value controls the wallet and everything in it. ATRA
> cannot revoke it, reverse a transfer or recover funds sent by someone who
> copied it. Store it offline.

## Balance reporting

A chain whose RPC cannot be reached reports an **error**, never a zero balance.
A fabricated zero is indistinguishable from an empty wallet, and it would flow
straight into the risk engine's balance check as if it were real.

Low native balance is flagged when the wallet cannot cover three plain
transfers, which gives the operator room to notice before an agent is stranded
mid-position.

## What the agent may do

- read balances and addresses
- read transaction history
- report that gas is low
- report that a chain is unreachable

## What the agent may never do

- request, read or reason about a private key
- initiate an export
- send funds to an address the operator has not allowlisted
- claim a balance it could not read

## Audit

Every wallet operation appends an audit row: creation, each export (format and
address, never the material), every balance read that failed. The audit table
rejects UPDATE and DELETE at the database level.

## Recovery

The encrypted vault lives in the data directory alongside the database. Back up
that directory and you have backed up the wallet — but the backup is only
openable with the password, so store the password separately and keep an
exported key offline for the case where both are lost.

See `docs/wallet-recovery.md`.

## Related

- `skills/risk-management/SKILL.md` — the limits that govern what may be spent
- `skills/emergency-exit/SKILL.md` — stopping everything
