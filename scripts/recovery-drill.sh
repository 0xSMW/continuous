#!/usr/bin/env bash
set -euo pipefail

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
SSH_KEY="${SSH_KEY:-}"
APP_DIR="${APP_DIR:-/opt/continuous}"
APP_TAG="${APP_TAG:-${ROLLBACK_APP_TAG:-}}"
BACKUP_FILE="${BACKUP_FILE:-}"
REMOTE_BACKUP_FILE="${REMOTE_BACKUP_FILE:-}"
CONFIRM_RECOVERY_DRILL="${CONFIRM_RECOVERY_DRILL:-}"
ALLOW_PRODUCTION_RECOVERY_DRILL="${ALLOW_PRODUCTION_RECOVERY_DRILL:-false}"
PRODUCTION_HOSTS="${PRODUCTION_HOSTS:-45.55.53.92 continuoushq.com getcontinuous.app}"
START_APP_AFTER_RESTORE="${START_APP_AFTER_RESTORE:-true}"
VALIDATE_RESTORE_DB="${VALIDATE_RESTORE_DB:-true}"
HEALTH_URL="${HEALTH_URL:-}"
REPORT_DIR="${REPORT_DIR:-reports/recovery-drills}"
REPORT_PATH="${REPORT_PATH:-}"
WRITE_RECOVERY_DRILL_REPORT="${WRITE_RECOVERY_DRILL_REPORT:-true}"

usage() {
  cat >&2 <<'USAGE'
Run a guarded Continuous recovery drill on a disposable host.

Required:
  HOST                         Disposable droplet IP or hostname.
  APP_TAG                      Existing app image tag to roll back to.
  BACKUP_FILE or REMOTE_BACKUP_FILE
                               Verified Postgres dump source.
  CONFIRM_RECOVERY_DRILL=disposable
                               Explicit confirmation that the target is disposable.

Example:
  HOST=203.0.113.10 \
    APP_TAG=sha-previous \
    REMOTE_BACKUP_FILE=/opt/continuous/backups/postgres/example.dump \
    CONFIRM_RECOVERY_DRILL=disposable \
    ./scripts/recovery-drill.sh

Production protection:
  The script refuses known production hosts unless
  ALLOW_PRODUCTION_RECOVERY_DRILL=true is set.
USAGE
}

timestamp() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

elapsed_seconds() {
  start="$1"
  now="$(date -u +%s)"
  printf '%s' "$((now - start))"
}

append_report() {
  if [ "$WRITE_RECOVERY_DRILL_REPORT" != "true" ]; then
    return
  fi

  printf '%s\n' "$1" >> "$REPORT_PATH"
}

if [ -z "$HOST" ] || [ -z "$APP_TAG" ]; then
  usage
  exit 1
fi

if [ -n "$BACKUP_FILE" ] && [ -n "$REMOTE_BACKUP_FILE" ]; then
  echo "Set only one of BACKUP_FILE or REMOTE_BACKUP_FILE." >&2
  exit 1
fi

if [ -z "$BACKUP_FILE" ] && [ -z "$REMOTE_BACKUP_FILE" ]; then
  usage
  exit 1
fi

if [ "$CONFIRM_RECOVERY_DRILL" != "disposable" ]; then
  echo "Refusing recovery drill without CONFIRM_RECOVERY_DRILL=disposable." >&2
  exit 1
fi

for production_host in $PRODUCTION_HOSTS; do
  if [ "$HOST" = "$production_host" ] && [ "$ALLOW_PRODUCTION_RECOVERY_DRILL" != "true" ]; then
    echo "Refusing to run recovery drill against production host $HOST." >&2
    echo "Use a disposable droplet, or set ALLOW_PRODUCTION_RECOVERY_DRILL=true for an explicit break-glass drill." >&2
    exit 1
  fi
done

if [ -n "$BACKUP_FILE" ]; then
  if [ ! -f "$BACKUP_FILE" ]; then
    echo "Backup file not found: $BACKUP_FILE" >&2
    exit 1
  fi

  if [ ! -f "$BACKUP_FILE.sha256" ]; then
    echo "Backup file is missing checksum sidecar: $BACKUP_FILE.sha256" >&2
    exit 1
  fi
fi

if [ ! -x ./scripts/rollback-app.sh ] || [ ! -x ./scripts/restore-db.sh ]; then
  echo "Missing executable rollback or restore script. Run from the repo root." >&2
  exit 1
fi

drill_started_at="$(timestamp)"
drill_started_seconds="$(date -u +%s)"
drill_id="${DRILL_ID:-continuous-recovery-$(date -u +%Y%m%dT%H%M%SZ)}"
backup_source="${REMOTE_BACKUP_FILE:-$BACKUP_FILE}"

if [ "$WRITE_RECOVERY_DRILL_REPORT" = "true" ]; then
  if [ -z "$REPORT_PATH" ]; then
    REPORT_PATH="$REPORT_DIR/$drill_id.md"
  fi

  install -d "$(dirname "$REPORT_PATH")"
  {
    printf '# Continuous Recovery Drill\n\n'
    printf '| Field | Value |\n'
    printf '|---|---|\n'
    printf '| Drill ID | `%s` |\n' "$drill_id"
    printf '| Started at | `%s` |\n' "$drill_started_at"
    printf '| Host | `%s` |\n' "$HOST"
    printf '| App tag | `%s` |\n' "$APP_TAG"
    printf '| Backup source | `%s` |\n' "$backup_source"
    printf '| Validate scratch restore | `%s` |\n' "$VALIDATE_RESTORE_DB"
    printf '| Start app after restore | `%s` |\n\n' "$START_APP_AFTER_RESTORE"
    printf '## Steps\n\n'
  } > "$REPORT_PATH"
fi

echo "Starting recovery drill $drill_id on $HOST"
echo "Rolling app and scheduler to $APP_TAG"
rollback_start="$(date -u +%s)"
rollback_env=(
  "HOST=$HOST"
  "SSH_USER=$SSH_USER"
  "APP_DIR=$APP_DIR"
  "APP_TAG=$APP_TAG"
)

if [ -n "$SSH_KEY" ]; then
  rollback_env+=("SSH_KEY=$SSH_KEY")
fi

env "${rollback_env[@]}" ./scripts/rollback-app.sh
rollback_elapsed="$(elapsed_seconds "$rollback_start")"
echo "Rollback step completed in ${rollback_elapsed}s"
append_report "- App rollback to \`$APP_TAG\` completed in \`${rollback_elapsed}s\`."

echo "Restoring database from $backup_source"
restore_start="$(date -u +%s)"
restore_env=(
  "HOST=$HOST"
  "SSH_USER=$SSH_USER"
  "APP_DIR=$APP_DIR"
  "CONFIRM_RESTORE=continuous"
  "START_APP_AFTER_RESTORE=$START_APP_AFTER_RESTORE"
  "VALIDATE_RESTORE_DB=$VALIDATE_RESTORE_DB"
)

if [ -n "$SSH_KEY" ]; then
  restore_env+=("SSH_KEY=$SSH_KEY")
fi

if [ -n "$BACKUP_FILE" ]; then
  restore_env+=("BACKUP_FILE=$BACKUP_FILE")
else
  restore_env+=("REMOTE_BACKUP_FILE=$REMOTE_BACKUP_FILE")
fi

env "${restore_env[@]}" ./scripts/restore-db.sh
restore_elapsed="$(elapsed_seconds "$restore_start")"
echo "Restore step completed in ${restore_elapsed}s"
append_report "- Database restore from \`$backup_source\` completed in \`${restore_elapsed}s\`."

if [ -n "$HEALTH_URL" ]; then
  echo "Checking health URL $HEALTH_URL"
  health_start="$(date -u +%s)"
  curl -fsS "$HEALTH_URL" >/dev/null
  health_elapsed="$(elapsed_seconds "$health_start")"
  echo "Health URL check completed in ${health_elapsed}s"
  append_report "- External health check \`$HEALTH_URL\` completed in \`${health_elapsed}s\`."
fi

drill_elapsed="$(elapsed_seconds "$drill_started_seconds")"
drill_completed_at="$(timestamp)"
echo "Recovery drill completed in ${drill_elapsed}s"

if [ "$WRITE_RECOVERY_DRILL_REPORT" = "true" ]; then
  append_report ""
  append_report "## Result"
  append_report ""
  append_report "- Completed at: \`$drill_completed_at\`"
  append_report "- Total elapsed: \`${drill_elapsed}s\`"
  append_report "- Compatibility boundary: app rollback is tag-based and safe only when the restored database backup is schema-compatible with \`$APP_TAG\`; migrations remain forward-only."
  echo "Wrote drill report: $REPORT_PATH"
fi
