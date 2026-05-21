#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOST="${SITE_HOST:-continuoushq.com}"
TENANT_SLUG="${TENANT_SLUG:-continuous-demo}"
CORE_PATH="${CORE_PATH:-/core}"
RESOLVE_IP="${RESOLVE_IP:-127.0.0.1}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-20}"
CURL_RETRIES="${CURL_RETRIES:-2}"
CURL_RETRY_DELAY="${CURL_RETRY_DELAY:-1}"
RUN_ID="${CORE_WORKER_LIFECYCLE_SMOKE_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; deploy the stack before Core worker lifecycle smoke checks." >&2
  exit 1
fi

WORKER_TOKEN="$(grep '^WORKER_RUN_TOKEN=' .env | cut -d= -f2- || true)"

if [ -z "$WORKER_TOKEN" ]; then
  echo "Missing bootstrap token for Core worker lifecycle smoke in $APP_DIR/.env." >&2
  exit 1
fi

resolve_arg="${SITE_HOST}:443:${RESOLVE_IP}"
core_url="https://${SITE_HOST}${CORE_PATH}"
curl_args=(
  --connect-timeout "$CURL_CONNECT_TIMEOUT"
  --max-time "$CURL_MAX_TIME"
  --retry "$CURL_RETRIES"
  --retry-delay "$CURL_RETRY_DELAY"
  --retry-connrefused
)

core_post() {
  payload="$1"

  curl -fsS "${curl_args[@]}" --resolve "$resolve_arg" \
    -X POST "$core_url" \
    -H "authorization: Bearer $WORKER_TOKEN" \
    -H "content-type: application/json" \
    -d "$payload"
}

UPSERT_PAYLOAD="$(
  /usr/bin/jq -nc \
    --arg key "deploy-core-worker-upsert-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" '{
      command: "worker.upsert",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        kind: "synthetic",
        state: "training",
        name: "Systems Readiness Worker",
        role: "systems_operations",
        mission: "Keep the platform boring in production and suspicious of shortcuts.",
        autonomyLevel: 2,
        scope: {
          domains: ["platform"],
          actions: ["observe", "prepare", "report"]
        },
        policy: {
          requiresApprovalFor: ["external_action", "spend", "credential_change"]
        },
        kpis: {
          checks: "green",
          surprises: "zero"
        },
        lifecycle: {
          source: "deploy_core_worker_lifecycle_smoke",
          cadence: "deploy"
        },
        evidence: {
          source: "deploy_core_worker_lifecycle_smoke",
          note: "Verifies generic /core worker lifecycle command shape."
        }
      }
    }'
)"
UPSERT_RESPONSE="$(core_post "$UPSERT_PAYLOAD")"
echo "$UPSERT_RESPONSE" | /usr/bin/jq -c '{api,error,command:.data.command,result:{created:.data.result.created,workerId:.data.result.workerId,state:.data.result.worker.state,objectId:.data.result.objectId,eventId:.data.result.eventId,evidenceId:.data.result.evidenceId,auditEventId:.data.result.auditEventId}}'
echo "$UPSERT_RESPONSE" | /usr/bin/jq -e \
  --arg tenant "$TENANT_SLUG" \
  '.error == null and .data.command == "worker.upsert" and .data.core.tenantSlug == $tenant and .data.result.created == true and .data.result.worker.state == "training" and (.data.result.workerId | length > 0) and (.data.result.objectId | length > 0) and (.data.result.eventId | length > 0) and (.data.result.evidenceId | length > 0) and (.data.result.auditEventId | length > 0)' \
  >/dev/null

WORKER_ID="$(echo "$UPSERT_RESPONSE" | /usr/bin/jq -r '.data.result.workerId')"

TRANSITION_PAYLOAD="$(
  /usr/bin/jq -nc \
    --arg key "deploy-core-worker-transition-$RUN_ID" \
    --arg tenant "$TENANT_SLUG" \
    --arg workerId "$WORKER_ID" '{
      command: "worker.transition",
      core: {tenantSlug: $tenant},
      idempotencyKey: $key,
      config: {
        workerId: $workerId,
        toState: "active",
        reason: "Production smoke verified the Core worker lifecycle command path.",
        lifecycle: {
          source: "deploy_core_worker_lifecycle_smoke",
          cadence: "deploy"
        },
        evidence: {
          source: "deploy_core_worker_lifecycle_smoke",
          note: "Transitioned through /core worker.transition."
        }
      }
    }'
)"
TRANSITION_RESPONSE="$(core_post "$TRANSITION_PAYLOAD")"
echo "$TRANSITION_RESPONSE" | /usr/bin/jq -c '{api,error,command:.data.command,result:{transitioned:.data.result.transitioned,workerId:.data.result.workerId,state:.data.result.worker.state,objectId:.data.result.objectId,eventId:.data.result.eventId,evidenceId:.data.result.evidenceId,auditEventId:.data.result.auditEventId}}'
echo "$TRANSITION_RESPONSE" | /usr/bin/jq -e \
  --arg tenant "$TENANT_SLUG" \
  --arg workerId "$WORKER_ID" \
  '.error == null and .data.command == "worker.transition" and .data.core.tenantSlug == $tenant and .data.result.transitioned == true and .data.result.workerId == $workerId and .data.result.worker.state == "active" and (.data.result.objectId | length > 0) and (.data.result.eventId | length > 0) and (.data.result.evidenceId | length > 0) and (.data.result.auditEventId | length > 0)' \
  >/dev/null

printf 'core_worker_lifecycle_smoke_status=ok\n'
printf 'core_path=%s\n' "$CORE_PATH"
printf 'worker_id=%s\n' "$WORKER_ID"
