#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=45.55.53.92 ./scripts/check-observability.sh" >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

remote_env=(
  "APP_DIR=$(quote "$APP_DIR")"
  "SITE_HOSTS=$(quote "${SITE_HOSTS:-}")"
  "MAX_DISK_PERCENT=$(quote "${MAX_DISK_PERCENT:-}")"
  "CERT_MIN_DAYS=$(quote "${CERT_MIN_DAYS:-}")"
  "REQUIRE_CADDY_ACCESS_LOG=$(quote "${REQUIRE_CADDY_ACCESS_LOG:-}")"
  "REQUIRE_BACKUP_FRESH=$(quote "${REQUIRE_BACKUP_FRESH:-}")"
  "BACKUP_MAX_AGE_HOURS=$(quote "${BACKUP_MAX_AGE_HOURS:-}")"
  "REMOTE_BACKUP_DIR=$(quote "${REMOTE_BACKUP_DIR:-}")"
  "REQUIRE_CHECKSUM=$(quote "${REQUIRE_CHECKSUM:-}")"
  "CHECK_SYSTEMD_FAILED=$(quote "${CHECK_SYSTEMD_FAILED:-}")"
  "ALERT_WEBHOOK_URL=$(quote "${ALERT_WEBHOOK_URL:-}")"
  "ALERT_WEBHOOK_TIMEOUT_SECONDS=$(quote "${ALERT_WEBHOOK_TIMEOUT_SECONDS:-}")"
)

ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "cd $(quote "$APP_DIR") && ${remote_env[*]} ./scripts/check-observability-on-host.sh"
