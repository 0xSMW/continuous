# Agent Build Path

The installed Codex app-server CLI can run over stdio or WebSocket and can
generate protocol bindings. Continuous defines repo-owned app-server Core and
worker tools: `continuous.core.schema` and `continuous.worker.schema` for
registry discovery, plus `continuous.core.view` / `continuous.core.command` and
`continuous.worker.view` / `continuous.worker.command` for registry-backed read
and command execution. The local executor also accepts Codex dynamic tool-call
payloads with `tool`, `arguments`, `callId`, `threadId`, and `turnId`. Use the
Next.js 16 MCP bridge for route/runtime visibility.

```sh
bun run app-server:help
bun run app-server:tools
bun run app-server:generate-ts
bun run app-server:generate-json-schema
```

Generated app-server protocol files are written under `generated/app-server/`
and ignored by git. They are protocol references. The committed Core and worker
tool manifests live in `src/core/app-server-tools.ts` and
`src/worker/app-server-tools.ts`; details are in
`docs/app-server-worker-tools.md`.

## Next.js MCP

The repo includes `.mcp.json` with `next-devtools-mcp` launched through `bunx`.
When `bun run dev` is running, compatible coding agents can connect to the
Next.js MCP endpoint and inspect routes, build/runtime errors, page metadata,
logs, and app structure.

```sh
bun run dev
```

Useful app surfaces for worker development:

| Surface | Purpose |
|---|---|
| `/` | Static public landing page; operational dashboard data stays behind authenticated control-plane routes |
| `/health` | Redacted machine health check |
| `/core` | Operator-gated, tenant-scoped persisted primitive summary |
| `POST /core` | Canonical Core command surface with `command`, `core`, `config`, and `idempotencyKey` payload fields for tasks, task transitions, workers, entity setup, approvals, capability grants, budget ledger operations, objects, object links, events, evidence, documents, packets, decisions, generated views, adapter intents, rule changes, customer signals, and payroll preview artifacts |
| `/approval?view=inbox` | Shared operator-gated approval inbox across Core, workflow, and worker subjects |
| `POST /approval` | Shared approval decision surface with `command`, top-level `idempotencyKey`, explicit `approval.subject`, and `config` payload fields |
| `POST /worker` with `view`, `worker`, and `config` | Canonical operator-gated worker read surface |
| `POST /worker` with `command`, `worker`, `config`, and `idempotencyKey` | Canonical worker command surface |
| `POST /app-server` with `tool`, `arguments`, `callId`, `threadId`, and `turnId` | Authenticated generic dynamic-tool bridge; Core and worker command/view payloads stay under `arguments` and route through the Core or worker registry |
| `/workflow?view=approvals` | Canonical operator-gated workflow approval queue |
| `POST /workflow` | Canonical workflow command surface for starts, transitions, queued step execution, and workflow approval decisions |
| `bun run worker:tool` | Repo-owned JSON worker toolbox for agents and local automation |
| `bun run app-server:tools continuous.core.schema` | App-server Core discovery surface for registered Core commands and views |
| `bun run app-server:tools continuous.core.view` | App-server Core read surface backed by the same Core view registry |
| `bun run app-server:tools continuous.core.command` | App-server Core command surface backed by registered Core command handlers |
| `bun run app-server:tools continuous.worker.view` | App-server read surface backed by the same worker view registry |
| `bun run app-server:tools continuous.worker.command` | App-server command surface backed by the same worker command registry |
| `bun run app-server:tools dynamic-call` | Codex dynamic tool-call adapter for the same app-server Core and worker tools |

`bun run worker:tool schema` exposes the registered worker commands and local
generic tool surfaces. Agents should inspect that registry metadata before
invoking a worker command, then send the same `command`, `worker`, `config`,
and `idempotencyKey` payload shape through either the toolbox or `/worker`.

## Boundary

Use the Next.js MCP bridge for Next.js diagnostics. Keep side-effecting Core and
worker execution on explicit operator commands, guarded `POST` routes, or the
registry-backed app-server command tools. Worker reads through app-server stay
on the same `view`, `worker`, and `config` envelope as `worker.view`; Core
reads stay on the same `view`, `core`, and `config` envelope as `POST /core`.
The dynamic-call adapter returns Codex-compatible `contentItems` and never
accepts operator identity in the tool arguments; authenticated bridges pass
operator identity, access, route-qualified command or view, tenant, and
worker-role scope when needed through transport context after control-plane
auth. `POST /app-server` accepts only dynamic tool-call fields at the top
level, so operation-specific Core and worker inputs stay inside
`arguments.config`. The
Revenue Worker now records the
configured operator, active capability grant, approval request, audit event, and
evidence before any external action can be approved. The shared approval service
decides worker and workflow approvals by subject so new worker families do not
need their own approval route or table.

## Build Loop

```sh
bun run check
bun run dev
```

For worker runtime changes, prefer the CLI path first because it does not expose
HTTP mutation. Read the lead source records into Core first, then run the worker
from the returned source selector:

```sh
export WORKER_OPERATOR_EMAIL=owner@continuoushq.com
bun run worker:tool worker.command <<'JSON'
{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}
JSON

bun run worker:tool worker.command <<'JSON'
{"command":"run","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-worker-run-001","config":{"intake":{"source":"website_form","sourceEventId":"form-001"}}}
JSON
```

When the HTTP snapshot, approval, or run path is required, use a route-scoped
token from `CONTROL_PLANE_TOKENS_JSON` or `CONTROL_PLANE_TOKEN_CATALOG_B64`.
Keep `WORKER_RUN_TOKEN` only as a bootstrap secret for first deploys and host
recovery.
Worker tool payloads must not carry operator identity. Remote app-server
bridges pass the authenticated transport context instead: operator identity,
access mode, route-qualified command or view, tenant scope, and worker-role
scope. Production also sets `CONTROL_PLANE_ALLOWED_TENANTS` and
`CONTROL_PLANE_ALLOWED_WORKER_ROLES`, so operator routes must carry an allowed
`tenantSlug` and `/worker` calls must carry an allowed `worker.role`. Deploys
also write a hashed `CONTROL_PLANE_TOKEN_CATALOG_B64` entry so credentials can
be scoped by route, read/write mode, and command. Keep worker-specific config
in the JSON payload:

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-worker-run-001",
  "config": {
    "intake": {
      "objectId": "lead_object_uuid",
      "eventId": "lead_received_event_uuid",
      "evidenceId": "lead_snapshot_evidence_uuid"
    }
  }
}
```

Headless Core commands use the same convention:

```json
{
  "command": "task.create",
  "core": {
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-core-task-001",
  "config": {
    "title": "Review agency notice packet",
    "priority": "high"
  }
}
```

The same surface owns the persisted Core primitives used by future workers:

```json
{
  "command": "object.upsert",
  "core": {
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-core-object-001",
  "config": {
    "type": "agency_notice",
    "name": "Agency notice packet",
    "source": "operator_payload",
    "externalId": "notice-001",
    "data": {
      "agency": "Department of Cheerful Paperwork"
    }
  }
}
```

Other supported Core commands are `task.transition`, `object.link`,
`adapter.upsert`, `connection.upsert`, `connection.health.record`, `entity.setup.record`,
`worker.upsert`, `worker.transition`, `event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`, `document.packet.prepare`,
`decision.record`, `approval.request`, `adapter.intent.record`,
`rule.change.record`, `capability.grant`, `budget.reserve`, `budget.charge`,
`budget.release`, `ai.infer`, `view.publish`, `customer_signal.record`, `payroll.preview.record`, and
`payroll.preview.packet.prepare`.

Use the same route for operational worker commands:

```json
{
  "command": "adapters.reconcile",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-adapters-reconcile-001",
  "config": {
    "limit": 25
  }
}
```

Due retry execution uses the same shape and remains blocked while recording
live-credential readiness and rollback proof:

```json
{
  "command": "adapters.retry",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-adapters-retry-001",
  "config": {
    "limit": 25
  }
}
```

The worker toolbox uses the same payload shape:

```sh
export WORKER_OPERATOR_EMAIL=owner@continuoushq.com
bun run worker:tool schema

bun run worker:tool worker.view <<'JSON'
{"view":"snapshot","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}
JSON

bun run worker:tool worker.command <<'JSON'
{"command":"adapters.reconcile","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-adapters-reconcile-002","config":{"limit":25}}
JSON

bun run worker:tool worker.command <<'JSON'
{"command":"adapters.retry","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-adapters-retry-002","config":{"limit":25}}
JSON
```
