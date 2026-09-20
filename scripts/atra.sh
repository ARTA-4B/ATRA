#!/bin/sh
# ATRA lifecycle helper for the Docker install. Thin, readable wrappers over
# docker compose so the commands in the documentation have one spelling.
# Nothing here reads, prints or needs a key, a password or a token.
#
# Usage: scripts/atra.sh <command>
#
#   install   check docker, build the image, start it, wait for /health,
#             print the dashboard URL
#   start     docker compose up -d (and wait for /health)
#   stop      docker compose stop  (SIGTERM; the runtime locks the vault and
#             checkpoints the database before exiting)
#   restart   stop, then start
#   status    container state plus /health and /ready
#   update    git pull --ff-only, rebuild, restart, wait for /health
#   logs      follow the container logs (keys never appear in them; the
#             runtime redacts key-shaped values before writing a line)
#   backup    scripts/backup.sh --docker  (prompts for a passphrase)
#   help      this text
#
# The port is published to 127.0.0.1 only. The dashboard is
# http://127.0.0.1:3000 unless ATRA_PORT is set in .env.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_DIR"

PORT=3000
if [ -f .env ]; then
  p=$(sed -n 's/^ATRA_PORT=\([0-9]*\).*/\1/p' .env | tail -n 1)
  [ -n "$p" ] && PORT=$p
fi
URL="http://127.0.0.1:$PORT"

die() {
  printf 'atra: %s\n' "$*" >&2
  exit 1
}

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
}

need_docker() {
  command -v docker >/dev/null 2>&1 || die "docker is not installed. Docker Desktop (Windows, macOS) or Docker Engine (Linux) is the supported install path; see docs/deployment.md"
  docker compose version >/dev/null 2>&1 || die "docker compose v2 is required (the 'docker compose' subcommand, not docker-compose)"
  docker info >/dev/null 2>&1 || die "the docker daemon is not running or this user cannot reach it"
}

fetch() {
  # GET a URL and print the body; exit non-zero on connection failure.
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 3 "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O - -T 3 "$1"
  else
    docker compose exec -T atra node -e "fetch(process.argv[1]).then(function(r){return r.text()}).then(function(t){process.stdout.write(t)}).catch(function(){process.exit(1)})" "$1"
  fi
}

wait_healthy() {
  printf 'atra: waiting for %s/health' "$URL" >&2
  i=0
  while [ $i -lt 60 ]; do
    if body=$(fetch "$URL/health" 2>/dev/null) && printf '%s' "$body" | grep -q '"status":"ok"'; then
      printf '\n' >&2
      return 0
    fi
    printf '.' >&2
    sleep 2
    i=$((i + 1))
  done
  printf '\n' >&2
  die "the runtime did not become healthy within two minutes; see 'scripts/atra.sh logs'"
}

print_next_steps() {
  ready=$(fetch "$URL/ready" 2>/dev/null || true)
  if printf '%s' "$ready" | grep -q '"setupRequired":true'; then
    printf 'atra: open %s and complete first-run setup. You start in PAPER mode.\n' "$URL"
  else
    printf 'atra: running at %s\n' "$URL"
  fi
}

cmd=${1:-help}
case "$cmd" in
  install)
    need_docker
    if [ ! -f .env ]; then
      cp .env.example .env
      printf 'atra: created .env from .env.example (everything in it is optional)\n' >&2
    fi
    docker compose build --pull
    docker compose up -d
    wait_healthy
    print_next_steps
    ;;
  start)
    need_docker
    docker compose up -d
    wait_healthy
    print_next_steps
    ;;
  stop)
    need_docker
    docker compose stop
    ;;
  restart)
    need_docker
    docker compose stop
    docker compose up -d
    wait_healthy
    ;;
  status)
    need_docker
    docker compose ps
    printf -- '--- %s/health ---\n' "$URL"
    fetch "$URL/health" || printf 'unreachable\n'
    printf '\n--- %s/ready ---\n' "$URL"
    fetch "$URL/ready" || printf '(503 before setup is complete, or unreachable)\n'
    printf '\n'
    ;;
  update)
    need_docker
    command -v git >/dev/null 2>&1 || die "git is not installed"
    git pull --ff-only
    docker compose build --pull
    docker compose up -d
    wait_healthy
    printf 'atra: updated to %s\n' "$(git rev-parse --short HEAD)"
    ;;
  logs)
    need_docker
    docker compose logs -f --tail 200
    ;;
  backup)
    shift
    exec sh "$SCRIPT_DIR/backup.sh" --docker "$@"
    ;;
  help|-h|--help)
    usage
    ;;
  *)
    printf 'atra: unknown command %s\n\n' "$cmd" >&2
    usage >&2
    exit 2
    ;;
esac
