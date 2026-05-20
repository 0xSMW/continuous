# Agent Build Path

The installed Codex app-server CLI exposes protocol tooling, not a repo-owned
daemon command. Continuous now defines repo-owned app-server worker tools:
`continuous.worker.schema` for registry discovery and
`continuous.worker.command` for registry-backed command execution. Use the
Next.js 16 MCP bridge for route/runtime visibility.

```sh
bun run app-server:help
bun run app-server:worker-tools
bun run app-server:generate-ts
bun run app-server:generate-json-schema
```

Generated app-server protocol files are written under `generated/app-server/`
and ignored by git. They are protocol references. The committed worker tool
manifest lives in `src/worker/app-server-tools.ts`; details are in
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
| `/` | Runtime dashboard with public core state and redacted worker readiness |
| `/api/health` | Machine health check |
| `/core` | Operator-gated persisted primitive summary |
| `POST /core` | Canonical Core command surface with `command`, `core`, `config`, and `idempotencyKey` payload fields for tasks, task transitions, approvals, capability grants, budget ledger operations, objects, object links, events, evidence, documents, packets, decisions, generated views, adapter intents, rule changes, customer signals, and payroll preview artifacts |
| `/approval?view=inbox` | Shared operator-gated approval inbox across Core, workflow, and worker subjects |
| `POST /approval` | Shared approval decision surface with `command`, `approval`, and `config` payload fields |
| `/worker?view=snapshot&role=revenue_operations` | Canonical operator-gated worker snapshot |
| `/worker?view=approvals&role=revenue_operations` | Canonical operator-gated worker approval queue |
| `POST /worker` | Canonical command surface with `command`, `worker`, `config`, and `idempotencyKey` payload fields |
| `/workflow?view=approvals` | Canonical operator-gated workflow approval queue |
| `POST /workflow` | Canonical workflow command surface for starts, transitions, queued step execution, and workflow approval decisions |
| `bun run worker:tool` | Repo-owned JSON worker toolbox for agents and local automation |
| `bun run app-server:worker-tools continuous.worker.command` | App-server command surface backed by the same worker registry |

`bun run worker:tool schema` exposes the registered worker commands and local
tool aliases. Agents should inspect that registry metadata before invoking a
worker command, then send the same `worker`, `config`, and `idempotencyKey`
payload shape through either the toolbox or `/worker`.

## Boundary

Use the Next.js MCP bridge for Next.js diagnostics. Keep side-effecting worker
execution on explicit operator commands, guarded `POST` routes, or the
registry-backed app-server worker command. The Revenue Worker now records the
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
bun run worker:tool worker.lead.read <<'JSON'
{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}
JSON

bun run worker:tool worker.run <<'JSON'
{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-revenue-run-001","config":{"intake":{"source":"website_form","sourceEventId":"form-001"}}}
JSON
```

When the HTTP snapshot, approval, or run path is required, start the app with
`WORKER_RUN_TOKEN` and include that bearer token on operator routes.
`WORKER_OPERATOR_EMAIL` must match an active seeded user, defaulting to
`owner@continuoushq.com`. Production also sets
`CONTROL_PLANE_ALLOWED_TENANTS` and `CONTROL_PLANE_ALLOWED_WORKER_ROLES`, so
operator routes must carry an allowed `tenantSlug` and `/worker` calls must
carry an allowed `worker.role`. Keep worker-specific config in the JSON payload:

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-revenue-run-001",
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
`event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`,
`document.packet.prepare`, `decision.record`, `approval.request`,
`adapter.intent.record`, `rule.change.record`, `capability.grant`,
`budget.reserve`, `budget.charge`, `budget.release`, `view.publish`,
`customer_signal.record`, `payroll.preview.record`, and
`payroll.preview.packet.prepare`.

Use the same route for operational worker commands:

```json
{
  "command": "adapters.reconcile",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
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
  "config": {
    "limit": 25
  }
}
```

The worker toolbox uses the same payload shape:

```sh
bun run worker:tool schema

bun run worker:tool worker.snapshot <<'JSON'
{"worker":{"role":"revenue_operations"}}
JSON

bun run worker:tool worker.adapters.reconcile <<'JSON'
{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{"limit":25}}
JSON

bun run worker:tool worker.adapters.retry <<'JSON'
{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{"limit":25}}
JSON
```
