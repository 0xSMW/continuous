#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOSTS="${SITE_HOSTS:-continuoushq.com, getcontinuous.app}"
ACME_EMAIL="${ACME_EMAIL:-admin@continuoushq.com}"
APP_URL="${APP_URL:-}"
WORKER_OPERATOR_EMAIL="${WORKER_OPERATOR_EMAIL:-owner@continuoushq.com}"
POSTGRES_DB="${POSTGRES_DB:-continuous}"
POSTGRES_USER="${POSTGRES_USER:-continuous}"
REMOTE="$SSH_USER@$HOST"

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=203.0.113.10 ./scripts/deploy.sh" >&2
  exit 1
fi

if [ -z "$APP_URL" ]; then
  first_host="${SITE_HOSTS%%,*}"
  first_host="${first_host#http://}"
  first_host="${first_host#https://}"
  APP_URL="https://$first_host"
fi

if [[ "$SITE_HOSTS" == *"http://"* || "$APP_URL" == http://* ]]; then
  echo "Plain HTTP deploys are disabled. Set HTTPS SITE_HOSTS and APP_URL." >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

for attempt in $(seq 1 60); do
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$REMOTE" "true" >/dev/null 2>&1; then
    break
  fi

  if [ "$attempt" -eq 60 ]; then
    echo "SSH did not become ready for $REMOTE." >&2
    exit 1
  fi

  sleep 5
done

ssh "$REMOTE" "mkdir -p $(quote "$APP_DIR")"
ssh "$REMOTE" "cloud-init status --wait >/dev/null 2>&1 || true; command -v docker >/dev/null; docker compose version >/dev/null; command -v rsync >/dev/null"

rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".next" \
  --exclude ".env" \
  --exclude ".env.*" \
  ./ "$REMOTE:$APP_DIR/"

ssh "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") SITE_HOSTS=$(quote "$SITE_HOSTS") ACME_EMAIL=$(quote "$ACME_EMAIL") APP_URL=$(quote "$APP_URL") WORKER_OPERATOR_EMAIL=$(quote "$WORKER_OPERATOR_EMAIL") POSTGRES_DB=$(quote "$POSTGRES_DB") POSTGRES_USER=$(quote "$POSTGRES_USER") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  password="$(openssl rand -hex 32)"
  umask 077
  {
    printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
    printf 'POSTGRES_USER=%s\n' "$POSTGRES_USER"
    printf 'POSTGRES_PASSWORD=%s\n' "$password"
    printf 'DATABASE_URL=postgresql://%s:%s@db:5432/%s\n' "$POSTGRES_USER" "$password" "$POSTGRES_DB"
    printf 'APP_ENV=production\n'
    printf 'APP_URL=%s\n' "$APP_URL"
    printf 'SITE_HOSTS=%s\n' "$SITE_HOSTS"
    printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
    printf 'APP_IMAGE=continuous-app\n'
    printf 'APP_TAG=local\n'
    printf 'WORKER_RUN_ENABLED=true\n'
    printf 'WORKER_RUN_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'WORKER_OPERATOR_EMAIL=%s\n' "$WORKER_OPERATOR_EMAIL"
  } > .env
  echo "Created $APP_DIR/.env"
else
  echo "Using existing $APP_DIR/.env"
fi

set_env() {
  key="$1"
  value="$2"
  tmp="$(mktemp)"

  if grep -q "^${key}=" .env; then
    awk -v key="$key" -v value="$value" '
      index($0, key "=") == 1 { print key "=" value; next }
      { print }
    ' .env > "$tmp"
  else
    cat .env > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi

  mv "$tmp" .env
  chmod 600 .env
}

set_env APP_URL "$APP_URL"
set_env SITE_HOSTS "$SITE_HOSTS"
set_env ACME_EMAIL "$ACME_EMAIL"
set_env WORKER_OPERATOR_EMAIL "$WORKER_OPERATOR_EMAIL"

worker_token="$(grep '^WORKER_RUN_TOKEN=' .env | cut -d= -f2- || true)"
if [ -z "$worker_token" ]; then
  worker_token="$(openssl rand -hex 32)"
fi
set_env WORKER_RUN_TOKEN "$worker_token"
set_env WORKER_RUN_ENABLED true

docker compose pull db caddy
docker compose up -d db
docker compose exec -T db sh -c 'until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB"; do sleep 1; done' </dev/null

db_password="$(grep '^POSTGRES_PASSWORD=' .env | cut -d= -f2-)"
if ! grep -q '^DATABASE_URL=' .env || [[ "$db_password" =~ [^A-Za-z0-9_.~-] ]]; then
  db_password="$(openssl rand -hex 32)"
  docker compose exec -T db psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "alter user \"$POSTGRES_USER\" with password '$db_password';" </dev/null
  set_env POSTGRES_PASSWORD "$db_password"
  set_env DATABASE_URL "postgresql://$POSTGRES_USER:$db_password@db:5432/$POSTGRES_DB"
fi

docker compose --profile tools run --rm --build migrate bun run db:migrate </dev/null
docker compose --profile tools run --rm --build migrate bun run db:seed </dev/null
docker compose up -d --build --remove-orphans app caddy
docker compose ps
REMOTE_SCRIPT
