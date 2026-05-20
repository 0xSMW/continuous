# Worker Readiness Matrix

This matrix turns the worker roadmap into launch gates. A worker can be coded
only after its contract row is explicit, and it can be promoted only when the
proof column points to current code, tests, deploy smoke, or a named blocker.

Status values:

- `live`: implemented and exercised in CI or deploy smoke.
- `partial`: implemented for the first slice, but missing a named launch gate.
- `planned`: contract exists, runtime is not registered.
- `blocked`: requires credentials, approval UI, external execution policy, or
  production-readiness evidence before promotion.

## Gate Legend

| Gate | Required proof |
|---|---|
| Contract | V1 contract doc names `/worker` command envelopes, Core writes, workflow, capabilities, adapter posture, evidence, generated views, evals, and security boundaries |
| Registry | Runtime command/view metadata is registered, or planned metadata exists for non-runtime workers |
| Object Map | Canonical Core objects and links needed by the worker are named and seeded or produced by commands |
| Workflow | Workflow definition, run/step shape, approval step, and terminal states are defined |
| Capabilities | Typed capability keys and grants define read, draft, prepare, approve, and execute boundaries |
| Budget | Budget account, reservation, usage event, and overage posture are present |
| Approval | Shared approval inbox can carry the worker's subject, decision, and continuation shape |
| Adapter | Dry-run adapter intent/receipt/retry/reconciliation exists; live execution gate is named |
| Eval | Golden cases or deploy smoke prove key behavior and idempotency |
| UI | Generated views or route output are sufficient for operator review |
| Launch | Production smoke or readiness gate proves the worker can run without unauthorized external mutation |
| Proof | Current files, tests, or deploy smoke that substantiate the row status |

## Matrix

| Worker | Contract | Registry | Object Map | Workflow | Capabilities | Budget | Approval | Adapter | Eval | UI | Launch | Proof | Primary blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Revenue Operations | live | live | live | live | live | live | live | partial | live | partial | partial | `docs/revenue-operations-worker-v1-contract.md`; `src/worker/revenue.ts`; `src/worker/revenue.integration.test.ts`; `app/worker/route.test.ts`; deploy smoke in `.github/workflows/deploy.yml` for `lead.read`, `lead.classify`, `response.draft`, `quote.prepare`, `run`, approval continuation, adapter retry/reconcile, and blocked external execution | Production connector credentials and approved external send remain blocked; scheduler polling needs real connection coverage | Provision production connector credentials, create pollable active connections through `/core connection.upsert`, record readiness through `/core connection.health.record`, then prove scoped adapter execution with receipt and rollback proof |
| Owner Chief-of-Staff | live | live | live | live | live | live | live | blocked | partial | partial | partial | `docs/owner-chief-of-staff-worker-v1-contract.md`; `src/worker/owner.ts`; `src/worker/planned-workers.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke in `.github/workflows/deploy.yml` for `brief.generate` and shared approval continuation | Read-only factuality and stale-source handling need broader evals | Expand owner brief eval cases and generated review views before mutation-capable commands |
| Dispatch/Ops | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | `docs/dispatch-operations-worker-v1-contract.md`; `src/worker/dispatch.ts`; `src/worker/tools.test.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke in `.github/workflows/deploy.yml` for `schedule.propose`, `customer_update.draft`, `closeout.prepare`, and `exception.route` | `schedule.propose`, `customer_update.draft`, `closeout.prepare`, and `exception.route` are registered and CI-covered; live calendar/customer-send credentials remain blocked | Prove scoped live calendar/customer-send execution gates before launch |
| Finance | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | `docs/finance-operations-worker-v1-contract.md`; `src/worker/finance.ts`; `src/worker/tools.test.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke in `.github/workflows/deploy.yml` for `invoice.prepare`, `ar_followup.draft`, `cash_forecast.generate`, and `payment_draft.prepare` | `invoice.prepare`, `ar_followup.draft`, `cash_forecast.generate`, and `payment_draft.prepare` are registered and produce cash packets from Dispatch closeouts, invoice evidence, account/cash-driver inputs, and bill/payment selectors; `expense_code.propose` is planned but not runtime-registered; live accounting/payment credentials, bank adapter readiness, and dual-control execution gates remain blocked | Implement expense-coding receipt fixture, live-accounting/payment readiness checks, and dual-control execution gates without adding finance-specific routes |
| Workforce | partial | partial | partial | partial | partial | partial | partial | blocked | partial | partial | partial | `docs/workforce-operations-worker-v1-contract.md`; `src/worker/workforce.ts`; `src/worker/planned-workers.ts`; `src/db/seed.ts`; `src/worker/tools.test.ts`; `src/worker/app-server-tools.test.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke in `.github/workflows/deploy.yml` for `hire.packet.prepare`, `payroll_input.prepare`, and `readiness` | `hire.packet.prepare` and `payroll_input.prepare` are registered and write workforce packets, restricted-document proof, payroll blockers, approvals, generated views, workflow/budget/audit proof; contractor, credential, and schedule readiness commands plus live HR/payroll credentials remain blocked | Implement contractor packet, credential review, schedule readiness, and live credential readiness gates without adding workforce-specific routes |
| Compliance | planned | planned | partial | partial | planned | planned | partial | planned | planned | planned | planned | `docs/compliance-operations-worker-v1-contract.md`; `src/worker/planned-workers.ts`; seeded obligation/rule workflow records in `src/db/seed.ts`; handoff contract in `docs/worker-handoffs.md`; contract coverage in `src/worker/worker-contracts.test.ts` | Needs Workforce classification and rule-source handoff fixture | Implement obligation/notice intake fixture and rule-source evidence checks |
| Systems | planned | planned | planned | planned | planned | planned | planned | partial | planned | planned | planned | `docs/systems-operations-worker-v1-contract.md`; `src/worker/planned-workers.ts`; Core connection health primitives in `src/core/primitives.ts`; deploy smoke in `.github/workflows/deploy.yml` for `connection.upsert` and `connection.health.record`; contract coverage in `src/worker/worker-contracts.test.ts` | Needs sync repair runtime and permission grant evidence; Core connection health snapshots now exist outside the Systems worker | Implement dry-run sync repair command and permission grant evidence |

## Promotion Rules

1. A worker may not move from `planned` to `live` until Contract, Registry,
   Object Map, Workflow, Capabilities, Budget, Approval, Adapter, Eval, UI, and
   Launch have named proof.
2. A worker may not execute external sends, filings, payroll, payments, or data
   writes outside Continuous until the Adapter and Launch gates are `live`.
3. Revenue remains the source of first worker proof. Future workers must consume
   its handoff contracts rather than inventing private object shapes.
4. Every promotion must update this matrix, the Proof column, the worker
   contract, and the applicable eval or deploy smoke in the same change.
