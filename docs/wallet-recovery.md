# Wallet backup, recovery, export and migration

Written for: the operator, before they fund a wallet. Read the first section
twice. Everything here was exercised on 2026-09-20 against a throwaway
install (a runtime in CI mode, setup completed, backup taken while it was
running, restored on a second data directory, unlocked with the original
password, same addresses); the Docker paths of the scripts are written the
same way but have not been run on this machine, which has no Docker.

## What you must hold, and what happens if you lose it

ATRA creates two agent wallets during setup: one secp256k1 key for Base,
BNB Smart Chain and Robinhood Chain, one ed25519 keypair for Solana. They are
stored **only** in the local SQLite database, encrypted under your dashboard
password. ATRA has no server, no account and no recovery service.

| You have | You can |
|---|---|
| The data directory (or a backup of it) **and** the dashboard password | Run ATRA again anywhere and export the keys |
| The data directory but not the password | Nothing. The vault cannot be opened. |
| The password but no copy of the data directory | Nothing. The keys are gone. |
| An exported key (hex, keystore, `id.json`, base58) | Import the wallet into any other wallet software, with or without ATRA |

So: keep the password somewhere ATRA is not, keep at least one backup of the
database somewhere the machine is not, and, once real funds are involved,
keep an exported key offline as the last resort. Anyone holding an exported
key controls the wallet; ATRA cannot revoke it.

## Where the data lives

| Install | Data directory | Contains |
|---|---|---|
| Docker (`docker compose up`) | the named volume `atra-data`, mounted at `/data` | `atra.db` and its `-wal`/`-shm` side files |
| Bare Node, default | Linux `~/.local/share/atra`, macOS `~/.local/share/atra`, Windows `%LOCALAPPDATA%\atra` | same |
| Bare Node, `ATRA_DATA_DIR` set | that directory | same |

The vault is inside `atra.db` (`vault_header`, `vault_secrets`). There is no
separate key file. Configuration is the `.env` file next to
`docker-compose.yml` (Docker) or wherever you keep it (bare Node); it may
hold RPC URLs with API keys and Telegram tokens, never a wallet key.

**Do not copy `atra.db` alone while the runtime is running.** The database
runs in WAL mode; a snapshot of the main file without the `-wal` file can be
missing everything since the last checkpoint. On the throwaway install used
to verify this document, `atra.db` was 4 KiB and the `-wal` file was 960 KiB
right after setup. The backup script takes a consistent snapshot with
SQLite's own `VACUUM INTO`, which is safe on a live database.

## Encrypted backup

```sh
scripts/backup.sh                 # Docker install (default when docker is present)
scripts/backup.sh --data-dir DIR  # bare Node install
```

Windows PowerShell: `.\scripts\backup.ps1` with the same options as
parameters (`-Docker`, `-DataDir`, `-EnvFile`, `-Out`, `-PassphraseFile`).
Both produce the same archive format; a backup made on one restores on the
other.

What it does, in order:

1. Takes a consistent snapshot of `atra.db` (inside the container for Docker,
   via `node:sqlite` locally) and verifies its SHA-256 after the copy.
2. Adds `.env` if it exists (`--env FILE` to point elsewhere).
3. Writes a `MANIFEST` with the SHA-256 of each file.
4. Asks for a passphrase twice (not echoed; minimum 12 characters), or reads
   it from `--passphrase-file` for unattended use.
5. Encrypts the tar.gz with `openssl enc -aes-256-cbc -pbkdf2 -iter 600000 -md sha256`
   and wraps it in a plain tar, `backups/atra-backup-<UTC stamp>.tar`, that
   also holds `meta.json` (the parameters, nothing secret) and the SHA-256 of
   the ciphertext.

Nothing leaves the machine. The scripts never print the passphrase, the
password, the contents of `.env` or anything from the vault; they print file
names, sizes and the first 16 hex characters of the snapshot's hash. If
`openssl` is missing the script refuses rather than writing a plaintext
backup. `age` and `gpg` were considered and not used: neither is installed by
default on the three platforms, and `openssl` is present on every Linux
distribution, on macOS and inside Git for Windows.

The archive is a second layer. The vault inside it is still encrypted under
the dashboard password, so a backup needs **both** the backup passphrase and
the dashboard password to yield a key. Store them separately.

Copy the `.tar` to somewhere off the machine. Not to ATRA: there is nowhere
to upload it to, and there never will be by default.

### Verifying a backup without restoring it

```sh
tar -xf backups/atra-backup-<stamp>.tar -C /tmp/check
cd /tmp/check && sha256sum -c SHA256SUMS
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in payload.enc | tar -tz
```

The last command lists `atra-backup-<stamp>/atra.db`, `MANIFEST` and, if
included, `config/.env`, without writing them anywhere. A wrong passphrase
prints `bad decrypt`.

## Restore

Stop the runtime first (`scripts/atra.sh stop` or stop the Node process).
The scripts refuse to run while a runtime answers on the port.

```sh
scripts/restore.sh backups/atra-backup-<stamp>.tar --docker
scripts/restore.sh backups/atra-backup-<stamp>.tar --data-dir DIR
```

PowerShell: `.\scripts\restore.ps1 <archive> -Docker` or `-DataDir DIR`.

What it does: decrypts, checks the gzip and tar structure, checks every file
against `MANIFEST`, runs SQLite's `integrity_check` when Node is available,
then installs `atra.db`. It **refuses to overwrite an existing database**
unless you pass `--force` (`-Force`), and even then the old file is renamed
to `atra.db.pre-restore-<stamp>`, never deleted. The `.env` inside the
archive is written only when you ask (`--env-out FILE`), and never over an
existing file without `--force`.

Then start the runtime and sign in with the dashboard password the vault was
created with. The wallets, the risk policy, the history and the pairing come
back exactly as they were at the snapshot. A restored runtime always starts
in PAPER mode; LIVE is never resumed across a restart.

### Manual restore, without the scripts

The format is deliberately ordinary so it survives the scripts:

```sh
tar -xf atra-backup-<stamp>.tar
openssl enc -d -aes-256-cbc -pbkdf2 -iter 600000 -md sha256 -in payload.enc | tar -xz
# atra-backup-<stamp>/atra.db is the database; copy it to the data directory
# (with the runtime stopped, and with no stale atra.db-wal / atra.db-shm beside it)
```

For the Docker volume, the script's path is `docker compose cp` into the
container followed by a one-off `docker compose run` that verifies the hash
and moves the file into place as the `node` user (a file copied in by
`docker cp` is owned by root, and the runtime runs as `node`). Doing it by
hand: stop the container, `docker compose cp atra-backup-<stamp>/atra.db atra:/data/atra.db.incoming`,
then `docker compose run --rm --no-deps -u root atra sh -c 'chown node:node /data/atra.db.incoming && mv /data/atra.db.incoming /data/atra.db && rm -f /data/atra.db-wal /data/atra.db-shm'`,
then `docker compose start`. This Docker path is untested on the author's
machine, which has no Docker; the local path is what the round trip above
exercised.

## Exporting a key

From the dashboard, Wallet page, after re-entering your password. Or from
the machine itself:

```
POST /api/v1/auth/reauth      { "password": "...", "purpose": "wallet.export" }
POST /api/v1/wallet/export    { "format": "...", "confirmation": "EXPORT" }
                              header x-atra-reauth: <token from the first call>
```

Both need the session cookie and `x-atra-client: atra-dashboard`; the export
route additionally requires a local client address and refuses anything
else. Formats:

| `format` | Produces | Imports into |
|---|---|---|
| `evm-private-key` | `0x` + 64 hex characters | any EVM wallet |
| `evm-keystore` | Web3 Secret Storage v3 JSON (needs `keystorePassword`, 12+ characters) | geth, ethers, MetaMask |
| `solana-id-json` | 64-byte JSON array | `solana-keygen`, Solana CLI |
| `solana-base58` | base58 of the 64-byte secret | Phantom, Solflare |

The response carries the material once, with a warning. The audit log
records that an export happened, the format and the address, never the
material. There is deliberately no export script in `scripts/`: a script
would have to write the key to a file or a terminal, and the dashboard path
shows it once, on screen, after a fresh password entry.

Prefer the keystore format for an offline copy: it is encrypted under a
password of its own. A raw hex key on a USB stick is a plaintext key.

## Moving to a new machine

1. On the old machine: `scripts/backup.sh` (or the PowerShell twin). Copy
   the `.tar` to the new machine.
2. On the new machine: clone the repository, `docker compose up -d` once so
   the image and the volume exist, then `docker compose stop`.
3. `scripts/restore.sh <archive> --docker --env-out .env` (omit `--env-out`
   if you would rather rewrite the configuration by hand; secrets in `.env`
   such as a bot token move with it).
4. `docker compose start`, open the dashboard, sign in with the same
   password. Check the wallet addresses match what you had.
5. Only then stop the old machine's runtime for good. Two runtimes with the
   same wallet must never trade at the same time: they would share a nonce
   and a balance without knowing it.

The same steps apply to a bare Node install with `--data-dir`.

## Changing the password

`POST /api/v1/auth/password` with a re-authentication for `auth.password`
(the dashboard exposes it where it exposes the password). The vault re-wraps its data-encryption key under the new
password; the per-secret ciphertexts are untouched, so the change is atomic
and old backups still open with the **old** password. Write the date of the
change next to your stored password.

## If the vault reports it is corrupt

`VAULT_CORRUPT` on export means the stored key does not derive to the
recorded address, which should be impossible without a damaged file. Do not
keep using that database. Restore the most recent backup, or import an
exported key into other wallet software and move the funds.

## What ATRA never does

- asks for a seed phrase or an existing key: it creates fresh agent wallets;
- uploads a backup, a key or the database anywhere;
- stores the password;
- keeps a copy of anything outside the data directory.

Any prompt or page asking you to type a recovery phrase into "ATRA" is not
ATRA.
