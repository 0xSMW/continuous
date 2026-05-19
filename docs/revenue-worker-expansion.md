# Revenue Worker Expansion

The current Revenue Worker is a deterministic persisted simulation. It proves
worker identity, capability grants, task ownership, budget reservation, usage,
inference logging, worker run lifecycle, event emission, evidence capture,
adapter receipts, approval requests, audit events, operator decisions, approval
state, and object versioning without external sends or money movement.

## Current Runtime

| Area | Current state |
|---|---|
| Worker identity | `Revenue Operations Worker`, autonomy level 2, owner-managed |
| Core loop | One operator run creates worker run, budget, inference, usage, event, evidence, adapter action, task update, and object version records |
| Operator read API | `GET /api/revenue-worker`, bearer-token required |
| Approval API | `GET /api/revenue-worker/approvals` and `POST /api/revenue-worker/approvals/:id`, bearer-token required |
| Run API | `POST /api/revenue-worker/run`, disabled by default and bearer-token gated when enabled |
| Operator run | `bun run worker:revenue -- --idempotency-key=<key>` |
| External execution | Disabled; adapter action records simulated receipts only |

## Expansion Gates

Do not increase autonomy until each gate has a persisted record and an operator
smoke test.

| Gate | Required proof |
|---|---|
| Auth | Configured operator user is bound to every side-effecting run and approval decision |
| Idempotency | `worker_runs` owns first-class run lifecycle state, with event idempotency kept as a compatibility guard |
| Budget | Reservation before model/tool work and usage attribution after |
| Evidence | Source snapshot, prompt/result trace, approval, and adapter receipt |
| Approval | First-class `approval_requests`, approval decision evidence, and audit trail |
| Adapter safety | Scoped credentials, dry-run mode, receipts, retries, and reconciliation |
| Eval | Historical lead/quote cases with expected classification and action outputs |

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

1. Convert the deterministic run into a small state machine.
2. Add read-only real lead intake.
3. Add quote approval UI backed by `ui_contracts`.
4. Add dry-run adapter execution with reconciliation.
5. Add eval fixtures and CI checks for lead classification and quote decisions.
6. Raise autonomy only for read, classify, draft, and owner brief capabilities.
