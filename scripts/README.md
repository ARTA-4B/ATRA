# scripts/

Operator helpers. POSIX `sh` for Linux, macOS and Git Bash, with a
PowerShell twin where Windows needs one. None of them prints, reads into a
log, or needs a key, a password or a token; the backup and restore scripts
prompt for a passphrase without echo and hand it to `openssl` on stdin.

| Script | Twin | Does |
|---|---|---|
| `atra.sh` | `atra.ps1` | Docker lifecycle: `install`, `start`, `stop`, `restart`, `status`, `update`, `logs`, `backup` |
| `backup.sh` | `backup.ps1` | Encrypted archive of the database (with the vault inside) and `.env`, with your passphrase, to a local directory. Consistent snapshot of a live database via `VACUUM INTO`. Refuses without `openssl` |
| `restore.sh` | `restore.ps1` | The reverse. Verifies every hash, refuses while a runtime is running, refuses to overwrite without `--force` and keeps the old file even then |
| `secret-scan.sh` | | The release-gate scan: key-shaped strings in tracked files, tracked data files, gitleaks when installed |
| `release-gate.sh` | | Runs every automatable line of `docs/SECURITY_RELEASE_CHECKLIST.md` and prints PASS / FAIL / SKIP / MANUAL |

The archive format is the same on every platform, so a backup made by
`backup.ps1` restores with `restore.sh` and the other way round (verified
2026-09-20). Details and the manual recovery path without these scripts:
[`docs/wallet-recovery.md`](../docs/wallet-recovery.md). Install and
lifecycle: [`docs/deployment.md`](../docs/deployment.md).

What has been verified: the local (`--data-dir`) paths of backup and
restore, end to end, including the passphrase and secrecy behaviour, on
Windows with both `sh` and PowerShell. What has not: the `--docker` paths,
because the author's machine has no Docker. They use `docker compose run`,
`docker compose cp` and the same snapshot program, and are written to be
exercised in CI against the smoke container.

Run them from anywhere; they locate the repository from their own path.
