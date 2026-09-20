#!/bin/sh
# Secret scan over the tracked tree, for the release checklist
# (docs/SECURITY_RELEASE_CHECKLIST.md) and for anyone about to push.
#
# It is deliberately blunt. It looks for the shapes that must never be
# committed and for files that should never be tracked, prints every hit so
# a reviewer can judge it, and fails when a hit lies outside the paths where
# published test vectors are allowed to live. Run from anywhere:
#
#   sh scripts/secret-scan.sh            # exit 0 = clean
#
# What it checks:
#   1. key-shaped strings in every tracked file: 32-byte hex (EVM private
#      keys; also sha256 digests, which is why hits are listed rather than
#      hidden), base58 64-byte values (Solana secret keys), Telegram bot
#      tokens, Solana id.json arrays, BIP-39 phrases, common API key prefixes
#      and PEM private-key headers;
#   2. tracked files that are data, not source: SQLite databases and their
#      WAL/SHM side files, .env files, keystores, PEM/key files;
#   3. gitleaks over the working tree and the history, when it is installed.
#
# Paths where published test vectors are expected (the same list CI uses,
# plus the spec documents that print the vectors) do not fail the scan, but
# their hits are still printed under "allowed" so nobody stops reading them.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_DIR"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { printf 'secret-scan: not a git checkout\n' >&2; exit 2; }

status=0

# Files that carry published vectors on purpose. A hit here is printed as
# allowed; a hit anywhere else fails the scan.
ALLOWED='^(runtime/test/|gateway/test/|gateway/vitest\.config\.ts$|docs/specs/|model/atra-4b/tests/)'

KEY_PATTERN='(0x)?[0-9a-fA-F]{64}|[1-9A-HJ-NP-Za-km-z]{86,88}|[0-9]{8,12}:[A-Za-z0-9_-]{30,}|\[[[:space:]]*([0-9]{1,3}[[:space:]]*,[[:space:]]*){63}[0-9]{1,3}[[:space:]]*\]|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(sk|pk|rk)-[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[abprs]-[A-Za-z0-9-]{10,}'

printf '== 1. key-shaped strings in tracked files ==\n'
hits=$(git grep -nIE "$KEY_PATTERN" -- . ':!*.lock' ':!pnpm-lock.yaml' ':!package-lock.json' ':!scripts/secret-scan.sh' 2>/dev/null | grep -v 'integrity sha' || true)
if [ -z "$hits" ]; then
  printf 'none\n'
else
  printf '%s\n' "$hits" | while IFS= read -r line; do
    path=${line%%:*}
    if printf '%s' "$path" | grep -qE "$ALLOWED"; then
      printf 'allowed  %s\n' "$(printf '%s' "$line" | cut -c1-160)"
    else
      printf 'FAIL     %s\n' "$(printf '%s' "$line" | cut -c1-160)"
    fi
  done
  if printf '%s\n' "$hits" | cut -d: -f1 | grep -vqE "$ALLOWED"; then
    status=1
  fi
fi

printf '\n== 2. tracked files that should never be tracked ==\n'
bad=$(git ls-files | grep -E '(^|/)(\.env(\..*)?|[^/]*\.(db|db-wal|db-shm|sqlite|sqlite3|pem|key|p12|pfx)|id\.json|keystore[^/]*\.json)$' | grep -vE '(^|/)\.env\.example$' || true)
if [ -z "$bad" ]; then
  printf 'none\n'
else
  printf '%s\n' "$bad" | sed 's/^/FAIL     /'
  status=1
fi

printf '\n== 3. gitleaks ==\n'
if command -v gitleaks >/dev/null 2>&1; then
  report=$(mktemp "${TMPDIR:-/tmp}/atra-gitleaks.XXXXXX")
  # --redact keeps the matched value out of the report; only rule, file and
  # line are printed. Findings do not fail this step by themselves: the list
  # is compared against the fixtures named in the release checklist.
  if gitleaks detect --source . --no-banner --redact=100 --exit-code 0 --report-format json --report-path "$report" >/dev/null 2>&1; then
    n=$(grep -c '"RuleID"' "$report" 2>/dev/null || true)
    printf 'history: %s finding(s); each must be a published vector or a test fixture named in the checklist\n' "${n:-0}"
    grep -E '"(RuleID|File|StartLine)"' "$report" 2>/dev/null | paste - - - | sed -E 's/[[:space:]]+/ /g; s/"//g; s/,//g' | sed 's/^/  /' | sort -u
  else
    printf 'gitleaks failed to run\n'
    status=1
  fi
  rm -f "$report"
else
  printf 'gitleaks is not installed; skipped (install it to scan the history: https://github.com/gitleaks/gitleaks)\n'
fi

printf '\n'
if [ "$status" -eq 0 ]; then
  printf 'secret-scan: clean\n'
else
  printf 'secret-scan: FAILED; fix every FAIL line before release\n' >&2
fi
exit "$status"
