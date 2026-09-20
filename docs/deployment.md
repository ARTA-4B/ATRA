# Deployment

Written for: the operator installing ATRA on their own machine. There is no
other kind of deployment: the runtime holds wallet keys and is meant to run
where you are. State on 2026-09-20.

## The supported path: Docker

```sh
git clone https://github.com/lamaokamg-hub/ATRA.git
cd ATRA
docker compose up -d
```

Then open http://127.0.0.1:3000 and complete first-run setup: a password of
at least 12 characters, the agent wallets, the chains you want, the default
risk limits. You start in **PAPER** mode and nothing here can change that
without the six-step activation ([paper-vs-live.md](paper-vs-live.md)).

Requirements: Docker Engine or Docker Desktop with the `docker compose`
subcommand (v2). Nothing else; there is no native code to compile. The image
builds the dashboard and the runtime in separate stages and ships neither a
build toolchain nor test tooling.

What `docker compose up` gives you, from `docker-compose.yml`:

- the port published to **`127.0.0.1:3000` only**. Nothing on your LAN can
  reach it. Exposing it is a deliberate change to that line, and it should
  come with an authenticating reverse proxy and `ATRA_HOST_ALLOWLIST`;
- the data in a named volume `atra-data`, mounted read-write at `/data`; the
  rest of the container is read-only, runs as the unprivileged `node` user
  with `no-new-privileges`, and has a `tmpfs` at `/tmp`;
- a health check through `node` (the slim image has no `wget`), a 30-second
  stop grace period so the runtime can lock the vault and checkpoint the
  database on SIGTERM, `restart: unless-stopped`, and log rotation;
- `ATRA_LOCAL_CLIENTS` set to the private ranges, because inside the
  container your browser's requests arrive from the Docker bridge, not from
  loopback, and setup and key export are restricted to "local" callers.

This is verified on every push by `.github/workflows/docker-smoke.yml`: build,
`up --wait`, `/health`, `/ready` 503 before setup, `/api/v1/meta` reporting
`PAPER` and `UNTRAINED`, 401 without a session, a full setup through the port
mapping, a scan of the container logs for key material, a restart, and a
graceful `docker stop` with exit code 0 for the API-only image. The author's
machine (Windows 11 Home without WSL) has never run Docker; CI is the Docker
gate for this project.

### The helper script

`scripts/atra.sh` (POSIX sh) and `scripts/atra.ps1` (Windows PowerShell) wrap
the same commands so the documentation has one spelling:

| Command | Does |
|---|---|
| `install` | checks Docker, creates `.env` from `.env.example` if missing, builds, starts, waits for `/health`, prints the URL |
| `start`, `stop`, `restart` | `docker compose up -d` / `stop`, with a health wait |
| `status` | `docker compose ps`, then `/health` and `/ready` |
| `update` | `git pull --ff-only`, rebuild with `--pull`, restart, wait for `/health` |
| `logs` | `docker compose logs -f --tail 200` |
| `backup` | `scripts/backup.sh --docker`, see [wallet-recovery.md](wallet-recovery.md) |

None of them reads, prints or needs a key, a password or a token. They have
been run on the author's machine only as far as the Docker checks let them
(`docker` is not installed there); the `backup`/`restore` local paths were
verified end to end.

## Without Docker

Node 24 (for `node:sqlite`) and pnpm 11.

```sh
cd runtime
pnpm install
pnpm run build
cp -r src/db/migrations dist/db/migrations    # the migrations are plain SQL; tsc does not copy them
pnpm start
```

Set `ATRA_STATIC_DIR` to a built dashboard (`npm install && npm run build` at
the repo root produces `dist/`) if you want the UI served from the same port;
without it the runtime serves the API and `/health` only. The data directory
defaults to `~/.local/share/atra` (Linux, macOS) or `%LOCALAPPDATA%\atra`
(Windows); `ATRA_DATA_DIR` overrides it. The runtime binds to `127.0.0.1`
unless `ATRA_HOST` says otherwise.

On Windows, `Ctrl+C` in the terminal delivers SIGINT and the runtime shuts
down cleanly; a `Stop-Process` is a hard kill, which is safe for the data
(the hash of anything in flight is already on disk; WAL is replayed on the
next open) but skips the tidy exit.

## Configuration

Copy `.env.example` to `.env`. Every value is optional; the runtime boots
with an empty environment (CI proves it on every push with `ATRA_MODE=ci`).
The ones that matter:

| Variable | Purpose |
|---|---|
| `ATRA_RPC_BASE`, `ATRA_RPC_BSC`, `ATRA_RPC_ROBINHOOD`, `ATRA_RPC_SOLANA` | Your own RPC endpoints. The defaults are keyless public endpoints, rate-limited; `mainnet.base.org` rate-limits the LP adapter's pool reads, so a keyed Base endpoint is needed for auto-LP there (Phase 4 report). A URL with a key inside is a secret: keep `.env` out of version control (it is gitignored) |
| `ATRA_LLM_KIND`, `ATRA_LLM_URL`, `ATRA_LLM_MODEL`, `ATRA_LLM_API_KEY_ENV` | `none`, `ollama` (default, `http://127.0.0.1:11434`) or `openai-compatible`. The last variable names the environment variable that holds the key; the key itself is never in a file ATRA reads |
| `ATRA_AUTOLOCK_MINUTES` | Idle minutes before the vault drops its key from memory (default 30) |
| `ATRA_GATEWAY_URL`, `ATRA_GATEWAY_TOKEN` or `ATRA_TELEGRAM_BOT_TOKEN` | Telegram, see [telegram.md](telegram.md). The gateway is not deployed today |
| `ATRA_HOST_ALLOWLIST`, `ATRA_CORS_ORIGINS`, `ATRA_LOCAL_CLIENTS` | Only if you put a reverse proxy in front or develop the dashboard |
| `ATRA_LOG_LEVEL`, `ATRA_LOG_PRETTY` | Logging; keys never appear in logs whatever the level |

No configuration file ever contains a wallet key or the dashboard password.

## Upgrading

```sh
scripts/atra.sh update        # or: git pull --ff-only && docker compose build --pull && docker compose up -d
```

Migrations are applied on start, forward only, each in its own transaction;
a migration that fails stops the runtime with the migration's name in the
error. Take a backup before upgrading across many commits: there is no
downgrade. A restart always comes back in PAPER mode. Check the release notes
in the phase reports for defects that a version knowingly ships with; on
2026-09-20 the Phase 4 report lists the LP reconcile boot order and the
scheduler intervals outside whole minutes.

## Backups

[wallet-recovery.md](wallet-recovery.md). Short version: `scripts/atra.sh backup`,
enter a passphrase twice, copy the resulting `.tar` off the machine, and keep
the dashboard password somewhere else again.

## Uninstalling

```sh
docker compose down          # stops and removes the container, keeps the volume
docker compose down -v       # also deletes the atra-data volume: the vault is gone
```

Before `-v`: export the keys or take a backup, and move any funds out of the
agent wallets. There is no way to recover a deleted volume.

## The hosted gateway

Optional, project-run, and **not deployed** on 2026-09-20. Everything an
operator needs works without it: public RPC, the two keyless market
providers, a local model, and Telegram through your own bot token. When it
exists, the runtime opts in with `ATRA_GATEWAY_URL` and an installation
token; nothing in the runtime is gated on it. Deployment steps for the
project maintainer are in `gateway/README.md` and are human steps by design:
CI holds no Cloudflare credentials and never deploys.

## Exposing the dashboard beyond the machine

Not recommended, and not the default. If you must: keep the port mapping on
loopback and put an authenticating reverse proxy (with TLS) in front of it on
the same host; add its hostname to `ATRA_HOST_ALLOWLIST`; leave
`ATRA_LOCAL_CLIENTS` alone so that setup and key export stay local to the
machine. The runtime's own defences (host allowlist, custom header on
writes, `SameSite=Strict` cookies, re-authentication for anything sensitive)
assume a hostile network already, but a key-holding service on the internet
is a target whatever the defences.

## What is deliberately not offered

- A hosted or managed ATRA. The keys would not be yours.
- An installer that downloads a binary. `git clone` and `docker compose`
  are the whole install, and you can read every line first.
- Automatic updates. `update` is a command you run.
- Telemetry. There is none; the runtime makes no outbound call that is not
  an RPC, a market provider, the model endpoint you configured, or the
  Telegram transport you configured.
