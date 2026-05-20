#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
BACKUP_FILE="${BACKUP_FILE:-}"
REMOTE_BACKUP_FILE="${REMOTE_BACKUP_FILE:-}"
CONFIRM_RESTORE="${CONFIRM_RESTORE:-}"
START_APP_AFTER_RESTORE="${START_APP_AFTER_RESTORE:-true}"
VALIDATE_RESTORE_DB="${VALIDATE_RESTORE_DB:-true}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 BACKUP_FILE=backups/postgres/continuous-postgres-20260520T000000Z.dump CONFIRM_RESTORE=continuous ./scripts/restore-db.sh" >&2
  exit 1
fi

if [ -z "$BACKUP_FILE" ] && [ -z "$REMOTE_BACKUP_FILE" ]; then
  echo "Set BACKUP_FILE to a local .dump file or REMOTE_BACKUP_FILE to a file already on the droplet." >&2
  exit 1
fi

if [ "$CONFIRM_RESTORE" != "continuous" ]; then
  echo "Refusing destructive restore. Set CONFIRM_RESTORE=continuous to replace the production database." >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

verify_local_checksum() {
  file="$1"
  sidecar="$file.sha256"

  if [ ! -f "$sidecar" ]; then
    echo "Local backup file has no checksum sidecar: $sidecar" >&2
    echo "Refusing destructive restore without checksum verification." >&2
    exit 1
  fi

  expected="$(awk '{print $1; exit}' "$sidecar")"
  actual="$(shasum -a 256 "$file" | awk '{print $1}')"

  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Local backup checksum mismatch for $file." >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    exit 1
  fi
}

remote_restore_file="$REMOTE_BACKUP_FILE"

if [ -n "$BACKUP_FILE" ]; then
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "Backup file not found: $BACKUP_FILE" >&2
    exit 1
  fi

  verify_local_checksum "$BACKUP_FILE"
  remote_restore_dir="/tmp/continuous-restore-$(date -u +%Y%m%dT%H%M%SZ)"
  remote_restore_file="$remote_restore_dir/$(basename "$BACKUP_FILE")"
  ssh "${SSH_ARGS[@]}" "$REMOTE" "install -m 0700 -d $(quote "$remote_restore_dir")"
  scp "${SSH_ARGS[@]}" "$BACKUP_FILE" "$REMOTE:$remote_restore_file" >/dev/null

  if [ -f "$BACKUP_FILE.sha256" ]; then
    scp "${SSH_ARGS[@]}" "$BACKUP_FILE.sha256" "$REMOTE:$remote_restore_file.sha256" >/dev/null
  fi
fi

ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") REMOTE_RESTORE_FILE=$(quote "$remote_restore_file") START_APP_AFTER_RESTORE=$(quote "$START_APP_AFTER_RESTORE") VALIDATE_RESTORE_DB=$(quote "$VALIDATE_RESTORE_DB") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; deploy the stack before restoring." >&2
  exit 1
fi

if [ ! -f "$REMOTE_RESTORE_FILE" ]; then
  echo "Remote restore file not found: $REMOTE_RESTORE_FILE" >&2
  exit 1
fi

if [ -f "$REMOTE_RESTORE_FILE.sha256" ]; then
  expected="$(awk '{print $1; exit}' "$REMOTE_RESTORE_FILE.sha256")"
  actual="$(sha256sum "$REMOTE_RESTORE_FILE" | awk '{print $1}')"

  if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "Remote backup checksum mismatch for $REMOTE_RESTORE_FILE." >&2
    echo "Expected: $expected" >&2
    echo "Actual:   $actual" >&2
    exit 1
  fi
else
  echo "Remote restore file has no checksum sidecar: $REMOTE_RESTORE_FILE.sha256" >&2
  echo "Refusing destructive restore without checksum verification." >&2
  exit 1
fi

docker compose up -d db >/dev/null
docker compose exec -T db sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done' </dev/null >/dev/null
docker compose exec -T db sh -c 'pg_restore --list' < "$REMOTE_RESTORE_FILE" >/dev/null

scratch_db=""
cleanup_scratch() {
  if [ -n "$scratch_db" ]; then
    docker compose exec -T db env SCRATCH_DB="$scratch_db" sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$SCRATCH_DB"' </dev/null >/dev/null 2>&1 || true
  fi
}
trap cleanup_scratch EXIT

if [ "$VALIDATE_RESTORE_DB" = "true" ]; then
  scratch_db="continuous_restore_check_$(date -u +%Y%m%d%H%M%S)_$$"
  docker compose exec -T db env SCRATCH_DB="$scratch_db" sh -c '
    set -eu
    dropdb -U "$POSTGRES_USER" --if-exists "$SCRATCH_DB"
    createdb -U "$POSTGRES_USER" "$SCRATCH_DB"
  ' </dev/null
  docker compose exec -T db env SCRATCH_DB="$scratch_db" sh -c 'pg_restore --no-owner --no-acl -U "$POSTGRES_USER" -d "$SCRATCH_DB"' < "$REMOTE_RESTORE_FILE"
  docker compose exec -T db env SCRATCH_DB="$scratch_db" sh -c 'dropdb -U "$POSTGRES_USER" --if-exists "$SCRATCH_DB"' </dev/null
  scratch_db=""
fi

docker compose stop app >/dev/null 2>&1 || true

docker compose exec -T db sh -c '
  set -eu
  psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=1 -c "select pg_terminate_backend(pid) from pg_stat_activity where datname = '\''$POSTGRES_DB'\'' and pid <> pg_backend_pid();"
  dropdb -U "$POSTGRES_USER" --if-exists "$POSTGRES_DB"
  createdb -U "$POSTGRES_USER" "$POSTGRES_DB"
' </dev/null

docker compose exec -T db sh -c 'pg_restore --no-owner --no-acl -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < "$REMOTE_RESTORE_FILE"
docker compose --profile tools run --rm migrate bun run db:migrate </dev/null

if [ "$START_APP_AFTER_RESTORE" = "true" ]; then
  docker compose up -d app caddy >/dev/null
  for attempt in $(seq 1 30); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:3000/health').then((r)=>process.exit(r.ok ? 0 : 1)).catch(()=>process.exit(1))" </dev/null; then
      break
    fi

    if [ "$attempt" -eq 30 ]; then
      echo "App health check did not recover after restore." >&2
      exit 1
    fi

    sleep 2
  done
fi

docker compose ps
REMOTE_SCRIPT

echo "Restore completed from $remote_restore_file"
