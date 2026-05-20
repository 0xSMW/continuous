# App-Server Worker Tools

Continuous exposes repo-owned app-server dynamic tool specs for worker
discovery and registry-backed command execution:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.worker.schema` | Read-only | Returns the registered Revenue, Owner, and Dispatch runtime commands, planned future-worker metadata, worker tool schema, and integration boundary |
| `continuous.worker.command` | Registry-backed command | Invokes an existing worker command with the same `command`, `worker`, `idempotencyKey`, and `config` envelope used by `/worker` |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`. The local manifest in
`src/worker/app-server-tools.ts` follows that shape and delegates commands to
the shared worker command registry.
`continuous.worker.schema` exposes each registered command's `configSchema`;
planned future-worker commands also expose a non-executable `configSchema` so
agents can inspect payload requirements before handlers exist.
`continuous.worker.command`, `/worker`, and `worker:tool` all run through that
same registry validation before dispatch.
The CI integration suite exercises `continuous.worker.command` on real
Revenue `lead.read` and `run` commands, proving the app-server boundary writes
the same worker run, approval, evidence, budget, and event records as `/worker`.
Dispatch `customer_update.draft` and `closeout.prepare` are also
schema-discoverable through the same registry-backed command list and keep
customer-send, QA, and Finance handoff data under `config`.

```sh
bun run app-server:worker-tools
bun run app-server:worker-tools continuous.worker.schema
```

```sh
bun run app-server:worker-tools continuous.worker.command --payload='{"command":"lead.read","operatorEmail":"owner@continuoushq.com","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-app-server-lead-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

Inbox and CRM lead intake use the same command surface with source-reader
metadata inside `config.reader`; the tool forwards that payload through the
registry without loading production tokens or executing external reads.

## Boundary

The app-server command tool is intentionally narrow:

- Commands are resolved by the same registry as `/worker` and `worker:tool`.
- Mutation envelopes are strict. Top-level fields are limited to `command`,
  `worker`, `operatorEmail`, `idempotencyKey`, and `config` for
  `continuous.worker.command`; top-level operation inputs such as `approvalId`,
  source records, retry limits, or lead payloads are rejected and must live
  under `config`.
- Worker-specific options stay inside `config` and are validated by the
  command registry's `configSchema`.
- Planned worker roles expose config schemas but remain non-executable until
  handlers are registered; promoted roles move into the registered command list.
- Caller supplies `operatorEmail`, `worker`, `idempotencyKey`, and `config`.
- No external execution is available.
- No production token is loaded.

The legacy local worker tool remains available for explicit operator-gated
commands:

```sh
bun run worker:tool worker.lead.read --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

```sh
bun run worker:tool worker.run --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-run-001","config":{"intake":{"source":"website_form","sourceEventId":"form-001"}}}'
```

```sh
bun run worker:tool worker.owner.brief.generate --payload='{"worker":{"role":"owner_chief_of_staff","tenantSlug":"continuous-demo"},"idempotencyKey":"local-owner-brief-001","config":{"window":{"from":"2026-05-19T00:00:00.000Z","to":"2026-05-20T00:00:00.000Z"},"scopes":["tasks","approvals","cash","capacity","obligations","workers"],"includeEvidence":true}}'
```

```http
POST /worker
```

Those mutation surfaces keep the same scalable payload shape:
`command`, `worker`, `idempotencyKey`, and `config`.
The local `worker:tool` command uses the tool name as the command selector and
keeps the same strict `worker`, `idempotencyKey`, `config`, and optional
`operatorEmail` envelope.
