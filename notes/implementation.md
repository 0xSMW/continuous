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
| Revenue Worker HTTP paths are guarded | Operator routes require bearer credentials, and production credentials now carry tenant, worker-role, route, read/write, and command scope through the control-plane token catalog |
| Added canonical worker API | `/worker` is the forward control-plane route; worker role, tenant selection, command, idempotency, and config live in structured payload fields for mutation commands |
| Added worker command registry | `/worker` and `bun run worker:tool` now share registered command metadata, role allowlisting, config validation, idempotency rules, tenant requirements, and external-execution posture |
| Hardened the worker API contract | Route-level tests now assert the generic `/worker` payload envelope, body `idempotencyKey` precedence, GET selector mapping, and malformed command config rejection |
| Removed worker-specific local shortcuts | `worker:tool` is the only local mutation entrypoint; Revenue Operations runs now use the same `worker`, `command`, `idempotencyKey`, and `config` envelope as `/worker` |
| Collapsed local worker aliases | `worker:tool` now exposes only `worker.command` and `worker.view`; command/view names live on the payload, and docs/tests reject worker-family-specific local tool names |
| Added canonical workflow API | `/workflow` validates definition-backed `start` and `transition` commands and records workflow events, audit events, and evidence |
| Made workflow transitions replayable | `/workflow` transition commands now require canonical idempotency keys, store a stable transition input hash on `workflow_steps`, replay matching retries, and return conflicts for key reuse with different payloads |
| Removed worker-specific HTTP wrappers | The greenfield API does not expose worker-family routes; new workers must extend `/worker` through registered commands rather than adding route names |
| Added workflow step ledger | Workflow starts and transitions now write durable step records with lease, retry, input, output, state-transition, event, evidence, and approval links |
| Added workflow step execution | `/workflow` now supports `command=steps.execute`, claiming queued or retryable steps, running generic transition handlers, and writing completion or retry state without workflow-specific URLs |
| Added capability-backed workflow execution | `capability_execution` workflow steps now require an active capability and actor grant, record worker/task capability proof, and keep external execution blocked |
| Added approval-backed workflow execution | `approval_request` workflow steps now create shared pending approval records from queued workflow execution and write workflow/task/event/audit/evidence proof without approval-specific routes |
| Added adapter and rule-change workflow execution | `adapter_intent_record` and `rule_change_record` workflow steps now reuse Core adapter-intent and rule-change primitives from queued workflow execution while keeping external execution blocked |
| Added packet-backed workflow execution | `packet_prepare`, `document_packet_prepare`, and `evidence_packet_prepare` steps now reuse Core packet creation from the workflow executor and write packet/document/event/audit/evidence/task proof |
| Expanded packet-backed workflow coverage | CI now proves generic workflow packet steps can prepare new-hire, contractor, payroll, filing, termination, AI-action, and rule-change packets without worker-specific routes |
| Added scheduled internal command drain | The `worker-scheduler` Compose service posts the canonical `/workflow` and `/worker` command envelopes for workflow step execution, Revenue lead source polling, and Revenue adapter retry/reconciliation work |
| Added shared approval service | Worker and workflow approvals now use a neutral approval service over `approval_requests`, with subject-scoped listing and decisions |
| Seeded the first open-workflow set | Entity setup, hire employee, contractor engagement, termination, payroll preview, AI budget cycle, and synthetic-worker lifecycle now all have persisted definitions, runs, and steps |
| Seeded the expanded operating workflow catalog | Open-state, compensation-change, location-change, payroll-run, off-cycle payroll, quarter-close, year-end, leave, incident, benefits-renewal, agency-notice, and filing-draft workflows now have persisted definitions, runs, and seed steps |
| Added worker execution roadmap | `docs/worker-roadmap.md` turns the worker catalog into phase-by-phase implementation gates for workers 2+ |
| Added future worker V1 contracts | Owner Chief-of-Staff, Dispatch, Finance, Workforce, Compliance, and Systems now have implementation-grade contracts covering API shape, Core objects, workflows, capabilities, adapters, evidence, views, evals, and security |
| Added planned future-worker metadata | `worker:tool schema` and `continuous.worker.schema` now expose planned command/view metadata for future workers while keeping those roles non-executable until runtime handlers exist |
| Added Owner Chief-of-Staff runtime slice | `owner_chief_of_staff` is now a registered `/worker` role with read-only `brief.generate`, `decision_queue.prepare`, `anomaly.triage`, `snapshot`, `briefs`, and `decisions` surfaces, seeded capability/budget/workflow substrate, owner brief packets, generated views, and eval coverage |
| Added Owner worker continuations | Owner brief generation now creates a shared `owner_brief_approval`, and `POST /worker` with `worker.role=owner_chief_of_staff`, `command=continue`, and `config.approvalId` publishes approved briefs, creates revision tasks, or marks rejected briefs stale without external execution |
| Added Dispatch schedule proposal runtime | `dispatch_operations` is now a registered `/worker` role with `command=schedule.propose`; it consumes approved Revenue handoff refs from `config.sourceRefs`, writes appointment/workflow/evidence/approval/adapter dry-run records, publishes `dispatch.schedule.review`, and keeps external calendar writes dry-run only |
| Added Dispatch customer update draft runtime | `dispatch_operations` now registers `command=customer_update.draft`; it consumes `config.jobId` plus `config.updateKind`, writes a blocked no-send customer update object, workflow/evidence packet, approval request, generated review view, budget/audit proof, and app-server/tool schema exposure without adding dispatch-specific routes |
| Added Dispatch closeout packet runtime | `dispatch_operations` now registers `command=closeout.prepare`; it consumes `config.workOrderId` plus keyed `config.sourceRefs`, writes a closeout object, QA checklist, evidence packet, approval request, `dispatch.closeout.review` generated view, budget/audit proof, and `dispatch.closeout_to_finance` handoff refs while invoice/payment execution stays blocked |
| Added Dispatch exception route runtime | `dispatch_operations` now registers `command=exception.route`; it consumes `config.jobId`, `config.reason`, `config.severity`, and optional keyed `config.sourceRefs`, writes a blocked exception task, decision record, evidence packet, document, workflow steps, budget/audit proof, and keeps external recovery blocked |
| Added Finance invoice preparation runtime | `finance_operations` now registers `command=invoice.prepare`; it consumes job, closeout, customer, and evidence selectors from `config`/`config.sourceRefs`, writes an invoice object/row, cash packet, approval request, accounting dry-run receipt, generated review view, workflow/budget/audit proof, and keeps external sends and money movement blocked |
| Added Finance AR follow-up runtime | `finance_operations` now registers `command=ar_followup.draft`; it consumes persisted invoice selectors from `config.invoiceId` or `config.sourceRefs`, writes a blocked AR follow-up draft, cash packet, approval request, generated review view, workflow/budget/audit proof, and keeps customer sends, payment links, and money movement blocked |
| Added Finance cash forecast runtime | `finance_operations` now registers `command=cash_forecast.generate`; it consumes forecast windows, account refs, cash drivers, and policy from `config`, writes a cash forecast object, cash packet, approval request, generated review view, workflow/budget/audit proof, and keeps external execution and money movement blocked |
| Added Finance payment draft runtime | `finance_operations` now registers `command=payment_draft.prepare`; it consumes bill or payment selectors from `config`/`config.sourceRefs`, writes a blocked payment object and payment instruction draft, cash packet, dual-control approval request, generated review view, workflow/budget/audit proof, and keeps ACH, payment links, bank writes, and money movement blocked |
| Tightened control-plane scopes | `/core`, `/worker`, `/workflow`, and `/approval` now fail closed when tenant or worker-role scope is required, even if a token catalog entry has an empty allowlist |
| Scoped Core summaries by tenant | Authenticated `GET /core` now passes the requested tenant into Core summary counts, active tasks, and recent events instead of returning global platform rows |
| Redacted public health | `/api/health` now reports service status and check states without leaking detailed record counts or operational internals |
| Made approval decisions explicit | `POST /approval` still uses the shared approval envelope, but decision calls must include `approval.subject` instead of falling back to a broad subject |
| Narrowed approval decision subjects | Shared approval decisions now reject `approval.subject=all`; Core-owned approvals use the typed `core` subject, while `all` remains only an inbox filter |
| Required explicit Revenue run input | Revenue `run`, `lead.classify`, and `response.draft` now require `config.intake`, `config.leadPacket`, or `config.lead`, so worker runs cannot silently execute placeholder lead packets |
| Proved app-server worker execution | The CI integration suite now executes Revenue `lead.read`/`run`, Owner `brief.generate`, and Dispatch `schedule.propose` through `continuous.worker.command`, proving the app-server boundary uses the same registry, payload envelope, and persisted worker records as `/worker` |
| Added first Revenue Worker eval gate | `bun run test` now includes a CI-backed Postgres integration eval that runs the seeded worker, verifies persisted output/evaluation records, and checks idempotent replay |
| Expanded Revenue Worker eval coverage | Revenue eval cases now cover direct lead packets, Core row intake refs, source-selector intake, a normal-urgency third service area, missing-fact owner review, pricing override behavior, and policy-risk external-send rejection before widening autonomy |
| Added persistence-only adapter reconciliation | `worker.command` scans pending dry-run adapter runs/actions, writes matched/retry/review state, records audit/evidence, and creates blocked retry/review system tasks without external execution |
| Added blocked adapter retry execution | `worker.command` drains due dry-run retry rows, writes blocked retry receipts/audit/evidence, closes retry system tasks, and leaves rows pending for reconciliation without external sends |
| Added adapter execution readiness proof | Adapter retry/review tasks and retry execution receipts now persist live-credential scope checks, missing scopes, rollback plans, and blocked execution gates before any live send path exists |
| Added workflow-level adapter reconciliation | Revenue adapter reconciliation now appends `adapter_reconciliation` workflow steps and moves `lead_to_cash` through `adapter_retry_scheduled`, `adapter_failure_review`, and `post_retry_reconciled` without enabling external execution |
| Promoted the Core command surface | `/core` is now the canonical Core route, and Core mutation requests reject top-level fields outside `command`, `core`, `idempotencyKey`, and `config` |
| Added headless Core task creation | `POST /core` with `command=task.create` creates platform tasks, emits `task.created`, and records audit proof without worker-specific routes |
| Expanded headless Core writes | `POST /core` now supports `object.upsert`, `event.ingest`, `evidence.attach`, `document.create`, and `decision.record` with tenant-scoped idempotency and audit proof |
| Added Core graph and generated-view commands | `POST /core` now supports `object.link` and `view.publish`, so object relationships and renderer-neutral UI contracts are written through the same structured Core payload instead of seed-only data |
| Added Core task and approval controls | `POST /core` now supports `task.transition` and `approval.request`, so the headless platform can move task state and create pending approval packets without a worker-specific path |
| Added Core adapter and rule-change intents | `POST /core` now supports `adapter.intent.record` and `rule.change.record`, creating blocked adapter intent and rule-change proof records through the canonical Core envelope |
| Added Core connector setup commands | `POST /core` now supports `adapter.upsert` and `connection.upsert`, so adapter catalog rows and tenant-scoped pollable connections can be managed headlessly with audit proof and managed credential refs instead of manual DB edits |
| Added Core connection health proof | `POST /core` now supports `connection.health.record`, storing connector readiness checks for state, adapter status, blocked external execution, managed credential refs, source/provider metadata, read scopes, polling config, and scheduler cursor proof without exposing credential values |
| Added Core authority and budget controls | `POST /core` now supports `capability.grant`, `budget.reserve`, `budget.charge`, and `budget.release`, so worker authority and AI budget movement are platform-owned commands with audit and evidence |
| Added durable evidence packets | `POST /core` now supports `packet.prepare` and `document.packet.prepare`, creating an `evidence_packets` record plus linked document, event, audit, and trace evidence for workflow review packets |
| Added shared approval inbox | `/approval` and `/approvals` expose a token-gated, subject-neutral approval inbox and decision surface on top of the shared `approval_requests`, `audit_events`, and evidence records |
| Expanded shared approval inbox detail | `/approval` now supports priority, risk, kind, state, and subject filters; approval records include evidence references and subject-aware continuation hints for worker, workflow, task, and Core decisions |
| Guarded canonical worker API surface | Contract tests now fail if worker-family-specific or `/api/*` control-plane route files appear; worker families must extend `/worker` through registered commands, `worker` selectors, `idempotencyKey`, and `config` payloads |
| Added planned-worker config schemas | `worker:tool schema` and `continuous.worker.schema` now expose non-executable `configSchema` metadata for Dispatch, Finance, Workforce, Compliance, and Systems commands before runtime handlers are added |
| Added customer-signal primitives | Satisfaction, feedback, complaint, testimonial, and review records persist as `CustomerSignal.type` rows, and `POST /core` `command=customer_signal.record` writes them with object links, note evidence, events, and audit proof |
| Added payroll preview kernel | Pay statements, payroll lines, payroll liabilities, and payroll calculation traces now persist as first-class Core tables; `POST /core` `command=payroll.preview.record` records preview artifacts with event, audit, and trace evidence while external execution stays blocked |
| Added payroll preview packet handoff | `POST /core` `command=payroll.preview.packet.prepare` gathers preview artifacts into variance reports, pay statement documents, approval packets, pending approval requests, and blocked payroll funding/tax draft records |
| Added payroll approval handoff | Shared approval decisions for `payroll_preview_approval` now transition the payroll run plus funding, tax, filing, packet, audit, and evidence handoff records while keeping external execution, submission, and money movement blocked |
| Agent build path uses app-server protocol tooling plus Next.js MCP | The installed Codex app-server CLI exposes protocol generation/help commands; `.mcp.json` keeps the Next.js 16 MCP bridge for route/runtime diagnostics |
| Added app-server worker command control | `continuous.worker.schema` exposes the registry, and `continuous.worker.command` invokes registered worker commands through the same `command`, `worker`, `idempotencyKey`, and `config` envelope without loading production tokens |
| Added registry-owned worker config schemas | `/worker`, `worker:tool`, and `continuous.worker.command` now share per-command `configSchema` checks for required fields, enums, integer bounds, and non-empty arrays before handlers run |
| Added the first authority ledger | Revenue Worker runs now create approval requests and audit events, and approval decisions create evidence before any external action is allowed |
| Added first-class adapter dry-runs | Revenue Worker runs now create linked adapter runs/actions, receipt evidence, attempt metadata, and reconciliation state while external mutation remains disabled |
| Added persisted-intake no-send worker packets | `POST /worker` `command=run` now prefers `config.intake` Core object/event/evidence references, stores source snapshot evidence, hashes normalized input for idempotency, and derives classification, draft response, quote, and approval packet output from the resolved payload; `config.leadPacket` remains a direct operator/test fallback |
| Bound Revenue quote approval UI | Revenue runs now publish/update the `quote.approval.review` generated view contract, link the view id into run output, and record event/audit proof while approval decisions still execute through `/approval` and `/worker command=continue` |
| Made Revenue intake runs self-tasking | Revenue runs now create a worker-owned quote-review task when no active task is available, so persisted Core intake and source-selector runs still carry task, budget, approval, and eval links |
| Added source-based worker intake | External callers can now run the Revenue Worker with `config.intake.source` and `config.intake.sourceEventId`; the worker resolves the matching Core object/event/evidence rows before preparing the no-send approval packet |
| Added read-only lead source intake | `POST /worker` `command=lead.read` now persists inbound lead source records as Core object/event/evidence rows, writes a read-only worker run plus budget/usage/audit records, and returns stable `config.intake` selectors for `command=run` |
| Added inbox and CRM lead source readers | `lead.read` now accepts read-only `config.reader` metadata for inbox and CRM records, requires credential references instead of embedded credential material, normalizes message/deal fields, and persists source-reader proof without external execution |
| Added connection-backed lead reads | `lead.read` can now omit direct records when `config.reader` references an active tenant connection; it reads buffered source records from connection config, persists the same Core intake selectors, updates `connections.lastSyncAt`, and records `lastLeadRead` cursor proof without embedding credentials |
| Added read-only lead source API polling | Connection-backed `lead.read` can now use `connection.config.polling.enabled=true` to poll supported inbox/CRM APIs with environment-backed credential references, normalize the returned records into Core intake selectors, and persist redacted polling receipts while external sends remain blocked |
| Added scheduled lead source polling | `worker-scheduler` now discovers active pollable connections, posts canonical `/worker` `command=lead.read` payloads with connection reader config, and hands returned selectors to `/worker` `command=run`, isolating per-connection and per-selector failures from workflow and adapter drain work |
| Added production scheduler handoff proof | The deploy smoke now creates an active buffered connection through `/core adapter.upsert` and `/core connection.upsert`, records connection health, runs the scheduler once, and verifies scheduled `lead.read` cursor proof plus the scheduled Revenue `run` approval workflow |
| Split Revenue classify and draft commands | `POST /worker` now exposes `command=lead.classify` and `command=response.draft` as explicit tenant-scoped Revenue commands that consume `config.intake` or direct fallback `config.leadPacket`, write worker run, inference, usage, event, evidence, audit, and budget proof, and keep external sends blocked |
| Added deploy smoke for split Revenue commands | The production deploy workflow now exercises `lead.read` followed by `lead.classify` and `response.draft` through `/worker`, then checks persisted worker run, event, evidence, audit, and usage rows before the full `run` smoke |
| Protected operational artifacts during deploy sync | Deploy rsync still deletes stale source files, but now excludes `backups/`, `logs/`, and `reports/recovery-drills/` so local database dumps, Caddy/observability logs, and recovery evidence are not removed during a release |
| Added expansion readiness and handoff contracts | `docs/worker-readiness.md` tracks each worker against shared launch gates, and `docs/worker-handoffs.md` defines Core-record handoffs from Revenue into Owner, Dispatch, Finance, Workforce, Compliance, and Systems expansion paths |
| Rejected mixed worker intake sources | Revenue Worker now treats persisted `config.intake` Core row references as authoritative and rejects requests that also include direct `leadPacket` or `lead` payloads |
| Added Revenue workflow spine | Revenue Worker runs now create a `lead_to_cash` workflow run plus durable workflow steps for intake, packet preparation, adapter dry-run, approval request, and approval decision continuation |
| Added worker continuation command | `POST /worker` `command=continue` is a generic idempotent continuation surface; V1 consumes `config.approvalId` for approved, revision-requested, or rejected approvals, prepares blocked no-send execution packets, revised approval packets, or rejected stop packets, creates document/evidence packet records, and keeps external execution blocked |
| Added tag-based app rollback | Deploys now tag app images by commit, persist `PREVIOUS_APP_TAG`, and expose a no-migration rollback path through the deploy workflow and `scripts/rollback-app.sh` for compatible app-only rollbacks |
| HTTPS is managed by Caddy | `continuoushq.com` and `getcontinuous.app` now point at the droplet, and Caddy issues and renews Let's Encrypt certificates from the persisted `caddy_data` volume |
| Added a database recovery lane | `scripts/backup-db.sh` creates verified Postgres dumps on the droplet and copies them off-box; `scripts/restore-db.sh` performs a confirmation-gated restore, migration, restart, and health check |
| Enabled DigitalOcean managed backups | The `continuous-01` droplet now has DO-managed backups enabled as the first off-host recovery layer; repo scripts also check custom dump age and checksum sidecars |
| Added object-storage backup wiring | Verified Postgres dumps can now upload to an S3-compatible target with checksum sidecar and `latest.json`; a systemd timer installer wires daily scheduled retention once bucket credentials are available |
| Scoped the shared operator token | `/worker`, `/core`, and `/workflow` now enforce tenant and worker-role allowlists from `CONTROL_PLANE_ALLOWED_TENANTS` and `CONTROL_PLANE_ALLOWED_WORKER_ROLES`; deploy writes production defaults for the demo tenant and currently executable worker roles |
| Added scoped control-plane token catalog | `/core`, `/worker`, `/workflow`, and `/approval` now authorize against route/read-write/command-scoped token catalog entries when present; deploy writes a hashed catalog entry derived from the generated worker token so future rotation does not require new API shapes |
| Added durable control-plane auth audit | `/core`, `/worker`, `/workflow`, and `/approval` now record route-level auth attempts into `control_plane_auth_sessions`, including credential id, token fingerprint, route, command, tenant, worker role, outcome, reason code, and safe request metadata without storing token material |
| Added token rotation attestations | `/core` now accepts `command=control_plane.token_rotation.attest` with rotation details inside `config`, persists append-only `control_plane_token_rotation_attestations`, links Core event/audit rows, and rejects raw token fields in the payload |
| Added managed control-plane credentials | `/core` now accepts `control_plane.credential.upsert`, `control_plane.credential.revoke`, and `control_plane.session.review`, storing scoped credential inventory, enforcing revoked/paused/expired managed credentials after catalog auth succeeds, and publishing safe operator session review views |
| Added deploy control-plane attestation | Production deploy smoke now records the bootstrap credential inventory row, revokes a disposable drill credential, reviews recent operator sessions, and writes the non-secret evidence ids into `/etc/continuous/production-readiness.env` |
| Added recovery drill harness | `scripts/recovery-drill.sh` composes tag-based app rollback and confirmation-gated database restore into one measured disposable-host drill, refuses known production hosts by default, and writes a local timing/compatibility report |
| Added production observability checks | Caddy now writes retained JSON access logs, deploy creates log directories, and `scripts/check-observability-on-host.sh` verifies Compose service state, public health, TLS freshness, disk usage, Caddy logs, and optional backup/systemd checks with webhook failure alerts |
| Tightened control-plane config envelopes | `/worker`, `/core`, `/workflow`, and `/approval` now reject non-object `config` values instead of silently normalizing them to `{}` |
| Added production readiness gate | `scripts/check-production-readiness.sh` and the optional deploy workflow gate now compose strict observability, scheduled off-host backup freshness, object-storage backup manifests, alerting, recovery-drill attestation, token-rotation, managed credential, auth-audit record references, and non-root access attestation into one customer-data readiness check |

### Tradeoffs

| Tradeoff | Notes |
|---|---|
| Single droplet versus managed Postgres | Simpler and cheaper now; the repo now has explicit backup/restore and object-retention wiring, but managed Postgres is still the right move when customer data needs managed backup/isolation guarantees |
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
| Codex app-server boundary | The installed CLI has protocol generation commands, but no local daemon subcommand in this environment; keep Next MCP for Next.js diagnostics and keep app-server worker commands registry-backed rather than worker-family-specific |
| Recovery boundary | App-only rollback is tag-based and destructive database restore is dump-backed; the new drill harness makes the app/database compatibility procedure repeatable, but it still must be run on a disposable droplet before customer data |
| Operator-token scope | The current production token now has hashed catalog metadata, per-command scope enforcement, durable auth session records, token-rotation attestations, managed credential inventory, revocation enforcement, and operator session review views; deploy smoke produces bootstrap inventory, disposable revocation, and session-review evidence, while broad use still needs real token rotation and broader operator review policy |
| Alerting boundary | Deploy smoke now proves the host observability check, but recurring alerts are not active until `scripts/install-observability-timer.sh` is run with a real `ALERT_WEBHOOK_URL` |
| Readiness boundary | The production readiness gate is strict and opt-in; it is expected to fail until object-storage credentials, backup and observability timers, alert webhook, recovery drill report, real token-rotation evidence, production connector credentials, and non-root host access are all actually provisioned and attested |

### Current State

The DigitalOcean stack is running on `45.55.53.92`. `continuoushq.com` and
`getcontinuous.app` both serve the app over HTTPS with Let's Encrypt
certificates. Continuous Core now has
persisted graph, task, capability, event, evidence, budget, adapter, authority,
document, decision, workflow, and generated UI primitives plus worker run lifecycle
records and `/`, `/api/health`, `/approval`, `/approvals`, `/core`, and `POST /core` task,
task-transition, approval-request, capability-grant, budget-ledger, object,
object-link, event, evidence, document, packet, payroll preview, payroll packet,
decision, and generated-view commands. Local
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
execution disabled until live credential scopes, rollback paths, and approval UI
are in place.

The canonical HTTP shape is now `/worker` with explicit worker roles:
`GET /worker?view=snapshot&role=revenue_operations` for state,
`GET /worker?view=approvals&role=revenue_operations` for approval queues, and
`POST /worker` with `command`, `worker`, `idempotencyKey`, and `config` for
side-effecting operations. The route rejects ad hoc top-level operation fields;
role and tenant selectors live under `worker`, while source records, approval
ids, retry limits, and direct fallback payloads live under `config`. Adapter
reconciliation and retry execution use the same route with
`command=adapters.reconcile` or `command=adapters.retry`, a tenant-scoped
`worker` target, and `config.limit`; approval continuations use
`command=continue`, an idempotency key, and `config.approvalId` for approved,
revision-requested, or rejected approval outcomes. Route handlers
now delegate to the
worker command registry,
which owns role allowlisting, command lookup, idempotency, config validation,
tenant requirements, and external-execution metadata. Worker-family-specific
HTTP routes are absent by design.

Workflow execution now has the same control-plane style through `/workflow`.
Definitions remain declarative, and the runtime validates transitions against
their JSON transition maps before updating `workflow_runs` and writing durable
`workflow_steps`, replayable event, audit, evidence, and approval records. The
same route can execute queued workflow steps with `command=steps.execute`; step
claims, leases, attempts, completion proof, and retry failures stay on the
shared workflow step ledger. Capability-backed steps now validate active
capability grants for the worker or task owner actor before completion and
write the grant, actor, task, and blocked external-execution posture into
workflow output and task outcome.
Packet-backed steps now prepare durable Core packets from queued workflow work,
linking the resulting document, evidence packet, event, audit, trace evidence,
workflow output, and task `lastWorkflowPacket` outcome without a new API route.
Workflow approvals are listed with `GET /workflow?view=approvals` and decided
with `POST /workflow` using `command=approval.decide`.
Production deploys also run the internal `worker-scheduler` sidecar. It calls
`/workflow` with `command=steps.execute`, then `/worker` with
`command=lead.read`, `command=adapters.retry`, and
`command=adapters.reconcile`, using the same tenant-scoped bearer-token
envelope as operator calls.
