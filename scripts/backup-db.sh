#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-$APP_DIR/backups/postgres}"
LOCAL_BACKUP_DIR="${LOCAL_BACKUP_DIR:-backups/postgres}"
BACKUP_NAME="${BACKUP_NAME:-continuous-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
COPY_TO_LOCAL="${COPY_TO_LOCAL:-true}"
BACKUP_OBJECT_STORAGE_ENABLED="${BACKUP_OBJECT_STORAGE_ENABLED:-false}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 ./scripts/backup-db.sh" >&2
  exit 1
fi

if [[ "$BACKUP_NAME" != *.dump ]]; then
  BACKUP_NAME="$BACKUP_NAME.dump"
fi

remote_env_script() {
  printf 'set -euo pipefail\n'
  printf 'export APP_DIR=%q\n' "$APP_DIR"
  printf 'export REMOTE_BACKUP_DIR=%q\n' "$REMOTE_BACKUP_DIR"
  printf 'export BACKUP_NAME=%q\n' "$BACKUP_NAME"
  printf 'export RETENTION_DAYS=%q\n' "$RETENTION_DAYS"
  printf 'export BACKUP_OBJECT_STORAGE_ENABLED=%q\n' "$BACKUP_OBJECT_STORAGE_ENABLED"
  printf 'export BACKUP_S3_ENDPOINT=%q\n' "${BACKUP_S3_ENDPOINT:-}"
  printf 'export BACKUP_S3_BUCKET=%q\n' "${BACKUP_S3_BUCKET:-}"
  printf 'export BACKUP_S3_REGION=%q\n' "${BACKUP_S3_REGION:-}"
  printf 'export BACKUP_S3_PREFIX=%q\n' "${BACKUP_S3_PREFIX:-}"
  printf 'export BACKUP_S3_ACCESS_KEY_ID=%q\n' "${BACKUP_S3_ACCESS_KEY_ID:-}"
  printf 'export BACKUP_S3_SECRET_ACCESS_KEY=%q\n' "${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  printf 'export BACKUP_S3_DRY_RUN=%q\n' "${BACKUP_S3_DRY_RUN:-}"
  printf 'export AWS_ENDPOINT_URL_S3=%q\n' "${AWS_ENDPOINT_URL_S3:-}"
  printf 'export AWS_REGION=%q\n' "${AWS_REGION:-}"
  printf 'export AWS_ACCESS_KEY_ID=%q\n' "${AWS_ACCESS_KEY_ID:-}"
  printf 'export AWS_SECRET_ACCESS_KEY=%q\n' "${AWS_SECRET_ACCESS_KEY:-}"
  printf 'cd "$APP_DIR"\n'
  printf 'exec bash ./scripts/backup-db-on-host.sh\n'
}

remote_output="$(
  remote_env_script | ssh "${SSH_ARGS[@]}" "$REMOTE" "bash -s"
)"

printf '%s\n' "$remote_output"

remote_backup_path="$(
  printf '%s\n' "$remote_output" \
    | awk -F= '$1 == "backup_path" {print substr($0, index($0, "=") + 1)}' \
    | tail -1
)"
remote_hash="$(
  printf '%s\n' "$remote_output" \
    | awk -F= '$1 == "sha256" {print substr($0, index($0, "=") + 1)}' \
    | tail -1
)"

if [ -z "$remote_backup_path" ] || [ -z "$remote_hash" ]; then
  echo "Backup did not return a remote path and checksum." >&2
  exit 1
fi

echo "Created remote backup: $remote_backup_path"
echo "Remote sha256: $remote_hash"

if [ "$COPY_TO_LOCAL" = "true" ]; then
  mkdir -p "$LOCAL_BACKUP_DIR"
  local_path="$LOCAL_BACKUP_DIR/$BACKUP_NAME"
  scp "${SSH_ARGS[@]}" "$REMOTE:$remote_backup_path" "$local_path" >/dev/null
  local_hash="$(shasum -a 256 "$local_path" | awk '{print $1}')"

  if [ "$local_hash" != "$remote_hash" ]; then
    echo "Checksum mismatch after copying backup locally." >&2
    echo "Remote: $remote_hash" >&2
    echo "Local:  $local_hash" >&2
    exit 1
  fi

  printf '%s  %s\n' "$local_hash" "$BACKUP_NAME" > "$local_path.sha256"
  echo "Copied verified backup: $local_path"
fi
