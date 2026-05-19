#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-$APP_DIR/backups/postgres}"
MAX_AGE_HOURS="${MAX_AGE_HOURS:-26}"
REQUIRE_CHECKSUM="${REQUIRE_CHECKSUM:-true}"
BACKUP_OBJECT_STORAGE_ENABLED="${BACKUP_OBJECT_STORAGE_ENABLED:-false}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 ./scripts/check-backup-age.sh" >&2
  exit 1
fi

if ! [[ "$MAX_AGE_HOURS" =~ ^[0-9]+$ ]] || [ "$MAX_AGE_HOURS" -le 0 ]; then
  echo "MAX_AGE_HOURS must be a positive integer." >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

backup_info="$(
  ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "REMOTE_BACKUP_DIR=$(quote "$REMOTE_BACKUP_DIR") REQUIRE_CHECKSUM=$(quote "$REQUIRE_CHECKSUM") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if [ ! -d "$REMOTE_BACKUP_DIR" ]; then
  echo "Remote backup directory does not exist: $REMOTE_BACKUP_DIR" >&2
  exit 1
fi

latest="$(find "$REMOTE_BACKUP_DIR" -maxdepth 1 -type f -name '*.dump' -print0 | xargs -0 ls -1t 2>/dev/null | head -1 || true)"

if [ -z "$latest" ]; then
  echo "No Postgres dump files found in $REMOTE_BACKUP_DIR." >&2
  exit 1
fi

if [ "$REQUIRE_CHECKSUM" = "true" ] && [ ! -f "$latest.sha256" ]; then
  echo "Latest backup is missing checksum sidecar: $latest.sha256" >&2
  exit 1
fi

if [ "$REQUIRE_CHECKSUM" = "true" ]; then
  expected="$(awk '{print $1; exit}' "$latest.sha256")"
  actual="$(sha256sum "$latest" | awk '{print $1}')"

  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Latest backup checksum mismatch: $latest" >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    exit 1
  fi
fi

mtime="$(stat -c '%Y' "$latest")"
size="$(stat -c '%s' "$latest")"
printf '%s|%s|%s\n' "$latest" "$mtime" "$size"
REMOTE_SCRIPT
)"

backup_path="${backup_info%%|*}"
rest="${backup_info#*|}"
backup_mtime="${rest%%|*}"
backup_size="${rest##*|}"
now="$(date -u +%s)"
age_seconds=$((now - backup_mtime))
max_age_seconds=$((MAX_AGE_HOURS * 3600))

if [ "$backup_size" -le 0 ]; then
  echo "Latest backup is empty: $backup_path" >&2
  exit 1
fi

if [ "$age_seconds" -gt "$max_age_seconds" ]; then
  echo "Latest backup is too old: $backup_path" >&2
  echo "Age: ${age_seconds}s; max: ${max_age_seconds}s" >&2
  exit 1
fi

echo "Latest backup is fresh: $backup_path"
echo "Age seconds: $age_seconds"
echo "Size bytes: $backup_size"

if [ "$BACKUP_OBJECT_STORAGE_ENABLED" = "true" ]; then
  if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required to check object-storage backup freshness." >&2
    exit 1
  fi

  BACKUP_S3_MAX_AGE_HOURS="${BACKUP_S3_MAX_AGE_HOURS:-$MAX_AGE_HOURS}" \
    bun scripts/s3-backup-object.ts --check-latest
fi
