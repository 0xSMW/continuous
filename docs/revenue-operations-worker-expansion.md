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
| Run API | `POST /worker` with `command=run` and `config.intake` Core references; direct `config.leadPacket` remains an operator/test fallback |
| Continuation API | `POST /worker` with `command=continue`, `idempotencyKey`, and `config.approvalId`; V1 turns `revision_requested` decisions into a revised no-send packet, persisted document/evidence packet, and fresh pending owner approval |
| Adapter reconciliation API | `POST /worker` with `command=adapters.reconcile`, tenant-scoped and bearer-token required |
| Operator run | `bun run worker:tool worker.run` with the same worker/config payload |
| Command registry | `/worker` commands and `worker:*` local tool aliases share role, config, idempotency, tenant, and external-execution validation |
| External execution | Disabled; adapter runtime records dry-run receipts, reconciliation states, and retry/review system tasks only |

`/worker` is the forward API. Worker role, tenant, operation config, and
idempotency belong in payload fields for mutation commands, not in
worker-family-specific URL paths. New worker families must register commands
and config schemas, not new HTTP route names.

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
| Adapter safety | Dry-run mode, receipt evidence, attempt metadata, reconciliation worker output, retry/review system tasks, and audit/evidence records are persisted; scoped live credentials are still blocked |
| Eval | Golden lead/quote cases with expected classification, approval, budget, adapter receipt, and idempotency outputs pass in CI |

## Next Capabilities

| Capability | Autonomy | Notes |
|---|---|---|
| `lead.read` | Allowed | Connect real inbound source after scoped auth |
| `lead.classify` | Allowed | Add eval set before real routing |
| `response.draft` | Allowed | Draft only until send policy exists |
| `quote.prepare` | Approval required | Keep threshold, discount, and margin rules explicit |
| `schedule.propose` | Approval required | Do not commit external calendars yet |
| `invoice.prepare` | Approval required | Tie to job closeout evidence |
| `payment_link.prepare` | Human approval | No autonomous money movement |
| `owner_brief.generate` | Allowed | Daily summary can be low-risk and read-only |

## Adapter Order

1. Website form intake with stored source snapshots.
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
| Owner brief | Leads, quotes, cash, blocked work, decisions needed |
| Quote approval | Scope, price, margin, evidence, draft response, approve/revise/reject |
| Exception console | Missing facts, budget overage, adapter failure, policy conflict |
| Evidence packet | Source message, inference trace, approval, receipt, object versions |
| Worker scorecard | Response time, quotes prepared, deposits collected, owner hours saved |

## Milestones

1. Extend the Revenue Worker state machine with retry, failure, reconciliation, and approved-execution continuation branches without enabling external execution.
2. Expand read-only real lead intake beyond Core object/event/evidence references into connected source readers.
3. Add quote approval UI backed by `ui_contracts`.
4. Extend persistence-only reconciliation tasks into live retry execution paths for failed or uncertain adapter results.
5. Extend eval fixtures beyond the first CI-enforced lead-to-quote cases.
6. Raise autonomy only for read, classify, draft, and owner brief capabilities.
