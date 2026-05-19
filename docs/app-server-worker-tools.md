# App-Server Worker Tools

Continuous exposes one repo-owned app-server dynamic tool spec for worker
discovery:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.worker.schema` | Read-only | Returns the registered worker command registry, worker tool schema, and integration boundary |

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

Side-effecting worker commands stay on the canonical operator-gated surfaces:

```sh
bun run worker:tool worker.run --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-run-001","config":{"intake":{"objectId":"lead_object_uuid","eventId":"lead_event_uuid","evidenceId":"lead_evidence_uuid"}}}'
```

```http
POST /worker
```

Those mutation surfaces keep the same scalable payload shape:
`command`, `worker`, `idempotencyKey`, and `config`.
