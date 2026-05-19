# Worker Execution Roadmap

This roadmap turns the worker catalog into an implementation sequence. Each
worker must reuse Continuous Core primitives before it gets a new runtime path:
business graph, workflow runs and steps, approvals, capabilities, budget,
adapters, generated UI, evidence, and evals.

## Shared Gates

| Gate | Required proof |
|---|---|
| Object map | Canonical records exist for the worker's operating flow |
| Workflow | Definition, seeded run, seeded step, approval policy, and evidence packet are persisted |
| Capabilities | Typed capability grants define read, draft, prepare, approve, and execute boundaries |
| Budget | Worker budget account, reservation path, usage event, and overage policy are present |
| Approval | Shared `approval_requests` route supports the worker's approval subject |
| Adapter | Dry-run action, receipt evidence, retry policy, and reconciliation state are present |
| Eval | Golden cases cover classification, missing facts, risk, cost, and approval behavior |
| UI | Generated approval, brief, exception, and evidence views can be rendered from data |
| Launch | Production smoke proves no external mutation without approval and receipt capture |

## Phase 1: Revenue Operations Worker

| Step | Exit condition |
|---|---|
| Lead-to-cash simulation | Run creates task, worker run, budget reservation, inference, usage, adapter dry-run, approval, audit, evidence, object version |
| Approval execution | Approval decision uses shared approval service and leaves external execution blocked |
| Adapter hardening | Live credentials are scoped, retries are durable, receipts reconcile, failure path creates tasks |
| Eval harness | CI-enforced lead-to-quote case proves classification, approval, budget, adapter receipt, and idempotency replay |
| First controlled send | Approved external message sends through adapter with receipt and rollback/escalation evidence |

## Phase 2: Owner Chief-of-Staff Worker

| Dependency | Implementation target |
|---|---|
| Shared graph summary | Cross-domain task, event, budget, obligation, approval, and worker run snapshot |
| Workflow | Daily brief and decision queue workflows with read-only evidence packets |
| Capabilities | `owner_brief.generate`, `approval.request`, `worker.read`, restricted reveal |
| Adapters | Read-only email, calendar, accounting, CRM, payment, and job data |
| Launch gate | No mutation; owner brief factuality and missing-critical-item evals pass |

## Phase 3: Dispatch/Ops Worker

| Dependency | Implementation target |
|---|---|
| Core objects | Job, appointment, crew, asset, material, closeout, customer update |
| Workflow | Promise-to-delivery state machine with schedule proposal and closeout packet |
| Capabilities | `schedule.propose`, `response.draft`, `document_packet.prepare`, `approval.request` |
| Adapters | Calendar dry-run, map/job system dry-run, customer-message approval |
| Launch gate | No customer update without approval; schedule conflicts create exception tasks |

## Phase 4: Finance Worker

| Dependency | Implementation target |
|---|---|
| Core objects | Invoice, bill, expense, receipt, cash forecast, reconciliation item |
| Workflow | Invoice draft, AR follow-up, expense coding, payment draft |
| Capabilities | `invoice.prepare`, `payment_link.prepare`, `ach_draft.prepare`, `approval.request` |
| Adapters | Accounting/payment/bank feeds in draft mode with receipts |
| Launch gate | Money movement remains blocked behind dual-control approval and receipt capture |

## Phase 5: Workforce Worker

| Dependency | Implementation target |
|---|---|
| Core objects | Person, employment, contractor engagement, credential, compensation, document |
| Workflow | Hire employee, engage contractor, credential renewal, payroll input readiness |
| Capabilities | `document_packet.prepare`, `payroll_preview.prepare`, `approval.request` |
| Adapters | Signature/docs, calendar, HRIS/payroll dry-run, email |
| Launch gate | Restricted documents and payroll blockers are visible without autonomous submission |

## Phase 6: Compliance Worker

| Dependency | Implementation target |
|---|---|
| Core objects | Rule pack, obligation, filing requirement, filing draft, notice, license, insurance |
| Workflow | Obligation intake, notice response, license renewal, filing draft, evidence export |
| Capabilities | `filing.prepare`, `document_packet.prepare`, `sensitive_data.reveal`, `approval.request` |
| Adapters | Document stores, calendar, agency portal/manual upload, email |
| Launch gate | Human approval required for submissions; every rule claim has a source ref |

## Phase 7: Systems Worker

| Dependency | Implementation target |
|---|---|
| Core objects | Adapter, connection, sync job, webhook, permission grant, data-quality issue |
| Workflow | Connector setup, sync repair, data-quality remediation, permission review |
| Capabilities | `worker.read`, `approval.request`, `document_packet.prepare` |
| Adapters | All platform adapters with scoped grants and rollback plans |
| Launch gate | Sync repair proves reconciliation and least-privilege scope before mutation |

## Expansion Rule

Do not add worker-specific HTTP routes. New worker families extend `/worker`
with role, command, config schema, capability grants, workflow definitions,
approval policies, and evals. Promotion above autonomy level 2 requires live
adapter scopes, retry workers, reconciliation, approval UI, and receipts.
