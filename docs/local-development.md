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
tenant, owner, Revenue, Owner, Dispatch, and Finance worker records, customer,
lead, quote, job, invoice, payment, capabilities, task, event, evidence, budget
records, dry-run adapter records, approval request, audit event, and generated
UI contract.

## Run

```sh
bun run dev
```

Open `http://localhost:3000` and `/api/health`. `/core` and `/worker` are
operator-only control-plane routes. To test command-scoped credentials, set
`CONTROL_PLANE_TOKENS_JSON` or `CONTROL_PLANE_TOKEN_CATALOG_B64` to a
route-scoped token catalog. Use `WORKER_RUN_TOKEN` only long enough to
bootstrap or rotate the catalog on a fresh host. Prefer `tokenSha256` so docs,
shell history, and logs never carry bearer values:

```sh
read -rsp "Route-scoped operator token: " CONTROL_PLANE_OPERATOR_TOKEN
CONTROL_PLANE_TOKEN_SHA256="$(printf '%s' "$CONTROL_PLANE_OPERATOR_TOKEN" | shasum -a 256 | awk '{print $1}')"
export CONTROL_PLANE_TOKENS_JSON='[{"id":"local-operator","tokenSha256":"'"$CONTROL_PLANE_TOKEN_SHA256"'","operatorEmail":"owner@continuoushq.com","allowedTenants":["continuous-demo"],"allowedWorkerRoles":["revenue_operations"],"allowedRoutes":["core","worker","workflow","approval"],"allowedAccess":["read","write"],"allowedCommands":["core:*","worker:*","workflow:*","approval:*"]}]'
```

Core side effects use a structured command payload. For local-only testing,
start the app with `WORKER_RUN_ENABLED=true` and call:

```sh
curl -X POST http://localhost:3000/core \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
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

Core task transition, object, graph-link, event, evidence, document, packet,
decision, approval-request, capability-grant, budget-ledger, generated-view,
and customer-signal commands use the same `command` / `core` / `config` shape:

```sh
curl -X POST http://localhost:3000/core \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
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
`adapter.upsert`, `connection.upsert`, `connection.health.record`,
`event.ingest`, `evidence.attach`, `document.create`, `decision.record`, `packet.prepare`,
`document.packet.prepare`, `approval.request`, `adapter.intent.record`,
`rule.change.record`, `capability.grant`, `budget.reserve`, `budget.charge`,
`budget.release`, `ai.infer`, `view.publish`, `customer_signal.record`, `payroll.preview.record`, and
`payroll.preview.packet.prepare`. Each command writes audit proof and keeps
external execution blocked.

Use `adapter.upsert`, `connection.upsert`, and `connection.health.record` for
headless connector setup and readiness proof. A pollable connection must keep
source, provider, reader, and credential refs inside `config`; inline access
tokens and passwords are rejected.

The shared approval inbox is `/approvals` in the browser and `/approval` for
operator-gated JSON. Decisions use `POST /approval` with `command`,
`approval`, and `config` payload fields.

The repo also includes `.mcp.json` for the Next.js MCP bridge. With `bun run dev`
running, compatible coding agents can inspect routes, runtime errors, metadata,
and logs through `next-devtools-mcp`. The installed Codex app-server CLI exposes
protocol tooling and repo-owned worker controls; inspect it with
`bun run app-server:help` and `bun run app-server:worker-tools` when worker
build tooling needs it.

## Revenue Operations Worker

The seed data includes the Continuous Revenue Worker for a service-SMB
lead-to-cash slice. Detailed snapshots are operator-only and require a
route-scoped operator token from the catalog:

```sh
bun run dev
curl "http://localhost:3000/worker?view=snapshot&role=revenue_operations" \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN"
```

The run command is a guarded side-effecting `POST /worker` call and is disabled
by default. For local-only testing, start the app with:

```sh
export WORKER_RUN_ENABLED=true
bun run dev
curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
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
audit trail while keeping external send and money movement blocked. Use
`worker.command` with `command=lead.read` to persist source lead records before
`worker.command` with `command=run`;
`config.leadPacket` is only the direct fallback for controlled local tests. If
`CONTROL_PLANE_ALLOWED_TENANTS` is set, every operator route must include an
allowed `tenantSlug`; if `CONTROL_PLANE_ALLOWED_WORKER_ROLES` is set, `/worker`
calls must include an allowed `worker.role`. If `CONTROL_PLANE_TOKENS_JSON` or
`CONTROL_PLANE_TOKEN_CATALOG_B64` is set, the matching token's own route,
read/write, and command scope is enforced before dispatch.

The same persisted loop can run without exposing HTTP:

```sh
bun run worker:tool worker.command <<'JSON'
{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"form-local-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}
JSON

bun run worker:tool worker.command <<'JSON'
{"command":"run","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-revenue-run-002","config":{"intake":{"source":"website_form","sourceEventId":"form-local-001"}}}
JSON
```

Agent-facing local automation can use the repo-owned worker toolbox:

```sh
bun run worker:tool schema
bun run worker:tool worker.view --payload='{"view":"snapshot","worker":{"role":"revenue_operations"}}'
bun run worker:tool worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-002","config":{"source":"website_form","records":[{"sourceEventId":"form-local-002","customerName":"Acme Roof Repair"}]}}'
bun run worker:tool worker.command --payload='{"command":"adapters.reconcile","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-adapters-reconcile-001","config":{"limit":25}}'
bun run worker:tool worker.command --payload='{"command":"adapters.retry","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-adapters-retry-001","config":{"limit":25}}'
```

Inbox and CRM source readers use the same `lead.read` command. They store
read-only source-reader metadata and credential references; direct examples
provide records in the payload and never fetch from external systems or write
back:

```sh
bun run worker:tool worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-inbox-read-001","config":{"source":"google_workspace_inbox","reader":{"kind":"inbox","provider":"google_workspace","credentialRef":"connection:google-workspace-demo","mode":"read_only"},"records":[{"messageId":"message-local-001","from":"Buyer <buyer@example.com>","subject":"Need roof leak inspection"}]}}'
bun run worker:tool worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-crm-read-001","config":{"source":"hubspot_crm","reader":{"kind":"crm","provider":"hubspot","credentialRef":"connection:hubspot-demo","mode":"read_only"},"records":[{"externalId":"deal-local-001","companyName":"Acme Roof Repair","dealName":"Window replacement quote","stage":"qualified"}]}}'
```

Connection-backed reads can also omit `records` when the referenced active
connection has buffered records under `config.inbox`, `config.crm`, `records`,
`sourceRecords`, or `leadRecords`. If `connection.config.polling.enabled=true`,
`lead.read` performs a read-only provider poll using an environment-backed
credential reference stored on the connection, then persists the returned source
records with `sourceMode: connection_api`, cursor proof, and a redacted polling
receipt. The request payload still only references the connection:

```sh
bun run worker:tool worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-connection-read-001","config":{"source":"google_workspace_inbox","reader":{"kind":"inbox","provider":"google_workspace","credentialRef":"connection:<connection-id>","mode":"read_only"}}}'
```

`worker:tool schema` is registry-backed. It exposes registered commands, local
generic tool surfaces, idempotency policy, tenant requirements, and
external-execution status before a command is invoked.

The app-server worker tool uses the same command envelope and registry:

```sh
bun run app-server:worker-tools continuous.worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-app-server-lead-001","config":{"source":"website_form","records":[{"sourceEventId":"form-local-app-server-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

The same reconciliation command is available through the canonical worker API:

```sh
curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "adapters.reconcile",
    "worker": {"role": "revenue_operations", "tenantSlug": "continuous-demo"},
    "idempotencyKey": "local-adapters-reconcile-002",
    "config": {"limit": 25}
}'
```

Due retry execution uses the same envelope and remains blocked/dry-run while
recording live-credential readiness and rollback proof:

```sh
curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d '{
    "command": "adapters.retry",
    "worker": {"role": "revenue_operations", "tenantSlug": "continuous-demo"},
    "idempotencyKey": "local-adapters-retry-002",
    "config": {"limit": 25}
  }'
```

List and decide approvals with the same route-scoped operator token:

```sh
curl "http://localhost:3000/worker?view=approvals&role=revenue_operations" \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN"

curl -X POST http://localhost:3000/worker \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"command\": \"approval.decide\",
    \"worker\": {\"role\": \"revenue_operations\", \"tenantSlug\": \"continuous-demo\"},
    \"idempotencyKey\": \"local-approval-decision-$APPROVAL_ID\",
    \"config\": {\"approvalId\": \"$APPROVAL_ID\", \"action\": \"approved\"}
}"
```

Workflow approvals use the shared approval ledger:

```sh
curl "http://localhost:3000/workflow?view=approvals&tenantSlug=continuous-demo" \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN"

curl -X POST http://localhost:3000/workflow \
  -H "authorization: Bearer $CONTROL_PLANE_OPERATOR_TOKEN" \
  -H "content-type: application/json" \
  -d "{
    \"command\": \"approval.decide\",
    \"workflow\": {\"tenantSlug\": \"continuous-demo\"},
    \"config\": {\"approvalId\": \"$APPROVAL_ID\", \"action\": \"approved\"}
  }"
```

Worker-specific HTTP paths are intentionally absent. New worker families should
target `/worker` by registering role-scoped commands with role, command,
idempotency, and config in the request payload.

## Notes

The app is intentionally server-rendered and database-backed. If Postgres is
down, the UI still renders a degraded health state instead of hiding the
failure.
