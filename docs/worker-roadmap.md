# Worker Execution Roadmap

This roadmap turns the worker catalog into an implementation sequence. Each
worker must reuse Continuous Core primitives before it gets a new runtime path:
business graph, workflow runs and steps, approvals, capabilities, budget,
adapters, generated UI, evidence, and evals.

Use [Worker readiness matrix](worker-readiness.md) for the gate status and
[Worker handoff contracts](worker-handoffs.md) for the Core records that move
work from one worker family to the next.

## Shared Gates

| Gate | Required proof |
|---|---|
| Contract | V1 contract doc defines API payloads, object fields, workflows, capabilities, adapters, evidence, views, evals, and security boundaries |
| Command registry | Worker commands and generic local worker tools are registered with role, config validation, idempotency, tenant requirements, and external-execution status |
| Object map | Canonical records exist for the worker's operating flow |
| Workflow | Definition, seeded run, seeded step, approval policy, and evidence packet are persisted |
| Capabilities | Typed capability grants define read, draft, prepare, approve, and execute boundaries |
| Budget | Worker budget account, reservation path, usage event, and overage policy are present |
| Approval | Shared `approval_requests` route supports the worker's approval subject |
| Adapter | Dry-run action, receipt evidence, retry policy, reconciliation state, and retry/review system-task creation are present |
| Eval | Golden cases cover classification, missing facts, risk, cost, and approval behavior |
| UI | Generated approval, brief, exception, and evidence views can be rendered from data |
| Launch | Production smoke proves no external mutation without approval and receipt capture |

## Phase 1: Revenue Operations Worker

| Step | Exit condition |
|---|---|
| Lead source intake | `lead.read` persists website-form, authenticated-inbox, and CRM-style source records as Core object/event/evidence rows and returns stable selectors for `run` |
| Lead-to-cash simulation | Run creates task, worker run, workflow run/steps, budget reservation, inference, usage, adapter dry-run, approval, audit, evidence, object version |
| Workflow worker command drain | Queued `worker_command` steps invoke registered `/worker` commands from workflow data through a dedicated command-runner boundary outside workflow row locks, inherit the workflow tenant, reject cross-tenant targets, and record command output on the step/run/task ledger after reacquiring the step lease |
| Approval execution | Approval decision uses shared approval service, advances the allowed workflow state, quote approved continuation can record Core-approved `customer_message.send` receipts from `config.execution`, and payment-link continuation records blocked provider-link approval proof without changing the `/worker` envelope |
| Adapter hardening | Reconciliation writes audit/evidence records and retry/review system tasks; due dry-run retries execute with blocked receipts, live-credential readiness checks, and rollback plans; production provider execution remains gated |
| Payment-link preparation | `payment_link.prepare` writes a blocked payment packet, payment instruction when possible, owner approval, generated review view, dry-run adapter receipt, workflow, Core budget settlement, audit proof, and a dedicated approval continuation path from persisted invoice refs |
| Readiness view | `POST /worker` with `view: "readiness"` reports the worker, capability, budget, workflow, dry-run receipt, quote-review view, payment-review view when payment-link proof is latest, and generic launch gates |
| Eval harness | CI-enforced lead-to-quote cases prove classification, approval, budget, adapter receipt, and idempotency replay |
| First controlled send | Approved external message sends record through the Core `customer_message.send` execution boundary with adapter receipt and rollback/escalation evidence |

### Revenue Completion Gate

Revenue is the first worker proof only when these gates are all live in the
same deploy. The Core-approved `customer_message.send` receipt-recording path now
exists under `config.execution`; production provider sends still require real
scoped credentials and rollback playbooks before customer-data use.

| Gate | Required evidence |
|---|---|
| Source coverage | Production `lead.read` runs from at least one live inbox or CRM connection created through `/core connection.upsert`, with `/core connection.health.record` proof and scheduler cursor evidence |
| Quote and payment decision | `lead.classify`, `response.draft`, `quote.prepare`, `payment_link.prepare`, `run`, shared approval, quote continuation, and payment-link continuation all write worker run, workflow, approval, audit, evidence, budget, generated-view, and adapter records from persisted Core refs |
| Controlled send | An approved customer message send uses the Core execution boundary, a scoped managed credential, adapter receipt, rollback/escalation evidence, and replay rejection for changed input |
| Cash handoff | Approved quote or closeout records can hand Dispatch/Ops and Finance enough Core refs to prepare schedule, invoice, AR follow-up, and payment-draft packets without private payloads |
| Eval and deploy | CI evals plus production smoke prove no send, live provider payment-link creation, filing, payroll submission, or money movement happens without the matching approval, credential, receipt, and rollback gate |
| Readiness report | The generic `/worker` readiness view returns ready dry-run checks and explicit live credential blockers before customer-data use |

## Phase 2: Owner Chief-of-Staff Worker

Status: first read-only runtime slice is registered on `/worker` for
`brief.generate`, `decision_queue.prepare`, `anomaly.triage`, `snapshot`,
`briefs`, and `decisions`. Owner brief approvals now continue through the same
`command=continue` worker spine for publish, revision, and stale outcomes.
Remaining work is deeper stale-source handling and broader factuality evals
before promotion.

| Dependency | Implementation target |
|---|---|
| Shared graph summary | Cross-domain task, event, budget, obligation, approval, and worker run snapshot |
| Workflow | Daily brief and decision queue workflows with read-only evidence packets |
| Capabilities | `brief.generate`, `decision_queue.prepare`, `anomaly.triage`, `continue`, `approval.decide` |
| Adapters | Read-only email, calendar, accounting, CRM, payment, and job data |
| Launch gate | No mutation; owner brief factuality and missing-critical-item evals pass |

## Phase 3: Dispatch/Ops Worker

Status: first runtime slices are registered on `/worker` for
`schedule.propose`, `customer_update.draft`, `closeout.prepare`, and
`exception.route`. The
schedule command consumes a Revenue `revenue.quote_to_dispatch` handoff from
`config.sourceRefs`, writes an appointment object, promise-to-delivery workflow
run/steps, dry-run calendar adapter receipt, approval request, dispatch packet,
and `dispatch.schedule.review` generated view. The customer update command
consumes `config.jobId` plus `config.updateKind`, writes a blocked no-send
draft, evidence packet, approval request, and
`dispatch.customer_update.review` view. The closeout command consumes
`config.workOrderId` and keyed `config.sourceRefs`, writes a closeout object,
QA checklist, evidence packet, approval request, `dispatch.closeout.review`
view, and `dispatch.closeout_to_finance` handoff refs while invoice/payment
execution stays blocked. The exception command consumes `config.jobId`,
`config.reason`, `config.severity`, and optional keyed `config.sourceRefs`,
writes a blocked task, decision record, evidence packet, document, and workflow
steps, and keeps external recovery blocked. Remaining work is live
calendar/send credentials.

| Dependency | Implementation target |
|---|---|
| Core objects | Job, appointment, crew, asset, material, closeout, customer update |
| Workflow | Promise-to-delivery state machine with schedule proposal, customer update draft, closeout packet, and exception route |
| Capabilities | `schedule.propose`, `customer_update.draft`, `closeout.prepare`, `exception.route`, `approval.decide` |
| Adapters | Calendar dry-run, map/job system dry-run, customer-message approval |
| Launch gate | No customer update without approval; schedule conflicts create exception tasks |

## Phase 4: Finance Worker

Runtime slices are registered on `POST /worker` with
`command: "invoice.prepare"`, `command: "ar_followup.draft"`,
`command: "cash_forecast.generate"`, and `command: "payment_draft.prepare"`
for `worker.role: "finance_operations"`.
Invoice preparation consumes Dispatch closeout refs from `config.sourceRefs`,
creates an invoice draft, cash packet, approval request, and accounting dry-run
receipt. AR follow-up consumes persisted invoice refs from `config.invoiceId`,
creates a blocked draft, cash packet, approval request, and generated review
view. Cash forecast consumes forecast windows, account refs, and cash-driver inputs from
`config`, writes a cash forecast object, cash packet, approval request, and
generated review view. Payment draft consumes bill or payment selectors from
`config`/`config.sourceRefs`, writes a payment object, payment instruction
draft, cash packet, dual-control approval request, generated review view,
workflow, budget, and audit proof. These commands keep sends, payment links,
external execution, and money movement blocked. Remaining Finance work is
expense coding, live accounting/payment credential readiness, and dual-control
execution gates.

| Dependency | Implementation target |
|---|---|
| Core objects | Invoice, bill, expense, receipt, cash forecast, reconciliation item |
| Workflow | Invoice draft, AR follow-up, expense coding, payment draft |
| Capabilities | `invoice.prepare`, `ar_followup.draft`, `cash_forecast.generate`, `payment_draft.prepare`, `approval.request` |
| Adapters | Accounting/payment/bank feeds in draft mode with receipts |
| Launch gate | Money movement remains blocked behind dual-control approval and receipt capture |

## Phase 5: Workforce Worker

Status: first runtime slices are registered on `/worker` for
`command=hire.packet.prepare` and `command=payroll_input.prepare`, plus
payload `view: "readiness"`. The commands keep role, tenant, idempotency, and operation
inputs in the generic worker envelope, write workforce packet, document,
approval, workflow, budget, audit, and generated-view proof, and keep
restricted documents redacted while payroll submission and money movement stay
blocked. Remaining Workforce backlog: contractor packets, credential review,
schedule readiness, and live HR/payroll credential gates.

| Dependency | Implementation target |
|---|---|
| Core objects | Person, employment, contractor engagement, credential, compensation, document |
| Workflow | Hire employee, engage contractor, credential renewal, payroll input readiness |
| Capabilities | `hire.packet.prepare`, `payroll_input.prepare`, `contractor.packet.prepare`, `credential.review`, `schedule_readiness.prepare`, `approval.decide` |
| Adapters | Signature/docs, calendar, HRIS/payroll dry-run, email |
| Launch gate | Restricted documents and payroll blockers are visible without autonomous submission |

## Phase 6: Compliance Worker

Status: first runtime slice is registered on the generic `/worker` envelope for
`command=filing.prepare`, `command=approval.decide`, and the `snapshot`,
`obligations`, and `packet` views. Role and tenant selection stay under
`worker`; filing requirement, period, source refs, and validation options stay
under `config`. The slice prepares source-backed filing draft packets and
review views while agency submission and legal advice remain blocked. Remaining
Compliance work is notice response, license renewal, evidence binder export,
live agency credentials, broader rule sources, and
receipt/rejection capture.

| Dependency | Implementation target |
|---|---|
| Core objects | Rule pack, obligation, filing requirement, filing draft, notice, license, insurance |
| Workflow | Obligation intake, notice response, license renewal, filing draft, evidence export |
| Capabilities | `filing.prepare`, `approval.decide`, `snapshot`, `obligations`, `packet` |
| Adapters | Document stores, calendar, agency portal/manual upload, email |
| Launch gate | Submission and legal advice stay blocked until rule refs, approval, live credential scope, and receipt capture are proven |

## Phase 7: Systems Worker

Status: first runtime slice is promoted on the generic `/worker` envelope for
`worker.role=systems_operations`. The slice covers connector health, sync
repair planning, data-quality remediation proposals, permission review, and
automation planning while keeping all external connector writes, permission
changes, repair application, and automation enablement dry-run or blocked. It
does not add systems-specific HTTP routes; role selection stays under `worker`
and operation inputs stay under `config`.

| Dependency | Implementation target |
|---|---|
| Core objects | Adapter, connection, sync job, webhook, permission grant, data-quality issue |
| Workflow | Connector setup, sync repair, data-quality remediation, permission review |
| Capabilities | `connector.health.scan`, `sync.repair.plan`, `data_quality.remediate`, `permission.review`, `automation.plan`, `approval.decide` |
| Adapters | All platform adapters with scoped grants and rollback plans |
| Launch gate | Sync repair proves reconciliation and least-privilege scope before mutation |

## Phase 8+: Post-Systems Worker Waves

Systems is the platform reliability gate, not the end of the worker catalog.
After Systems can prove connector health, least-privilege scopes, sync repair,
data-quality remediation, and rollback evidence, expansion should move in
waves that compose the first seven workers instead of creating private APIs.

| Wave | Worker family | First packaged outcome | Entry gate |
|---|---|---|---|
| 8 | Offer and Pricing Worker | Runtime `margin.review.prepare` command and `price_policy` view for price book, quote-line, margin, and discount packets; change-order packets remain follow-up | Revenue quote evidence, margin rules, and approval policies are available as Core records |
| 9 | Customer Experience Worker | Runtime `recovery.draft` command and `signals` view for source-backed recovery packets; escalation and review-response packets remain follow-up | Revenue/Dispatch customer messages and customer-signal records have source evidence and approval posture |
| 10 | Asset and Supply Worker | Inventory, vendor, purchase, maintenance, and stockout packets | Dispatch closeout, Finance cash, and Systems sync refs prove asset/vendor state without purchase mutation |
| 11 | Growth Worker | Runtime `campaign.draft` command and `campaigns` view for source-backed campaign, channel, audience, content draft, and budget packets | Customer signal, review, budget, and source-claim evidence can block external publish/send/spend/tracking until approval |
| 12 | Vertical packaged workers | Quote-to-Cash Field, Knowledge Delivery, Inventory/Replenishment, Compliance QA, and Maintenance bundles | The package declares which existing family commands it composes, which Core refs are accepted, and which approvals block execution |

Post-Systems workers must still register commands on `/worker`, keep selectors
under `worker`, keep operation inputs under `config`, reuse shared approval and
evidence packets, and add at least one Core-record handoff fixture before any
runtime handler is promoted.

Offer and Pricing now has its first runtime slice after Systems:
`worker.role=offer_pricing_operations`, `command=margin.review.prepare`,
`view: "price_policy"`, the `revenue.quote_to_pricing` handoff fixture, and a
generated pricing review packet. Price publishing, customer sends, quote
mutation, and change-order execution remain blocked follow-up gates.

Customer Experience now has its first runtime slice:
`worker.role=customer_experience_operations`, `command=recovery.draft`,
`view: "signals"`, the `customer.signal_to_experience` handoff fixture, and a
generated customer-signals review packet. Customer sends, refunds, concessions,
review responses, and promise mutations remain blocked follow-up gates.

Growth now has its first runtime slice:
`worker.role=growth_operations`, `command=campaign.draft`,
`view: "campaigns"`, the `customer.signal_to_growth` handoff fixture, and a
generated campaign review packet. Publish, send, ad-spend, and tracking
mutations remain blocked until approval, source proof, budget proof, scoped
credentials, receipts, and rollback evidence are present.

## Expansion Rule

Do not add worker-specific HTTP routes. New worker families extend `/worker`
by registering role-scoped commands, config schemas, capability grants,
workflow definitions, approval policies, and evals. Promotion above autonomy
level 2 requires live adapter scopes, retry workers, reconciliation, approval
UI, receipts, and rollback evidence.
