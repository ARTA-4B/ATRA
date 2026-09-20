#!/bin/sh
# ATRA restore: the reverse of scripts/backup.sh. Decrypts an archive with the
# operator's passphrase, verifies every hash, and installs the database into a
# data directory or the compose volume. It refuses to overwrite an existing
# database unless --force is given, and it refuses while the runtime is
# running. Nothing here touches the network or prints a secret.
#
# Usage:
#   scripts/restore.sh ARCHIVE.tar (--docker | --data-dir DIR)
#                      [--force] [--env-out FILE] [--passphrase-file FILE]
#
#   --docker            install into the atra-data compose volume
#   --data-dir DIR      install into a local data directory (created if missing)
#   --force             replace an existing atra.db. The old one is kept as
#                       atra.db.pre-restore-<stamp>, never deleted.
#   --env-out FILE      also write the archived .env to FILE. Refused if FILE
#                       exists, unless --force. Without this flag the config
#                       stays in the archive and only the database is restored.
#   --passphrase-file   read the passphrase from a file instead of prompting
#
# The vault inside the restored database still needs the dashboard password
# it was created with; the backup passphrase only opens the archive.

set -eu

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

ARCHIVE=""
MODE=""
DATA_DIR=""
FORCE=0
ENV_OUT=""
PASS_FILE=""

usage() {
  sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'
  exit "${1:-0}"
}

die() {
  printf 'restore: %s\n' "$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --docker) MODE=docker ;;
    --data-dir) [ $# -ge 2 ] || die "--data-dir needs a value"; MODE=local; DATA_DIR=$2; shift ;;
    --force) FORCE=1 ;;
    --env-out) [ $# -ge 2 ] || die "--env-out needs a value"; ENV_OUT=$2; shift ;;
    --passphrase-file) [ $# -ge 2 ] || die "--passphrase-file needs a value"; PASS_FILE=$2; shift ;;
    -h|--help) usage 0 ;;
    -*) printf 'restore: unknown argument %s\n' "$1" >&2; usage 2 ;;
    *) [ -z "$ARCHIVE" ] || die "only one archive at a time"; ARCHIVE=$1 ;;
  esac
  shift
done

[ -n "$ARCHIVE" ] || usage 2
[ -f "$ARCHIVE" ] || die "no such file: $ARCHIVE"
[ -n "$MODE" ] || die "say where to restore: --docker or --data-dir DIR"

command -v openssl >/dev/null 2>&1 || die "openssl is not installed"
command -v tar >/dev/null 2>&1 || die "tar is not installed"

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | cut -d' ' -f1
  else
    openssl dgst -sha256 -r "$1" | cut -d' ' -f1
  fi
}

read_passphrase() {
  if [ -n "$PASS_FILE" ]; then
    [ -r "$PASS_FILE" ] || die "cannot read passphrase file $PASS_FILE"
    PASS=$(head -n 1 "$PASS_FILE")
  else
    [ -t 0 ] || die "no terminal to prompt on; use --passphrase-file"
    printf 'Backup passphrase (not echoed): ' >&2
    stty -echo
    read -r PASS
    stty echo
    printf '\n' >&2
  fi
  [ -n "$PASS" ] || die "empty passphrase"
}

# --- refuse while the runtime is running -------------------------------------
#
# Replacing a database file underneath a process that has it open corrupts
# the process's view of it. The check is best effort; the documentation says
# to stop the runtime first, and --force does not override this.

runtime_running_locally() {
  port=${ATRA_PORT:-3000}
  if command -v curl >/dev/null 2>&1; then
    curl -fsS --max-time 2 "http://127.0.0.1:$port/health" >/dev/null 2>&1
  elif command -v node >/dev/null 2>&1; then
    node -e "fetch('http://127.0.0.1:$port/health',{signal:AbortSignal.timeout(2000)}).then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})" >/dev/null 2>&1
  else
    return 1
  fi
}

case "$MODE" in
  local)
    if runtime_running_locally; then
      die "a runtime is answering on 127.0.0.1:${ATRA_PORT:-3000}; stop it before restoring"
    fi
    ;;
  docker)
    command -v docker >/dev/null 2>&1 || die "docker is not installed"
    cd "$REPO_DIR"
    docker compose version >/dev/null 2>&1 || die "docker compose v2 is required"
    if [ -n "$(docker compose ps --status running -q atra 2>/dev/null)" ]; then
      die "the atra container is running; 'docker compose stop' first"
    fi
    if [ -z "$(docker compose ps -a -q atra 2>/dev/null)" ]; then
      docker compose create --no-build atra >/dev/null 2>&1 || die "no atra container; run 'docker compose up -d' once, then 'docker compose stop'"
    fi
    ;;
esac

# --- unpack and decrypt -----------------------------------------------------

umask 077
WORK=$(mktemp -d "${TMPDIR:-/tmp}/atra-restore.XXXXXX")
cleanup() {
  stty echo 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

mkdir -p "$WORK/outer"
tar -xf "$ARCHIVE" -C "$WORK/outer" || die "not a readable archive"
[ -f "$WORK/outer/meta.json" ] || die "meta.json missing; this is not an ATRA backup"
[ -f "$WORK/outer/payload.enc" ] || die "payload.enc missing"

FORMAT=$(sed -n 's/.*"format": *"\([^"]*\)".*/\1/p' "$WORK/outer/meta.json")
[ "$FORMAT" = "atra-backup/1" ] || die "unsupported backup format '$FORMAT'"
ITER=$(sed -n 's/.*"kdf_iter": *\([0-9]*\).*/\1/p' "$WORK/outer/meta.json")
[ -n "$ITER" ] || die "meta.json has no kdf_iter"
CREATED=$(sed -n 's/.*"created_utc": *"\([^"]*\)".*/\1/p' "$WORK/outer/meta.json")

if [ -f "$WORK/outer/SHA256SUMS" ]; then
  WANT=$(cut -d' ' -f1 "$WORK/outer/SHA256SUMS")
  GOT=$(hash_file "$WORK/outer/payload.enc")
  [ "$WANT" = "$GOT" ] || die "payload.enc is damaged (sha256 mismatch); this archive cannot be trusted"
fi

read_passphrase
printf 'restore: decrypting backup from %s\n' "${CREATED:-unknown time}" >&2
if ! printf '%s\n' "$PASS" | openssl enc -d -aes-256-cbc -pbkdf2 -iter "$ITER" -md sha256 \
     -pass stdin -in "$WORK/outer/payload.enc" -out "$WORK/payload.tar.gz" 2>/dev/null; then
  PASS=""
  die "decryption failed: wrong passphrase or damaged archive"
fi
PASS=""

mkdir -p "$WORK/plain"
# gzip's CRC and tar's structure are the first integrity check after CBC.
tar -xzf "$WORK/payload.tar.gz" -C "$WORK/plain" 2>/dev/null || die "decrypted payload is not a valid tar.gz: wrong passphrase or damaged archive"
rm -f "$WORK/payload.tar.gz"

STAGE=$(find "$WORK/plain" -mindepth 1 -maxdepth 1 -type d -name 'atra-backup-*' | head -n 1)
[ -n "$STAGE" ] || die "payload has no atra-backup-* directory"
[ -f "$STAGE/MANIFEST" ] || die "MANIFEST missing from payload"
[ -f "$STAGE/atra.db" ] || die "atra.db missing from payload"

# Every file must match the hash recorded when the backup was made. The loop
# reads from a file rather than a pipe so that `die` runs in this shell.
sed -n '/^files$/,$p' "$STAGE/MANIFEST" | sed '1d' > "$WORK/manifest-files"
while read -r want name; do
  [ -n "$name" ] || continue
  [ -f "$STAGE/$name" ] || die "MANIFEST names $name but it is missing"
  got=$(hash_file "$STAGE/$name")
  [ "$got" = "$want" ] || die "$name does not match its MANIFEST hash; refusing to install a corrupt file"
done < "$WORK/manifest-files"

DB_HASH=$(hash_file "$STAGE/atra.db")

# A structural check with SQLite itself when node is available locally.
if command -v node >/dev/null 2>&1; then
  CHECK=$(node -e "const s=require('node:sqlite');const d=new s.DatabaseSync(process.argv[1],{readOnly:true});console.log(d.prepare('PRAGMA integrity_check').get().integrity_check);d.close();" "$STAGE/atra.db" 2>/dev/null || printf 'unavailable')
  [ "$CHECK" = "ok" ] || [ "$CHECK" = "unavailable" ] || die "SQLite integrity_check reported: $CHECK"
fi

# --- install ----------------------------------------------------------------

STAMP=$(date -u +%Y%m%dT%H%M%SZ)

case "$MODE" in
  local)
    mkdir -p "$DATA_DIR"
    if [ -e "$DATA_DIR/atra.db" ]; then
      [ "$FORCE" -eq 1 ] || die "$DATA_DIR/atra.db exists; pass --force to replace it (the old file is kept)"
      mv "$DATA_DIR/atra.db" "$DATA_DIR/atra.db.pre-restore-$STAMP"
      rm -f "$DATA_DIR/atra.db-wal" "$DATA_DIR/atra.db-shm"
      printf 'restore: previous database kept as %s\n' "$DATA_DIR/atra.db.pre-restore-$STAMP" >&2
    fi
    cp "$STAGE/atra.db" "$DATA_DIR/atra.db.incoming"
    [ "$(hash_file "$DATA_DIR/atra.db.incoming")" = "$DB_HASH" ] || die "copy into $DATA_DIR did not verify"
    mv "$DATA_DIR/atra.db.incoming" "$DATA_DIR/atra.db"
    chmod 600 "$DATA_DIR/atra.db" 2>/dev/null || true
    printf 'restore: installed %s/atra.db (sha256 %s...)\n' "$DATA_DIR" "$(printf '%s' "$DB_HASH" | cut -c1-16)" >&2
    ;;
  docker)
    REMOTE="/data/.restore-$STAMP.db"
    docker compose cp "$STAGE/atra.db" "atra:$REMOTE" >/dev/null || die "copy into the container failed"
    # copyFileSync rather than rename: 'docker cp' leaves the file owned by
    # root, and the runtime runs as 'node'. A fresh copy is owned by the
    # process writing it. No double quotes in the program, on purpose.
    INSTALL_JS="const f=require('node:fs'),c=require('node:crypto'),a=process.argv;const src=a[1],dst=a[2],want=a[3],force=a[4],stamp=a[5];const got=c.createHash('sha256').update(f.readFileSync(src)).digest('hex');if(got!==want){console.error('sha256 mismatch after copy');process.exit(4)}if(f.existsSync(dst)){if(force!=='1'){f.unlinkSync(src);console.error('refusing to overwrite an existing database; pass --force (the old file is kept)');process.exit(3)}const b=dst+'.pre-restore-'+stamp;f.renameSync(dst,b);for(const x of ['-wal','-shm']){try{f.unlinkSync(dst+x)}catch(e){}}console.log('previous database kept as '+b)}f.copyFileSync(src,dst+'.incoming');f.renameSync(dst+'.incoming',dst);f.unlinkSync(src);console.log('installed '+dst);"
    if ! docker compose run --rm --no-deps -T atra node -e "$INSTALL_JS" "$REMOTE" /data/atra.db "$DB_HASH" "$FORCE" "$STAMP" >&2; then
      die "install inside the volume failed"
    fi
    printf 'restore: installed /data/atra.db in the atra-data volume (sha256 %s...)\n' "$(printf '%s' "$DB_HASH" | cut -c1-16)" >&2
    ;;
esac

# --- config -----------------------------------------------------------------

if [ -n "$ENV_OUT" ]; then
  if [ -f "$STAGE/config/.env" ]; then
    if [ -e "$ENV_OUT" ] && [ "$FORCE" -ne 1 ]; then
      die "$ENV_OUT exists; pass --force to replace it"
    fi
    cp "$STAGE/config/.env" "$ENV_OUT"
    chmod 600 "$ENV_OUT" 2>/dev/null || true
    printf 'restore: wrote config to %s\n' "$ENV_OUT" >&2
  else
    printf 'restore: the archive holds no config file; nothing written to %s\n' "$ENV_OUT" >&2
  fi
elif [ -f "$STAGE/config/.env" ]; then
  printf 'restore: the archive also holds a .env; pass --env-out FILE to restore it\n' >&2
fi

printf 'restore: done. Start the runtime and sign in with the dashboard password the vault was created with.\n' >&2
