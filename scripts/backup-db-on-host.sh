#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-$APP_DIR/backups/postgres}"
BACKUP_NAME="${BACKUP_NAME:-continuous-postgres-$(date -u +%Y%m%dT%H%M%SZ).dump}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_OBJECT_STORAGE_ENABLED="${BACKUP_OBJECT_STORAGE_ENABLED:-false}"

if [[ "$BACKUP_NAME" != *.dump ]]; then
  BACKUP_NAME="$BACKUP_NAME.dump"
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; deploy the stack before backing up." >&2
  exit 1
fi

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]]; then
  echo "RETENTION_DAYS must be a non-negative integer." >&2
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

hash="$(sha256sum "$backup_path" | awk '{print $1}')"
printf '%s  %s\n' "$hash" "$BACKUP_NAME" > "$backup_path.sha256"
chmod 600 "$backup_path.sha256"

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$REMOTE_BACKUP_DIR" -type f \( -name '*.dump' -o -name '*.dump.sha256' \) -mtime "+$RETENTION_DAYS" -delete
fi

printf 'backup_path=%s\n' "$backup_path"
printf 'backup_name=%s\n' "$BACKUP_NAME"
printf 'sha256=%s\n' "$hash"

if [ "$BACKUP_OBJECT_STORAGE_ENABLED" = "true" ]; then
  s3_env_args=()
  for name in \
    BACKUP_S3_ENDPOINT \
    BACKUP_S3_BUCKET \
    BACKUP_S3_REGION \
    BACKUP_S3_PREFIX \
    BACKUP_S3_ACCESS_KEY_ID \
    BACKUP_S3_SECRET_ACCESS_KEY \
    BACKUP_S3_DRY_RUN \
    AWS_ENDPOINT_URL_S3 \
    AWS_REGION \
    AWS_ACCESS_KEY_ID \
    AWS_SECRET_ACCESS_KEY; do
    if [ -n "${!name:-}" ]; then
      s3_env_args+=(-e "$name=${!name}")
    fi
  done

  upload_output="$(
    docker compose --profile tools run --rm -T \
      -v "$REMOTE_BACKUP_DIR:/backups/postgres:ro" \
      "${s3_env_args[@]}" \
      migrate bun scripts/s3-backup-object.ts --file="/backups/postgres/$BACKUP_NAME" </dev/null
  )"
  printf 'object_upload=%s\n' "$(printf '%s' "$upload_output" | tr '\n' ' ')"
fi
