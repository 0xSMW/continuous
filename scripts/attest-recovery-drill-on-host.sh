#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
RECOVERY_DRILL_REPORT="${RECOVERY_DRILL_REPORT:-}"
RECOVERY_DRILL_HOST="${RECOVERY_DRILL_HOST:-}"
PRODUCTION_HOSTS="${PRODUCTION_HOSTS:-45.55.53.92 continuoushq.com getcontinuous.app}"
ALLOW_PRODUCTION_RECOVERY_DRILL_ATTESTATION="${ALLOW_PRODUCTION_RECOVERY_DRILL_ATTESTATION:-false}"
EXPECTED_RECOVERY_DRILL_REPORT_SHA256="${EXPECTED_RECOVERY_DRILL_REPORT_SHA256:-}"
WRITE_READINESS_ENV="${WRITE_READINESS_ENV:-true}"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

fail() {
  printf 'continuous_recovery_drill_attestation_status=failed\n' >&2
  printf 'reason=%s\n' "$1" >&2
  exit 1
}

shell_quote() {
  printf "%q" "$1"
}

set_readiness_value() {
  key="$1"
  value="$2"
  dir="$(dirname "$READINESS_ENV_FILE")"
  tmp="$(mktemp)"

  if [ ! -d "$dir" ]; then
    install -m 0700 -d "$dir"
  fi

  touch "$READINESS_ENV_FILE"
  chmod 0600 "$READINESS_ENV_FILE"

  if grep -q "^${key}=" "$READINESS_ENV_FILE"; then
    awk -v key="$key" -v value="$(shell_quote "$value")" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' "$READINESS_ENV_FILE" > "$tmp"
  else
    cat "$READINESS_ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$(shell_quote "$value")" >> "$tmp"
  fi

  cat "$tmp" > "$READINESS_ENV_FILE"
  rm -f "$tmp"
  chmod 0600 "$READINESS_ENV_FILE"
}

if [ -z "$RECOVERY_DRILL_REPORT" ]; then
  fail "missing_recovery_drill_report"
fi

case "$RECOVERY_DRILL_REPORT" in
  /*) report_path="$RECOVERY_DRILL_REPORT" ;;
  *) report_path="$APP_DIR/$RECOVERY_DRILL_REPORT" ;;
esac

if [ ! -f "$report_path" ]; then
  fail "recovery_drill_report_missing:$report_path"
fi

if [ -z "$RECOVERY_DRILL_HOST" ]; then
  RECOVERY_DRILL_HOST="$(
    awk -F'`' '/^\| Host \|/ { print $2; exit }' "$report_path" || true
  )"
fi

if [ -z "$RECOVERY_DRILL_HOST" ]; then
  fail "recovery_drill_host_missing:$report_path"
fi

for production_host in $PRODUCTION_HOSTS; do
  if [ "$RECOVERY_DRILL_HOST" = "$production_host" ] &&
    [ "$ALLOW_PRODUCTION_RECOVERY_DRILL_ATTESTATION" != "true" ]; then
    fail "recovery_drill_host_is_production:$RECOVERY_DRILL_HOST"
  fi
done

grep -q '^# Continuous Recovery Drill' "$report_path" ||
  fail "recovery_drill_report_invalid_heading:$report_path"
grep -q '^## Result' "$report_path" ||
  fail "recovery_drill_report_missing_result:$report_path"
grep -q 'Completed at:' "$report_path" ||
  fail "recovery_drill_report_missing_completed_at:$report_path"
grep -q 'Total elapsed:' "$report_path" ||
  fail "recovery_drill_report_missing_elapsed:$report_path"
grep -q 'Compatibility boundary:' "$report_path" ||
  fail "recovery_drill_report_missing_compatibility_boundary:$report_path"

report_sha256="$(sha256sum "$report_path" | awk '{print $1}')"
if [ -n "$EXPECTED_RECOVERY_DRILL_REPORT_SHA256" ] &&
  [ "$EXPECTED_RECOVERY_DRILL_REPORT_SHA256" != "$report_sha256" ]; then
  fail "recovery_drill_report_sha256_mismatch:$report_path"
fi

report_completed_at="$(
  awk -F'`' '/Completed at:/ { print $2; exit }' "$report_path" || true
)"
report_elapsed="$(
  awk -F'`' '/Total elapsed:/ { print $2; exit }' "$report_path" || true
)"

if [ "$WRITE_READINESS_ENV" = "true" ]; then
  set_readiness_value RECOVERY_DRILL_ATTESTED_AT "$CHECKED_AT"
  set_readiness_value RECOVERY_DRILL_REPORT "$RECOVERY_DRILL_REPORT"
  set_readiness_value RECOVERY_DRILL_REPORT_SHA256 "$report_sha256"
  set_readiness_value RECOVERY_DRILL_HOST "$RECOVERY_DRILL_HOST"
  set_readiness_value RECOVERY_DRILL_COMPLETED_AT "$report_completed_at"
  set_readiness_value RECOVERY_DRILL_ELAPSED "$report_elapsed"
fi

printf 'continuous_recovery_drill_attestation_status=ok\n'
printf 'checked_at=%s\n' "$CHECKED_AT"
printf 'report=%s\n' "$RECOVERY_DRILL_REPORT"
printf 'report_sha256=%s\n' "$report_sha256"
printf 'drill_host=%s\n' "$RECOVERY_DRILL_HOST"
