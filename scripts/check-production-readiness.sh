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
  echo "Example: HOST=45.55.53.92 ./scripts/check-production-readiness.sh" >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

remote_env=(
  "APP_DIR=$(quote "$APP_DIR")"
  "READINESS_ENV_FILE=$(quote "${READINESS_ENV_FILE:-}")"
  "BACKUP_ENV_FILE=$(quote "${BACKUP_ENV_FILE:-}")"
  "OBSERVABILITY_ENV_FILE=$(quote "${OBSERVABILITY_ENV_FILE:-}")"
  "BACKUP_MAX_AGE_HOURS=$(quote "${BACKUP_MAX_AGE_HOURS:-}")"
  "REQUIRE_BACKUP_TIMER=$(quote "${REQUIRE_BACKUP_TIMER:-}")"
  "REQUIRE_OBSERVABILITY_TIMER=$(quote "${REQUIRE_OBSERVABILITY_TIMER:-}")"
  "REQUIRE_ALERT_WEBHOOK=$(quote "${REQUIRE_ALERT_WEBHOOK:-}")"
  "REQUIRE_OBJECT_STORAGE_BACKUP=$(quote "${REQUIRE_OBJECT_STORAGE_BACKUP:-}")"
  "REQUIRE_BACKUP_FRESH=$(quote "${REQUIRE_BACKUP_FRESH:-}")"
  "REQUIRE_OBSERVABILITY_STRICT=$(quote "${REQUIRE_OBSERVABILITY_STRICT:-}")"
  "REQUIRE_RECOVERY_DRILL_ATTESTATION=$(quote "${REQUIRE_RECOVERY_DRILL_ATTESTATION:-}")"
  "REQUIRE_TOKEN_ROTATION_ATTESTATION=$(quote "${REQUIRE_TOKEN_ROTATION_ATTESTATION:-}")"
  "REQUIRE_CONTROL_PLANE_CREDENTIAL_ATTESTATION=$(quote "${REQUIRE_CONTROL_PLANE_CREDENTIAL_ATTESTATION:-}")"
  "REQUIRE_NON_ROOT_ACCESS_ATTESTATION=$(quote "${REQUIRE_NON_ROOT_ACCESS_ATTESTATION:-}")"
)

ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "cd $(quote "$APP_DIR") && ${remote_env[*]} ./scripts/check-production-readiness-on-host.sh"
