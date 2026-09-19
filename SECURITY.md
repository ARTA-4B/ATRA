# Security

## Reporting a vulnerability

Please report security issues privately rather than in a public issue. Open a
[private security advisory](https://github.com/sighttrue/ATRA/security/advisories/new)
on GitHub. You will get an acknowledgement, and a fix or a mitigation before
any public disclosure.

If the report concerns a way to extract key material, move funds, or bypass the
risk engine, say so in the first line so it is triaged first.

## What has and has not been done

- **No third-party audit has been performed.** This document will say so until
  one has.
- Every security property listed below has an automated test that fails if the
  property breaks, and CI scans container logs and the repository for key
  material on every push.
- Dependency advisories are checked on every push; high and critical
  advisories fail the build.

## The properties ATRA is built around

1. **Private keys never leave the machine.** They are generated locally,
   encrypted at rest, and there is no upload, backup service or telemetry.
2. **The reasoning model never sees a key.** Prompts are built from an
   allowlist of fields, and a prompt that would contain key material is refused
   before it is sent.
3. **Nothing goes through Telegram that could move funds.** No export, no
   withdrawal (Phase 4 scope; designed as disabled by default).
4. **Keys are never logged.** Every log object passes through a redactor that
   strips key-shaped values; audit rows do the same.
5. **No project credential is hard-coded.** Provider keys are the operator's,
   supplied at runtime, or the hosted gateway's, kept server-side.
6. **The model cannot execute arbitrary contract calls.** There is no generic
   "call this contract" path. Every action is a named adapter operation with
   its own schema, and contracts must be allowlisted.
7. **The model cannot override the risk engine.** The engine is a pure
   function that does not import the model.
8. **LIVE is never the default.** It requires six explicit steps and
   re-authentication; the emergency stop revokes it.
9. **The emergency stop works with the model offline.** It writes one row and
   takes effect on the next read.
10. **User funds and project treasury funds never mix.** The treasury agent
    (Phase 5) has no access to user wallets.

## Vault design

```
operator password
  → Argon2id (46 MiB, t=2, p=1, per-install salt)
    → key-encryption key
      → XChaCha20-Poly1305 unwraps a random 32-byte data-encryption key
        → XChaCha20-Poly1305 decrypts each secret, bound by AAD to its own row
```

All primitives are the audited pure-JS `@noble` implementations. There is no
native addon in the process. Plaintext is handed to a synchronous callback and
overwritten when it returns; it is never converted to a string except at the
export boundary, after re-authentication, on loopback only.

## Local API defence

The runtime binds to loopback and holds keys, which makes it a DNS-rebinding
and CSRF target. Defences are layered because each alone has a known gap:

- Host header allowlist
- Origin / Sec-Fetch-Site checks on state-changing requests
- a required custom header a cross-origin form cannot set
- `SameSite=Strict` session cookies
- setup and export restricted to loopback callers

## Out of scope

- A compromised operating system. If an attacker has code execution on the
  machine while the vault is unlocked, they can read the data-encryption key
  from memory. Lock the vault when away; the default idle lock is 30 minutes.
- A weak password. The KDF slows brute force; it does not make "password1"
  safe.
- Loss of both the password and any exported key. There is no recovery.

## Supported versions

Only the `main` branch receives fixes until a first tagged release exists.
