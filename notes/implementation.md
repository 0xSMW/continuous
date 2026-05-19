# Implementation Notes

## 2026-05-19

### Decisions

| Decision | Rationale |
|---|---|
| Used Apache-2.0 | Suitable for an open source platform and includes a patent grant |
| Built a runnable Next/Postgres core service | The first blocker is platform substrate before worker layering |
| Used Drizzle and concrete Postgres tables from day one | The user chose real persistence instead of mocks |
| Chose DigitalOcean Droplet + Docker Compose | The user explicitly chose lower-level control over App Platform |
| Kept app, Postgres, and Caddy on one droplet for now | This is the fastest controlled production shape for a greenfield platform |
| Started with IP-only HTTP, then switched to domain HTTPS | `continuoushq.com` and `getcontinuous.app` now point at the droplet and serve HTTPS |
| Added a manual GitHub deploy workflow | CI should be automatic, but production deploys should be explicit while the platform is young |
| Standardized on Bun | Project instructions require Bun over npm/pnpm |
| Keep process notes under `notes/` | Repo instructions now ask for implementation and task notes in that folder |
| Restored the canonical operating-layer strategy | Revenue remains the first customer-facing worker demo, but Continuous Core must first cover entity, workforce, payroll, filings, compliance, payments, AI operations, generated UI, and evidence |
| Added open workflow documentation | Hiring, contractor engagement, termination, payroll, filings, AI budget, and synthetic-worker lifecycle now have explicit document, approval, state, and evidence requirements |
| Simplified the canonical data model | Replaced early one-table-per-concept naming with smaller primitives such as Worker.kind, WorkRelationship.type, FilingArtifact.type, EvidenceItem.type, and CustomerSignal.type |
| Revenue Worker HTTP paths are guarded | There is no auth system yet, so detailed worker reads require the operator token, and the side-effecting run endpoint is disabled by default |
| Agent build path uses Codex app-server plus Next.js MCP | The local Codex app-server daemon is bootstrapped and running; `.mcp.json` keeps the Next.js 16 MCP bridge for route/runtime diagnostics |
| HTTPS is managed by Caddy | `continuoushq.com` and `getcontinuous.app` now point at the droplet, and Caddy issues and renews Let's Encrypt certificates from the persisted `caddy_data` volume |

### Tradeoffs

| Tradeoff | Notes |
|---|---|
| Single droplet versus managed Postgres | Simpler and cheaper now; move Postgres out when customer data needs managed backup/isolation guarantees |
| Docker verification | Docker is not running locally on this Mac, so full container verification is happening on the DigitalOcean droplet |
| Domain TLS | Caddy now serves `continuoushq.com` and `getcontinuous.app` over HTTPS and renews certificates automatically; decide whether to include `www` hostnames in `SITE_HOSTS` before serving those records |
| Bootstrap seed data | Seed records prove the substrate shape but are not customer fixtures |
| Deploy updates | The deploy script keeps Postgres and its volume in place, then builds and rolls the app/Caddy services after migrations and seed data |
| Migration runner | Drizzle Kit's container migrator failed silently, so `db:migrate` uses a small Bun/Postgres runner that records Drizzle migration history and refuses partial baselines |
| GitHub deploy access | The manual deploy workflow adds the current GitHub runner as a temporary SSH `/32` on the DigitalOcean firewall, then removes it at the end |
| Strategy breadth versus current runtime | The running app is still a narrow persisted core demo; the updated strategy and docs now define the broader product surface that implementation should grow toward |
| Worker runtime mode | First worker run is a deterministic simulation that writes the durable loop without external sends or money movement |
| Worker selection | Runtime selection now accepts tenant or worker selectors and falls back only when a single active Revenue Worker exists |
| Worker run lifecycle | `worker_runs` is now the idempotent lifecycle boundary for Revenue Worker runs, with events kept as the audit log |
| Codex app-server boundary | The local app-server daemon is available; keep Next MCP for Next.js diagnostics and add app-server-owned worker tools only when the repo needs custom worker controls |

### Current State

The DigitalOcean stack is running on `45.55.53.92`. `continuoushq.com` and
`getcontinuous.app` both serve the app over HTTPS with Let's Encrypt
certificates. Continuous Core now has
persisted graph, task, capability, event, evidence, budget, adapter, and
generated UI primitives plus worker run lifecycle records and `/`,
`/api/health`, and `/api/core`. Local
Node-side validation passes; the real Bun path is verified in the droplet
containers and GitHub CI.

The strategy now makes the broader entity/workforce/payroll/filing/compliance/
payment/AI-ops core explicit. Next implementation should start from the
canonical objects and open workflows rather than letting the Revenue Worker demo
define the platform boundaries.

### Revenue Worker Runtime

The first Revenue Worker slice uses the existing worker, task, event, evidence,
budget, inference, usage, adapter, worker-run, and UI-contract primitives. Each
run requires an idempotency key, writes a `worker_runs` lifecycle record,
enforces the worker budget before spend, creates durable budget/evidence/event
records, marks the quote task as `approval_required`, and leaves external
execution disabled until real auth and adapter approvals are in place.
