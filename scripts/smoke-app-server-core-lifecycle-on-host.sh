#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/continuous}"
SITE_HOST="${SITE_HOST:-continuoushq.com}"
TENANT_SLUG="${TENANT_SLUG:-continuous-demo}"
APP_SERVER_PATH="${APP_SERVER_PATH:-/app-server}"
RESOLVE_IP="${RESOLVE_IP:-127.0.0.1}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-5}"
CURL_MAX_TIME="${CURL_MAX_TIME:-20}"
CURL_RETRIES="${CURL_RETRIES:-2}"
CURL_RETRY_DELAY="${CURL_RETRY_DELAY:-1}"
RUN_ID="${APP_SERVER_CORE_LIFECYCLE_SMOKE_RUN_ID:-$(date -u +%Y%m%d%H%M%S)}"

cd "$APP_DIR"

if [ ! -f .env ]; then
  echo "Missing $APP_DIR/.env; deploy the stack before app-server Core lifecycle smoke checks." >&2
  exit 1
fi

POSTGRES_USER="$(grep '^POSTGRES_USER=' .env | cut -d= -f2- || true)"
POSTGRES_DB="$(grep '^POSTGRES_DB=' .env | cut -d= -f2- || true)"
WORKER_TOKEN="$(grep '^WORKER_RUN_TOKEN=' .env | cut -d= -f2- || true)"
POSTGRES_USER="${POSTGRES_USER:-continuous}"
POSTGRES_DB="${POSTGRES_DB:-continuous}"

if [ -z "$WORKER_TOKEN" ]; then
  echo "Missing bootstrap token for app-server Core lifecycle smoke in $APP_DIR/.env." >&2
  exit 1
fi

resolve_arg="${SITE_HOST}:443:${RESOLVE_IP}"
app_server_url="https://${SITE_HOST}${APP_SERVER_PATH}"
curl_args=(
  --connect-timeout "$CURL_CONNECT_TIMEOUT"
  --max-time "$CURL_MAX_TIME"
  --retry "$CURL_RETRIES"
  --retry-delay "$CURL_RETRY_DELAY"
  --retry-connrefused
)

psql_db() {
  docker compose exec -T db psql -At -v ON_ERROR_STOP=1 \
    -U "$POSTGRES_USER" \
    -d "$POSTGRES_DB" \
    "$@" \
    </dev/null
}

app_server_post() {
  payload="$1"

  curl -fsS "${curl_args[@]}" --resolve "$resolve_arg" \
    -X POST "$app_server_url" \
    -H "authorization: Bearer $WORKER_TOKEN" \
    -H "content-type: application/json" \
    -d "$payload"
}

seeded_systems_context="$(
  psql_db -c "
    select w.id || '|' || ba.id || '|' || c.key || '|' || w.state
    from workers w
    join budget_accounts ba
      on ba.tenant_id = w.tenant_id
     and ba.target = 'worker'
     and ba.target_id = w.id
     and ba.active = true
    join capability_grants cg
      on cg.tenant_id = w.tenant_id
     and cg.actor_type = 'worker'
     and cg.actor_id = w.id
     and cg.active = true
    join capabilities c
      on c.id = cg.capability_id
     and c.active = true
     and c.key = 'permission.review'
    where w.role = 'systems_operations'
      and w.state in ('training', 'active', 'paused')
    order by w.created_at
    limit 1;
  "
)"

if [ -z "$seeded_systems_context" ]; then
  echo "Missing seeded systems_operations worker with permission.review grant and active budget." >&2
  exit 1
fi

IFS='|' read -r SYSTEMS_WORKER_ID SYSTEMS_BUDGET_ACCOUNT_ID SYSTEMS_CAPABILITY_KEY SYSTEMS_WORKER_STATE <<<"$seeded_systems_context"

UPSERT_KEY="deploy-app-server-core-worker-upsert-$RUN_ID"
UPSERT_PAYLOAD="$(
  /usr/bin/jq -nc \
    --arg key "$UPSERT_KEY" \
    --arg tenant "$TENANT_SLUG" \
    --arg workerId "$SYSTEMS_WORKER_ID" '{
      tool: "continuous.core.command",
      arguments: {
        command: "worker.upsert",
        core: {tenantSlug: $tenant},
        idempotencyKey: $key,
        config: {
          workerId: $workerId,
          role: "systems_operations",
          lifecycle: {
            source: "deploy_app_server_core_lifecycle_smoke",
            cadence: "deploy"
          },
          evidence: {
            source: "deploy_app_server_core_lifecycle_smoke",
            note: "Verifies continuous.core.command worker.upsert through POST /app-server."
          }
        }
      },
      callId: $key,
      threadId: "deploy-smoke",
      turnId: "deploy-smoke"
    }'
)"
UPSERT_RESPONSE="$(app_server_post "$UPSERT_PAYLOAD")"
echo "$UPSERT_RESPONSE" | /usr/bin/jq -c '{api,error,success:.data.success,contentItemCount:(.data.contentItems | length)}'
echo "$UPSERT_RESPONSE" | /usr/bin/jq -e \
  --arg tenant "$TENANT_SLUG" \
  --arg workerId "$SYSTEMS_WORKER_ID" '
    .api == "continuous.app_server.v1" and
    .error == null and
    .data.success == true and
    (.data.contentItems[0].text | fromjson |
      .ok == true and
      .tool == "continuous.core.command" and
      .data.command == "worker.upsert" and
      .data.core.tenantSlug == $tenant and
      .data.result.workerId == $workerId and
      .data.result.worker.role == "systems_operations" and
      (.data.result.worker.state == "training" or .data.result.worker.state == "active" or .data.result.worker.state == "paused")
    )
  ' >/dev/null

SMOKE_WORKER_ID="$(echo "$UPSERT_RESPONSE" | /usr/bin/jq -r '.data.contentItems[0].text | fromjson | .data.result.workerId')"
if [ "$SMOKE_WORKER_ID" != "$SYSTEMS_WORKER_ID" ]; then
  echo "App-server Core worker upsert targeted unexpected worker: $SMOKE_WORKER_ID" >&2
  exit 1
fi

if [ "$SYSTEMS_WORKER_STATE" = "active" ]; then
  TARGET_WORKER_STATE="paused"
else
  TARGET_WORKER_STATE="active"
fi

TRANSITION_KEY="deploy-app-server-core-worker-transition-$RUN_ID"
TRANSITION_PAYLOAD="$(
  /usr/bin/jq -nc \
    --arg key "$TRANSITION_KEY" \
    --arg tenant "$TENANT_SLUG" \
    --arg workerId "$SMOKE_WORKER_ID" \
    --arg toState "$TARGET_WORKER_STATE" '{
      tool: "continuous.core.command",
      arguments: {
        command: "worker.transition",
        core: {tenantSlug: $tenant},
        idempotencyKey: $key,
        config: {
          workerId: $workerId,
          role: "systems_operations",
          toState: $toState,
          reason: "App-server Core lifecycle smoke verified a scoped worker state transition.",
          lifecycle: {
            source: "deploy_app_server_core_lifecycle_smoke",
            cadence: "deploy"
          },
          evidence: {
            source: "deploy_app_server_core_lifecycle_smoke",
            note: "Verifies worker.transition stays worker-role scoped through POST /app-server."
          }
        }
      },
      callId: $key,
      threadId: "deploy-smoke",
      turnId: "deploy-smoke"
    }'
)"
TRANSITION_RESPONSE="$(app_server_post "$TRANSITION_PAYLOAD")"
echo "$TRANSITION_RESPONSE" | /usr/bin/jq -c '{api,error,success:.data.success,contentItemCount:(.data.contentItems | length)}'
echo "$TRANSITION_RESPONSE" | /usr/bin/jq -e \
  --arg tenant "$TENANT_SLUG" \
  --arg workerId "$SMOKE_WORKER_ID" \
  --arg toState "$TARGET_WORKER_STATE" '
    .api == "continuous.app_server.v1" and
    .error == null and
    .data.success == true and
    (.data.contentItems[0].text | fromjson |
      .ok == true and
      .tool == "continuous.core.command" and
      .data.command == "worker.transition" and
      .data.core.tenantSlug == $tenant and
      .data.result.transitioned == true and
      .data.result.workerId == $workerId and
      .data.result.worker.role == "systems_operations" and
      .data.result.worker.state == $toState
    )
  ' >/dev/null

if [ "$TARGET_WORKER_STATE" = "paused" ]; then
  RESTORE_KEY="deploy-app-server-core-worker-restore-$RUN_ID"
  RESTORE_PAYLOAD="$(
    /usr/bin/jq -nc \
      --arg key "$RESTORE_KEY" \
      --arg tenant "$TENANT_SLUG" \
      --arg workerId "$SMOKE_WORKER_ID" '{
        tool: "continuous.core.command",
        arguments: {
          command: "worker.transition",
          core: {tenantSlug: $tenant},
          idempotencyKey: $key,
          config: {
            workerId: $workerId,
            role: "systems_operations",
            toState: "active",
            reason: "App-server Core lifecycle smoke restored the worker after transition proof.",
            lifecycle: {
              source: "deploy_app_server_core_lifecycle_smoke",
              cadence: "deploy"
            },
            evidence: {
              source: "deploy_app_server_core_lifecycle_smoke",
              note: "Restores the seeded worker before worker.run.start."
            }
          }
        },
        callId: $key,
        threadId: "deploy-smoke",
        turnId: "deploy-smoke"
      }'
  )"
  RESTORE_RESPONSE="$(app_server_post "$RESTORE_PAYLOAD")"
  echo "$RESTORE_RESPONSE" | /usr/bin/jq -c '{api,error,success:.data.success,contentItemCount:(.data.contentItems | length)}'
  echo "$RESTORE_RESPONSE" | /usr/bin/jq -e \
    --arg tenant "$TENANT_SLUG" \
    --arg workerId "$SMOKE_WORKER_ID" '
      .api == "continuous.app_server.v1" and
      .error == null and
      .data.success == true and
      (.data.contentItems[0].text | fromjson |
        .ok == true and
        .tool == "continuous.core.command" and
        .data.command == "worker.transition" and
        .data.core.tenantSlug == $tenant and
        .data.result.workerId == $workerId and
        .data.result.worker.role == "systems_operations" and
        .data.result.worker.state == "active"
      )
    ' >/dev/null
fi

RUN_START_KEY="deploy-app-server-core-worker-run-start-$RUN_ID"
RUN_START_PAYLOAD="$(
  /usr/bin/jq -nc \
    --arg key "$RUN_START_KEY" \
    --arg tenant "$TENANT_SLUG" \
    --arg workerId "$SYSTEMS_WORKER_ID" \
    --arg budgetAccountId "$SYSTEMS_BUDGET_ACCOUNT_ID" \
    --arg capabilityKey "$SYSTEMS_CAPABILITY_KEY" '{
      tool: "continuous.core.command",
      arguments: {
        command: "worker.run.start",
        core: {tenantSlug: $tenant},
        idempotencyKey: $key,
        config: {
          worker: {
            id: $workerId,
            role: "systems_operations"
          },
          command: "permission.review",
          mode: "deploy_smoke",
          capabilityKey: $capabilityKey,
          budgetAccountId: $budgetAccountId,
          units: 10,
          input: {
            source: "deploy_app_server_core_lifecycle_smoke",
            check: "app-server Core worker-run lifecycle"
          },
          policy: {
            externalExecution: "blocked"
          },
          evidence: {
            source: "deploy_app_server_core_lifecycle_smoke"
          }
        }
      },
      callId: $key,
      threadId: "deploy-smoke",
      turnId: "deploy-smoke"
    }'
)"
RUN_START_RESPONSE="$(app_server_post "$RUN_START_PAYLOAD")"
echo "$RUN_START_RESPONSE" | /usr/bin/jq -c '{api,error,success:.data.success,contentItemCount:(.data.contentItems | length)}'
echo "$RUN_START_RESPONSE" | /usr/bin/jq -e \
  --arg tenant "$TENANT_SLUG" \
  --arg workerId "$SYSTEMS_WORKER_ID" \
  --arg capabilityKey "$SYSTEMS_CAPABILITY_KEY" '
    .api == "continuous.app_server.v1" and
    .error == null and
    .data.success == true and
    (.data.contentItems[0].text | fromjson |
      .ok == true and
      .tool == "continuous.core.command" and
      .data.command == "worker.run.start" and
      .data.core.tenantSlug == $tenant and
      .data.result.started == true and
      .data.result.run.worker.id == $workerId and
      .data.result.run.worker.role == "systems_operations" and
      .data.result.capability.capabilityKey == $capabilityKey and
      (.data.result.workerRunId | length > 0) and
      (.data.result.budget.reservationId | length > 0)
    )
  ' >/dev/null

WORKER_RUN_ID="$(echo "$RUN_START_RESPONSE" | /usr/bin/jq -r '.data.contentItems[0].text | fromjson | .data.result.workerRunId')"

RUN_COMPLETE_KEY="deploy-app-server-core-worker-run-complete-$RUN_ID"
RUN_COMPLETE_PAYLOAD="$(
  /usr/bin/jq -nc \
    --arg key "$RUN_COMPLETE_KEY" \
    --arg tenant "$TENANT_SLUG" \
    --arg workerId "$SYSTEMS_WORKER_ID" \
    --arg workerRunId "$WORKER_RUN_ID" '{
      tool: "continuous.core.command",
      arguments: {
        command: "worker.run.complete",
        core: {tenantSlug: $tenant},
        idempotencyKey: $key,
        config: {
          worker: {
            id: $workerId,
            role: "systems_operations"
          },
          workerRunId: $workerRunId,
          state: "done",
          reason: "App-server Core lifecycle smoke completed without external execution.",
          costUsd: 0,
          output: {
            source: "deploy_app_server_core_lifecycle_smoke",
            result: "ok",
            externalExecution: "blocked"
          },
          evidence: {
            source: "deploy_app_server_core_lifecycle_smoke"
          }
        }
      },
      callId: $key,
      threadId: "deploy-smoke",
      turnId: "deploy-smoke"
    }'
)"
RUN_COMPLETE_RESPONSE="$(app_server_post "$RUN_COMPLETE_PAYLOAD")"
echo "$RUN_COMPLETE_RESPONSE" | /usr/bin/jq -c '{api,error,success:.data.success,contentItemCount:(.data.contentItems | length)}'
echo "$RUN_COMPLETE_RESPONSE" | /usr/bin/jq -e \
  --arg tenant "$TENANT_SLUG" \
  --arg workerId "$SYSTEMS_WORKER_ID" \
  --arg workerRunId "$WORKER_RUN_ID" '
    .api == "continuous.app_server.v1" and
    .error == null and
    .data.success == true and
    (.data.contentItems[0].text | fromjson |
      .ok == true and
      .tool == "continuous.core.command" and
      .data.command == "worker.run.complete" and
      .data.core.tenantSlug == $tenant and
      .data.result.completed == true and
      .data.result.workerRunId == $workerRunId and
      .data.result.run.worker.id == $workerId and
      .data.result.run.worker.role == "systems_operations" and
      .data.result.run.state == "done" and
      .data.result.budget.state == "used"
    )
  ' >/dev/null

printf 'app_server_core_lifecycle_smoke_status=ok\n'
printf 'app_server_path=%s\n' "$APP_SERVER_PATH"
printf 'worker_id=%s\n' "$SMOKE_WORKER_ID"
printf 'worker_run_id=%s\n' "$WORKER_RUN_ID"
