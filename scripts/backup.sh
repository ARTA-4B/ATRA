#!/bin/sh
# ATRA backup: an encrypted archive of the SQLite database (which contains the
# encrypted wallet vault) and the .env configuration, made with the operator's
# own passphrase and left in a local directory. Nothing here touches the
# network, and nothing here prints a key, a password or the contents of the
# vault.
#
# Usage:
#   scripts/backup.sh [--docker | --data-dir DIR] [--env FILE] [--out DIR]
#                     [--passphrase-file FILE]
#
#   --docker            snapshot the database inside the compose volume
#                       (the default when docker-compose.yml is in the repo
#                       and docker is installed)
#   --data-dir DIR      snapshot a local data directory (non-Docker install)
#   --env FILE          the .env to include; default <repo>/.env, skipped if absent
#   --out DIR           where to write the archive; default <repo>/backups
#   --passphrase-file   read the passphrase from a file (for unattended use;
#                       keep it mode 0600). Otherwise it is prompted, twice,
#                       without echo.
#
# Output: <out>/atra-backup-<UTC stamp>.tar, a plain tar holding
#   meta.json       format, cipher and KDF parameters (nothing secret)
#   payload.enc     openssl enc AES-256-CBC, PBKDF2-SHA256, 600000 iterations
#   SHA256SUMS      sha256 of payload.enc, for bit-rot detection
# Inside payload.enc, once decrypted, is a tar.gz with atra.db, config/.env
# (if included) and MANIFEST with the sha256 of each file.
#
# Why openssl: it is present on every Linux distribution, on macOS (LibreSSL,
# which supports -pbkdf2), and inside Git for Windows. age is not installed
# anywhere by default and gpg's symmetric mode needs an agent and a TTY.
# AES-CBC is not authenticated, so restore verifies the gzip CRC and the
# MANIFEST hashes after decryption; a wrong passphrase or a corrupted archive
# cannot be mistaken for a good one.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

PBKDF2_ITER=600000
MODE=""
DATA_DIR=""
ENV_FILE="$REPO_DIR/.env"
ENV_GIVEN=0
OUT_DIR="$REPO_DIR/backups"
PASS_FILE=""

usage() {
  sed -n '2,34p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf 'backup: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker ;;
    --data-dir) [ $# -ge 2 ] || die "--data-dir needs a value"; MODE=local; DATA_DIR=$2; shift ;;
    --env) [ $# -ge 2 ] || die "--env needs a value"; ENV_FILE=$2; ENV_GIVEN=1; shift ;;
    --out) [ $# -ge 2 ] || die "--out needs a value"; OUT_DIR=$2; shift ;;
    --passphrase-file) [ $# -ge 2 ] || die "--passphrase-file needs a value"; PASS_FILE=$2; shift ;;
    -h|--help) usage 0 ;;
    *) printf 'backup: unknown argument %s\n' "$1" >&2; usage 2 ;;
  esac
  shift
done

if [ -z "$MODE" ]; then
  if [ -f "$REPO_DIR/docker-compose.yml" ] && command -v docker >/dev/null 2>&1; then
    MODE=docker
  else
    die "say where the data is: --docker or --data-dir DIR"
  fi
fi

# --- prerequisites ----------------------------------------------------------

command -v openssl >/dev/null 2>&1 || die "openssl is not installed; refusing to write an unencrypted backup"
command -v tar >/dev/null 2>&1 || die "tar is not installed"

# openssl enc must support -pbkdf2; LibreSSL before 2.9 and very old OpenSSL do not.
if ! openssl enc -help 2>&1 | grep -q -- '-pbkdf2'; then
  die "this openssl does not support 'enc -pbkdf2'; upgrade it rather than weakening the KDF"
fi

hash_file() {
  # sha256 of a file as lowercase hex, using whichever tool exists.
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

# --- passphrase -------------------------------------------------------------
#
# The passphrase is handed to openssl on stdin (-pass stdin), so it never
# appears in a process listing or the environment. printf is a shell builtin
# in every POSIX shell in use, so it does not appear in argv either.

read_passphrase() {
  if [ -n "$PASS_FILE" ]; then
    [ -r "$PASS_FILE" ] || die "cannot read passphrase file $PASS_FILE"
    PASS=$(head -n 1 "$PASS_FILE")
  else
    [ -t 0 ] || die "no terminal to prompt on; use --passphrase-file"
    printf 'Backup passphrase (min 12 characters, not echoed): ' >&2
    stty -echo
    read -r PASS
    stty echo
    printf '\n' >&2
    printf 'Repeat passphrase: ' >&2
    stty -echo
    read -r PASS2
    stty echo
    printf '\n' >&2
    [ "$PASS" = "$PASS2" ] || die "passphrases do not match"
    PASS2=""
  fi
  [ "${#PASS}" -ge 12 ] || die "passphrase must be at least 12 characters"
}

# --- staging ----------------------------------------------------------------

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
NAME="atra-backup-$STAMP"
umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/atra-backup.XXXXXX")
cleanup() {
  stty echo 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM
STAGE="$WORK/$NAME"
mkdir -p "$STAGE/config"

# One JavaScript program, shared with the Docker path, produces a consistent
# snapshot of a live WAL database with SQLite's own VACUUM INTO and prints its
# sha256. No double quotes on purpose: it travels as one argv on every shell.
SNAPSHOT_JS="const s=require('node:sqlite'),f=require('node:fs'),c=require('node:crypto'),a=process.argv;const d=new s.DatabaseSync(a[1]);d.prepare('VACUUM INTO ?').run(a[2]);d.close();console.log('sha256 '+c.createHash('sha256').update(f.readFileSync(a[2])).digest('hex'));"

case "$MODE" in
  local)
    [ -f "$DATA_DIR/atra.db" ] || die "no atra.db in $DATA_DIR"
    command -v node >/dev/null 2>&1 || die "node is needed to snapshot a live database (the runtime needs it too)"
    printf 'backup: snapshotting %s\n' "$DATA_DIR/atra.db" >&2
    SNAP_OUT=$(node -e "$SNAPSHOT_JS" "$DATA_DIR/atra.db" "$STAGE/atra.db") || die "snapshot failed"
    WANT=${SNAP_OUT#sha256 }
    SOURCE_DESC="local:$DATA_DIR"
    ;;
  docker)
    command -v docker >/dev/null 2>&1 || die "docker is not installed"
    cd "$REPO_DIR"
    docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
    # The container must exist for 'docker compose cp'; it does after the first
    # 'docker compose up'. If it was removed with 'down', create it without
    # starting it.
    if [ -z "$(docker compose ps -a -q atra 2>/dev/null)" ]; then
      docker compose create --no-build atra >/dev/null 2>&1 || die "no atra container; run 'docker compose up -d' once first"
    fi
    REMOTE="/data/.backup-$STAMP.db"
    printf 'backup: snapshotting the database inside the atra-data volume\n' >&2
    SNAP_OUT=$(docker compose run --rm --no-deps -T atra node -e "$SNAPSHOT_JS" /data/atra.db "$REMOTE") || die "snapshot inside the container failed"
    WANT=$(printf '%s\n' "$SNAP_OUT" | grep '^sha256 ' | tail -n 1)
    WANT=${WANT#sha256 }
    docker compose cp "atra:$REMOTE" "$STAGE/atra.db" >/dev/null || die "copy out of the container failed"
    docker compose run --rm --no-deps -T atra node -e "require('node:fs').unlinkSync(process.argv[1])" "$REMOTE" >/dev/null 2>&1 || printf 'backup: warning: could not remove %s from the volume\n' "$REMOTE" >&2
    SOURCE_DESC="docker:atra-data"
    ;;
esac

GOT=$(hash_file "$STAGE/atra.db")
[ "$GOT" = "$WANT" ] || die "snapshot hash mismatch (expected $WANT, got $GOT); refusing to archive a corrupt copy"

if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$STAGE/config/.env"
  ENV_DESC="included"
elif [ "$ENV_GIVEN" -eq 1 ]; then
  die "env file $ENV_FILE does not exist"
else
  rmdir "$STAGE/config"
  ENV_DESC="none found"
fi

RUNTIME_VERSION=$(sed -n 's/^ *"version": *"\([^"]*\)".*/\1/p' "$REPO_DIR/runtime/package.json" 2>/dev/null | head -n 1)

{
  printf 'atra-backup manifest v1\n'
  printf 'created_utc %s\n' "$STAMP"
  printf 'source %s\n' "$SOURCE_DESC"
  printf 'runtime_version %s\n' "${RUNTIME_VERSION:-unknown}"
  printf 'files\n'
  (cd "$STAGE" && find . -type f ! -name MANIFEST | sort | while read -r f; do
    printf '%s  %s\n' "$(hash_file "$f")" "${f#./}"
  done)
} > "$STAGE/MANIFEST"

# --- encrypt ----------------------------------------------------------------

read_passphrase

PLAIN="$WORK/payload.tar.gz"
(cd "$WORK" && tar -czf "$PLAIN" "$NAME")

OUTER="$WORK/outer"
mkdir -p "$OUTER"
printf '%s\n' "$PASS" | openssl enc -aes-256-cbc -pbkdf2 -iter "$PBKDF2_ITER" -md sha256 -salt \
  -pass stdin -in "$PLAIN" -out "$OUTER/payload.enc" || die "encryption failed"
PASS=""
rm -f "$PLAIN"

cat > "$OUTER/meta.json" <<JSON
{
  "format": "atra-backup/1",
  "created_utc": "$STAMP",
  "source": "$SOURCE_DESC",
  "cipher": "aes-256-cbc",
  "kdf": "pbkdf2",
  "kdf_md": "sha256",
  "kdf_iter": $PBKDF2_ITER,
  "payload": "payload.enc",
  "payload_contains": "tar.gz of $NAME/{atra.db,config/.env,MANIFEST}",
  "restore": "scripts/restore.sh, or: openssl enc -d -aes-256-cbc -pbkdf2 -iter $PBKDF2_ITER -md sha256 -in payload.enc | tar -xz"
}
JSON
printf '%s  payload.enc\n' "$(hash_file "$OUTER/payload.enc")" > "$OUTER/SHA256SUMS"

mkdir -p "$OUT_DIR"
# The default output directory sits inside the checkout; make it ignore itself
# so an archive can never be committed by accident, whatever .gitignore says.
[ -e "$OUT_DIR/.gitignore" ] || printf '*
' > "$OUT_DIR/.gitignore"
FINAL="$OUT_DIR/$NAME.tar"
(cd "$OUTER" && tar -cf "$FINAL" meta.json SHA256SUMS payload.enc)
chmod 600 "$FINAL" 2>/dev/null || true

SIZE=$(wc -c < "$FINAL" | tr -d ' ')
printf 'backup: wrote %s (%s bytes)\n' "$FINAL" "$SIZE" >&2
printf 'backup: database snapshot sha256 %s... (full hash inside MANIFEST); config %s\n' "$(printf '%s' "$GOT" | cut -c1-16)" "$ENV_DESC" >&2
printf 'backup: the archive opens only with this passphrase, and the vault inside it only with the dashboard password. Store both, separately, offline.\n' >&2
printf '%s\n' "$FINAL"
