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
| Added canonical worker API | `/worker` is the forward control-plane route; worker role, tenant selection, command, idempotency, and config live in structured payload fields for mutation commands |
| Added worker command registry | `/worker` and `bun run worker:tool` now share registered command metadata, role allowlisting, config validation, idempotency rules, tenant requirements, and external-execution posture |
| Added canonical workflow API | `/workflow` validates definition-backed `start` and `transition` commands and records workflow events, audit events, and evidence |
| Removed worker-specific HTTP wrappers | The greenfield API does not expose worker-family routes; new workers must extend `/worker` through registered commands rather than adding route names |
| Added workflow step ledger | Workflow starts and transitions now write durable step records with lease, retry, input, output, state-transition, event, evidence, and approval links |
| Added shared approval service | Worker and workflow approvals now use a neutral approval service over `approval_requests`, with subject-scoped listing and decisions |
| Seeded the first open-workflow set | Entity setup, hire employee, contractor engagement, termination, payroll preview, AI budget cycle, and synthetic-worker lifecycle now all have persisted definitions, runs, and steps |
| Added worker execution roadmap | `docs/worker-roadmap.md` turns the worker catalog into phase-by-phase implementation gates for workers 2+ |
| Added first Revenue Worker eval gate | `bun run test` now includes a CI-backed Postgres integration eval that runs the seeded worker, verifies persisted output/evaluation records, and checks idempotent replay |
| Added persistence-only adapter reconciliation | `worker.adapters.reconcile` scans pending dry-run adapter runs/actions, writes matched/retry/review state, and records audit/evidence without external execution |
| Added headless Core task creation | `POST /api/core` with `command=task.create` creates platform tasks, emits `task.created`, and records audit proof without worker-specific routes |
| Expanded headless Core writes | `POST /api/core` now supports `object.upsert`, `event.ingest`, `evidence.attach`, `document.create`, and `decision.record` with tenant-scoped idempotency and audit proof |
| Added Core graph and generated-view commands | `POST /api/core` now supports `object.link` and `view.publish`, so object relationships and renderer-neutral UI contracts are written through the same structured Core payload instead of seed-only data |
| Added Core task and approval controls | `POST /api/core` now supports `task.transition` and `approval.request`, so the headless platform can move task state and create pending approval packets without a worker-specific path |
| Added Core authority and budget controls | `POST /api/core` now supports `capability.grant`, `budget.reserve`, `budget.charge`, and `budget.release`, so worker authority and AI budget movement are platform-owned commands with audit and evidence |
| Added durable evidence packets | `POST /api/core` now supports `packet.prepare` and `document.packet.prepare`, creating an `evidence_packets` record plus linked document, event, audit, and trace evidence for workflow review packets |
| Agent build path uses app-server protocol tooling plus Next.js MCP | The installed Codex app-server CLI exposes protocol generation/help commands; `.mcp.json` keeps the Next.js 16 MCP bridge for route/runtime diagnostics |
| Added the first authority ledger | Revenue Worker runs now create approval requests and audit events, and approval decisions create evidence before any external action is allowed |
| Added first-class adapter dry-runs | Revenue Worker runs now create linked adapter runs/actions, receipt evidence, attempt metadata, and reconciliation state while external mutation remains disabled |
| Added persisted-intake no-send worker packets | `POST /worker` `command=run` now prefers `config.intake` Core object/event/evidence references, stores source snapshot evidence, hashes normalized input for idempotency, and derives classification, draft response, quote, and approval packet output from the resolved payload; `config.leadPacket` remains a direct operator/test fallback |
| Added Revenue workflow spine | Revenue Worker runs now create a `lead_to_cash` workflow run plus durable workflow steps for intake, packet preparation, adapter dry-run, approval request, and approval decision continuation |
| Added worker continuation command | `POST /worker` `command=continue` is a generic idempotent continuation surface; V1 consumes `config.approvalId` for `revision_requested` approvals, records workflow/task/audit/evidence state, and keeps external execution blocked |
| HTTPS is managed by Caddy | `continuoushq.com` and `getcontinuous.app` now point at the droplet, and Caddy issues and renews Let's Encrypt certificates from the persisted `caddy_data` volume |
| Added a database recovery lane | `scripts/backup-db.sh` creates verified Postgres dumps on the droplet and copies them off-box; `scripts/restore-db.sh` performs a confirmation-gated restore, migration, restart, and health check |

### Tradeoffs

| Tradeoff | Notes |
|---|---|
| Single droplet versus managed Postgres | Simpler and cheaper now; the repo now has explicit backup/restore scripts, but managed Postgres is still the right move when customer data needs managed backup/isolation guarantees |
| Docker verification | Docker is not running locally on this Mac, so full container verification is happening on the DigitalOcean droplet |
| Domain TLS | Caddy now serves `continuoushq.com` and `getcontinuous.app` over HTTPS and renews certificates automatically; decide whether to include `www` hostnames in `SITE_HOSTS` before serving those records |
| Bootstrap seed data | Seed records prove the substrate shape but are not customer fixtures |
| Deploy updates | The deploy script keeps Postgres and its volume in place, then builds and rolls the app/Caddy services after migrations and seed data |
| Migration runner | Drizzle Kit's container migrator failed silently, so `db:migrate` uses a small Bun/Postgres runner that records Drizzle migration history and refuses partial baselines |
| GitHub deploy access | The manual deploy workflow adds the current GitHub runner as a temporary SSH `/32` on the DigitalOcean firewall, then removes it at the end |
| Strategy breadth versus current runtime | The running app is still a narrow persisted core demo; the updated strategy and docs now define the broader product surface that implementation should grow toward |
| Worker runtime mode | First worker run is a deterministic simulation that writes the durable loop, operator identity, approval request, and audit events without external sends or money movement |
| Worker selection | Runtime selection now accepts tenant or worker selectors and falls back only when a single active Revenue Worker exists |
| Worker run lifecycle | `worker_runs` is now the idempotent lifecycle boundary for Revenue Worker runs, with events kept as the audit log |
| Codex app-server boundary | The installed CLI has protocol generation commands, but no local daemon subcommand in this environment; keep Next MCP for Next.js diagnostics and add app-server-owned worker tools only when the repo needs custom worker controls |
| Recovery boundary | The restore script is intentionally destructive and migrations remain forward-only, so rollback depends on a compatible database dump until tag-based app rollback and migration rollback policy exist |

### Current State

The DigitalOcean stack is running on `45.55.53.92`. `continuoushq.com` and
`getcontinuous.app` both serve the app over HTTPS with Let's Encrypt
certificates. Continuous Core now has
persisted graph, task, capability, event, evidence, budget, adapter, authority,
document, decision, workflow, and generated UI primitives plus worker run lifecycle
records and `/`, `/api/health`, `/api/core`, and `POST /api/core` task,
task-transition, approval-request, capability-grant, budget-ledger, object,
object-link, event, evidence, document, packet, decision, and generated-view commands. Local
Node-side validation passes; the real Bun path is verified in the droplet
containers and GitHub CI.

Postgres recovery is now explicit: production backups are custom-format dumps
verified with `pg_restore --list`, copied off the droplet with checksum
verification, and restorable through a confirmation-gated script that recreates
the database, runs migrations, restarts the app, and checks health.

The strategy now makes the broader entity/workforce/payroll/filing/compliance/
payment/AI-ops core explicit. Next implementation should start from the
canonical objects and open workflows rather than letting the Revenue Worker demo
define the platform boundaries.

### Revenue Worker Runtime

The first Revenue Worker slice uses the existing worker, task, event, evidence,
budget, inference, usage, adapter, workflow, worker-run, approval, audit, and UI-contract
primitives. Each run requires an idempotency key, writes a `worker_runs`
lifecycle record and a `lead_to_cash` workflow run, binds a configured active
operator user, enforces an active worker capability grant and budget before
spend, creates durable budget/evidence/event/approval/audit records, writes
workflow steps for intake, packet preparation, adapter dry-run, approval
request, and approval decision, writes dry-run adapter run/action/receipt
evidence, marks the quote task as `approval_required`, and leaves external
execution disabled until retry/reconciliation workers, live credential scopes,
and approval UI are in place.

The canonical HTTP shape is now `/worker` with explicit worker roles:
`GET /worker?view=snapshot&role=revenue_operations` for state,
`GET /worker?view=approvals&role=revenue_operations` for approval queues, and
`POST /worker` with `command`, `worker`, `idempotencyKey`, and `config` for
side-effecting operations. Adapter reconciliation uses the same route with
`command=adapters.reconcile`, a tenant-scoped `worker` target, and
`config.limit`; revision continuation uses `command=continue`, an
idempotency key, and `config.approvalId`. Route handlers now delegate to the
worker command registry,
which owns role allowlisting, command lookup, idempotency, config validation,
tenant requirements, and external-execution metadata. Worker-family-specific
HTTP routes are absent by design.

Workflow execution now has the same control-plane style through `/workflow`.
Definitions remain declarative, and the runtime validates transitions against
their JSON transition maps before updating `workflow_runs` and writing durable
`workflow_steps`, replayable event, audit, evidence, and approval records.
Workflow approvals are listed with `GET /workflow?view=approvals` and decided
with `POST /workflow` using `command=approval.decide`.
