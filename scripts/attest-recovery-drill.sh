#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
REPORT_PATH="${REPORT_PATH:-}"
RECOVERY_DRILL_REPORT="${RECOVERY_DRILL_REPORT:-}"
RECOVERY_DRILL_HOST="${RECOVERY_DRILL_HOST:-}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
REMOTE="$SSH_USER@$HOST"
SSH_ARGS=(-o BatchMode=yes -o ConnectTimeout=10)

if [ -n "$SSH_KEY" ]; then
  SSH_ARGS+=(-i "$SSH_KEY")
fi

usage() {
  cat >&2 <<'USAGE'
Attest a completed disposable-host recovery drill on the production host.

Required:
  HOST                         Production droplet IP or hostname.
  REPORT_PATH or RECOVERY_DRILL_REPORT
                               Local report to copy, or report already present
                               on the production host.

Examples:
  HOST=45.55.53.92 \
    REPORT_PATH=reports/recovery-drills/continuous-recovery-20260520T000000Z.md \
    ./scripts/attest-recovery-drill.sh

  HOST=45.55.53.92 \
    RECOVERY_DRILL_REPORT=reports/recovery-drills/continuous-recovery-20260520T000000Z.md \
    ./scripts/attest-recovery-drill.sh
USAGE
}

quote() {
  printf "%q" "$1"
}

if [ -z "$HOST" ]; then
  usage
  exit 1
fi

if [ -z "$REPORT_PATH" ] && [ -z "$RECOVERY_DRILL_REPORT" ]; then
  usage
  exit 1
fi

if [ -n "$REPORT_PATH" ]; then
  if [ ! -f "$REPORT_PATH" ]; then
    echo "Recovery drill report not found: $REPORT_PATH" >&2
    exit 1
  fi

  if [ -z "$RECOVERY_DRILL_REPORT" ]; then
    RECOVERY_DRILL_REPORT="reports/recovery-drills/$(basename "$REPORT_PATH")"
  fi

  case "$RECOVERY_DRILL_REPORT" in
    /*) remote_report_path="$RECOVERY_DRILL_REPORT" ;;
    *) remote_report_path="$APP_DIR/$RECOVERY_DRILL_REPORT" ;;
  esac

  remote_tmp="/tmp/continuous-recovery-drill-$(date -u +%Y%m%dT%H%M%SZ).md"
  scp "${SSH_ARGS[@]}" "$REPORT_PATH" "$REMOTE:$remote_tmp" >/dev/null
  ssh "${SSH_ARGS[@]}" "$REMOTE" \
    "install -m 0755 -d $(quote "$(dirname "$remote_report_path")") && mv $(quote "$remote_tmp") $(quote "$remote_report_path") && chmod 0640 $(quote "$remote_report_path")"
fi

ssh "${SSH_ARGS[@]}" "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") READINESS_ENV_FILE=$(quote "$READINESS_ENV_FILE") RECOVERY_DRILL_REPORT=$(quote "$RECOVERY_DRILL_REPORT") RECOVERY_DRILL_HOST=$(quote "$RECOVERY_DRILL_HOST") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"

if [ ! -x "$APP_DIR/scripts/attest-recovery-drill-on-host.sh" ]; then
  echo "Missing executable $APP_DIR/scripts/attest-recovery-drill-on-host.sh. Deploy the latest repo before attesting." >&2
  exit 1
fi

"$APP_DIR/scripts/attest-recovery-drill-on-host.sh"
REMOTE_SCRIPT
