#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
REMOTE_BACKUP_DIR="${REMOTE_BACKUP_DIR:-$APP_DIR/backups/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_OBJECT_STORAGE_ENABLED="${BACKUP_OBJECT_STORAGE_ENABLED:-true}"
BACKUP_TIMER_ON_CALENDAR="${BACKUP_TIMER_ON_CALENDAR:-*-*-* 04:17:00 UTC}"
BACKUP_TIMER_RANDOMIZED_DELAY="${BACKUP_TIMER_RANDOMIZED_DELAY:-20min}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 BACKUP_S3_ENDPOINT=... BACKUP_S3_BUCKET=... BACKUP_S3_ACCESS_KEY_ID=... BACKUP_S3_SECRET_ACCESS_KEY=... ./scripts/install-backup-timer.sh" >&2
  exit 1
fi

if [ "$BACKUP_OBJECT_STORAGE_ENABLED" = "true" ]; then
  if [ -z "${BACKUP_S3_ENDPOINT:-${AWS_ENDPOINT_URL_S3:-}}" ] || [ -z "${BACKUP_S3_BUCKET:-}" ]; then
    echo "Object backup scheduling requires BACKUP_S3_ENDPOINT and BACKUP_S3_BUCKET." >&2
    exit 1
  fi

  if [ -z "${BACKUP_S3_ACCESS_KEY_ID:-${AWS_ACCESS_KEY_ID:-}}" ] || [ -z "${BACKUP_S3_SECRET_ACCESS_KEY:-${AWS_SECRET_ACCESS_KEY:-}}" ]; then
    echo "Object backup scheduling requires BACKUP_S3_ACCESS_KEY_ID and BACKUP_S3_SECRET_ACCESS_KEY." >&2
    exit 1
  fi
fi

quote() {
  printf "%q" "$1"
}

env_file="$(mktemp)"
cleanup() {
  rm -f "$env_file"
}
trap cleanup EXIT

umask 077
{
  printf 'APP_DIR=%q\n' "$APP_DIR"
  printf 'REMOTE_BACKUP_DIR=%q\n' "$REMOTE_BACKUP_DIR"
  printf 'RETENTION_DAYS=%q\n' "$RETENTION_DAYS"
  printf 'BACKUP_OBJECT_STORAGE_ENABLED=%q\n' "$BACKUP_OBJECT_STORAGE_ENABLED"
  printf 'BACKUP_S3_ENDPOINT=%q\n' "${BACKUP_S3_ENDPOINT:-}"
  printf 'BACKUP_S3_BUCKET=%q\n' "${BACKUP_S3_BUCKET:-}"
  printf 'BACKUP_S3_REGION=%q\n' "${BACKUP_S3_REGION:-}"
  printf 'BACKUP_S3_PREFIX=%q\n' "${BACKUP_S3_PREFIX:-postgres}"
  printf 'BACKUP_S3_ACCESS_KEY_ID=%q\n' "${BACKUP_S3_ACCESS_KEY_ID:-}"
  printf 'BACKUP_S3_SECRET_ACCESS_KEY=%q\n' "${BACKUP_S3_SECRET_ACCESS_KEY:-}"
  printf 'AWS_ENDPOINT_URL_S3=%q\n' "${AWS_ENDPOINT_URL_S3:-}"
  printf 'AWS_REGION=%q\n' "${AWS_REGION:-}"
  printf 'AWS_ACCESS_KEY_ID=%q\n' "${AWS_ACCESS_KEY_ID:-}"
  printf 'AWS_SECRET_ACCESS_KEY=%q\n' "${AWS_SECRET_ACCESS_KEY:-}"
} > "$env_file"

scp "${SSH_ARGS[@]}" "$env_file" "$REMOTE:/tmp/continuous-postgres-backup.env" >/dev/null
ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") BACKUP_TIMER_ON_CALENDAR=$(quote "$BACKUP_TIMER_ON_CALENDAR") BACKUP_TIMER_RANDOMIZED_DELAY=$(quote "$BACKUP_TIMER_RANDOMIZED_DELAY") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if [ ! -x "$APP_DIR/scripts/backup-db-on-host.sh" ]; then
  echo "Missing executable $APP_DIR/scripts/backup-db-on-host.sh. Deploy the latest repo before installing the timer." >&2
  exit 1
fi

install -m 0700 -d /etc/continuous
install -m 0600 /tmp/continuous-postgres-backup.env /etc/continuous/postgres-backup.env
rm -f /tmp/continuous-postgres-backup.env

cat >/etc/systemd/system/continuous-postgres-backup.service <<SERVICE
[Unit]
Description=Continuous Postgres verified backup
Wants=docker.service
After=docker.service

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/continuous/postgres-backup.env
ExecStart=$APP_DIR/scripts/backup-db-on-host.sh
SERVICE

cat >/etc/systemd/system/continuous-postgres-backup.timer <<TIMER
[Unit]
Description=Run Continuous Postgres verified backup

[Timer]
OnCalendar=$BACKUP_TIMER_ON_CALENDAR
RandomizedDelaySec=$BACKUP_TIMER_RANDOMIZED_DELAY
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now continuous-postgres-backup.timer >/dev/null
systemctl list-timers continuous-postgres-backup.timer --no-pager
REMOTE_SCRIPT

echo "Installed continuous-postgres-backup.timer on $HOST"
