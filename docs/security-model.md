# Security model

Written for: anyone deciding whether to put money behind ATRA, and any
engineer changing a line that a boundary below depends on. It says what ATRA
protects against, what it does not, and where each protection lives in the
code. State of the tree on 2026-09-20. No third-party audit has been
performed.

## What ATRA protects against

| Threat | What ATRA does | Where |
|---|---|---|
| **A remote attacker without local access** (a malicious web page the operator visits, a scanner on the LAN, a phishing site) | The runtime binds to loopback and the container publishes to `127.0.0.1` only. The Host header must be a loopback name or an explicit allowlist entry (DNS rebinding). Every state-changing request must carry `x-atra-client: atra-dashboard`, which a cross-origin form cannot set, and a same-origin `Sec-Fetch-Site`/`Origin`. The session cookie is `SameSite=Strict`. Setup and key export additionally require a local client address and fail closed when the address is unknown. Bodies over 256 KiB are refused before authentication. | `runtime/src/http/middleware.ts`, `docker-compose.yml`; tests `runtime/test/api.test.ts` "security guards" |
| **A compromised or hostile model** (a fine-tune gone wrong, a poisoned prompt, a model that has been told to drain the wallet) | The model returns JSON, which is schema-validated; a reply that does not parse is `NO_ACTION`/`HOLD`; a reply that contradicts its inputs (wrong chain, unlisted token, size over the cap, reduce of nothing) is overridden and recorded as a model failure. The proposal is rebuilt by deterministic code and evaluated by a pure risk engine that does not import the model. The model has no route to a signer, cannot request an export and never receives key material: a prompt that would contain any is refused before it is sent. | `runtime/src/agents/trader/agent.ts`, `agents/liquidity-manager/agent.ts`, `risk/engine.ts`, `llm/provider.ts`; tests `phase3-trading.test.ts`, `liquidity.test.ts`, `research.test.ts` |
| **A hostile market** (a fake pool, a token that cannot be sold, a price feed that lies, a sandwich) | Tokens and protocols must be allowlisted per chain; the contract the transaction targets, and on Solana every top-level program, is checked against the registry; prices are the median of two independent providers and are `disputed` past 200 bps; every input carries an age and is refused when stale or from the future; a zero price is unknown, not a number; pool liquidity has a floor; slippage and price impact have caps; LIVE simulates before signing; fills are booked from what the chain reports, never from the quote. | `risk/engine.ts`, `market/service.ts`, `execution/live.ts`; tests `risk-engine.test.ts`, `market.test.ts`, `review-regressions.test.ts` |
| **An operator mistake** (going live by accident, a fat-fingered limit, a wrong address, a restart at the wrong moment) | PAPER is hard-coded at creation. LIVE needs six timestamped steps within ten minutes, a fresh re-authentication, and expires after twelve hours; a restart, a policy change or the emergency stop drops it back to PAPER. Default limits are small. Withdrawals need a quote, a re-authentication, EIP-55 checksum validation, and a typed `WITHDRAW` for "all", for 1,000 USD or more, or when the USD value is unknown. The transaction hash is written to disk before broadcast so a crash never causes a second signature. An unreadable balance is an error, never a zero. | `core/state.ts`, `wallet/withdrawal.ts`, `execution/live.ts`; tests `api.test.ts`, `review-regressions.test.ts` "the LIVE checklist is consumed and reset", `phase3-trading.test.ts` |
| **A stolen database file** | Every secret is encrypted under a key derived from the operator password with Argon2id (46 MiB, t=2). Pair codes are stored as SHA-256 only, sessions and re-auth tokens as hashes. The file contains addresses, decisions and history, which are not secret, and ciphertext, which is useless without the password. | `wallet/vault.ts`, `wallet/crypto.ts`, `telegram/pairing.ts`, `core/auth.ts`; test `vault.test.ts` "stores no plaintext anywhere in the database file" |
| **Someone who reaches the Telegram bot** | The runtime authorises every message itself against its single stored link (user id and chat id), drops replayed and old updates, rate-limits strangers to three generic replies per ten minutes, and refuses every export, withdrawal, policy, LIVE and clear-stop command with a fixed reply. The gateway filters first, but the runtime trusts nothing it is told. | `telegram/commands.ts`; tests `telegram-commands.test.ts`, `gateway/test/webhook.test.ts` |
| **Password guessing** | Login failures are throttled with a lockout window. | `core/auth.ts`; test `review-regressions.test.ts` "password guessing is throttled" |

## What ATRA does not protect against

Be honest with yourself about these before funding a wallet.

- **A compromised machine.** If an attacker has code execution on the host
  while the vault is unlocked, the data-encryption key is in the process's
  memory and every secret is one call away. Malware with keyboard access has
  the password. ATRA runs where you run it; it cannot be safer than that
  machine. Mitigations, not solutions: the vault auto-locks after 30 idle
  minutes (`ATRA_AUTOLOCK_MINUTES`), the key is dropped on shutdown, and the
  container runs read-only as a non-root user with `no-new-privileges`.
- **A malicious operator.** The operator can export the keys, raise every
  limit, allowlist any token, disable the checks by editing the source and
  go LIVE. Nothing in ATRA constrains the person who owns the machine, and
  nothing is meant to.
- **A supply-chain attack on npm or PyPI.** The runtime has no native
  addons and uses the audited `@noble` cryptography, `hono`, `viem`, `zod`,
  `pino` and `croner`; versions are pinned and `pnpm audit` runs in CI. That
  reduces the surface. It does not protect against a compromised release of
  a dependency that is already pinned. The same is true of the Docker base
  image and of the Python training stack.
- **A physical attacker.** Someone with the machine and enough time has the
  encrypted database; the Argon2id parameters slow a brute force, they do not
  make a weak password safe. Someone with the machine while it is unlocked
  has everything.
- **Loss of the password and every exported key.** There is no recovery,
  no reset and no support channel that can help. See
  [wallet-recovery.md](wallet-recovery.md).
- **The chains and the protocols themselves.** A router exploit, a
  depegged stablecoin, a chain halt or a rug in an allowlisted token is
  outside ATRA's control. The limits bound the loss; they do not prevent it.
- **The hosted gateway, when it exists.** It is designed never to hold a
  key or a password and to refuse broadcast methods, and today it is not
  deployed. A deployed gateway is still a server run by someone else; the
  runtime keeps working without it.

## The key hierarchy

```
operator password (never stored; verified only by unwrapping)
  │  Argon2id, 46 MiB memory, t = 2, p = 1, 16-byte per-install salt
  ▼
key-encryption key (KEK), 32 bytes, wiped after use
  │  XChaCha20-Poly1305, AAD "atra.vault.dek.v1"
  ▼
data-encryption key (DEK), 32 random bytes, held in memory only while unlocked
  │  XChaCha20-Poly1305, AAD "atra.vault.secret.v1:<kind>:<row id>"
  ▼
one row per secret: the EVM private key (secp256k1, 32 bytes) and the Solana
keypair (ed25519, 64 bytes), ciphertext and nonce in vault_secrets
```

- A wrong password fails at the Poly1305 tag check on the wrapped DEK; there
  is no separate password oracle.
- The AAD binds each ciphertext to its own row, so a secret copied into
  another row fails to decrypt instead of authenticating.
- Changing the password re-wraps the DEK only; the per-secret ciphertexts are
  untouched, so the change is atomic.
- Plaintext is handed to a synchronous callback as a `Uint8Array` and
  overwritten when the callback returns. It is never converted to a string
  except at the export boundary. Signing happens inside that callback: the
  key exists for one ECDSA or ed25519 operation.
- All primitives are the pure-JS `@noble` implementations. No native code
  shares the process with the vault. Argon2id parameters are stored beside
  the vault so they can be raised later without invalidating an install.

Files: `runtime/src/wallet/vault.ts`, `crypto.ts`, `evm.ts`, `solana.ts`,
`service.ts`. Tests: `runtime/test/vault.test.ts` (19), `wallet-keys.test.ts`
(19), including the published Web3 Secret Storage v3 vector and RFC 8032
test 1.

## What is never logged, stored in plain text, sent or shown

| Never | Enforced by |
|---|---|
| A private key, in any encoding, in a log line, an audit row, an API response other than the export endpoint, a Telegram reply, a notification or a model prompt | `logging/redact.ts` scrubs key-shaped values (0x-hex-64, bare hex-64, base58-64, `id.json` arrays, BIP-39 phrases, bot tokens, API-key prefixes) and replaces any value under a secret-looking key; `audit.ts` passes every detail object through it; `llm/provider.ts` refuses a prompt that contains one; Telegram replies pass the same scrubber. Tests: `redact.test.ts`, `api.test.ts` "never puts secret material in the audit trail", `telegram-service.test.ts` "secrecy" |
| The operator password | Argon2id hash for login (`auth_credential`); the vault verifies by unwrapping; never logged |
| Session and re-authentication tokens | stored as hashes; re-auth tokens are single use, five minutes, bound to purpose and session |
| Telegram bot token and gateway installation token | read from the environment at the composition root (`readTelegramSecrets`), handed to the transport, held nowhere else; the secrecy test runs every command with both set and a real logger capturing every line |
| Pairing codes | SHA-256 only, single atomic use, five-minute TTL |
| Provider API keys | the runtime reads the *name* of an environment variable (`ATRA_LLM_API_KEY_ENV`), never a key from a file; a BYOK RPC URL is reported as its host only |
| Message text of Telegram commands | the command word and the outcome are recorded, not the text |

CI adds a second layer: every push scans the tracked tree for key shapes and
scans the container's logs after a full setup for the same shapes
(`.github/workflows/ci.yml`, `docker-smoke.yml`).

## The LIVE activation path

PAPER is the only mode a fresh install can be in (`core/state.ts`,
`createInstallation`: the value is a literal, there is no parameter). To
reach LIVE, all of the following, in one sitting:

1. Six checklist steps recorded through `POST /api/v1/control/activation/step`:
   `acknowledged`, `reauthenticated`, `riskReviewed`, `walletFunded`,
   `gasChecked`, `adapterChecked`. Each is a timestamp and counts for ten
   minutes; a step recorded yesterday says nothing about today's balance.
2. A re-authentication token for the purpose `mode.live` (password re-entered,
   single use, five minutes).
3. `POST /api/v1/control/mode/live`, which refuses under an emergency stop or
   a pause, and refuses while any step is missing.

Activation consumes the steps. LIVE then lasts at most twelve hours, after
which the risk engine rejects with `LIVE_NOT_ACTIVATED` (`risk-engine.test.ts`
"rejects LIVE when the activation session has expired"). Any of these drops
the runtime back to PAPER and clears the checklist:

- a process restart (`#demoteOnBoot`);
- a change to the risk policy (the operator reviewed the old limits);
- the emergency stop (engaging it needs no password; clearing it does);
- `POST /api/v1/control/mode/paper`, always allowed.

In LIVE the executor checks the mode, the pause and the stop again
immediately before signing, because the state can change between the
decision and the signature. A LIVE-mode action while the runtime is PAPER is
rejected by the engine (`MODE_MISMATCH`) and again by the executor, with zero
signing contexts created (`phase3-trading.test.ts` "never signs while the
runtime is in PAPER").

Telegram cannot activate LIVE, cannot clear the stop and cannot change a
limit. Withdrawals are the operator's own money and are allowed in PAPER and
under an emergency stop; they still need a re-authentication.

## Things that look like gaps and are not

- **Withdrawals bypass the risk engine.** By design: the engine bounds what
  the *agent* may do. A withdrawal is the operator taking their own funds
  out, and gating that behind the agent's limits would trap an operator
  behind a breached limit.
- **A LIVE fill whose receipt exposes no transfer is booked at
  `minAmountOut`.** Labelled `min-out-lower-bound` in the audit row; it is
  the worst case the chain enforced, never the quote.
- **Reconciled fills after a restart carry no fill-time price.** The audit
  row says the valuation is missing rather than inventing one.

## Things that are gaps

Recorded, not hidden. See the release checklist for the full list.

- The LIVE LP executor does not simulate before signing (Phase 4 report).
- The boot order runs the swap reconcile before the LP reconcile, so an LP
  row left in flight by a crash is settled without booking the position
  (Phase 4 report; not fixed on 2026-09-20).
- Telegram rate limiters and the emergency challenge live in memory and
  reset on restart; the replay cursor and the pairing link are persisted.
- A SQLite data directory from a Phase 2 probe run (`runtime/.live/`) and an
  empty smoke database (`runtime/.smoke/`) are tracked in git. The vault
  rows inside are encrypted and those wallets never held funds, but a data
  directory does not belong in a repository. The release checklist lists
  the removal as a blocking item.

## Reporting

[SECURITY.md](../SECURITY.md). Say in the first line if the report concerns
key extraction, fund movement or a risk-engine bypass.
