#!/usr/bin/env bash
set -u -o pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
BACKUP_ENV_FILE="${BACKUP_ENV_FILE:-/etc/continuous/postgres-backup.env}"
OBSERVABILITY_ENV_FILE="${OBSERVABILITY_ENV_FILE:-/etc/continuous/observability.env}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
REQUIRE_BACKUP_TIMER="${REQUIRE_BACKUP_TIMER:-true}"
REQUIRE_OBSERVABILITY_TIMER="${REQUIRE_OBSERVABILITY_TIMER:-true}"
REQUIRE_ALERT_WEBHOOK="${REQUIRE_ALERT_WEBHOOK:-true}"
REQUIRE_OBJECT_STORAGE_BACKUP="${REQUIRE_OBJECT_STORAGE_BACKUP:-true}"
REQUIRE_BACKUP_FRESH="${REQUIRE_BACKUP_FRESH:-true}"
REQUIRE_OBSERVABILITY_STRICT="${REQUIRE_OBSERVABILITY_STRICT:-true}"
REQUIRE_RECOVERY_DRILL_ATTESTATION="${REQUIRE_RECOVERY_DRILL_ATTESTATION:-true}"
REQUIRE_TOKEN_ROTATION_ATTESTATION="${REQUIRE_TOKEN_ROTATION_ATTESTATION:-true}"
REQUIRE_NON_ROOT_ACCESS_ATTESTATION="${REQUIRE_NON_ROOT_ACCESS_ATTESTATION:-true}"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

failures=()

record_failure() {
  failures+=("$1")
  printf 'FAIL %s\n' "$1" >&2
}

record_ok() {
  printf 'OK %s\n' "$1"
}

bool_enabled() {
  [ "$1" = "true" ]
}

env_value() {
  file="$1"
  name="$2"

  if [ ! -f "$file" ]; then
    return
  fi

  bash -c 'set -a; source "$1"; name="$2"; printf "%s" "${!name-}"' _ "$file" "$name" 2>/dev/null
}

require_file() {
  path="$1"

  if [ -f "$path" ]; then
    record_ok "file_present:$path"
  else
    record_failure "file_missing:$path"
  fi
}

require_env_value() {
  file="$1"
  name="$2"
  value="$(env_value "$file" "$name")"

  if [ -n "$value" ]; then
    record_ok "env_value_present:$file:$name"
  else
    record_failure "env_value_missing:$file:$name"
  fi
}

require_env_equals() {
  file="$1"
  name="$2"
  expected="$3"
  value="$(env_value "$file" "$name")"

  if [ "$value" = "$expected" ]; then
    record_ok "env_value:$file:$name=$expected"
  else
    record_failure "env_value_unexpected:$file:$name"
  fi
}

check_timer() {
  timer="$1"

  if systemctl is-enabled --quiet "$timer" 2>/dev/null; then
    record_ok "timer_enabled:$timer"
  else
    record_failure "timer_not_enabled:$timer"
  fi

  if systemctl is-active --quiet "$timer" 2>/dev/null; then
    record_ok "timer_active:$timer"
  else
    record_failure "timer_not_active:$timer"
  fi
}

run_strict_observability() {
  if ! bool_enabled "$REQUIRE_OBSERVABILITY_STRICT"; then
    record_ok "strict_observability_skipped"
    return
  fi

  if [ ! -x "$APP_DIR/scripts/check-observability-on-host.sh" ]; then
    record_failure "observability_script_missing:$APP_DIR/scripts/check-observability-on-host.sh"
    return
  fi

  output="$(
    APP_DIR="$APP_DIR" \
      REQUIRE_BACKUP_FRESH="$REQUIRE_BACKUP_FRESH" \
      BACKUP_MAX_AGE_HOURS="$BACKUP_MAX_AGE_HOURS" \
      CHECK_SYSTEMD_FAILED=true \
      REQUIRE_CADDY_ACCESS_LOG=true \
      ALERT_WEBHOOK_URL="" \
      "$APP_DIR/scripts/check-observability-on-host.sh" 2>&1
  )"
  status="$?"

  if [ "$status" -eq 0 ]; then
    record_ok "strict_observability_check"
    printf '%s\n' "$output"
  else
    record_failure "strict_observability_check_failed"
    printf '%s\n' "$output" >&2
  fi
}

run_object_storage_check() {
  if ! bool_enabled "$REQUIRE_OBJECT_STORAGE_BACKUP"; then
    record_ok "object_storage_backup_check_skipped"
    return
  fi

  if [ ! -f "$BACKUP_ENV_FILE" ]; then
    record_failure "object_storage_backup_env_missing:$BACKUP_ENV_FILE"
    return
  fi

  if ! command -v docker >/dev/null 2>&1; then
    record_failure "docker_missing_for_object_storage_check"
    return
  fi

  output="$(
    cd "$APP_DIR" && set -a && source "$BACKUP_ENV_FILE" && set +a && \
      BACKUP_S3_MAX_AGE_HOURS="${BACKUP_S3_MAX_AGE_HOURS:-$BACKUP_MAX_AGE_HOURS}" \
      docker compose --profile tools run --rm -T migrate \
        bun scripts/s3-backup-object.ts --check-latest 2>&1
  )"
  status="$?"

  if [ "$status" -eq 0 ]; then
    record_ok "object_storage_backup_latest"
    printf '%s\n' "$output"
  else
    record_failure "object_storage_backup_latest_failed"
    printf '%s\n' "$output" >&2
  fi
}

cd "$APP_DIR" 2>/dev/null || {
  record_failure "app_dir_missing:$APP_DIR"
  printf 'continuous_production_readiness_status=failed\n' >&2
  printf 'checked_at=%s\n' "$CHECKED_AT" >&2
  exit 1
}

require_file "$APP_DIR/.env"

if bool_enabled "$REQUIRE_BACKUP_TIMER"; then
  check_timer continuous-postgres-backup.timer
  require_file "$BACKUP_ENV_FILE"
  require_env_equals "$BACKUP_ENV_FILE" BACKUP_OBJECT_STORAGE_ENABLED true
  require_env_value "$BACKUP_ENV_FILE" BACKUP_S3_ENDPOINT
  require_env_value "$BACKUP_ENV_FILE" BACKUP_S3_BUCKET
  require_env_value "$BACKUP_ENV_FILE" BACKUP_S3_ACCESS_KEY_ID
  require_env_value "$BACKUP_ENV_FILE" BACKUP_S3_SECRET_ACCESS_KEY
else
  record_ok "backup_timer_check_skipped"
fi

if bool_enabled "$REQUIRE_OBSERVABILITY_TIMER"; then
  check_timer continuous-observability-check.timer
  require_file "$OBSERVABILITY_ENV_FILE"
  require_env_equals "$OBSERVABILITY_ENV_FILE" REQUIRE_BACKUP_FRESH true
  require_env_equals "$OBSERVABILITY_ENV_FILE" CHECK_SYSTEMD_FAILED true

  if bool_enabled "$REQUIRE_ALERT_WEBHOOK"; then
    require_env_value "$OBSERVABILITY_ENV_FILE" ALERT_WEBHOOK_URL
  else
    record_ok "alert_webhook_check_skipped"
  fi
else
  record_ok "observability_timer_check_skipped"
fi

if bool_enabled "$REQUIRE_RECOVERY_DRILL_ATTESTATION" || \
  bool_enabled "$REQUIRE_TOKEN_ROTATION_ATTESTATION" || \
  bool_enabled "$REQUIRE_NON_ROOT_ACCESS_ATTESTATION"; then
  require_file "$READINESS_ENV_FILE"
fi

if bool_enabled "$REQUIRE_RECOVERY_DRILL_ATTESTATION"; then
  require_env_value "$READINESS_ENV_FILE" RECOVERY_DRILL_ATTESTED_AT
  require_env_value "$READINESS_ENV_FILE" RECOVERY_DRILL_REPORT
else
  record_ok "recovery_drill_attestation_skipped"
fi

if bool_enabled "$REQUIRE_TOKEN_ROTATION_ATTESTATION"; then
  require_env_value "$READINESS_ENV_FILE" TOKEN_ROTATION_ATTESTED_AT
  require_env_value "$READINESS_ENV_FILE" TOKEN_ROTATION_ATTESTATION_ID
  require_env_value "$READINESS_ENV_FILE" CONTROL_PLANE_AUTH_AUDIT_ATTESTED_AT
  require_env_value "$READINESS_ENV_FILE" CONTROL_PLANE_AUTH_SESSION_ID
else
  record_ok "token_rotation_attestation_skipped"
fi

if bool_enabled "$REQUIRE_NON_ROOT_ACCESS_ATTESTATION"; then
  require_env_value "$READINESS_ENV_FILE" NON_ROOT_ACCESS_ATTESTED_AT
else
  record_ok "non_root_access_attestation_skipped"
fi

run_strict_observability
run_object_storage_check

if [ "${#failures[@]}" -gt 0 ]; then
  printf 'continuous_production_readiness_status=failed\n' >&2
  printf 'checked_at=%s\n' "$CHECKED_AT" >&2
  exit 1
fi

printf 'continuous_production_readiness_status=ok\n'
printf 'checked_at=%s\n' "$CHECKED_AT"
