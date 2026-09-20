#!/bin/sh
# The security release gate, runnable. Each line of section 11 of the spec
# (docs/SECURITY_RELEASE_CHECKLIST.md) maps to one step here; the step either
# runs the test files that prove the line or performs the scan, and the
# summary at the end says PASS, FAIL or SKIP with the reason. Nothing is
# modified. Run from anywhere; it takes a few minutes:
#
#   sh scripts/release-gate.sh
#
# Selecting tests by name (vitest -t) is deliberate: the count printed next
# to a line is the number of tests whose names mention that property, which
# is what a reviewer wants to see, rather than "the suite passed".
#
# The gate does not replace reading the checklist. Two lines cannot be
# automated and are printed as MANUAL: "no third-party audit is claimed" and
# the review of gitleaks findings against the list of published vectors.

set -u

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)
cd "$REPO_DIR"

RESULTS=$(mktemp "${TMPDIR:-/tmp}/atra-gate.XXXXXX")
trap 'rm -f "$RESULTS"' EXIT INT TERM
overall=0

record() {
  # record STATUS "line" "evidence"
  printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$RESULTS"
  [ "$1" = "FAIL" ] && overall=1
  printf '[%s] %s: %s\n' "$1" "$2" "$3"
}

# Run vitest on a name filter inside a project directory and report the
# number of passing tests. Prints "passed=N failed=M" on success.
vitest_named() {
  dir=$1
  pattern=$2
  out=$(cd "$dir" && npx vitest run -t "$pattern" 2>&1)
  code=$?
  passed=$(printf '%s\n' "$out" | sed -n 's/.*Tests[[:space:]]*\([0-9][0-9]*\) passed.*/\1/p' | tail -n 1)
  failed=$(printf '%s\n' "$out" | sed -n 's/.*Tests.*[[:space:]]\([0-9][0-9]*\) failed.*/\1/p' | tail -n 1)
  printf 'passed=%s failed=%s exit=%s' "${passed:-0}" "${failed:-0}" "$code"
  [ "$code" -eq 0 ] && [ "${passed:-0}" -gt 0 ]
}

vitest_files() {
  dir=$1
  shift
  out=$(cd "$dir" && npx vitest run "$@" 2>&1)
  code=$?
  passed=$(printf '%s\n' "$out" | sed -n 's/.*Tests[[:space:]]*\([0-9][0-9]*\) passed.*/\1/p' | tail -n 1)
  failed=$(printf '%s\n' "$out" | sed -n 's/.*Tests.*[[:space:]]\([0-9][0-9]*\) failed.*/\1/p' | tail -n 1)
  printf 'passed=%s failed=%s exit=%s (%s)' "${passed:-0}" "${failed:-0}" "$code" "$*"
  [ "$code" -eq 0 ] && [ "${passed:-0}" -gt 0 ]
}

printf '== ATRA security release gate, %s ==\n\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# --- 1. dependency audit ------------------------------------------------------

audit_one() {
  dir=$1
  tool=$2
  case "$tool" in
    pnpm) out=$(cd "$dir" && pnpm audit --prod 2>&1); code=$? ;;
    npm) out=$(cd "$dir" && npm audit --omit=dev 2>&1); code=$? ;;
  esac
  if [ "$code" -eq 0 ]; then
    record PASS "dependency audit ($dir)" "$(printf '%s\n' "$out" | tail -n 1)"
  elif printf '%s' "$out" | grep -qE 'ERR_PNPM_AUDIT_BAD_RESPONSE|responded with 50[0-9]|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNREFUSED'; then
    record SKIP "dependency audit ($dir)" "registry unreachable: $(printf '%s\n' "$out" | tail -n 1 | cut -c1-120)"
  else
    record FAIL "dependency audit ($dir)" "$(printf '%s\n' "$out" | grep -iE 'vulnerabilit|severity' | head -n 3 | tr '\n' ' ')"
  fi
}
if command -v pnpm >/dev/null 2>&1; then
  audit_one runtime pnpm
  audit_one gateway pnpm
else
  record SKIP "dependency audit (runtime, gateway)" "pnpm is not installed"
fi
if command -v npm >/dev/null 2>&1 && [ -f package-lock.json ]; then
  audit_one . npm
else
  record SKIP "dependency audit (frontend)" "npm or package-lock.json missing"
fi

# --- 2. secret scan -----------------------------------------------------------

if sh scripts/secret-scan.sh > "$RESULTS.scan" 2>&1; then
  record PASS "secret scan" "scripts/secret-scan.sh clean; $(grep -c '^allowed' "$RESULTS.scan") allowed hit(s) in test/spec paths"
else
  record FAIL "secret scan" "$(grep -c '^FAIL' "$RESULTS.scan") FAIL line(s); run scripts/secret-scan.sh"
fi
rm -f "$RESULTS.scan"

# --- 3. no hardcoded provider credentials ------------------------------------

cred_hits=$(git grep -nIiE '(apikey|api_key|bot_token|bottoken|secret|pepper|password)["'"'"']?[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9_:/.+=-]{12,}["'"'"']' -- runtime/src gateway/src src gateway/wrangler.jsonc 2>/dev/null | grep -vE 'placeholder|REPLACE_WITH|example|\.invalid' || true)
if [ -z "$cred_hits" ]; then
  record PASS "no hardcoded provider credentials" "no key/token/password literal in runtime/src, gateway/src, src or wrangler.jsonc; keys come from the environment (runtime/src/config/env.ts) and wrangler secrets"
else
  record FAIL "no hardcoded provider credentials" "$(printf '%s\n' "$cred_hits" | head -n 3 | cut -c1-120 | tr '\n' ' ')"
fi

# --- 4. no private keys in fixtures ------------------------------------------
# The secret scan lists every key-shaped fixture. This step re-checks the one
# property that can be checked mechanically: no fixture key is a *valid*
# Solana keypair (public half derived from the secret half), which would mean
# somebody committed a generated key rather than a published vector.

if [ -d runtime/node_modules/@noble/curves ]; then
  b58=$(git grep -hoE '[1-9A-HJ-NP-Za-km-z]{86,88}' -- runtime/test gateway/test 2>/dev/null | sort -u)
  bad=0
  for k in $b58; do
    if (cd runtime && node -e "
const {base58}=require('@scure/base');const {ed25519}=require('@noble/curves/ed25519.js');
const b=base58.decode(process.argv[1]);if(b.length!==64)process.exit(0);
const pub=ed25519.getPublicKey(b.slice(0,32));process.exit(Buffer.from(pub).equals(Buffer.from(b.slice(32)))?1:0);" "$k" 2>/dev/null); then :; else bad=$((bad + 1)); fi
  done
  if [ "$bad" -eq 0 ]; then
    record PASS "no private keys in fixtures" "$(printf '%s\n' "$b58" | grep -c . ) base58 fixture(s), none is a valid ed25519 keypair; hex fixtures are the published Web3 Secret Storage, RFC 8032 and key=1 vectors (see checklist)"
  else
    record FAIL "no private keys in fixtures" "$bad base58 fixture(s) are valid keypairs"
  fi
else
  record SKIP "no private keys in fixtures" "runtime/node_modules missing; run pnpm install in runtime/"
fi

# --- 5. no arbitrary transaction endpoint ------------------------------------

arb=$(git grep -nIE 'calldata|rawTransaction|sendRawTransaction|signRaw|eth_sendTransaction|/tx/send|[^a-zA-Z]call\(to|data: z\.' -- runtime/src/http/routes 2>/dev/null || true)
iface=$(grep -nE '^\s*call\s*\(' runtime/src/execution/types.ts 2>/dev/null || true)
if [ -z "$arb" ] && [ -z "$iface" ]; then
  n=$(grep -hE '\.(post|put|patch|delete)\(' runtime/src/http/routes/*.ts | wc -l | tr -d ' ')
  record PASS "no arbitrary transaction endpoint" "$n write routes, none accepts calldata or a raw transaction; ExecutionAdapter has no call(to, data)"
else
  record FAIL "no arbitrary transaction endpoint" "$(printf '%s\n%s\n' "$arb" "$iface" | head -n 3 | tr '\n' ' ')"
fi

# --- 6..14 tests --------------------------------------------------------------

run_gate() {
  line=$1
  dir=$2
  shift 2
  if ev=$(vitest_files "$dir" "$@"); then
    record PASS "$line" "$ev"
  else
    record FAIL "$line" "$ev"
  fi
}
run_named() {
  line=$1
  dir=$2
  pattern=$3
  if ev=$(vitest_named "$dir" "$pattern"); then
    record PASS "$line" "$ev for -t '$pattern' in $dir"
  else
    record FAIL "$line" "$ev for -t '$pattern' in $dir"
  fi
}

run_gate "auth tests" runtime test/api.test.ts test/review-regressions.test.ts
run_gate "Telegram authorization tests (runtime)" runtime test/telegram-commands.test.ts test/telegram-pairing.test.ts test/telegram-service.test.ts test/telegram-routes.test.ts test/telegram-transport.test.ts
if [ -d gateway/node_modules ]; then
  run_gate "Telegram authorization tests (gateway)" gateway test/webhook.test.ts test/ws.test.ts test/admin.test.ts
else
  record SKIP "Telegram authorization tests (gateway)" "gateway/node_modules missing; run pnpm install in gateway/"
fi
run_gate "wallet-vault tests" runtime test/vault.test.ts test/wallet-keys.test.ts
run_gate "risk-engine tests" runtime test/risk-engine.test.ts test/ledger-gate.test.ts test/review-regressions.test.ts
run_named "emergency-stop tests" runtime "emergency"
run_named "restart/recovery tests" runtime "restart|reconcil|across a restart"
run_named "malformed LLM output tests" runtime "malformed model output|parse failure|rejects free text|rejects an empty reply|rejects truncated|rejects an unknown enum|rejects a missing field|contradict|invented|null provider"
run_named "RPC failure tests" runtime "RPC|provider that throws|providers fail|one provider fails|unreachable endpoint|rate limit as a typed error|unreadable chain"
run_named "stale market-data tests" runtime "stale"

record MANUAL "no third-party audit claimed" "none has occurred; README.md and SECURITY.md say so"
record MANUAL "gitleaks findings reviewed" "compare the list printed by scripts/secret-scan.sh with the fixtures named in docs/SECURITY_RELEASE_CHECKLIST.md"

printf '\n== summary ==\n'
awk -F'\t' '{ printf "%-7s %-45s %s\n", $1, $2, $3 }' "$RESULTS"
printf '\n'
if [ "$overall" -eq 0 ]; then
  printf 'release-gate: no FAIL lines (MANUAL and SKIP lines still need a human)\n'
else
  printf 'release-gate: FAIL lines present; V1 is not ready\n' >&2
fi
exit "$overall"
