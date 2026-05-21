#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOST="${SITE_HOST:-continuoushq.com}"
EXPECTED_POSTGRES_MAJOR="${EXPECTED_POSTGRES_MAJOR:-17}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
WORKER_PATH="${WORKER_PATH:-/worker}"
APP_SERVER_PATH="${APP_SERVER_PATH:-/app-server}"
RESOLVE_IP="${RESOLVE_IP:-127.0.0.1}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-20}"
CURL_RETRIES="${CURL_RETRIES:-2}"
CURL_RETRY_DELAY="${CURL_RETRY_DELAY:-1}"

if [ -z "$SITE_HOST" ]; then
  echo "SITE_HOST is required." >&2
  exit 1
fi

if ! [[ "$EXPECTED_POSTGRES_MAJOR" =~ ^[0-9]+$ ]]; then
  echo "EXPECTED_POSTGRES_MAJOR must be an integer." >&2
  exit 1
fi

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; deploy the stack before smoke checks." >&2
  exit 1
fi

POSTGRES_USER="$(grep '^POSTGRES_USER=' .env | cut -d= -f2- || true)"
POSTGRES_DB="$(grep '^POSTGRES_DB=' .env | cut -d= -f2- || true)"
WORKER_TOKEN="$(grep '^WORKER_RUN_TOKEN=' .env | cut -d= -f2- || true)"
POSTGRES_USER="${POSTGRES_USER:-continuous}"
POSTGRES_DB="${POSTGRES_DB:-continuous}"

resolve_arg="${SITE_HOST}:443:${RESOLVE_IP}"
health_url="https://${SITE_HOST}${HEALTH_PATH}"
worker_url="https://${SITE_HOST}${WORKER_PATH}"
app_server_url="https://${SITE_HOST}${APP_SERVER_PATH}"
curl_args=(
  --connect-timeout "$CURL_CONNECT_TIMEOUT"
  --max-time "$CURL_MAX_TIME"
  --retry "$CURL_RETRIES"
  --retry-delay "$CURL_RETRY_DELAY"
  --retry-connrefused
)
worker_smoke_out="${TMPDIR:-/tmp}/continuous-worker-smoke.$$"
app_server_smoke_out="${TMPDIR:-/tmp}/continuous-app-server-smoke.$$"
trap 'rm -f "$worker_smoke_out" "$app_server_smoke_out"' EXIT

HEALTH_RESPONSE="$(
  curl -fsS "${curl_args[@]}" --resolve "$resolve_arg" "$health_url"
)"
printf '%s\n' "$HEALTH_RESPONSE" | /usr/bin/jq -c '{service,status,mode,checkedAt}'
printf '%s\n' "$HEALTH_RESPONSE" | /usr/bin/jq -e \
  '.status == "ok" and .mode == "production"' \
  >/dev/null

worker_status="$(
  curl -sS "${curl_args[@]}" --resolve "$resolve_arg" \
    -o "$worker_smoke_out" -w '%{http_code}' \
    -X POST \
    -H 'content-type: application/json' \
    --data '{"view":"snapshot","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}' \
    "$worker_url"
)"

if [ "$worker_status" != "401" ]; then
  echo "Expected $WORKER_PATH to require auth; got $worker_status." >&2
  cat "$worker_smoke_out" >&2 || true
  exit 1
fi

api_segment="api"
worker_segment="worker"
workers_segment="${worker_segment}s"
old_revenue_segment="$(printf '%s-%s' revenue "$worker_segment")"
old_worker_role_path="$(printf '/%s/%s' "$worker_segment" revenue_operations)"

assert_old_worker_path_absent() {
  old_path="$1"
  old_status="$(
    curl -sS "${curl_args[@]}" --resolve "$resolve_arg" \
      -o "$worker_smoke_out" -w '%{http_code}' \
      -X POST \
      -H 'content-type: application/json' \
      --data '{"command":"run","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}' \
      "https://${SITE_HOST}${old_path}"
  )"

  case "$old_status" in
    404 | 405)
      ;;
    *)
      echo "Expected old worker URL ${old_path} to be absent; got ${old_status}." >&2
      cat "$worker_smoke_out" >&2 || true
      exit 1
      ;;
  esac
}

assert_old_worker_path_absent "/${api_segment}/${old_revenue_segment}"
assert_old_worker_path_absent "/${api_segment}/${old_revenue_segment}/run"
assert_old_worker_path_absent "/${api_segment}/${workers_segment}/revenue"
assert_old_worker_path_absent "$old_worker_role_path"

app_server_status="$(
  curl -sS "${curl_args[@]}" --resolve "$resolve_arg" \
    -o "$app_server_smoke_out" -w '%{http_code}' \
    -X POST \
    -H 'content-type: application/json' \
    --data '{"tool":"continuous.worker.schema","arguments":{},"callId":"production-smoke","threadId":"production-smoke","turnId":"production-smoke"}' \
    "$app_server_url"
)"

if [ "$app_server_status" != "401" ]; then
  echo "Expected $APP_SERVER_PATH to require auth; got $app_server_status." >&2
  cat "$app_server_smoke_out" >&2 || true
  exit 1
fi

if [ -z "$WORKER_TOKEN" ]; then
  echo "Missing WORKER_RUN_TOKEN for authenticated app-server schema smoke." >&2
  exit 1
fi

APP_SERVER_CORE_SCHEMA_RESPONSE="$(
  curl -fsS "${curl_args[@]}" --resolve "$resolve_arg" \
    -X POST \
    -H "authorization: Bearer $WORKER_TOKEN" \
    -H 'content-type: application/json' \
    --data '{"tool":"continuous.core.schema","arguments":{},"callId":"production-core-schema-smoke","threadId":"production-smoke","turnId":"production-smoke"}' \
    "$app_server_url"
)"
printf '%s\n' "$APP_SERVER_CORE_SCHEMA_RESPONSE" | /usr/bin/jq -c '{api,error,success:.data.success,contentItemCount:(.data.contentItems | length)}'
printf '%s\n' "$APP_SERVER_CORE_SCHEMA_RESPONSE" | /usr/bin/jq -e '
  .api == "continuous.app_server.v1" and
  .error == null and
  .data.success == true and
  (.data.contentItems[0].text | fromjson |
    .ok == true and
    .tool == "continuous.core.schema" and
    (.data.registry.commands | any(.name == "task.create" and .apiRoute == "/core")) and
    (.data.registry.commands | any(.name == "worker.upsert" and .apiRoute == "/core")) and
    (.data.registry.commands | any(.name == "worker.transition" and .apiRoute == "/core")) and
    (.data.registry.commands | any(.name == "worker.run.start" and .apiRoute == "/core")) and
    (.data.registry.commands | any(.name == "worker.run.complete" and .apiRoute == "/core")) and
    (.data.registry.views | any(.name == "summary" and .apiRoute == "/core"))
  )
' >/dev/null

if [ "${APP_SERVER_CORE_LIFECYCLE_SMOKE:-false}" = "true" ]; then
  APP_DIR="$APP_DIR" SITE_HOST="$SITE_HOST" TENANT_SLUG="continuous-demo" \
    ./scripts/smoke-app-server-core-lifecycle-on-host.sh
fi

version_num="$(
  docker compose exec -T db psql -At -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -c "select current_setting('server_version_num');" \
    </dev/null
)"
actual_major="$((version_num / 10000))"

if [ "$actual_major" -ne "$EXPECTED_POSTGRES_MAJOR" ]; then
  echo "Expected Postgres $EXPECTED_POSTGRES_MAJOR, got server_version_num=$version_num." >&2
  exit 1
fi

printf 'production_smoke_status=ok\n'
printf 'site_host=%s\n' "$SITE_HOST"
printf 'app_server_path=%s\n' "$APP_SERVER_PATH"
printf 'postgres_major=%s\n' "$actual_major"
