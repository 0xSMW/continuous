# Revenue Operations Worker Expansion

The current Revenue Worker is a deterministic persisted simulation. It proves
worker identity, capability grants, task ownership, budget reservation, usage,
inference logging, worker run lifecycle, event emission, evidence capture,
adapter receipts, approval requests, audit events, operator decisions, approval
state, workflow state, and object versioning without external sends or money movement.

## Current Runtime

| Area | Current state |
|---|---|
| Worker identity | `Revenue Operations Worker`, autonomy level 2, owner-managed |
| Core loop | One operator run creates workflow run/steps, worker run, source snapshot evidence, budget, inference, usage, event, adapter run/action, approval packet, task update, and object version records |
| Operator read API | `GET /worker?view=snapshot&role=revenue_operations`, bearer-token required |
| Approval API | `GET /worker?view=approvals&role=revenue_operations` and `POST /worker` with `command=approval.decide`, bearer-token required |
| Source read API | `POST /worker` with `command=lead.read`, `idempotencyKey`, `config.source`, and `config.records[]`; persists Core lead object/event/evidence rows and returns `config.intake` selectors |
| Run API | `POST /worker` with `command=run` and `config.intake` source selectors or Core references; direct `config.leadPacket` remains an operator/test fallback |
| Continuation API | `POST /worker` with `command=continue`, `idempotencyKey`, and `config.approvalId`; V1 turns `approved` decisions into blocked no-send execution packets, `revision_requested` decisions into revised packets plus fresh pending owner approval, and `rejected` decisions into closed no-send stop packets |
| Adapter reconciliation API | `POST /worker` with `command=adapters.reconcile` and `command=adapters.retry`, tenant-scoped and bearer-token required |
| Operator run | `bun run worker:tool worker.run` with the same worker/config payload |
| Command registry | `/worker` commands and `worker:*` local tool aliases share role, config, idempotency, tenant, and external-execution validation |
| External execution | Disabled; adapter runtime records dry-run receipts, reconciliation states, retry execution receipts, retry/review system tasks, and workflow-level retry/review/post-retry steps only |

`/worker` is the forward API. Worker role, tenant, operation config, and
idempotency belong in payload fields for mutation commands, not in
worker-family-specific URL paths. New worker families must register commands
and config schemas, not new HTTP route names. The mutation envelope accepts only
`command`, `worker`, `idempotencyKey`, and `config` as top-level fields;
worker selectors live under `worker`, and operation inputs live under `config`.

## Expansion Gates

Do not increase autonomy until each gate has a persisted record and an operator
smoke test.

| Gate | Required proof |
|---|---|
| Auth | Configured operator user is bound to every side-effecting run and approval decision |
| Idempotency | `worker_runs` owns first-class run lifecycle state, with event idempotency kept as a compatibility guard |
| Budget | Reservation before model/tool work and usage attribution after |
| Evidence | Source snapshot, prompt/result trace, approval, and adapter receipt |
| Approval | First-class `approval_requests`, approval decision evidence, audit trail, and allowed workflow advancement while external execution remains blocked |
| Adapter safety | Dry-run mode, receipt evidence, attempt metadata, reconciliation worker output, due retry execution, retry/review system tasks, workflow retry/review/post-retry states, and audit/evidence records are persisted; scoped live credentials are still blocked |
| Eval | Golden lead/quote cases with expected classification, approval, budget, adapter receipt, and idempotency outputs pass in CI |
| Launch | Production smoke proves no external mutation without approval and receipt capture |

## Next Capabilities

| Capability | Autonomy | Notes |
|---|---|---|
| `lead.read` | Allowed | Website-form source record intake is persisted; scoped external source readers come next |
| `lead.classify` | Allowed | Add eval set before real routing |
| `response.draft` | Allowed | Draft only until send policy exists |
| `quote.prepare` | Approval required | Keep threshold, discount, and margin rules explicit |
| `schedule.propose` | Approval required | Do not commit external calendars yet |
| `invoice.prepare` | Approval required | Tie to job closeout evidence |
| `payment_link.prepare` | Human approval | No autonomous money movement |

## Adapter Order

1. Website form intake with stored source snapshots. Present through `command=lead.read`.
2. Gmail or Google Workspace lead inbox read-only.
3. Calendar availability read-only.
4. CRM or spreadsheet write-back in dry-run mode.
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

1. Expand read-only real lead intake beyond website-form source records into authenticated inbox and CRM source readers.
2. Add quote approval UI backed by `ui_contracts`.
3. Extend blocked retry execution into scoped live credential checks and rollback paths for failed or uncertain adapter results.
4. Extend eval fixtures beyond the first CI-enforced lead-to-quote cases.
5. Raise autonomy only for Revenue read, classify, and draft capabilities; owner brief generation belongs to the Owner Chief-of-Staff worker.
