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

remote_info="$(
  ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "APP_DIR=$(quote "$APP_DIR") REMOTE_BACKUP_DIR=$(quote "$REMOTE_BACKUP_DIR") BACKUP_NAME=$(quote "$BACKUP_NAME") RETENTION_DAYS=$(quote "$RETENTION_DAYS") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; deploy the stack before backing up." >&2
  exit 1
fi

install -m 0700 -d "$REMOTE_BACKUP_DIR"
backup_path="$REMOTE_BACKUP_DIR/$BACKUP_NAME"
tmp_path="$REMOTE_BACKUP_DIR/.tmp-$BACKUP_NAME"

rm -f "$tmp_path"
docker compose up -d db >/dev/null
docker compose exec -T db sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done' </dev/null >/dev/null
docker compose exec -T db sh -c 'pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"' </dev/null > "$tmp_path"
docker compose exec -T db sh -c 'pg_restore --list' < "$tmp_path" >/dev/null
chmod 600 "$tmp_path"
mv "$tmp_path" "$backup_path"

if [ "$RETENTION_DAYS" -gt 0 ] 2>/dev/null; then
  find "$REMOTE_BACKUP_DIR" -type f -name '*.dump' -mtime "+$RETENTION_DAYS" -delete
fi

hash="$(sha256sum "$backup_path" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$BACKUP_NAME" > "$backup_path.sha256"
chmod 600 "$backup_path.sha256"
printf '%s|%s\n' "$backup_path" "$hash"
REMOTE_SCRIPT
)"

remote_info="$(printf '%s\n' "$remote_info" | tail -1)"
remote_backup_path="${remote_info%%|*}"
remote_hash="${remote_info##*|}"

if [ -z "$remote_backup_path" ] || [ "$remote_backup_path" = "$remote_hash" ]; then
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
