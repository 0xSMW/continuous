# Local Development

## Requirements

- Node.js 22+
- Bun 1.3+
- Docker, when testing Postgres and Compose locally
- `doctl`, when operating DigitalOcean resources

## Commands

```sh
bun install
bun run lint
bun run typecheck
bun run test
bun run build
bun run check
```

## Database

Create a local `.env` from `.env.example`, then fill `DATABASE_URL` and
`POSTGRES_PASSWORD` with local-only values. Keep `.env` untracked.

With Docker running:

```sh
docker compose up -d db
bun run db:migrate
bun run db:seed
```

`db:seed` is idempotent and loads a bootstrap service-SMB lead-to-cash slice:
tenant, owner, Revenue Operations Worker, customer, lead, quote, job, invoice,
payment, capabilities, task, event, evidence, budget records, adapter record,
approval request, audit event, and generated UI contract.

## Run

```sh
bun run dev
```

Open `http://localhost:3000` and `/api/health`. `/api/core` is an
operator-only summary and uses the same bearer token as the canonical `/worker`
control plane.

Core side effects use a structured command payload. For local-only testing,
start the app with `WORKER_RUN_ENABLED=true` and call:

```sh
curl -X POST http://localhost:3000/api/core \
  -H "authorization: Bearer $WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "task.create",
    "core": {"tenantSlug": "continuous-demo"},
    "idempotencyKey": "local-core-task-001",
    "config": {
      "title": "Review agency notice packet",
      "priority": "high",
      "evidence": {"required": ["notice_packet"]}
    }
  }'
```

Core task transition, object, graph-link, event, evidence, document, decision,
approval-request, capability-grant, budget-ledger, and generated-view commands
use the same `command` / `core` / `config` shape:

```sh
curl -X POST http://localhost:3000/api/core \
  -H "authorization: Bearer $WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "object.upsert",
    "core": {"tenantSlug": "continuous-demo"},
    "idempotencyKey": "local-core-object-001",
    "config": {
      "type": "agency_notice",
      "name": "Agency notice packet",
      "source": "operator_payload",
      "externalId": "notice-001",
      "data": {"agency": "Department of Cheerful Paperwork"}
    }
  }'
```

The additional Core write commands are `task.transition`, `object.link`,
`event.ingest`, `evidence.attach`, `document.create`, `decision.record`,
`approval.request`, `capability.grant`, `budget.reserve`, `budget.charge`,
`budget.release`, and `view.publish`. Each command writes audit proof and keeps
external execution blocked.

The repo also includes `.mcp.json` for the Next.js MCP bridge. With `bun run dev`
running, compatible coding agents can inspect routes, runtime errors, metadata,
and logs through `next-devtools-mcp`. The installed Codex app-server CLI exposes
protocol tooling for future repo-owned worker controls; inspect it with
`bun run app-server:help` when worker build tooling needs it.

## Revenue Worker

The seed data includes the Continuous Revenue Worker for a service-SMB
lead-to-cash slice. Detailed snapshots are operator-only and require the worker
token:

```sh
read -rsp "Worker token: " WORKER_RUN_TOKEN
export WORKER_RUN_TOKEN
bun run dev
curl "http://localhost:3000/worker?view=snapshot&role=revenue_operations" \
  -H "authorization: Bearer $WORKER_RUN_TOKEN"
```

The run API is a guarded side-effecting `POST` and is disabled by default. For
local-only testing, start the app with:

```sh
read -rsp "Worker token: " WORKER_RUN_TOKEN
export WORKER_RUN_ENABLED=true
export WORKER_RUN_TOKEN
bun run dev
curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "run",
    "worker": {"role": "revenue_operations"},
    "idempotencyKey": "local-revenue-run-001",
    "config": {
      "intake": {
        "objectId": "lead_object_uuid",
        "eventId": "lead_received_event_uuid",
        "evidenceId": "lead_snapshot_evidence_uuid"
      }
    }
  }'
```

Runs are bound to `WORKER_OPERATOR_EMAIL`, which defaults to the seeded
`owner@continuoushq.com` user. A successful run records an approval request and
audit trail while keeping external send and money movement blocked. Create the
lead object/event/evidence through `/api/core` first; `config.leadPacket` is only
the direct fallback for controlled local tests.

The same persisted loop can run without exposing HTTP:

```sh
bun run worker:tool worker.run <<'JSON'
{"worker":{"role":"revenue_operations"},"idempotencyKey":"local-revenue-run-002","config":{"intake":{"objectId":"lead_object_uuid","eventId":"lead_received_event_uuid","evidenceId":"lead_snapshot_evidence_uuid"}}}
JSON
```

Agent-facing local automation can use the repo-owned worker toolbox:

```sh
bun run worker:tool schema
bun run worker:tool worker.snapshot --payload='{"worker":{"role":"revenue_operations"}}'
bun run worker:tool worker.adapters.reconcile --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{"limit":25}}'
```

The same reconciliation command is available through the canonical worker API:

```sh
curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "adapters.reconcile",
    "worker": {"role": "revenue_operations", "tenantSlug": "continuous-demo"},
    "config": {"limit": 25}
  }'
```

List and decide approvals with the same bearer token:

```sh
curl "http://localhost:3000/worker?view=approvals&role=revenue_operations" \
  -H "authorization: Bearer $WORKER_RUN_TOKEN"

curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"command\": \"approval.decide\",
    \"worker\": {\"role\": \"revenue_operations\"},
    \"config\": {\"approvalId\": \"$APPROVAL_ID\", \"action\": \"approved\"}
}"
```

Workflow approvals use the shared approval ledger:

```sh
curl "http://localhost:3000/workflow?view=approvals&tenantSlug=continuous-demo" \
  -H "authorization: Bearer $WORKER_RUN_TOKEN"

curl -X POST http://localhost:3000/workflow \
  -H "authorization: Bearer $WORKER_RUN_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"command\": \"approval.decide\",
    \"workflow\": {\"tenantSlug\": \"continuous-demo\"},
    \"config\": {\"approvalId\": \"$APPROVAL_ID\", \"action\": \"approved\"}
  }"
```

Worker-specific HTTP paths are intentionally absent. New worker families should
target `/worker` with role, command, idempotency, and config in the request
payload.

## Notes

The app is intentionally server-rendered and database-backed. If Postgres is
down, the UI still renders a degraded health state instead of hiding the
failure.
