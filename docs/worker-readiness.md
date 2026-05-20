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

## Matrix

| Worker | Contract | Registry | Object Map | Workflow | Capabilities | Budget | Approval | Adapter | Eval | UI | Launch | Primary blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Revenue Operations | live | live | live | live | live | live | live | partial | live | partial | partial | Production connector credentials and approved external send remain blocked; scheduler polling needs real connection coverage | Provision production connector credentials, create pollable active connections through `/core connection.upsert`, record readiness through `/core connection.health.record`, then prove scoped adapter execution with receipt and rollback proof |
| Owner Chief-of-Staff | live | live | live | live | live | live | live | blocked | partial | partial | partial | Read-only factuality and stale-source handling need broader evals | Expand owner brief eval cases and generated review views before mutation-capable commands |
| Dispatch/Ops | planned | planned | planned | planned | planned | planned | planned | planned | planned | planned | planned | Needs Revenue-to-Dispatch job handoff fixture | Implement job/work-order object pack and calendar dry-run adapter fixture |
| Finance | planned | planned | planned | planned | planned | planned | planned | planned | planned | planned | planned | Needs Dispatch closeout and Revenue invoice/payment handoff fixtures | Implement cash packet fixture, AR follow-up workflow, and money-movement dual-control gate |
| Workforce | planned | planned | partial | partial | partial | partial | partial | planned | planned | planned | planned | Runtime is schema/seed backed only | Implement document packet fixture, payroll readiness workflow, and restricted-document proof |
| Compliance | planned | planned | partial | partial | planned | planned | partial | planned | planned | planned | planned | Needs Workforce classification and rule-source handoff fixture | Implement obligation/notice intake fixture and rule-source evidence checks |
| Systems | planned | planned | planned | planned | planned | planned | planned | partial | planned | planned | planned | Needs sync repair runtime and permission grant evidence; Core connection health snapshots now exist outside the Systems worker | Implement dry-run sync repair command and permission grant evidence |

## Promotion Rules

1. A worker may not move from `planned` to `live` until Contract, Registry,
   Object Map, Workflow, Capabilities, Budget, Approval, Adapter, Eval, UI, and
   Launch have named proof.
2. A worker may not execute external sends, filings, payroll, payments, or data
   writes outside Continuous until the Adapter and Launch gates are `live`.
3. Revenue remains the source of first worker proof. Future workers must consume
   its handoff contracts rather than inventing private object shapes.
4. Every promotion must update this matrix, the worker contract, and the
   applicable eval or deploy smoke in the same change.
