#!/usr/bin/env bash
# Deploy the public website to Cloudflare Workers Static Assets.
#
# The API token is read from a file outside the repository and exported only
# for the wrangler process. It is never printed, never passed as an argument
# (arguments are visible in the process list) and never written anywhere by
# this script. Delete the file to revoke local access; revoke the token in the
# Cloudflare dashboard to revoke it everywhere.
#
#   scripts/deploy-web.sh [--dry-run]
#
# Expects:
#   ~/.cloudflare/atra.token   one line: the API token, nothing else
#   CLOUDFLARE_ACCOUNT_ID      optional; also readable from ~/.cloudflare/atra.account
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
token_file="${CLOUDFLARE_TOKEN_FILE:-$HOME/.cloudflare/atra.token}"
account_file="${CLOUDFLARE_ACCOUNT_FILE:-$HOME/.cloudflare/atra.account}"

if [[ ! -f "$token_file" ]]; then
  echo "No API token at $token_file" >&2
  echo "Create a scoped token in the Cloudflare dashboard and save it there." >&2
  exit 1
fi

# Permission hygiene: on a shared machine an ordinary-mode file is readable by
# other accounts. Not fatal on Windows, where POSIX modes are approximated.
if [[ "$(uname -s)" != MINGW* && "$(uname -s)" != MSYS* ]]; then
  mode="$(stat -c '%a' "$token_file" 2>/dev/null || echo '')"
  if [[ -n "$mode" && "$mode" != "600" && "$mode" != "400" ]]; then
    echo "warning: $token_file is mode $mode; chmod 600 it" >&2
  fi
fi

CLOUDFLARE_API_TOKEN="$(tr -d '\r\n' < "$token_file")"
export CLOUDFLARE_API_TOKEN
if [[ -z "$CLOUDFLARE_API_TOKEN" ]]; then
  echo "The token file is empty." >&2
  exit 1
fi

if [[ -z "${CLOUDFLARE_ACCOUNT_ID:-}" && -f "$account_file" ]]; then
  CLOUDFLARE_ACCOUNT_ID="$(tr -d '\r\n' < "$account_file")"
  export CLOUDFLARE_ACCOUNT_ID
fi

cd "$repo_root"

# Who the token belongs to, so a deploy cannot silently land in the wrong
# account. Account ids are identifiers, not secrets.
echo "== whoami =="
npx wrangler whoami || true

echo
echo "== build =="
npm run build

echo
echo "== deploy =="
if [[ "${1:-}" == "--dry-run" ]]; then
  npx wrangler deploy --dry-run
else
  npx wrangler deploy
fi
