#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOST="${SITE_HOST:-continuoushq.com}"
EXPECTED_POSTGRES_MAJOR="${EXPECTED_POSTGRES_MAJOR:-17}"
HEALTH_PATH="${HEALTH_PATH:-/health}"
WORKER_PATH="${WORKER_PATH:-/worker}"
RESOLVE_IP="${RESOLVE_IP:-127.0.0.1}"

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
POSTGRES_USER="${POSTGRES_USER:-continuous}"
POSTGRES_DB="${POSTGRES_DB:-continuous}"

resolve_arg="${SITE_HOST}:443:${RESOLVE_IP}"
health_url="https://${SITE_HOST}${HEALTH_PATH}"
worker_url="https://${SITE_HOST}${WORKER_PATH}"

HEALTH_RESPONSE="$(
  curl -fsS --resolve "$resolve_arg" "$health_url"
)"
printf '%s\n' "$HEALTH_RESPONSE" | /usr/bin/jq -c '{service,status,mode,checkedAt}'
printf '%s\n' "$HEALTH_RESPONSE" | /usr/bin/jq -e \
  '.status == "ok" and .mode == "production"' \
  >/dev/null

worker_status="$(
  curl -sS --resolve "$resolve_arg" \
    -o /tmp/continuous-worker-smoke.out -w '%{http_code}' \
    -X POST \
    -H 'content-type: application/json' \
    --data '{"view":"snapshot","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}' \
    "$worker_url"
)"

if [ "$worker_status" != "401" ]; then
  echo "Expected $WORKER_PATH to require auth; got $worker_status." >&2
  cat /tmp/continuous-worker-smoke.out >&2 || true
  exit 1
fi

version_num="$(
  docker compose exec -T db psql -At -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    -c "select current_setting('server_version_num');"
)"
actual_major="$((version_num / 10000))"

if [ "$actual_major" -ne "$EXPECTED_POSTGRES_MAJOR" ]; then
  echo "Expected Postgres $EXPECTED_POSTGRES_MAJOR, got server_version_num=$version_num." >&2
  exit 1
fi

printf 'production_smoke_status=ok\n'
printf 'site_host=%s\n' "$SITE_HOST"
printf 'postgres_major=%s\n' "$actual_major"
