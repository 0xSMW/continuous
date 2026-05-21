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
| Canonical worker HTTP surface is guarded | Operator routes require bearer credentials, and production credentials now carry tenant, worker-role, route, read/write, and command scope through the control-plane token catalog |
| Added canonical worker API | `/worker` is the forward control-plane route; worker role, tenant selection, command, idempotency, and config live in structured payload fields for mutation commands |
| Added controlled execution config | Revenue approval continuation still uses `/worker` with `command=continue`; approved controlled-send receipt details live only under `config.execution`, require explicit connection/credential/receipt/rollback proof, persist as a safe summary plus redacted receipt, and are bound into the idempotency hash |
| Normalized worker role naming | Strategy examples and contract guardrails now use role-based names such as `revenue_operations` instead of `_worker` identifiers, so future workers extend the same `/worker` command envelope |
| Added worker command registry | `/worker` and `bun run worker:tool` now share registered command metadata, role allowlisting, config validation, idempotency rules, tenant requirements, and external-execution posture |
| Published implementation-grade worker contracts | `continuous.worker.schema` now returns the full worker contract catalog, runtime contracts, registered executable commands, and non-executable follow-up commands so expansion stays metadata-driven instead of URL-driven |
| Pinned worker route metadata | Worker contract, command, and view metadata now carry `apiRoute: "/worker"`, so future worker roles inherit the generic control-plane route from registry data instead of inventing role-specific URLs |
| Hardened the worker API contract | Route-level tests now assert the generic `/worker` payload envelope, body `idempotencyKey` precedence, GET selector mapping, and malformed command config rejection |
| Removed worker idempotency header fallback | `POST /worker` now treats the payload `idempotencyKey` as the only command idempotency source; `idempotency-key` headers no longer bypass the canonical command envelope |
| Removed Core and workflow idempotency header fallback | `POST /core` and `POST /workflow` now treat the payload `idempotencyKey` as the only command idempotency source, keeping command identity inside the canonical envelope |
| Made approval decisions idempotent | `/approval`, `/workflow`, and worker `approval.decide` commands now require payload idempotency keys, replay matching decisions from stored audit/evidence proof, and reject changed decision input before state changes |
| Aligned approval decision callers | Deploy smoke and the browser approval console now send the canonical `/approval` decision envelope with top-level idempotency keys instead of relying on implicit decision retries |
| Made payroll approval application fail closed | Payroll approval decisions now require packet, packet document, filing draft, and payment instruction refs to exist, match, and remain blocked before any payroll handoff or applied audit proof is written |
| Tightened control-plane command examples | Local/deploy docs and host credential attestation now use exact route-qualified `allowedCommands` lists instead of route-wide command wildcards |
| Reasserted generic worker URL shape | Contract tests now generically classify any worker-family URL shape as non-canonical; worker families must use `/worker` with structured command/read envelopes instead of adding family-specific routes |
| Closed worker URL naming escape hatches | Contract tests now reject both hyphenated and underscored worker-family API names, keeping role naming in payload selectors instead of route names |
| Shared the worker envelope guard | `/worker`, `worker.command`, `worker.view`, and `continuous.worker.command` now share envelope helpers so future worker families cannot drift into route-specific or tool-specific payload shapes |
| Required explicit worker command envelopes | `/worker`, `worker.command`, and `continuous.worker.command` now reject missing command names and missing/non-object command `config` before registry dispatch, so auth and runtime always see a clear command plus operation payload boundary |
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
| Isolated scheduler drain lanes | A failure in workflow step execution, Revenue lead polling, Revenue run handoff, adapter retry, or adapter reconciliation is recorded in the cycle result without blocking the other scheduler lanes |
| Added shared approval service | Worker and workflow approvals now use a neutral approval service over `approval_requests`, with subject-scoped listing and decisions |
| Seeded the first open-workflow set | Entity setup, hire employee, contractor engagement, termination, payroll preview, AI budget cycle, and synthetic-worker lifecycle now all have persisted definitions, runs, and steps |
| Seeded the expanded operating workflow catalog | Open-state, compensation-change, location-change, payroll-run, off-cycle payroll, quarter-close, year-end, leave, incident, benefits-renewal, agency-notice, and filing-draft workflows now have persisted definitions, runs, and seed steps |
| Added worker execution roadmap | `docs/worker-roadmap.md` turns the worker catalog into phase-by-phase implementation gates for workers 2+ |
| Added future worker V1 contracts | Owner Chief-of-Staff, Dispatch, Finance, Workforce, Compliance, and Systems now have implementation-grade contracts covering API shape, Core objects, workflows, capabilities, adapters, evidence, views, evals, and security |
| Added planned future-worker metadata | `worker:tool schema` and `continuous.worker.schema` expose planned command/view metadata for future workers and non-executable follow-up commands while keeping roles without runtime handlers unavailable |
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
| Added Workforce packet runtime | `workforce_operations` now registers `command=hire.packet.prepare`, `command=payroll_input.prepare`, `view: "snapshot"`, and `view: "readiness"` on `/worker`; config stays in the generic worker envelope while the handlers write workforce packets, document/checklist proof, restricted-document redaction proof, payroll blockers, approvals, generated views, workflow/budget/audit records, and blocked/dry-run execution posture |
| Split Workforce executable and planned contract entries | The Workforce V1 contract now separates currently executable registry entries from follow-up metadata entries, keeping `contractor.packet.prepare`, `credential.review`, and `schedule_readiness.prepare` planned until runtime handlers exist |
| Added Compliance runtime slice | `compliance_operations` now runs `filing.prepare` plus compliance views through the generic `/worker` envelope; filing inputs live under `config`, while agency submission and legal advice stay blocked |
| Added Compliance deploy smoke | Production deploy now exercises `/worker` `command=filing.prepare` for `compliance_operations`, proving filing packet, document, approval, generated view, workflow steps, handoff, and blocked agency/legal posture without adding compliance-specific routes |
| Documented Systems Operations runtime promotion | Systems Operations is now treated in docs as a first runtime slice on the generic `/worker` envelope; repair planning stays dry-run, permission and automation execution stay blocked, and no systems-specific routes should be introduced |
| Added authenticated app-server transport context | `continuous.worker.command` and `continuous.worker.view` can now receive operator identity, access, route-qualified command/view, tenant, and worker-role scope from an authenticated control-plane transport context instead of only `WORKER_OPERATOR_EMAIL`, while keeping `operatorEmail` out of tool payloads and preserving trusted-local guards for CLI use |
| Added authenticated app-server bridge | `POST /app-server` now accepts only dynamic tool-call fields at the top level, authenticates through the `app_server` control-plane route with exact bridge command scope, builds worker-registry transport context server-side, and keeps worker operation inputs under `arguments.config` |
| Removed implicit worker view defaults | `worker.view`, `continuous.worker.view`, and the shared worker view executor now require an explicit `view`, keeping reads as clear payload contracts instead of hidden `snapshot` fallbacks |
| Guarded app-server context CLI plumbing | `bun run app-server:worker-tools` accepts only trusted-local context through `--context` or `APP_SERVER_WORKER_TRANSPORT_CONTEXT_JSON` and rejects forged `source: "control_plane"` context; real control-plane context must come from an authenticated bridge |
| Locked the public root page | `/` is now static and does not query or render Core summary counts, task titles, event names, approval/run counts, or database errors; operational data remains behind authenticated control-plane routes and `/health` stays the public liveness endpoint |
| Added Codex dynamic tool-call adapter | App-server worker tooling now accepts Codex dynamic call payloads with `tool`, `arguments`, `callId`, `threadId`, and `turnId`, returns `contentItems`, and still delegates to the same registry-backed worker executor |
| Required production hash-only control-plane catalogs | `APP_ENV=production` now rejects catalog entries carrying raw `token` values; production catalogs must use `tokenSha256` via `CONTROL_PLANE_TOKENS_JSON` or `CONTROL_PLANE_TOKEN_CATALOG_B64` |
| Tightened control-plane scopes | `/core`, `/worker`, `/workflow`, and `/approval` now fail closed when tenant or worker-role scope is required, even if a token catalog entry has an empty allowlist |
| Scoped Core summaries by tenant | Authenticated `GET /core` now passes the requested tenant into Core summary counts, active tasks, and recent events instead of returning global platform rows |
| Redacted public health | `/api/health` now reports service status and check states without leaking detailed record counts or operational internals |
| Made approval decisions explicit | `POST /approval` still uses the shared approval envelope, but decision calls must include `approval.subject` instead of falling back to a broad subject |
| Narrowed approval decision subjects | Shared approval decisions now reject `approval.subject=all`; Core-owned approvals use the typed `core` subject, while `all` remains only an inbox filter |
| Required explicit Revenue run input | Revenue `run`, `lead.classify`, `response.draft`, and `quote.prepare` now require `config.intake`, `config.leadPacket`, or `config.lead`, so worker runs cannot silently execute placeholder lead packets |
| Proved app-server worker execution | The CI integration suite now executes Revenue `lead.read`/`run`, Owner `brief.generate`, and Dispatch `schedule.propose` through `continuous.worker.command`, proving the app-server boundary uses the same registry, payload envelope, and persisted worker records as `/worker` |
| Added first Revenue Worker eval gate | `bun run test` now includes a CI-backed Postgres integration eval that runs the seeded worker, verifies persisted output/evaluation records, and checks idempotent replay |
| Expanded Revenue Worker eval coverage | Revenue eval cases now cover direct lead packets, Core row intake refs, source-selector intake, a normal-urgency third service area, missing-fact owner review, pricing override behavior, and policy-risk external-send rejection before widening autonomy |
| Added persistence-only adapter reconciliation | `worker.command` scans pending dry-run adapter runs/actions, writes matched/retry/review state, records audit/evidence, and creates blocked retry/review system tasks without external execution |
| Added blocked adapter retry execution | `worker.command` drains due dry-run retry rows, writes blocked retry receipts/audit/evidence, closes retry system tasks, and leaves rows pending for reconciliation without external sends |
| Added adapter execution readiness proof | Adapter retry/review tasks and retry execution receipts now persist live-credential scope checks, missing scopes, rollback plans, and blocked execution gates before any live send path exists |
| Added workflow-level adapter reconciliation | Revenue adapter reconciliation now appends `adapter_reconciliation` workflow steps and moves `lead_to_cash` through `adapter_retry_scheduled`, `adapter_failure_review`, and `post_retry_reconciled` without enabling external execution |
| Promoted the Core command surface | `/core` is now the canonical Core route, and Core mutation requests reject top-level fields outside `command`, `core`, `idempotencyKey`, and `config` |
| Added headless Core task creation | `POST /core` with `command=task.create` creates platform tasks, emits `task.created`, and records audit proof without worker-specific routes |
| Added queryable worker expansion metadata | `continuous.worker.schema` now exposes `registry.expansion` with launch order, first command/view pairs, Core object spines, handoffs, blockers, and packaged-worker gates while keeping execution on `/worker` with inputs under `config` |
| Added production app-server worker execution smoke | Deploy now calls `POST /app-server` with `continuous.worker.command` for Revenue `lead.read`, proving the authenticated dynamic-tool bridge can execute a real worker command with `command`, `worker`, `idempotencyKey`, and `config` under `arguments` |
| Expanded headless Core writes | `POST /core` now supports `object.upsert`, `event.ingest`, `evidence.attach`, `document.create`, and `decision.record` with tenant-scoped idempotency and audit proof |
| Added Core graph and generated-view commands | `POST /core` now supports `object.link` and `view.publish`, so object relationships and renderer-neutral UI contracts are written through the same structured Core payload instead of seed-only data |
| Added Core task and approval controls | `POST /core` now supports `task.transition` and `approval.request`, so the headless platform can move task state and create pending approval packets without a worker-specific path; approval requests now reject changed-input replays |
| Added Core adapter and rule-change intents | `POST /core` now supports `adapter.intent.record` and `rule.change.record`, creating blocked adapter intent and rule-change proof records through the canonical Core envelope |
| Added Core external outcome recording | `POST /core` now supports `external_action.record`, recording receipt/outcome proof for payment instructions, payments, and filing drafts while updating the Core target state without executing external actions |
| Added Core connector setup commands | `POST /core` now supports `adapter.upsert` and `connection.upsert`, so adapter catalog rows and tenant-scoped pollable connections can be managed headlessly with audit proof and managed credential refs instead of manual DB edits |
| Added Core connection health proof | `POST /core` now supports `connection.health.record`, storing connector readiness checks for state, adapter status, blocked external execution, managed credential refs, source/provider metadata, read scopes, polling config, and scheduler cursor proof without exposing credential values |
| Added entity setup recording | `POST /core` now supports `entity.setup.record`, recording legal entity facts, identifiers, work locations, masked bank account refs, blocked payment instructions, workflow run/step proof, an entity setup packet, trace evidence, and audit proof without adding entity-specific URLs |
| Added Core worker lifecycle controls | `POST /core` now supports `worker.upsert` and `worker.transition`, creating synthetic/human/robot/service worker records, worker Core object/version metadata, lifecycle events, trace evidence, audit proof, replay fingerprints, and guarded state transitions without adding worker-family URLs |
| Added Core authority and budget controls | `POST /core` now supports `capability.grant`, `budget.reserve`, `budget.charge`, and `budget.release`, so worker authority and AI budget movement are platform-owned commands with audit and evidence |
| Added Core worker-run lifecycle controls | `POST /core` and `continuous.core.command` now support `worker.run.start` and `worker.run.complete`, binding worker role scope before dispatch, proving active capability grants and worker-owned budget reservations, writing worker-run event/audit/evidence proof, and keeping external execution blocked |
| Updated worker-run command scopes | Deploy, local, and host attestation token catalogs now include exact `core:worker.run.start`, `core:worker.run.complete`, `app_server:core.command.worker.run.start`, and `app_server:core.command.worker.run.complete` scopes so worker-run lifecycle access stays on the generic Core envelope |
| Documented worker-run boundary | Docs now distinguish registered worker business commands on `/worker` from the reusable Core `worker.run.start` and `worker.run.complete` ledger boundary, and production app-server schema smoke asserts both lifecycle commands are registered |
| Hardened Core authority and budget replay | `approval.request`, `capability.grant`, `budget.reserve`, `budget.charge`, and `budget.release` now store replay fingerprints and reject idempotency-key reuse with changed command input |
| Added durable evidence packets | `POST /core` now supports `packet.prepare` and `document.packet.prepare`, creating an `evidence_packets` record plus linked document, event, audit, and trace evidence for workflow review packets |
| Added shared approval inbox | `/approval` and `/approvals` expose a token-gated, subject-neutral approval inbox and decision surface on top of the shared `approval_requests`, `audit_events`, and evidence records |
| Expanded shared approval inbox detail | `/approval` now supports priority, risk, kind, state, and subject filters; approval records include evidence references and subject-aware continuation hints for worker, workflow, task, and Core decisions |
| Guarded canonical worker API surface | Contract tests now fail if worker-family-specific or `/api/*` control-plane route files appear; worker families must extend `/worker` through registered commands, `worker` selectors, `idempotencyKey`, and `config` payloads |
| Added planned-worker config schemas | `worker:tool schema` and `continuous.worker.schema` now expose non-executable `configSchema` metadata for follow-up commands and future Compliance commands before runtime handlers are added |
| Added customer-signal primitives | Satisfaction, feedback, complaint, testimonial, and review records persist as `CustomerSignal.type` rows, and `POST /core` `command=customer_signal.record` writes them with object links, note evidence, events, and audit proof |
| Added payroll preview kernel | Pay statements, payroll lines, payroll liabilities, and payroll calculation traces now persist as first-class Core tables; `POST /core` `command=payroll.preview.record` records preview artifacts with event, audit, and trace evidence while external execution stays blocked |
| Added payroll preview packet handoff | `POST /core` `command=payroll.preview.packet.prepare` gathers preview artifacts into variance reports, pay statement documents, approval packets, pending approval requests, and blocked payroll funding/tax draft records |
| Hardened Core payroll replay | `payroll.preview.record` and `payroll.preview.packet.prepare` now store replay fingerprints and reject idempotency-key reuse with changed payroll input |
| Added payroll approval handoff | Shared approval decisions for `payroll_preview_approval` now transition the payroll run plus funding, tax, filing, packet, audit, and evidence handoff records while keeping external execution, submission, and money movement blocked |
| Added Core AI gateway | `POST /core` now supports `command=ai.infer`, selecting an active model route, redacting configured request fields, reserving and charging budget, storing replay fingerprints, and writing inference, usage, event, audit, and evidence proof while live provider execution remains blocked |
| Hardened Core AI replay | `ai.infer` now stores a replay fingerprint over route selector, budget, actor/task/object/capability refs, raw input, redaction, and evaluation config, and rejects idempotency-key reuse with changed AI input |
| Clarified Revenue readiness semantics | `/worker` `view=readiness` now separates dry-run readiness from `launchReady`, and returns generic `launchGates` for live source coverage, connection health, scheduler cursor proof, controlled send credentials, receipt/rollback, and cash/payment handoff proof |
| Fixed Core worker command guard | `/core` now permits the canonical `worker.upsert` and `worker.transition` command namespace while still rejecting route-shaped and family-worker operation names |
| Agent build path uses app-server protocol tooling plus Next.js MCP | The installed Codex app-server CLI exposes protocol generation/help commands; `.mcp.json` keeps the Next.js 16 MCP bridge for route/runtime diagnostics |
| Added app-server worker command control | `continuous.worker.schema` exposes the registry, and `continuous.worker.command` invokes registered worker commands through the same `command`, `worker`, `idempotencyKey`, and `config` envelope without loading production tokens |
| Added app-server worker view control | `continuous.worker.view` reads registered worker views through the same `view`, `worker`, and `config` envelope as local worker tooling, so app-server can inspect snapshots and readiness without worker-family URLs |
| Matched local worker envelopes to `/worker` | `worker.command` and `continuous.worker.command` no longer accept top-level `operatorEmail`; trusted local execution uses `WORKER_OPERATOR_EMAIL`, authenticated app-server transport uses context, and payloads stay `command`, `worker`, `idempotencyKey`, and `config` |
| Added registry-owned worker config schemas | `/worker`, `worker:tool`, and `continuous.worker.command` now share per-command `configSchema` checks for required fields, enums, integer bounds, and non-empty arrays before handlers run |
| Tightened selector/config boundaries | Shared approval decisions now require `approval.subject` in the `approval` selector object instead of accepting `config.subject`, and worker view filters stay under `config` on local tool calls |
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
| Hardened split Revenue command guardrails | `lead.classify` and `response.draft` now have first-class eval cases and scoring; direct runtime calls reject empty config before synthetic lead defaults, `lead.read`/`lead.classify`/`response.draft` enforce budget policy and capacity, and connection-backed `lead.read` persists request hashes for replay-conflict detection |
| Protected operational artifacts during deploy sync | Deploy rsync still deletes stale source files, but now excludes `backups/`, `logs/`, and `reports/recovery-drills/` so local database dumps, Caddy/observability logs, and recovery evidence are not removed during a release |
| Added expansion readiness and handoff contracts | `docs/worker-readiness.md` tracks each worker against shared launch gates, and `docs/worker-handoffs.md` defines Core-record handoffs from Revenue into Owner, Dispatch, Finance, Workforce, Compliance, and Systems expansion paths |
| Rejected mixed worker intake sources | Revenue Worker now treats persisted `config.intake` Core row references as authoritative and rejects requests that also include direct `config.leadPacket` or `config.lead` payloads |
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
| Added token rotation attestations | `/core` now accepts `command=control_plane.token_rotation.attest` with rotation details inside `config`, persists append-only `control_plane_token_rotation_attestations`, stores replay fingerprints, links Core event/audit rows, and rejects raw token fields in the payload |
| Added managed control-plane credentials | `/core` now accepts `control_plane.credential.upsert`, `control_plane.credential.revoke`, and `control_plane.session.review`, storing scoped credential inventory with replay fingerprints, enforcing revoked/paused/expired managed credentials after catalog auth succeeds, and publishing safe operator session review views |
| Hardened control-plane credential replay | `control_plane.token_rotation.attest`, `control_plane.credential.upsert`, `control_plane.credential.revoke`, and `control_plane.session.review` now store replay fingerprints and reject idempotency-key reuse with changed control-plane input |
| Added deploy control-plane attestation | Production deploy now rotates and attests the bootstrap control-plane token, then smoke records the bootstrap credential inventory row, revokes a disposable drill credential, reviews recent operator sessions, and writes the non-secret evidence ids into `/etc/continuous/production-readiness.env` |
| Added token-rotation recovery behavior | If a prior deploy leaves the host half-rotated, the next deploy preserves the current bootstrap token instead of minting another un-attested token, then lets the fixed app and post-deploy credential attestation bring managed inventory back in sync |
| Added stale-fingerprint recovery guard | `control_plane.token_rotation.attest` and `control_plane.credential.upsert` can reconcile stale managed token fingerprints after catalog auth succeeds, while normal commands still reject mismatched fingerprints and stale rows must still allow the exact route, access, and route-qualified command |
| Added recovery drill harness | `scripts/recovery-drill.sh` composes tag-based app rollback and confirmation-gated database restore into one measured disposable-host drill, refuses known production hosts by default, and writes a local timing/compatibility report |
| Added recovery drill report attestation | `scripts/attest-recovery-drill.sh` copies a completed disposable-host drill report onto the production host, verifies the report shape and checksum through `scripts/attest-recovery-drill-on-host.sh`, and the strict readiness gate rechecks that artifact instead of trusting env markers alone |
| Added production observability checks | Caddy now writes retained JSON access logs, deploy creates log directories, and `scripts/check-observability-on-host.sh` verifies Compose service state, public health, TLS freshness, disk usage, Caddy logs, and optional backup/systemd checks with webhook failure alerts |
| Tightened control-plane config envelopes | `/worker`, `/core`, `/workflow`, and `/approval` now reject non-object `config` values instead of silently normalizing them to `{}` |
| Added production readiness gate | `scripts/check-production-readiness.sh` and the optional deploy workflow gate now compose strict observability, scheduled off-host backup freshness, object-storage backup manifests, alerting, recovery-drill attestation, token-rotation, managed credential, auth-audit record references, and non-root access attestation into one customer-data readiness check |
| Added non-root deploy access attestation | `scripts/install-non-root-access.sh` creates a dedicated deploy user, verifies app-dir and Docker Compose access without root, and records live-checked non-secret evidence for the strict readiness gate |
| Enabled non-root deploy smokes | The non-root installer now delegates the non-secret readiness env file to the deploy user, and control-plane attestation updates that file without requiring directory write access |
| Removed legacy worker env aliases | Compose services now use only generic `WORKER_*` names so worker runtime configuration is role-neutral |
| Hardened workflow and approval envelopes | `/workflow` and `/approval` now reject missing content type, malformed JSON, array bodies, and non-object `config` instead of normalizing malformed mutation requests to empty objects |
| Hardened control-plane POST body handling | `POST /core`, `/worker`, `/workflow`, and `/approval` now reject invalid bearer credentials before reading the request body, bound command bodies at 1 MiB, and record authenticated malformed-body attempts before returning body-shape errors |
| Required managed control-plane credential inventory | `/core`, `/worker`, `/workflow`, and `/approval` now require a persisted managed credential row with a token fingerprint after catalog auth succeeds, so missing inventory, unknown tenants, stale fingerprints, and fingerprintless rows fail closed before normal route dispatch; only Core token-rotation attestation and credential upsert remain bootstrap/recovery-compatible |
| Failed closed omitted catalog scopes | Control-plane token catalog entries without explicit route, access, or command scopes now fail authorization instead of inheriting wildcard control-plane access |
| Redacted scheduler cycle logs | Scheduler cycle logs now record command status, errors, and counts without raw worker/workflow result payloads that may contain customer or tenant data |
| Hardened route-scoped control-plane auth | The legacy `WORKER_RUN_TOKEN` fallback is now worker-route-only, non-worker routes use explicit catalog tokens in tests/docs, and all control-plane mutation routes require an exact `application/json` media type instead of substring content-type matching |
| Completed Core route dispatch proof | `app/core/route.test.ts` now proves successful `GET /core` summary plus `/core` dispatch for task, object, graph-link, event, evidence, document, packet, decision, approval, capability, budget, and generated-view commands through the canonical `command`/`core`/`idempotencyKey`/`config` envelope |
| Normalized worker ledger namespaces | Revenue, Owner, Dispatch, and Finance worker sources now write through `continuous.worker`, with event/schema names role-qualified under `worker.<role>.*` instead of worker-family-specific namespaces |
| Expanded app-server Revenue proof | The CI integration suite now runs Revenue `lead.classify`, `response.draft`, and `quote.prepare` through `continuous.worker.command`, scores the split-command eval fixtures, and verifies generic worker ledger records in addition to the existing app-server `lead.read -> run` proof |
| Constrained adapter auth metadata | `adapter.upsert` now normalizes `config.auth` to a non-secret `authMode`, rejects credential-shaped values, and emits only `authMode` in adapter responses, events, and audit records while managed credential refs stay on connections |
| Hardened split Revenue actions | `lead.read`, `lead.classify`, `response.draft`, and `quote.prepare` now check worker budget capacity before reserving units, and empty run/classify/draft/quote configs fail before any synthetic lead defaults or worker-run records are written |
| Hardened workflow approvals and local reads | `/workflow command=approval.decide` now requires the same top-level idempotency key discipline as other workflow mutations, local `worker.view` reads fail closed in production unless explicitly trusted, and deploy token scopes now include the registered Finance `payment_draft.prepare` command |
| Registered Revenue quote preparation | `POST /worker` and `continuous.worker.command` now expose `command=quote.prepare` as a first-class Revenue command using the shared `worker`, `idempotencyKey`, and `config` envelope; it writes quote-preparation run/evidence/approval/view proof, preserves legacy `run` replay hashes, and keeps external sends blocked |
| Registered Revenue payment-link preparation | `POST /worker` and `continuous.worker.command` now expose `command=payment_link.prepare` as a first-class Revenue command using invoice refs under `config`; it writes a blocked payment packet, payment instruction for verified bank accounts, stable payment review view, adapter receipt, workflow/budget/evidence/audit proof, and keeps live provider link creation and money movement blocked |
| Normalized payment-link API shape | `payment_link.prepare` accepts `config.invoiceId`, `config.invoiceObjectId`, or keyed `config.sourceRefs` through the canonical `/worker` envelope, with a stable `payment.approval.review` view key and per-run details stored in view data |
| Enforced non-root customer-data deploys | The GitHub deploy workflow now rejects `require_production_readiness=true` when `DEPLOY_USER=root`, then verifies the remote SSH session has a non-zero UID before repository sync, so strict/customer-data deploys cannot silently use the bootstrap root path |
| Fixed non-root rotation readiness writes | Deploy-time token rotation now updates a delegated `/etc/continuous/production-readiness.env` file in place instead of trying to chmod the system directory, so non-root deploys can keep token-rotation evidence current |
| Added runner-built release images | Normal GitHub DigitalOcean deploys now require a successful CI run for the exact commit, build app, migrate, and scheduler images on the runner, upload a checksum-verified release archive to the droplet, load those images, and start Compose with `--no-build` |
| Added app-server bridge route scope | `POST /app-server` is now treated as a separate control-plane route/audience for Codex dynamic tool calls; it authenticates `app_server:*` bridge commands, then passes scoped worker-registry context into `continuous.worker.command` or `continuous.worker.view` without accepting operator identity in payloads |
| Bounded deploy readiness smokes | Production deploy now times out Postgres and scheduler readiness checks with container logs, and host smoke probes `/health`, `/worker`, and `/app-server` with bounded curl calls so failures report quickly instead of waiting for the job cap |
| Prevented shallow smoke stdin drain | `scripts/smoke-production-on-host.sh` now closes stdin around its Postgres version probe so heredoc-driven deploy scripts continue into deeper credential, Core worker lifecycle, and worker runtime smokes |

### Tradeoffs

| Tradeoff | Notes |
|---|---|
| Single droplet versus managed Postgres | Simpler and cheaper now; the repo now has explicit backup/restore and object-retention wiring, but managed Postgres is still the right move when customer data needs managed backup/isolation guarantees |
| Docker verification | Docker is not running locally on this Mac, so full container verification is happening on the DigitalOcean droplet |
| Domain TLS | Caddy now serves `continuoushq.com` and `getcontinuous.app` over HTTPS and renews certificates automatically; decide whether to include `www` hostnames in `SITE_HOSTS` before serving those records |
| Bootstrap seed data | Seed records prove the substrate shape but are not customer fixtures |
| Deploy updates | The deploy script keeps Postgres and its volume in place, then builds and rolls the app/Caddy services after migrations and seed data |
| Migration runner | Drizzle Kit's container migrator failed silently, so `db:migrate` uses a small Bun/Postgres runner that records Drizzle migration history and refuses partial baselines |
| GitHub deploy access | The manual deploy workflow adds the current GitHub runner as a temporary SSH `/32` on the DigitalOcean firewall, then removes it at the end; strict customer-data mode now requires a non-root deploy user before sync |
| Strategy breadth versus current runtime | The running app is still a narrow persisted core demo; the updated strategy and docs now define the broader product surface that implementation should grow toward |
| Worker runtime mode | First worker run is a deterministic simulation that writes the durable loop, operator identity, approval request, and audit events without external sends or money movement |
| Worker selection | Runtime selection now accepts tenant or worker selectors and falls back only when a single active Revenue Worker exists |
| Worker run lifecycle | `worker_runs` is now the idempotent lifecycle boundary for Revenue Worker runs, with events kept as the audit log |
| Codex app-server boundary | The installed CLI can run over stdio or WebSocket and generate protocol bindings; keep Next MCP for Next.js diagnostics and keep app-server worker commands registry-backed rather than worker-family-specific. Remote bridges should pass authenticated transport context rather than operator identity in payloads |
| Recovery boundary | App-only rollback is tag-based and destructive database restore is dump-backed; the drill harness makes the app/database compatibility procedure repeatable, but it still must be run on a disposable droplet and attested from its report before customer data |
| Operator-token scope | The current production token now has hashed catalog metadata, per-command scope enforcement, durable auth session records, deploy-time token-rotation attestations, managed credential inventory, revocation enforcement, and operator session review views; broad use still needs broader operator review policy and customer-specific credential handling |
| Backup boundary | Production has a systemd Postgres backup timer plus DigitalOcean Spaces object-storage backup evidence; keep freshness checks passing before customer data |
| Alerting boundary | Deploy smoke now proves the host observability check, but recurring alerts are not complete until `scripts/install-observability-timer.sh` is run with a real `ALERT_WEBHOOK_URL` |
| Readiness boundary | The production readiness gate is strict and opt-in; it is expected to fail until observability timer/webhook, a verified recovery drill report, production connector credentials, and non-root deploy use are all actually provisioned and attested |
| Worker selector boundary | `/worker`, `worker.command`, and `continuous.worker.command` now treat `worker` as a strict selector object with only `role`, `id`, and `tenantSlug`; every operation-specific field must live under `config` |
| App-server worker argument boundary | `/app-server` now rejects worker command/view arguments that put operation fields beside `arguments.config` before dynamic dispatch, keeping remote tool calls aligned with `/worker` and `worker:tool` |
| Registered worker view schemas | Worker views now publish and enforce `configSchema` metadata alongside commands, so reads such as `obligations` and `packet` keep filters under `config` and reject unsupported fields before handler execution |
| Command body boundary | `/core`, `/worker`, `/workflow`, and `/approval` reject invalid credentials before body reads, cap command bodies at 1 MiB, and reject non-JSON, malformed JSON, and non-object command bodies after authentication instead of collapsing them into empty envelopes |
| Local mutation trust boundary | `worker.command` and `continuous.worker.command` require transport-provided `WORKER_OPERATOR_EMAIL` and are disabled under `APP_ENV=production` unless `CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true`; their payloads mirror `/worker`, and production automation should prefer the authenticated `/worker` route |
| Worker ledger namespace boundary | Role-specific worker behavior is carried by `worker.role`, event type suffixes, command names, and persisted payloads; sources stay generic as `continuous.worker` so new worker families do not require new source namespaces |
| Compliance launch boundary | The first Compliance slice can prepare filing packets and approval views, but live agency credentials, broader rule-source coverage, and receipt/rejection capture remain follow-ups before any submission path; legal advice remains blocked |
| Hardened command-scoped control-plane auth | Catalog-backed control-plane credentials now reject explicit blank commands when command scopes exist, managed credential command lists fail closed on missing command names, malformed catalog payloads have regression coverage, and `/worker` read payloads reject worker-family-specific selector drift |
| Unified worker HTTP envelopes | `/worker` now uses `POST` for both command and read controls: commands carry `command`, `worker`, `idempotencyKey`, and `config`, while reads carry `view`, `worker`, and `config`, with query-shaped worker reads rejected |
| Removed local worker operator fallback | `worker.command`, `worker.view`, `continuous.worker.command`, and `continuous.worker.view` never default or accept operator identity from payloads; local CLI calls require `WORKER_OPERATOR_EMAIL`, while authenticated app-server bridges pass operator identity through transport context |
| Removed runtime operator defaults | `WORKER_OPERATOR_EMAIL` no longer defaults in runtime config, catalog-backed credentials must carry their own `operatorEmail`, and the legacy bootstrap token path now fails closed unless deploy/local transport supplies an explicit operator |
| Required production catalog auth | Production `/core`, `/worker`, `/workflow`, and `/approval` auth now fails closed without a route-scoped token catalog, public routes no longer accept `x-worker-run-token`, and managed credential upserts bind identity to the authenticated credential instead of accepting `config.operatorEmail` |
| Hardened worker selector values | `/worker`, `worker.command`, and `continuous.worker.command` now reject malformed optional `worker.id` and `worker.tenantSlug` values instead of silently dropping wrong-type selectors |
| Hardened worker role naming | `/worker`, `worker.command`, `continuous.worker.command`, and direct registry calls now require lower_snake_case role selectors such as `revenue_operations`, rejecting route-like family-worker names before auth scope or runtime dispatch |
| Added release parity smoke | CI now runs against Postgres 17 and checks the live major version before lint/typecheck/test/build; deploy and rollback smokes reuse `scripts/smoke-production-on-host.sh` to prove production health, generic `/worker` auth, and host Postgres major parity before deeper worker smoke |
| Release image boundary | The GitHub deploy workflow now uses runner-built image archives with checksum verification and an exact-SHA CI success gate. It is not yet a registry-pushed immutable digest flow; `scripts/deploy.sh` also still keeps a host-build bootstrap/break-glass path |
| Deploy timeout boundary | The GitHub deploy workflow has bounded service readiness and smoke calls, but the strict customer-data gate remains opt-in until non-root deploy, observability, backup, recovery-drill, and credential evidence are all provisioned |
| Hardened Core/workflow failure coverage | `/core external_action.record` now has route-level invalid-idempotency, adapter mismatch, and replay-conflict coverage plus integration coverage for changed-input replay and adapter/connection mismatch; `/workflow` now preserves structured route failures across overview, approvals, start, transition, step execution, and approval decisions |

### Current State

The DigitalOcean stack is running on `45.55.53.92`. `continuoushq.com` and
`getcontinuous.app` both serve the app over HTTPS with Let's Encrypt
certificates. Continuous Core now has
persisted graph, task, capability, event, evidence, budget, adapter, authority,
document, decision, workflow, and generated UI primitives plus worker run lifecycle
records and `/`, `/health` (with `/api/health` kept as a compatibility alias),
`/approval`, `/approvals`, `/core`, and `POST /core` task,
task-transition, approval-request, capability-grant, budget-ledger, object,
object-link, event, evidence, document, packet, payroll preview, payroll packet,
decision, generated-view, AI inference, and control-plane credential/session
commands. Route tests now prove those canonical Core command dispatch paths,
including successful tenant-scoped `GET /core`; integration tests prove
changed-input replay rejection for the hardened Core command families.
Local
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

The canonical HTTP shape is `/worker` with explicit worker roles in payloads:
`POST /worker` with `view`, `worker`, and `config` for state and approval
queue reads, and `POST /worker` with `command`, `worker`, `idempotencyKey`, and
`config` for side-effecting operations. The route accepts only canonical worker
envelope fields, and rejects operation fields nested under `worker`; role, id,
and tenant selectors live under `worker`, while source records, approval ids,
retry limits, read filters, and direct fallback payloads live under `config`.
Adapter
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
envelope as operator calls. Each drain lane reports `succeeded` or `failed`;
workflow, polling, revenue handoff, retry, and reconciliation failures no
longer prevent the remaining lanes from running in that scheduler cycle.

Public health checks now prefer `/health`; deploy, rollback, restore, dashboard,
and observability references were moved to that route while `/api/health`
continues to respond for older probes.

Workforce readiness now includes existing employment objects updated by
`hire.packet.prepare`, so production deploy smoke can keep proving both hire
packet visibility and payroll readiness rows through the generic `/worker`
readiness view.

Compliance Operations is now documented as a first runtime slice on the generic
`/worker` envelope. The slice prepares filing draft packets and compliance
views from worker-payload `config`, keeps agency submission and legal advice
blocked, and leaves live credentials, rule-source breadth, and receipt capture
as the next launch gates.

Compliance filing preparation now writes the documented filing workflow spine:
filing draft preparation advances to validation, validation advances to
review-ready or blocked, and the approval-request step advances review-ready
packets to approval-pending while agency submission and legal advice remain
blocked.

Systems Operations is now documented as a first runtime slice on the generic
`/worker` envelope. The slice is limited to dry-run repair planning, permission
and automation review evidence, rollback packets, and blocked external
execution; it should not introduce systems-specific routes.

The expansion roadmap now has a concrete Revenue completion gate and a
post-Systems sequencing wave for Offer/Pricing, Customer Experience,
Asset/Supply, Growth, and vertical packaged workers. `docs/worker-handoffs.md`
also names the first Core-record handoff fixture each post-initial family must
prove before runtime promotion.

The top-level README now matches the implemented `/core` command catalog,
including entity setup, external action proof, and control-plane credential
attestation commands. Deployment docs now reflect the live firewall posture:
HTTP/HTTPS stay open, while SSH is opened only temporarily by the deploy
workflow.

Revenue Operations now exposes a generic `/worker` `view: "readiness"` read
surface. It reports worker registration, capability, budget, workflow, latest
dry-run proof, quote-review view refs, launch status, and source/credential
launch gates without adding Revenue-specific URLs or app-server tool names.

Offer and Pricing is now a runtime worker family, not just a planned catalog
candidate. Its first slice is `worker.role=offer_pricing_operations`,
`command=margin.review.prepare`, and `view: "price_policy"` on `/worker`,
consuming `revenue.quote_to_pricing` Core refs and writing pricing review
objects, packet/document/evidence, approval, workflow steps, generated view,
budget, and audit proof while price publish, quote mutation, and customer sends
stay blocked.

Offer and Pricing generated-view naming is pinned to the registered
`price_policy` view. Margin review and change-order review remain sections
inside that view until they are promoted as explicit registry entries, avoiding
dotted public view names that drift from `/worker` metadata.

The Offer and Pricing metadata accepts the full
`revenue.quote_to_pricing` source-ref packet, including quote, lead, customer,
evidence, approval, and workflow refs. Worker views also expose
`configSchema`, so `price_policy` callers can discover `config.quoteObjectId`
and `config.priceBookId` from `continuous.worker.schema`.

Offer and Pricing now has a seeded worker, capability grants, budget account,
pricing-margin workflow definition, quote-line fixture, margin rule, discount
policy, source quote evidence packet, runtime handler, integration test, and
deploy app-server smoke. The public view name is `price_policy`, and all
operation-specific inputs stay under `config`.

Customer Experience is now a runtime worker family, not just a planned catalog
candidate. Its first slice is `worker.role=customer_experience_operations`,
`command=recovery.draft`, and `view: "signals"` on `/worker`, consuming
`customer.signal_to_experience` Core refs and writing recovery objects,
packet/document/evidence, approval, workflow steps, generated `customer.signals`
view, budget, and audit proof while customer sends, refunds, concessions, and
review publishing stay blocked.

Managed control-plane credential inventory now fails closed when durable
tenant, route, access, command, or worker-role scope lists are omitted or empty.
This matches the deployment docs and prevents an empty managed credential row
from authorizing broad access after catalog auth succeeds.

Deploy app-server smoke now prints the parsed inner dynamic-tool result for
Offer/Pricing before asserting success. The transport remains the generic
`POST /app-server` and `continuous.worker.command` envelope, but runtime errors
now show the failing command, worker role, call id, and worker error in Actions
logs instead of only the outer `success:false` bridge envelope.

Deploy now prunes stopped containers, dangling Docker images, old app image
tags, build cache, container JSON logs, and stale release archive files before
uploading and loading release images. Docker cleanup calls are bounded so cleanup
cannot hang the rollout, while the target, current, and previous app tags stay
available for rollback on smaller droplets.

Worker command and view names now have an explicit shared operation identifier
guard across `/worker`, `/app-server`, local worker tools, app-server tools, and
direct registry dispatch. Canonical operations stay simple, such as `run`,
`lead.read`, `payment_draft.prepare`, and `price_policy`; URL-shaped names,
reserved route prefixes, and family-worker command names are rejected before
registry dispatch. Worker operation inputs still belong under `config` on
`/worker` and under `arguments.config` on the app-server bridge.

The one-shot Postgres backup operator script now streams backup configuration
to the remote host over stdin before invoking `backup-db-on-host.sh`. This keeps
S3-compatible object-storage credentials out of SSH command arguments while
preserving the verified dump, checksum sidecar, optional local copy, and object
storage upload path.

Revenue `payment_link.prepare` is now a registered `/worker` command, not a
follow-up placeholder or worker-specific route. It prepares a payment primitive,
payment instruction when a bank account exists, owner approval, generated
payment review view, workflow/budget/audit proof, and a dry-run adapter receipt
from invoice refs under `config`, while live provider payment-link creation and
money movement remain blocked.

`db:migrate` now takes a Postgres advisory lock before reading migration
history or applying files. CI can run integration suites against the same test
database in parallel, so the migration runner owns cross-process serialization
instead of requiring every worker test file to coordinate separately.

The code-owned worker contract metadata now uses the same nested invoice-ref
schema as the runtime registry for Revenue `payment_link.prepare`. Future
schema readers should see `config.invoiceId`, `config.invoiceObjectId`,
`config.sourceRefs.invoiceId`, or `config.sourceRefs.invoiceObjectId` as the
valid payment-link entry points, not a loose `sourceRefs` object.

The expansion map now distinguishes Growth's inbound and outbound handoffs:
`customer.signal_to_growth` opens Growth campaign drafting from customer or
review evidence, while `growth.campaign_to_owner_review` remains Growth's
owner-review output. Planned Customer Experience, Asset/Supply, Growth, and
Vertical Package command schemas now name the concrete Core refs and policy
flags expected by the contracts instead of exposing only broad object blobs.

Approval decisions now enforce the assigned reviewer when
`approval_requests.reviewer_user_id` is set. Tenant-scoped approval authority is
not enough to approve someone else's pending packet; the reviewer has to match
the active operator before Core, workflow, or worker state is mutated.

Control-plane credential upsert now compares requested durable scope against
the caller's authenticated catalog policy before persistence. `POST /core`
`command=control_plane.credential.upsert` rejects empty tenant, route, access,
or command scopes and refuses to mint credentials with routes, access modes,
commands, tenants, or worker roles outside the caller's own scope, so token
rotation and credential inventory cannot become a self-escalation path.

Queued workflows can now invoke registered worker commands through a generic
`worker_command` step kind. The workflow step carries `command`, `worker`, an
optional step-scoped `idempotencyKey`, and command `config` in its input; the
executor derives tenant scope from the claimed workflow tenant, rejects
cross-tenant targets, calls the shared worker registry directly, and records the
result on the workflow step, workflow run, and linked task outcome without
adding worker-family routes.

Live DigitalOcean state confirms DO-managed backups are enabled on
`continuous-01` and available backup images exist. Provisioning still needs an
explicit managed-backup verification step so newly created droplets do not rely
on manual post-create state.

The app-server bridge now exposes Core tools through the same generic dynamic
tool route as workers. `continuous.core.command`, `continuous.core.view`, and
`continuous.core.schema` keep Core target selection under `core`, operation
input under `config`, and operator/scope context server-side; Core app-server
authorization is tenant-scoped, while worker app-server authorization remains
tenant plus worker-role scoped. Credential and token-rotation administration
remains excluded from app-server dynamic tools. The local CLI entrypoint is now
the generic `app-server:tools` script instead of a worker-specific name.

Unexpected server-side failures on Core, Workflow, Approval, and Worker routes
now return generic 500-class messages instead of raw internal exception text.
Typed client/validation errors below 500 still preserve their specific code and
message, while Core summary failures, workflow step execution failures, and
worker view failures suppress raw internal details in API responses.

Production deploy and control-plane attestation catalogs now include exact
`app_server:core.*` scopes, and deploy smoke exercises Core schema, summary
view, and `task.create` command calls through `POST /app-server` before worker
app-server command smoke.

Revenue live-source readiness now distinguishes manual connection-backed
`lead.read` from scheduler-owned polling. The scheduler stamps non-secret
provenance under `config.scheduler`, Revenue persists that as
`lastLeadRead.schedulerProof`, and the readiness gate only treats
`scheduler_lead_read_cursor` as ready when the proof is verified for the
connection and scheduler idempotency key.
