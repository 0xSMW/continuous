# App-Server Worker Tools

Continuous exposes one repo-owned app-server dynamic tool spec for worker
discovery:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.worker.schema` | Read-only | Returns the registered Revenue and Owner runtime commands, planned future-worker metadata, worker tool schema, and integration boundary |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`. The local manifest in
`src/worker/app-server-tools.ts` follows that shape without exposing mutation.

```sh
bun run app-server:worker-tools
bun run app-server:worker-tools continuous.worker.schema
```

## Boundary

The app-server tool is discovery-only:

- No database connection is opened.
- No worker command is executed.
- No external execution is available.
- No production token is required.
- Future worker metadata is discoverable but not executable until handlers are
  registered in the runtime command registry.

Side-effecting worker commands stay on the canonical operator-gated surfaces:

```sh
bun run worker:tool worker.run --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-run-001","config":{"intake":{"objectId":"lead_object_uuid","eventId":"lead_event_uuid","evidenceId":"lead_evidence_uuid"}}}'
```

```sh
bun run worker:tool worker.owner.brief.generate --payload='{"worker":{"role":"owner_chief_of_staff","tenantSlug":"continuous-demo"},"idempotencyKey":"local-owner-brief-001","config":{"window":{"from":"2026-05-19T00:00:00.000Z","to":"2026-05-20T00:00:00.000Z"},"scopes":["tasks","approvals","cash","capacity","obligations","workers"],"includeEvidence":true}}'
```

```http
POST /worker
```

Those mutation surfaces keep the same scalable payload shape:
`command`, `worker`, `idempotencyKey`, and `config`.
