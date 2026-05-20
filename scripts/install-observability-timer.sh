#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
OBSERVABILITY_TIMER_INTERVAL="${OBSERVABILITY_TIMER_INTERVAL:-15min}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 ./scripts/install-observability-timer.sh" >&2
  exit 1
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
  printf 'SITE_HOSTS=%q\n' "${SITE_HOSTS:-}"
  printf 'MAX_DISK_PERCENT=%q\n' "${MAX_DISK_PERCENT:-85}"
  printf 'CERT_MIN_DAYS=%q\n' "${CERT_MIN_DAYS:-14}"
  printf 'REQUIRE_CADDY_ACCESS_LOG=%q\n' "${REQUIRE_CADDY_ACCESS_LOG:-true}"
  printf 'REQUIRE_BACKUP_FRESH=%q\n' "${REQUIRE_BACKUP_FRESH:-false}"
  printf 'BACKUP_MAX_AGE_HOURS=%q\n' "${BACKUP_MAX_AGE_HOURS:-26}"
  printf 'REMOTE_BACKUP_DIR=%q\n' "${REMOTE_BACKUP_DIR:-$APP_DIR/backups/postgres}"
  printf 'REQUIRE_CHECKSUM=%q\n' "${REQUIRE_CHECKSUM:-true}"
  printf 'CHECK_SYSTEMD_FAILED=%q\n' "${CHECK_SYSTEMD_FAILED:-false}"
  printf 'ALERT_WEBHOOK_URL=%q\n' "${ALERT_WEBHOOK_URL:-}"
  printf 'ALERT_WEBHOOK_TIMEOUT_SECONDS=%q\n' "${ALERT_WEBHOOK_TIMEOUT_SECONDS:-8}"
} > "$env_file"

scp "${SSH_ARGS[@]}" "$env_file" "$REMOTE:/tmp/continuous-observability.env" >/dev/null
ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") OBSERVABILITY_TIMER_INTERVAL=$(quote "$OBSERVABILITY_TIMER_INTERVAL") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

if [ ! -x "$APP_DIR/scripts/check-observability-on-host.sh" ]; then
  echo "Missing executable $APP_DIR/scripts/check-observability-on-host.sh. Deploy the latest repo before installing the timer." >&2
  exit 1
fi

install -m 0700 -d /etc/continuous
install -m 0600 /tmp/continuous-observability.env /etc/continuous/observability.env
rm -f /tmp/continuous-observability.env
install -m 0755 -d "$APP_DIR/logs/observability"

cat >/etc/systemd/system/continuous-observability-check.service <<SERVICE
[Unit]
Description=Continuous production observability check
Wants=docker.service network-online.target
After=docker.service network-online.target

[Service]
Type=oneshot
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/continuous/observability.env
ExecStart=$APP_DIR/scripts/check-observability-on-host.sh
StandardOutput=append:$APP_DIR/logs/observability/check.log
StandardError=append:$APP_DIR/logs/observability/check.log
SERVICE

cat >/etc/systemd/system/continuous-observability-check.timer <<TIMER
[Unit]
Description=Run Continuous production observability check

[Timer]
OnBootSec=5min
OnUnitActiveSec=$OBSERVABILITY_TIMER_INTERVAL
AccuracySec=1min
Persistent=true

[Install]
WantedBy=timers.target
TIMER

systemctl daemon-reload
systemctl enable --now continuous-observability-check.timer >/dev/null
systemctl list-timers continuous-observability-check.timer --no-pager
REMOTE_SCRIPT

echo "Installed continuous-observability-check.timer on $HOST"
