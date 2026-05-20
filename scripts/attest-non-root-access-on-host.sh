#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
READINESS_ENV_FILE="${READINESS_ENV_FILE:-/etc/continuous/production-readiness.env}"
DEPLOY_USER_NAME="${DEPLOY_USER_NAME:-continuous-deploy}"
WRITE_READINESS_ENV="${WRITE_READINESS_ENV:-true}"
CHECKED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

fail() {
  printf 'continuous_non_root_access_status=failed\n' >&2
  printf 'reason=%s\n' "$1" >&2
  exit 1
}

shell_quote() {
  printf "%q" "$1"
}

set_readiness_value() {
  key="$1"
  value="$2"

  install -m 0700 -d "$(dirname "$READINESS_ENV_FILE")"
  touch "$READINESS_ENV_FILE"
  chmod 0600 "$READINESS_ENV_FILE"

  tmp="$(mktemp)"
  if grep -q "^${key}=" "$READINESS_ENV_FILE"; then
    awk -v key="$key" -v value="$(shell_quote "$value")" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' "$READINESS_ENV_FILE" > "$tmp"
  else
    cat "$READINESS_ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$(shell_quote "$value")" >> "$tmp"
  fi

  install -m 0600 "$tmp" "$READINESS_ENV_FILE"
  rm -f "$tmp"
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_command:$1"
}

require_command id
require_command getent
require_command docker

if ! getent passwd "$DEPLOY_USER_NAME" >/dev/null; then
  fail "deploy_user_missing:$DEPLOY_USER_NAME"
fi

deploy_uid="$(id -u "$DEPLOY_USER_NAME")"
if [ "$deploy_uid" = "0" ]; then
  fail "deploy_user_is_root:$DEPLOY_USER_NAME"
fi

deploy_groups="$(id -nG "$DEPLOY_USER_NAME" | tr ' ' ',')"
case ",$deploy_groups," in
  *,docker,*) ;;
  *) fail "deploy_user_missing_docker_group:$DEPLOY_USER_NAME" ;;
esac

if [ ! -d "$APP_DIR" ]; then
  fail "app_dir_missing:$APP_DIR"
fi

if [ "$(id -u)" = "0" ]; then
  require_command runuser
  runuser -u "$DEPLOY_USER_NAME" -- test -w "$APP_DIR" ||
    fail "app_dir_not_writable_by_deploy_user:$APP_DIR"
  docker_compose_version="$(
    runuser -u "$DEPLOY_USER_NAME" -- docker compose version --short 2>/dev/null ||
      runuser -u "$DEPLOY_USER_NAME" -- docker compose version 2>/dev/null
  )"
elif [ "$(id -un)" = "$DEPLOY_USER_NAME" ]; then
  test -w "$APP_DIR" || fail "app_dir_not_writable_by_deploy_user:$APP_DIR"
  docker_compose_version="$(docker compose version --short 2>/dev/null || docker compose version 2>/dev/null)"
else
  fail "must_run_as_root_or_deploy_user:$DEPLOY_USER_NAME"
fi

if [ -z "$docker_compose_version" ]; then
  fail "docker_compose_unavailable_for_deploy_user:$DEPLOY_USER_NAME"
fi

if [ "$WRITE_READINESS_ENV" = "true" ]; then
  if [ "$(id -u)" != "0" ]; then
    fail "write_readiness_env_requires_root:$READINESS_ENV_FILE"
  fi

  set_readiness_value NON_ROOT_ACCESS_ATTESTED_AT "$CHECKED_AT"
  set_readiness_value NON_ROOT_ACCESS_USER "$DEPLOY_USER_NAME"
  set_readiness_value NON_ROOT_ACCESS_UID "$deploy_uid"
  set_readiness_value NON_ROOT_ACCESS_GROUPS "$deploy_groups"
  set_readiness_value NON_ROOT_ACCESS_APP_DIR "$APP_DIR"
  set_readiness_value NON_ROOT_ACCESS_DOCKER_COMPOSE_VERSION "$docker_compose_version"
fi

printf 'continuous_non_root_access_status=ok\n'
printf 'checked_at=%s\n' "$CHECKED_AT"
printf 'deploy_user=%s\n' "$DEPLOY_USER_NAME"
printf 'deploy_uid=%s\n' "$deploy_uid"
printf 'deploy_groups=%s\n' "$deploy_groups"
printf 'app_dir=%s\n' "$APP_DIR"
printf 'docker_compose_version=%s\n' "$docker_compose_version"
