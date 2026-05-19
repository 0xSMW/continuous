# Agent Build Path

The installed Codex app-server CLI exposes protocol tooling, not a repo-owned
daemon command. This repo does not yet define app-server-owned worker tools.
Use the Next.js 16 MCP bridge for route/runtime visibility, and add direct
app-server tools only when worker control surfaces need repo-owned methods.

```sh
bun run app-server:help
bun run app-server:generate-ts
bun run app-server:generate-json-schema
```

Generated app-server protocol files are written under `generated/app-server/`
and ignored by git. They are protocol references, not worker tools.

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
| `/api/core` | Operator-gated persisted primitive summary |
| `POST /api/core` | Canonical Core command surface with `command`, `core`, `config`, and `idempotencyKey` payload fields for tasks, objects, events, evidence, documents, and decisions |
| `/worker?view=snapshot` | Canonical operator-gated worker snapshot |
| `/worker?view=approvals` | Canonical operator-gated worker approval queue |
| `POST /worker` | Canonical command surface with `command`, `worker`, `config`, and `idempotencyKey` payload fields |
| `/workflow?view=approvals` | Canonical operator-gated workflow approval queue |
| `POST /workflow` | Canonical workflow command surface for starts, transitions, and workflow approval decisions |
| `bun run worker:tool` | Repo-owned JSON worker toolbox for agents and local automation |

## Boundary

Use the Next.js MCP bridge for Next.js diagnostics. Keep side-effecting worker
execution on explicit operator commands or guarded `POST` routes. The Revenue
Worker now records the configured operator, active capability grant, approval
request, audit event, and evidence before any external action can be approved.
The shared approval service decides worker and workflow approvals by subject so
new worker families do not need their own approval route or table.

## Build Loop

```sh
bun run check
bun run dev
```

For worker runtime changes, prefer the CLI path first because it does not expose
HTTP mutation:

```sh
bun run worker:tool worker.run <<'JSON'
{"worker":{"role":"revenue_operations"},"idempotencyKey":"local-revenue-run-001","config":{"leadPacket":{"source":"website_form","sourceEventId":"local-form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high","missingFacts":["preferred_time_window"]}}}
JSON
```

When the HTTP snapshot, approval, or run path is required, start the app with
`WORKER_RUN_TOKEN` and include that bearer token on operator routes.
`WORKER_OPERATOR_EMAIL` must match an active seeded user, defaulting to
`owner@continuoushq.com`. Keep worker-specific config in the JSON payload:

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "local-revenue-run-001",
  "config": {
    "leadPacket": {
      "source": "website_form",
      "sourceEventId": "local-form-001",
      "customerName": "Acme Roof Repair",
      "customerIntent": "roof leak inspection",
      "serviceArea": "roofing",
      "urgency": "high",
      "missingFacts": ["preferred_time_window"]
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

Other supported Core commands are `event.ingest`, `evidence.attach`,
`document.create`, and `decision.record`.

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

The worker toolbox uses the same payload shape:

```sh
bun run worker:tool schema

bun run worker:tool worker.snapshot <<'JSON'
{"worker":{"role":"revenue_operations"},"config":{}}
JSON

bun run worker:tool worker.adapters.reconcile <<'JSON'
{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{"limit":25}}
JSON
```
