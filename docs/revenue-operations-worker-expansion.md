# Revenue Operations Worker Expansion

The current Revenue Operations Worker is a deterministic persisted runtime. It proves
worker identity, capability grants, task ownership, Core worker-run budget
reservation and usage settlement, inference logging, event emission, evidence capture,
adapter receipts, approval requests, audit events, operator decisions, approval
state, workflow state, object versioning, and approved controlled-send receipt
recording without storing live credential material or moving money.

## Current Runtime

| Area | Current state |
|---|---|
| Worker identity | `Revenue Operations Worker`, autonomy level 2, owner-managed |
| Core loop | One operator run starts a Core worker-run lifecycle, creates workflow run/steps, source snapshot evidence, inference, event, adapter run/action, approval packet, task update, and object version records, then completes the Core run with budget settlement |
| Operator read views | `POST /worker` with payload `view: "snapshot"` or `view: "readiness"`, `worker.role: "revenue_operations"`, and read filters under `config`, bearer-token required; readiness reports dry-run proof, blockers, launch gates, and latest proof refs |
| Approval controls | `POST /worker` with payload `view: "approvals"` for reads and `command: "approval.decide"` for decisions, bearer-token required |
| Source read command | `POST /worker` with payload `command: "lead.read"`, `idempotencyKey`, `config.source`, optional `config.reader`, and direct `config.records[]` or an active connection reference; persists website-form, inbox, CRM, buffered connection, or read-only API-polled source records as Core lead object/event/evidence rows, updates connection cursor proof when connection-backed, and returns `config.intake` selectors |
| Split classify/draft commands | `POST /worker` with payload `command: "lead.classify"` or `command: "response.draft"`; both accept `config.intake` selectors or direct fallback `config.leadPacket`, use the Core worker-run lifecycle, write event/evidence/audit records, and keep external sends blocked |
| Quote prepare command | `POST /worker` with payload `command: "quote.prepare"`; accepts the same `config.intake` selectors or direct fallback `config.leadPacket`, uses the Core worker-run lifecycle, writes quote packet, approval, generated view, event/evidence/audit records, and keeps external sends blocked |
| Payment-link prepare command | `POST /worker` with payload `command: "payment_link.prepare"`; accepts persisted invoice refs under `config.invoiceId`, `config.invoiceObjectId`, or keyed `config.sourceRefs`, uses the Core worker-run lifecycle, writes a payment primitive, payment instruction when a bank account exists, packet, approval, generated view, workflow, event/evidence/audit, and dry-run adapter receipt while live provider link creation and money movement stay blocked; payment-link approval continuations stay payment-specific and still block provider execution |
| Run command | `POST /worker` with payload `command: "run"` and `config.intake` source selectors or Core references; direct `config.leadPacket` remains an operator/test fallback, and Core owns the worker-run row plus budget settlement |
| Continuation command | `POST /worker` with payload `command: "continue"`, `idempotencyKey`, and `config.approvalId`; the continuation starts and completes through the Core worker-run lifecycle, quote approved decisions default to blocked no-send execution packets, approved controlled-send receipts are recorded only when scoped quote/customer-message details are supplied under `config.execution`, payment-link approved decisions create blocked provider-link packets, `revision_requested` decisions create revised quote or payment-link packets plus fresh pending owner approval, and `rejected` decisions create closed no-send stop packets |
| Adapter reconciliation commands | `POST /worker` with payload `command: "adapters.reconcile"` or `command: "adapters.retry"`, tenant-scoped and bearer-token required |
| Scheduled internal drain | `worker-scheduler` posts `/workflow` `steps.execute`, `/worker` `lead.read` for pollable active connections, `/worker` `run` for returned intake selectors, `/worker` `adapters.retry`, and `/worker` `adapters.reconcile` on the internal Compose network with the same command envelopes |
| Workflow packet execution | Queued `packet_prepare` steps can prepare Core packets through `/workflow` execution, carrying packet content under `workflow_steps.input.packet` and writing packet/document/event/audit/evidence/task proof |
| Workflow approval execution | Queued `approval_request` steps can create shared workflow approval records through `/workflow` execution, carrying business approval details under `workflow_steps.input.approval` while run, step, task, event, audit, and evidence links are derived by the executor |
| Workflow worker command execution | Queued `worker_command` steps can invoke registered worker commands through `/workflow` execution; command name, worker role/id, idempotency key, and command config live in the step input, tenant scope is derived from the claimed workflow tenant, worker execution runs through a dedicated command-runner boundary outside workflow row locks, and outputs are recorded back to the step, run, and task after the step lease is reacquired |
| Quote approval UI | Revenue runs bind the shared `quote.approval.review` generated view contract to the latest quote approval request, including approval actions, evidence refs, and blocked continuation hints |
| Operator run | `bun run worker:tool worker.command` or `continuous.worker.command` with the same worker/config payload |
| Command registry | `/worker`, `worker.command` / `worker.view`, and app-server worker commands share role, config, idempotency, tenant, and external-execution validation |
| External execution | Blocked by default; source readers normalize supplied read-only records with credential references only, and adapter runtime records dry-run receipts, controlled-send receipts, reconciliation states, retry execution receipts, retry/review system tasks, and workflow-level retry/review/post-retry steps only |

`/worker` is the forward API. Worker role, tenant, operation config, and
idempotency belong in payload fields for mutation commands, not in
worker-family-specific URL paths. New worker families must register commands
and config schemas, not new HTTP route names. The mutation envelope accepts only
`command`, `worker`, `idempotencyKey`, and `config` as top-level fields;
worker selectors live under `worker`, and operation inputs live under `config`.
The `worker` object is limited to `role`, `id`, and `tenantSlug`.

## Expansion Gates

Do not increase autonomy until each gate has a persisted record and an operator
smoke test.

| Gate | Required proof |
|---|---|
| Auth | Configured operator user is bound to every side-effecting run and approval decision |
| Idempotency | Core `worker.run.start` / `worker.run.complete` owns first-class run lifecycle state for read/classify/draft/run/quote/payment-link/continue paths, with event idempotency kept as a compatibility guard |
| Budget | Core reservation before model/tool work and usage attribution after |
| Evidence | Source snapshot, prompt/result trace, approval, and adapter receipt |
| Approval | First-class `approval_requests`, approval decision evidence, audit trail, and allowed workflow advancement while external execution remains blocked |
| Adapter safety | Dry-run mode, receipt evidence, attempt metadata, reconciliation worker output, due retry execution, retry/review system tasks, workflow retry/review/post-retry states, live-credential readiness checks, rollback plans, and audit/evidence records are persisted; scoped live execution is still blocked |
| Eval | Golden lead/quote cases cover direct packets, Core row intake refs, source-selector intake, normal urgency, expected classification, approval, budget, adapter receipt, and idempotency outputs in CI |
| Launch | Production smoke proves no external mutation without approval and receipt capture |
| Readiness | `view: "readiness"` returns ready dry-run checks for the latest persisted quote-preparation proof, while source coverage, live credentials, receipt/rollback, and cash/payment gates remain explicit blockers until provisioned and proven |

## Next Capabilities

| Capability | Autonomy | Notes |
|---|---|---|
| `lead.read` | Allowed | Website-form, authenticated-inbox, CRM-style, buffered connection, and read-only API-polled source records normalize into persisted Core lead intake selectors; production credential provisioning and live-provider scheduler coverage still need operational proof |
| `lead.classify` | Allowed | Registered command now writes classification run, inference, usage, trace evidence, event, and audit proof |
| `response.draft` | Allowed | Registered command now writes draft run, inference, usage, draft evidence, event, and audit proof; external send remains blocked |
| `quote.prepare` | Allowed | Registered command prepares owner-reviewable quote packets, approval requests, generated quote views, and dry-run adapter receipts while external send remains blocked |
| `payment_link.prepare` | Human approval | Registered command prepares owner-reviewable blocked payment-link packets through the Core worker-run lifecycle; approval continuations write payment-link-specific approved/revision/rejected packets while live provider creation and money movement remain blocked |
| `schedule.propose` | Approval required | Do not commit external calendars yet |
| `invoice.prepare` | Approval required | Tie to job closeout evidence |

## Adapter Order

1. Website form intake with stored source snapshots. Present through `command: "lead.read"`.
2. Gmail or Google Workspace lead inbox source-reader records with credential references, read-only metadata, optional API polling, and no external execution.
3. CRM or spreadsheet lead source-reader records with credential references, read-only metadata, optional HubSpot-style API polling, and no live write-back.
4. Calendar availability read-only.
5. Quote/invoice system draft creation.
6. Stripe or payment provider preparation with human approval.

## Data To Add

| Data | Purpose |
|---|---|
| Price rules | Quote consistency, discount limits, margin floors |
| Service area and capacity | Lead qualification and scheduling |
| Customer history | Better context and duplicate detection |
| Message templates | Controlled outbound tone and compliance |
| Approval policies | Thresholds for price, discount, contract, schedule, and money movement |
| Eval cases | Regression tests for classification and next-action choices |

## UI Surfaces

| Surface | Purpose |
|---|---|
| Revenue brief input | Leads, quotes, cash, blocked work, and decisions needed for the Owner Chief-of-Staff worker |
| Quote approval | Scope, price, margin, evidence, draft response, approve/revise/reject |
| Exception console | Missing facts, budget overage, adapter failure, policy conflict |
| Evidence packet | Source message, inference trace, approval, receipt, object versions |
| Worker scorecard | Response time, quotes prepared, deposits collected, owner hours saved |

## Milestones

1. Provision production inbox/CRM credentials, enable pollable active connections, and monitor scheduled `lead.read` coverage behind the persisted source-reader shape.
2. Provision scoped live write credentials, tested rollback playbooks, and a first controlled send after the persisted retry readiness gate stays green.
3. Keep missing-fact, pricing override, and policy-risk eval fixtures green as the worker expands toward higher autonomy.
4. Raise autonomy only for Revenue read, classify, and draft capabilities; owner brief generation belongs to the Owner Chief-of-Staff worker.
