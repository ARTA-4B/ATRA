# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue. Open a
[private security advisory](https://github.com/lamaokamg-hub/ATRA/security/advisories/new)
on GitHub. You will get an acknowledgement, and a fix or a mitigation before
any public disclosure.

If the report concerns a way to extract key material, move funds, bypass the
risk engine, or make the model reach a signer, say so in the first line so it
is triaged first.

There is no bug bounty. There is no paid support. The maintainer is one
person.

## What has and has not been done

- **No third-party audit has been performed.** This file will say so until
  one has.
- Every security property below has an automated test that fails if the
  property breaks. The release gate lists each property, the test that proves
  it, and the date it was last run:
  [docs/SECURITY_RELEASE_CHECKLIST.md](docs/SECURITY_RELEASE_CHECKLIST.md).
  On 2026-09-20 that gate is **not passed**: a data directory from a probe
  run is tracked in git and must be removed first. The gate document says
  exactly what else is verified only partially.
- CI scans the tracked tree and the container's logs for key material on
  every push, and audits dependencies; high and critical advisories fail the
  build.
- The full threat model, including what ATRA does **not** protect against
  (a compromised machine, a malicious operator, a supply-chain attack on npm,
  a physical attacker), is in [docs/security-model.md](docs/security-model.md).

## The properties ATRA is built around

1. **Private keys never leave the machine.** They are generated locally,
   encrypted at rest, and there is no upload, backup service or telemetry.
   The backup script encrypts with your own passphrase and writes to a local
   directory.
2. **The reasoning model never sees a key.** Prompts are built from an
   allowlist of fields, and a prompt that would contain key material is
   refused before it is sent.
3. **Nothing goes through Telegram that could move funds.** No export, no
   withdrawal, no limit change, no LIVE activation, no clearing of the
   emergency stop; the runtime refuses every such command regardless of what
   a gateway forwards.
4. **Keys are never logged.** Every log object, audit detail and Telegram
   reply passes through a redactor that strips key-shaped values.
5. **No project credential is hard-coded.** Provider keys are the operator's,
   supplied through the environment, or the hosted gateway's, kept as Worker
   secrets.
6. **The model cannot execute arbitrary contract calls.** There is no generic
   "call this contract" path and no endpoint that accepts calldata or a raw
   transaction. Every action is a named adapter operation with its own schema,
   against contracts that must be allowlisted.
7. **The model cannot override the risk engine.** The engine is a pure
   function that does not import the model, the clock or the network.
8. **LIVE is never the default.** It requires six explicit steps within ten
   minutes plus a re-authentication, expires after twelve hours, and every
   restart, policy change or emergency stop reverts it.
9. **The emergency stop works with the model offline.** It writes one row and
   takes effect on the next read; engaging it needs no password.
10. **User funds and project treasury funds never mix.** The treasury (Phase
    5) is watch-only by construction: no table references the vault, and the
    runtime cannot sign for it.

## Vault design

```
operator password
  -> Argon2id (46 MiB, t=2, p=1, 16-byte per-install salt)
    -> key-encryption key
      -> XChaCha20-Poly1305 unwraps a random 32-byte data-encryption key
        -> XChaCha20-Poly1305 decrypts each secret, bound by AAD to its own row
```

All primitives are the audited pure-JS `@noble` implementations. There is no
native addon in the process. Plaintext is handed to a synchronous callback
and overwritten when it returns; it is never converted to a string except at
the export boundary, after re-authentication, from a local client only.

## Local API defence

The runtime binds to loopback and holds keys, which makes it a DNS-rebinding
and CSRF target. Defences are layered because each alone has a known gap:

- Host header allowlist
- Origin / Sec-Fetch-Site checks on state-changing requests
- a required custom header a cross-origin form cannot set
- `SameSite=Strict` session cookies
- setup and export restricted to local callers, failing closed when the
  client address is unknown
- request bodies capped at 256 KiB before authentication
- login throttling

## Out of scope

- A compromised operating system. If an attacker has code execution on the
  machine while the vault is unlocked, they can read the data-encryption key
  from memory. Lock the vault when away; the default idle lock is 30 minutes.
- A weak password. The KDF slows brute force; it does not make "password1"
  safe.
- Loss of both the password and any exported key. There is no recovery. See
  [docs/wallet-recovery.md](docs/wallet-recovery.md).
- The operator. Nothing constrains the person who owns the machine.

## Supported versions

Only the `main` branch receives fixes until a first tagged release exists.
