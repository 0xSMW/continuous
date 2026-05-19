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

quote() {
  printf "%q" "$1"
}

remote_env=(
  "APP_DIR=$(quote "$APP_DIR")"
  "REMOTE_BACKUP_DIR=$(quote "$REMOTE_BACKUP_DIR")"
  "BACKUP_NAME=$(quote "$BACKUP_NAME")"
  "RETENTION_DAYS=$(quote "$RETENTION_DAYS")"
  "BACKUP_OBJECT_STORAGE_ENABLED=$(quote "$BACKUP_OBJECT_STORAGE_ENABLED")"
  "BACKUP_S3_ENDPOINT=$(quote "${BACKUP_S3_ENDPOINT:-}")"
  "BACKUP_S3_BUCKET=$(quote "${BACKUP_S3_BUCKET:-}")"
  "BACKUP_S3_REGION=$(quote "${BACKUP_S3_REGION:-}")"
  "BACKUP_S3_PREFIX=$(quote "${BACKUP_S3_PREFIX:-}")"
  "BACKUP_S3_ACCESS_KEY_ID=$(quote "${BACKUP_S3_ACCESS_KEY_ID:-}")"
  "BACKUP_S3_SECRET_ACCESS_KEY=$(quote "${BACKUP_S3_SECRET_ACCESS_KEY:-}")"
  "BACKUP_S3_DRY_RUN=$(quote "${BACKUP_S3_DRY_RUN:-}")"
  "AWS_ENDPOINT_URL_S3=$(quote "${AWS_ENDPOINT_URL_S3:-}")"
  "AWS_REGION=$(quote "${AWS_REGION:-}")"
  "AWS_ACCESS_KEY_ID=$(quote "${AWS_ACCESS_KEY_ID:-}")"
  "AWS_SECRET_ACCESS_KEY=$(quote "${AWS_SECRET_ACCESS_KEY:-}")"
)

remote_output="$(
  ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "cd $(quote "$APP_DIR") && ${remote_env[*]} bash ./scripts/backup-db-on-host.sh"
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
