#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

HOST="${HOST:-}"
SSH_USER="${SSH_USER:-root}"
APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOSTS="${SITE_HOSTS:-http://:80}"
ACME_EMAIL="${ACME_EMAIL:-admin@continuoushq.com}"
APP_URL="${APP_URL:-http://$HOST}"
POSTGRES_DB="${POSTGRES_DB:-continuous}"
POSTGRES_USER="${POSTGRES_USER:-continuous}"
REMOTE="$SSH_USER@$HOST"

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=203.0.113.10 ./scripts/deploy.sh" >&2
  exit 1
fi

quote() {
  printf "%q" "$1"
}

ssh "$REMOTE" "mkdir -p $(quote "$APP_DIR")"
ssh "$REMOTE" "cloud-init status --wait >/dev/null 2>&1 || true; command -v docker >/dev/null; command -v rsync >/dev/null"

rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".next" \
  --exclude ".env" \
  --exclude ".env.*" \
  ./ "$REMOTE:$APP_DIR/"

ssh "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") SITE_HOSTS=$(quote "$SITE_HOSTS") ACME_EMAIL=$(quote "$ACME_EMAIL") APP_URL=$(quote "$APP_URL") POSTGRES_DB=$(quote "$POSTGRES_DB") POSTGRES_USER=$(quote "$POSTGRES_USER") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"

if [ ! -f .env ]; then
  password="$(openssl rand -base64 36 | tr -d '\n')"
  umask 077
  {
    printf 'POSTGRES_DB=%s\n' "$POSTGRES_DB"
    printf 'POSTGRES_USER=%s\n' "$POSTGRES_USER"
    printf 'POSTGRES_PASSWORD=%s\n' "$password"
    printf 'APP_ENV=production\n'
    printf 'APP_URL=%s\n' "$APP_URL"
    printf 'SITE_HOSTS=%s\n' "$SITE_HOSTS"
    printf 'ACME_EMAIL=%s\n' "$ACME_EMAIL"
    printf 'APP_IMAGE=continuous-app\n'
    printf 'APP_TAG=local\n'
  } > .env
  echo "Created $APP_DIR/.env"
else
  echo "Using existing $APP_DIR/.env"
fi

docker compose pull db caddy
docker compose up -d db
docker compose --profile tools run --rm migrate
docker compose --profile tools run --rm migrate npm run db:seed
docker compose up -d --build app caddy
docker compose ps
REMOTE_SCRIPT
