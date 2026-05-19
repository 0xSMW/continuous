# Agent Build Path

The local Codex app-server daemon is bootstrapped and running through the
managed Codex install at `~/.codex/app-server-control/app-server-control.sock`.
This repo does not yet define app-server-owned worker tools. Use the Next.js 16
MCP bridge for route/runtime visibility, and add direct app-server tools only
when worker control surfaces need repo-owned app-server methods.

```sh
bun run app-server:version
```

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
| `/api/revenue-worker` | Operator-gated Revenue Worker snapshot |
| `bun run worker:revenue` | Operator CLI run path |

## Boundary

Use the Next.js MCP bridge for Next.js diagnostics. Keep side-effecting worker
execution on explicit operator commands or guarded `POST` routes until real
operator identity, permissions, and audit controls ship.

## Build Loop

```sh
bun run check
bun run dev
```

For worker runtime changes, prefer the CLI path first because it does not expose
HTTP mutation:

```sh
bun run worker:revenue -- --idempotency-key=local-revenue-run-001
```

When the HTTP snapshot or run path is required, start the app with
`REVENUE_WORKER_RUN_TOKEN` and include that bearer token on both
`GET /api/revenue-worker` and `POST /api/revenue-worker/run`.
