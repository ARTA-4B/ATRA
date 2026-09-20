# Contributing

Thank you for reading this before opening a pull request. ATRA holds wallet
keys and can, once an operator activates LIVE, sign real transactions. That
shapes everything below: the rules exist so a contribution cannot quietly
weaken a boundary.

## Before you start

- Read [docs/architecture.md](docs/architecture.md) for which file owns
  what, and [docs/security-model.md](docs/security-model.md) for the
  boundaries.
- Look for an existing issue. For anything larger than a bug fix, open an
  issue first and say what you intend; a design conversation is cheaper than
  a rewritten pull request.
- Security issues do not go in issues or pull requests. See
  [SECURITY.md](SECURITY.md).

## Rules that are not negotiable

A pull request that breaks one of these will not be merged, however good the
rest of it is.

1. **The model never signs, never broadcasts, and cannot override the risk
   engine.** No new path from an agent's output to a signer. No import of the
   model from `risk/`.
2. **Private keys reach exactly one place.** `WalletService.useSigningKey`
   is the only way to touch a signing key; the callback is synchronous and
   the plaintext is wiped when it returns. Keys never appear in logs, audit
   rows, API responses (other than the re-authenticated export), Telegram
   replies or prompts.
3. **PAPER is the default.** LIVE keeps its six-step activation and its
   automatic reversions.
4. **No generic contract call.** New protocols are named adapters with a
   closed set of operations over registry contracts, never `call(to, data)`.
5. **The emergency stop works without the model**, the network or a
   scheduler tick.
6. **Treasury funds and user funds never mix.**
7. **Money is a `bigint` in base units or a micro-USD decimal string.** A
   `number` that represents money is a bug.
8. **No invented figures.** No metrics, audits, partners, volumes, users or
   P&L that did not happen. ATRA-4B is labelled `UNTRAINED` until a run
   completes and `evaluate.py` passes, and CI enforces the label.
9. **A new migration is a new file.** `runtime/src/db/migrations/NNN_name.sql`
   with the next free number; existing migrations are never edited.
   Decision and fill tables stay append-only, with triggers.
10. **Exactly four chains.** Base, BNB Smart Chain, Robinhood Chain, Solana.
    ATRA never substitutes one for another.

## How the code is written

The runtime is strict TypeScript 6 (NodeNext ESM, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess`, `erasableSyntaxOnly`: no enums, no parameter
properties; imports carry `.js`). ESLint is strict (`require-await`,
`no-floating-promises`, `consistent-type-imports`, `no-console`, `eqeqeq`);
the `unsafe-*` rules are relaxed only under `runtime/test/**`.

- Errors are `AppError(ErrorCode.X, message, { errors, details })`.
- Logs go through `childLogger(name)`; never `console`.
- Audit rows go through `AuditLog.append({ category, action, status, summary, chain?, actor, mode, detail, correlationId })`.
- HTTP responses use `envelope(c, data, { source })` and problem+json errors;
  sessions through `requireSession()`; bodies through `parse(c, zodSchema)`.
- SQLite goes through the `Db` wrapper: `db.prepare<P, R>(sql).get/all/run`,
  `db.transaction(fn)()`.
- Route factories take their service as a parameter; services are classes
  built from a deps object; `core/services.ts` is the only composition root.
- Every fact a response carries has a `source` and an `asOf`. An unknown
  value is `null` with a reason, never zero.

Before pushing, from `runtime/` (the gateway has the same scripts):

```sh
pnpm run lint          # eslint src test
pnpm run typecheck     # tsc --noEmit
pnpm run format:check  # prettier --check "{src,test}/**/*.ts"
pnpm run test          # vitest run
```

After `eslint --fix`, always re-run Prettier on the same files: CI runs
`prettier --check` and an autofix has broken it before. Do not add a
dependency without saying why in the pull request; the runtime has no native
addons and would like to keep it that way.

## Tests

A change to a boundary comes with a test that fails without the change. The
existing suites show the pattern: `runtime/test/phase3-trading.test.ts`
builds a complete runtime against `:memory:` with fake chains, a scripted
model and the real pipeline. Security properties are written as things that
must never happen (`redact.test.ts`, `vault.test.ts` "stores no plaintext
anywhere in the database file").

Fixtures may contain key-shaped strings only when they are published test
vectors (Web3 Secret Storage v3, RFC 8032, BIP-39) or demonstrably not valid
keys, and only under `runtime/test/`, `gateway/test/` or `docs/specs/`.
`scripts/secret-scan.sh` fails otherwise. Never commit a data directory, a
`.env`, or anything the scan lists.

## Documentation

Documentation states what is true today, in the present tense, with a date
where it matters. No roadmap language dressed as fact. If your change alters
a claim in `README.md`, a phase report or a document under `docs/`, change
the claim in the same pull request.

## Pull requests

- One concern per pull request. A refactor and a behaviour change are two.
- Explain *why* in the description, not just what. Link the issue.
- Commit messages in English, imperative, with a body when the why is not
  obvious.
- CI must be green: `ci`, `docker-smoke` and, if you touched `gateway/`,
  `gateway`.
- Live network probes in a pull request are read-only. Never sign, never
  broadcast, never spend, never send a credential anywhere, and record every
  probe (what, endpoint, result) in the description.

## Working on the parts

| Part | Where | Notes |
|---|---|---|
| Runtime | `runtime/` | pnpm; Node 24; `pnpm run dev` watches with tsx |
| Gateway | `gateway/` | its own pnpm project; vitest inside workerd; `wrangler dev` needs a gitignored `.dev.vars` |
| Dashboard | repo root (`src/`, `index.html`, `vite.config.ts`) | `npm install && npm run dev`, proxied to the runtime on port 3000 |
| Model pipeline | `model/atra-4b/` | Python 3.12; `pip install -r requirements-cpu.txt`; `python -m pytest tests -q` |
| Scripts | `scripts/` | POSIX sh with PowerShell twins; must never print a secret |
| Skills | `skills/*/SKILL.md` | one file per agent capability; the rules an agent is allowed to follow |

## Licence

By contributing you agree that your contribution is licensed under the MIT
licence in [LICENSE](LICENSE).
