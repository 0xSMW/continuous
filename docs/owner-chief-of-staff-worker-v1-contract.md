# Owner Chief-of-Staff Worker V1 Contract

This contract defines the first read-only management worker. It turns the
Continuous Core graph into an owner brief, decision queue, anomaly list, and
routing plan without mutating external systems.

## Header

| Field | Value |
|---|---|
| Worker role | `owner_chief_of_staff` |
| First outcome | Daily owner brief and decision queue with evidence links |
| Autonomy level | `1` |
| External execution | `blocked` |

## API Shape

All commands and read views use `POST /worker`; no owner-specific route is
added. Operation inputs and read filters stay under `config`.

```json
{
  "command": "brief.generate",
  "worker": {
    "role": "owner_chief_of_staff",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "owner-brief-2026-05-19",
  "config": {
    "window": {
      "from": "2026-05-19T00:00:00.000Z",
      "to": "2026-05-20T00:00:00.000Z"
    },
    "scopes": ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
    "includeEvidence": true
  }
}
```

Approval continuations use the same payload shape:

```json
{
  "command": "continue",
  "worker": {
    "role": "owner_chief_of_staff",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "owner-brief-2026-05-19-continue",
  "config": {
    "approvalId": "approval-request-id"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "briefs"` payload | `worker.view` | `worker.role`, optional `config.state`, `config.from`, `config.to` | None | Read-only | Blocked |
| `brief.generate` | `worker.command` | `config.window`, `config.scopes[]` | Required | Core worker-run lifecycle, budget settlement, evidence, document, decision drafts, view publish | Blocked |
| `decision_queue.prepare` | `worker.command` | `config.window`, optional `config.priorityFloor` | Required | Core worker-run lifecycle, budget settlement, internal decision proposals, decision queue view | Blocked |
| `anomaly.triage` | `worker.command` | `config.window`, `config.metricKeys[]` | Required | Core worker-run lifecycle, budget settlement, metric evidence, internal review task, anomaly view | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | Required | Approval/task/workflow evidence only | Blocked |
| `continue` | `worker.command` | `config.approvalId` | Required | Publish, revise, or stale an owner brief from a decided approval | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `owner_brief` | `window`, `sections`, `sourceCounts`, `riskFlags`, `budgetBurn`, `generatedAt` | `draft`, `review_ready`, `published`, `stale` | `summarizes`, `uses_evidence`, `routes_to` |
| `decision` | `kind`, `priority`, `recommendation`, `deadline`, `options`, `rationale` | `proposed`, `approved`, `rejected`, `deferred` | `about_object`, `blocked_by`, `requires_approval` |
| `metric` | `key`, `value`, `unit`, `period`, `target`, `variance`, `sourceRefs` | `normal`, `watch`, `anomaly` | `measures`, `derived_from` |
| `task` | Existing Core task fields plus `ownerRef`, `dueAt`, `evidence.required`, `kpi` | Core task states | `routes_to`, `blocked_by`, `about_object` |
| `obligation` | `kind`, `dueAt`, `jurisdiction`, `status`, `risk`, `sourceRefs` | `open`, `blocked`, `review_ready`, `closed` | `requires_decision`, `about_entity` |
| `worker_run` | Existing worker run lifecycle fields | Existing worker run states | `produced_by`, `summarizes` |

Every object write must version through `object_versions`; every generated brief
must include immutable source ids for the records summarized.

`brief.generate`, `decision_queue.prepare`, and `anomaly.triage` all enter
through `/worker`, but their canonical run rows are owned by Core
`worker.run.start` and `worker.run.complete` with
`source = continuous.core.worker_runs`. Owner-specific events, evidence, audit,
objects, decisions, and generated views stay role-qualified business proof under
the Owner worker.

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `daily_owner_brief` | `draft -> source_review -> synthesis -> review_ready -> published` | `published` requires owner approval when sensitive reveal is used | Create `task.create` with `owner_brief_failure` |
| `decision_queue` | `draft -> scoring -> review_ready -> routed -> closed` | `routed` requires owner approval for priority changes | Create exception task for missing source refs |
| `anomaly_triage` | `draft -> metric_scan -> explanation_ready -> review_ready -> closed` | Approval required before routing to another worker | Mark anomaly `blocked` when evidence is incomplete |

Retry policy: three attempts for source reads and synthesis, no retries for
approval decisions, and idempotent replay by `idempotencyKey`.

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Tenant-scoped worker, task, event, evidence, budget, approval reads | No | Blocked |
| `owner_brief.generate` | 1 | Worker | Configured window and scopes | No unless sensitive reveal | Blocked |
| `decision_queue.prepare` | 1 | Worker | Tenant-scoped tasks, approvals, obligations, evidence, and decision proposals | Yes for route changes | Blocked |
| `anomaly.triage` | 1 | Worker | Tenant-scoped KPI, budget, task, obligation, and event evidence | Yes before routing to another worker | Blocked |
| `approval.request` | 2 | Worker | Owner decisions and route proposals | Yes for route changes | Blocked |
| `sensitive_data.reveal` | 1 | Worker | Redacted fields only unless explicitly approved | Yes | Blocked |

## Adapters

| Adapter | Read payload | Write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Email | Message metadata, unread counts, customer thread refs | None | Source ids and redaction map | Retry 3, then create source-read task |
| Calendar | Availability, conflicts, upcoming commitments | None | Calendar ids and time window | Retry 3, then mark calendar section incomplete |
| Accounting | Cash, AR/AP, invoice status | None | Ledger refs and balance timestamp | Retry 2, then mark cash confidence low |
| CRM/jobs | Lead, job, closeout, capacity snapshots | None | Object refs and stale-source flag | Retry 3, then route Systems Worker task |
| Payments | Deposit, payout, failed payment reads | None | Payment ids and no-money-movement proof | Retry 2, then require manual review |

## Evidence Packet

`owner_brief_packet` contains:

- Source snapshot evidence for each section.
- Metric trace evidence with calculation inputs and redactions.
- Decision rationale evidence for every proposed owner action.
- Budget usage evidence for generation cost.
- A generated document `owner_brief` in `review_ready` state.

Sensitive fields are redacted by default: bank account numbers, payroll details,
tax identifiers, worker documents, customer payment tokens, and private message
bodies.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `owner.brief.review` | `owner_brief` | `approve_brief`, `route_task`, `request_revision` | `no_sources`, `source_partial`, `stale` |
| `owner.decision.queue` | `decision` | `approve`, `reject`, `defer`, `assign` | `empty`, `blocked_by_missing_evidence` |
| `owner.anomaly.review` | `metric` | `acknowledge`, `route_to_worker`, `snooze` | `no_anomalies`, `source_unavailable` |

## Evals

Golden cases must cover factual brief synthesis, missing critical item
detection, stale source handling, budget pressure, sensitive data redaction,
idempotent replay, and no external mutation.

## Security

Tenant isolation is enforced by tenant-scoped reads and source refs. Prompt
injection from emails, notes, CRM fields, or documents must be treated as
untrusted source content and quoted only inside evidence. Sensitive reveal needs
approval and audit. Abuse cases: hiding cash risk, fabricating anomalies,
over-routing tasks, exposing employee/customer private data, or treating a
brief recommendation as an approved action.
