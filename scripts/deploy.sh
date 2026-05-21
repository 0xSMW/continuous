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
WORKER_OPERATOR_EMAIL="${WORKER_OPERATOR_EMAIL:-}"
POSTGRES_DB="${POSTGRES_DB:-continuous}"
POSTGRES_USER="${POSTGRES_USER:-continuous}"
APP_IMAGE="${APP_IMAGE:-continuous-app}"
APP_TAG="${APP_TAG:-sha-$(git rev-parse --short=12 HEAD 2>/dev/null || date -u +%Y%m%d%H%M%S)}"
EXPECTED_POSTGRES_MAJOR="${EXPECTED_POSTGRES_MAJOR:-17}"
REMOTE="$SSH_USER@$HOST"

if [ -z "$HOST" ]; then
  echo "Set HOST to the droplet IP or hostname." >&2
  echo "Example: HOST=203.0.113.10 ./scripts/deploy.sh" >&2
  exit 1
fi

if [ -z "$WORKER_OPERATOR_EMAIL" ]; then
  echo "Set WORKER_OPERATOR_EMAIL to a seeded active operator email." >&2
  echo "Example: WORKER_OPERATOR_EMAIL=owner@continuoushq.com HOST=203.0.113.10 ./scripts/deploy.sh" >&2
  exit 1
fi

if [ -z "$APP_URL" ]; then
  first_host="${SITE_HOSTS%%,*}"
  first_host="$(printf '%s' "$first_host" | xargs)"
  first_host="${first_host#http://}"
  first_host="${first_host#https://}"
  APP_URL="https://$first_host"
fi
SITE_HOST="${APP_URL#https://}"
SITE_HOST="${SITE_HOST%%/*}"
SITE_HOST="${SITE_HOST%%:*}"

if [[ "$SITE_HOSTS" == *"http://"* || "$APP_URL" == http://* ]]; then
  echo "Plain HTTP deploys are disabled. Set HTTPS SITE_HOSTS and APP_URL." >&2
  exit 1
fi

if [[ ! "$APP_IMAGE" =~ ^[A-Za-z0-9._/-]+$ ]]; then
  echo "APP_IMAGE may only contain letters, numbers, dot, underscore, slash, or dash." >&2
  exit 1
fi

if [[ ! "$APP_TAG" =~ ^[A-Za-z0-9._-]+$ ]]; then
  echo "APP_TAG may only contain letters, numbers, dot, underscore, or dash." >&2
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
ssh "$REMOTE" "cloud-init status --wait >/dev/null 2>&1 || true; command -v docker >/dev/null; docker compose version >/dev/null; command -v rsync >/dev/null; command -v jq >/dev/null; command -v curl >/dev/null; command -v sha256sum >/dev/null; command -v base64 >/dev/null; command -v openssl >/dev/null"

rsync -az --delete \
  --exclude ".git" \
  --exclude "node_modules" \
  --exclude ".next" \
  --exclude ".env" \
  --exclude ".env.*" \
  --exclude "/backups/" \
  --exclude "/logs/" \
  --exclude "/reports/recovery-drills/" \
  ./ "$REMOTE:$APP_DIR/"

ssh "$REMOTE" \
  "APP_DIR=$(quote "$APP_DIR") SITE_HOSTS=$(quote "$SITE_HOSTS") SITE_HOST=$(quote "$SITE_HOST") ACME_EMAIL=$(quote "$ACME_EMAIL") APP_URL=$(quote "$APP_URL") WORKER_OPERATOR_EMAIL=$(quote "$WORKER_OPERATOR_EMAIL") POSTGRES_DB=$(quote "$POSTGRES_DB") POSTGRES_USER=$(quote "$POSTGRES_USER") APP_IMAGE=$(quote "$APP_IMAGE") APP_TAG=$(quote "$APP_TAG") EXPECTED_POSTGRES_MAJOR=$(quote "$EXPECTED_POSTGRES_MAJOR") bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cd "$APP_DIR"
install -m 0755 -d logs/caddy logs/observability

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
    printf 'APP_IMAGE=%s\n' "$APP_IMAGE"
    printf 'APP_TAG=%s\n' "$APP_TAG"
    printf 'WORKER_RUN_ENABLED=true\n'
    printf 'WORKER_RUN_TOKEN=%s\n' "$(openssl rand -hex 32)"
    printf 'WORKER_OPERATOR_EMAIL=%s\n' "$WORKER_OPERATOR_EMAIL"
    printf 'CONTROL_PLANE_ALLOWED_TENANTS=continuous-demo\n'
    printf 'CONTROL_PLANE_ALLOWED_WORKER_ROLES=revenue_operations,owner_chief_of_staff,dispatch_operations,finance_operations,workforce_operations,compliance_operations,systems_operations,offer_pricing_operations\n'
    printf 'WORKER_SCHEDULER_ENABLED=true\n'
    printf 'WORKER_SCHEDULER_BASE_URL=http://app:3000\n'
    printf 'WORKER_SCHEDULER_TENANT_SLUG=continuous-demo\n'
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

set_control_plane_token_catalog() {
  token_hash="$(printf '%s' "$worker_token" | sha256sum | awk '{print $1}')"
  allowed_commands='"core:view.summary","core:task.create","core:task.transition","core:object.upsert","core:adapter.upsert","core:connection.upsert","core:connection.health.record","core:entity.setup.record","core:worker.upsert","core:worker.transition","core:object.link","core:event.ingest","core:evidence.attach","core:document.create","core:packet.prepare","core:document.packet.prepare","core:decision.record","core:approval.request","core:adapter.intent.record","core:rule.change.record","core:external_action.record","core:capability.grant","core:budget.reserve","core:budget.charge","core:budget.release","core:ai.infer","core:view.publish","core:customer_signal.record","core:payroll.preview.record","core:payroll.preview.packet.prepare","core:control_plane.token_rotation.attest","core:control_plane.credential.upsert","core:control_plane.credential.revoke","core:control_plane.session.review","worker:view.snapshot","worker:view.approvals","worker:view.briefs","worker:view.decisions","worker:view.board","worker:view.exceptions","worker:view.readiness","worker:view.health","worker:view.repairs","worker:run","worker:lead.read","worker:lead.classify","worker:response.draft","worker:quote.prepare","worker:payment_link.prepare","worker:schedule.propose","worker:customer_update.draft","worker:closeout.prepare","worker:exception.route","worker:invoice.prepare","worker:ar_followup.draft","worker:cash_forecast.generate","worker:payment_draft.prepare","worker:hire.packet.prepare","worker:payroll_input.prepare","worker:continue","worker:approval.decide","worker:adapters.reconcile","worker:adapters.retry","worker:brief.generate","worker:decision_queue.prepare","worker:anomaly.triage","worker:connector.health.scan","worker:sync.repair.plan","worker:data_quality.remediate","worker:permission.review","worker:automation.plan","worker:margin.review.prepare","worker:view.price_policy","workflow:view.overview","workflow:view.approvals","workflow:start","workflow:transition","workflow:steps.execute","workflow:approval.decide","approval:view.inbox","approval:approval.decide"'
  compliance_worker_permissions='"worker:view.obligations","worker:view.packet","worker:filing.prepare"'
  app_server_commands='"app_server:worker.schema","app_server:worker.view.snapshot","app_server:worker.view.approvals","app_server:worker.view.briefs","app_server:worker.view.decisions","app_server:worker.view.board","app_server:worker.view.exceptions","app_server:worker.view.readiness","app_server:worker.view.health","app_server:worker.view.repairs","app_server:worker.command.run","app_server:worker.command.lead.read","app_server:worker.command.lead.classify","app_server:worker.command.response.draft","app_server:worker.command.quote.prepare","app_server:worker.command.payment_link.prepare","app_server:worker.command.schedule.propose","app_server:worker.command.customer_update.draft","app_server:worker.command.closeout.prepare","app_server:worker.command.exception.route","app_server:worker.command.invoice.prepare","app_server:worker.command.ar_followup.draft","app_server:worker.command.cash_forecast.generate","app_server:worker.command.payment_draft.prepare","app_server:worker.command.hire.packet.prepare","app_server:worker.command.payroll_input.prepare","app_server:worker.command.continue","app_server:worker.command.approval.decide","app_server:worker.command.adapters.reconcile","app_server:worker.command.adapters.retry","app_server:worker.command.brief.generate","app_server:worker.command.decision_queue.prepare","app_server:worker.command.anomaly.triage","app_server:worker.command.connector.health.scan","app_server:worker.command.sync.repair.plan","app_server:worker.command.data_quality.remediate","app_server:worker.command.permission.review","app_server:worker.command.automation.plan","app_server:worker.command.margin.review.prepare","app_server:worker.view.price_policy"'
  compliance_app_server_permissions='"app_server:worker.view.obligations","app_server:worker.view.packet","app_server:worker.command.filing.prepare"'
  allowed_commands="${allowed_commands},${compliance_worker_permissions},${app_server_commands},${compliance_app_server_permissions}"
  catalog_json="$(
    printf '[{"id":"bootstrap-operator","tokenSha256":"%s","operatorEmail":"%s","allowedTenants":["continuous-demo"],"allowedWorkerRoles":["revenue_operations","owner_chief_of_staff","dispatch_operations","finance_operations","workforce_operations","compliance_operations","systems_operations","offer_pricing_operations"],"allowedRoutes":["core","worker","workflow","approval","app_server"],"allowedAccess":["read","write"],"allowedCommands":[%s]}]' \
      "$token_hash" \
      "$WORKER_OPERATOR_EMAIL" \
      "$allowed_commands"
  )"
  catalog_b64="$(printf '%s' "$catalog_json" | base64 -w0)"

  set_env CONTROL_PLANE_TOKENS_JSON ""
  set_env CONTROL_PLANE_TOKEN_CATALOG_B64 "$catalog_b64"
}

cleanup_release_storage() {
  mkdir -p "$APP_DIR/releases"
  current_app_tag="$(grep '^APP_TAG=' .env | cut -d= -f2- || true)"
  previous_app_tag="$(grep '^PREVIOUS_APP_TAG=' .env | cut -d= -f2- || true)"

  echo "Remote disk before deploy cleanup:"
  df -h / "$APP_DIR" /var/lib/docker 2>/dev/null || df -h /
  docker system df || true

  run_cleanup() {
    if command -v timeout >/dev/null 2>&1; then
      timeout --preserve-status 120s "$@" >/dev/null 2>&1 || true
    else
      "$@" >/dev/null 2>&1 || true
    fi
  }
  prune_old_app_images() {
    docker images "$APP_IMAGE" --format '{{.Repository}} {{.Tag}}' | while read -r image_repo image_tag; do
      if [ -z "$image_repo" ] || [ -z "$image_tag" ] || [ "$image_tag" = "<none>" ]; then
        continue
      fi

      keep_image=false
      case "$image_tag" in
        "$APP_TAG"|"$APP_TAG-migrate"|"$APP_TAG-scheduler")
          keep_image=true
          ;;
      esac
      if [ -n "$current_app_tag" ]; then
        case "$image_tag" in
          "$current_app_tag"|"$current_app_tag-migrate"|"$current_app_tag-scheduler")
            keep_image=true
            ;;
        esac
      fi
      if [ -n "$previous_app_tag" ]; then
        case "$image_tag" in
          "$previous_app_tag"|"$previous_app_tag-migrate"|"$previous_app_tag-scheduler")
            keep_image=true
            ;;
        esac
      fi

      if [ "$keep_image" = false ]; then
        run_cleanup docker image rm "$image_repo:$image_tag"
      fi
    done
  }
  run_cleanup docker container prune -f
  run_cleanup docker image prune -f
  run_cleanup docker builder prune -af
  prune_old_app_images
  find /var/lib/docker/containers -type f -name '*-json.log' -exec truncate -s 0 {} + 2>/dev/null || true
  find "$APP_DIR/releases" -mindepth 2 -maxdepth 2 -type f ! -path "$APP_DIR/releases/$APP_TAG/*" -delete 2>/dev/null || true

  find "$APP_DIR/releases" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r release_dir; do
    release_name="$(basename "$release_dir")"
    case "$release_name" in
      "$APP_TAG"|"$current_app_tag"|"$previous_app_tag")
        ;;
      *)
        rm -rf "$release_dir"
        ;;
    esac
  done

  echo "Remote disk after deploy cleanup:"
  df -h / "$APP_DIR" /var/lib/docker 2>/dev/null || df -h /
  docker system df || true
  du -sh "$APP_DIR/releases" 2>/dev/null || true
}

set_env APP_URL "$APP_URL"
set_env SITE_HOSTS "$SITE_HOSTS"
set_env ACME_EMAIL "$ACME_EMAIL"
set_env WORKER_OPERATOR_EMAIL "$WORKER_OPERATOR_EMAIL"
set_env CONTROL_PLANE_ALLOWED_TENANTS "continuous-demo"
set_env CONTROL_PLANE_ALLOWED_WORKER_ROLES "revenue_operations,owner_chief_of_staff,dispatch_operations,finance_operations,workforce_operations,compliance_operations,systems_operations,offer_pricing_operations"
set_env WORKER_SCHEDULER_ENABLED true
set_env WORKER_SCHEDULER_BASE_URL "http://app:3000"
set_env WORKER_SCHEDULER_TENANT_SLUG "continuous-demo"
current_app_tag="$(grep '^APP_TAG=' .env | cut -d= -f2- || true)"
set_env APP_IMAGE "$APP_IMAGE"
if [ -n "$current_app_tag" ] && [ "$current_app_tag" != "$APP_TAG" ]; then
  set_env PREVIOUS_APP_TAG "$current_app_tag"
fi
set_env APP_TAG "$APP_TAG"

previous_worker_token="$(grep '^WORKER_RUN_TOKEN=' .env | cut -d= -f2- || true)"
worker_token="$(openssl rand -hex 32)"
if [ -n "$previous_worker_token" ] && docker compose ps --status running app | grep -q app; then
  TOKEN_ROTATION_OUTPUT=""
  if TOKEN_ROTATION_OUTPUT="$(
    APP_DIR="$APP_DIR" \
      SITE_HOST="$SITE_HOST" \
      NEXT_WORKER_RUN_TOKEN="$worker_token" \
      CONTROL_PLANE_ROTATION_RUN_ID="$(date -u +%Y%m%d%H%M%S)" \
      "$APP_DIR/scripts/rotate-control-plane-token-on-host.sh"
  )" && printf '%s\n' "$TOKEN_ROTATION_OUTPUT" | /usr/bin/jq -e \
    '.control_plane_token_rotation_status == "ok" and (.tokenRotationAttestationId | length > 0)' \
    >/dev/null; then
    printf '%s\n' "$TOKEN_ROTATION_OUTPUT"
  else
    if [ -n "$TOKEN_ROTATION_OUTPUT" ]; then
      printf '%s\n' "$TOKEN_ROTATION_OUTPUT" >&2
    fi
    echo "Pre-deploy token rotation could not be attested; preserving the existing bootstrap token while retaining the catalog for this recovery deploy." >&2
    worker_token="$previous_worker_token"
  fi
else
  echo "No running app found for pre-deploy token rotation; writing a fresh bootstrap token and seeding the route-scoped catalog."
fi
set_env WORKER_RUN_TOKEN "$worker_token"
set_env WORKER_RUN_ENABLED true
set_control_plane_token_catalog
cleanup_release_storage

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
docker compose --profile scheduler up -d --build --remove-orphans app caddy worker-scheduler
docker compose --profile scheduler ps --status running worker-scheduler | grep -q worker-scheduler
APP_DIR="$APP_DIR" SITE_HOST="$SITE_HOST" EXPECTED_POSTGRES_MAJOR="$EXPECTED_POSTGRES_MAJOR" \
  ./scripts/smoke-production-on-host.sh
CONTROL_PLANE_ATTESTATION_OUTPUT="$(
  APP_DIR="$APP_DIR" \
    SITE_HOST="$SITE_HOST" \
    CONTROL_PLANE_ATTESTATION_RUN_ID="$(date -u +%Y%m%d%H%M%S)" \
    ./scripts/attest-control-plane-on-host.sh
)"
printf '%s\n' "$CONTROL_PLANE_ATTESTATION_OUTPUT"
printf '%s\n' "$CONTROL_PLANE_ATTESTATION_OUTPUT" | /usr/bin/jq -e \
  '.control_plane_attestation_status == "ok" and (.credentialId | length > 0) and (.revocationAuditId | length > 0) and (.sessionReviewViewId | length > 0) and (.authSessionId | length > 0)' \
  >/dev/null
APP_DIR="$APP_DIR" SITE_HOST="$SITE_HOST" TENANT_SLUG="continuous-demo" \
  ./scripts/smoke-core-worker-lifecycle-on-host.sh
docker compose ps
REMOTE_SCRIPT
