# Core Platform Setup

Continuous Core is the operating substrate for agentic workers. The setup goal
is to make SMB work legible, governable, budgeted, observable, and executable
through typed capabilities.

## Product Shape

Continuous is a headless worker platform with three planes:

| Plane | Purpose |
|---|---|
| Continuous Core | Business graph, event log, task ledger, workflows, rules, capabilities, adapters, generated UI, and evidence |
| Continuous AI Gateway | Model routing, intelligence budgets, usage ledger, redaction, provider controls, worker authorization, and evals |
| Continuous Workers | Packaged agentic workers with missions, tools, scopes, budgets, approvals, KPIs, and evidence |

The first complete platform slice is:

```text
Continuous Core canonical operating layer + first open workflows
```

Revenue Operations remains the first customer-facing worker demo, but it sits on
top of a broader core. The core must be able to represent entity, workforce,
payroll, filings, compliance, payments, AI operations, generated UI, and
evidence before packaged workers can safely act.

## Core Components

| Component | Setup responsibility |
|---|---|
| Business graph | Store canonical business objects and relationships across customers, work, money, systems, workers, and obligations |
| Event log | Record every meaningful internal and external event in replayable order |
| Task ledger | Represent accountable work with owner, due date, state, capability, evidence, outcome, cost, and KPI impact |
| Workflow engine | Run durable state machines across humans, agentic workers, approvals, adapters, and external systems |
| Rule engine | Execute policy, pricing, risk, workflow, and vertical rules without burying them in worker prompts |
| Capability registry | Define every action as a typed capability with scope, side effects, risk level, schemas, and approval policy |
| AI gateway | Route model calls, reserve and charge budget, redact data, enforce provider policy, and record eval signals |
| Adapter runtime | Connect to systems of action with retries, idempotency, receipts, reconciliation, and scoped credentials |
| Generated UI | Produce structured views for approvals, briefs, queues, exceptions, evidence, budgets, and scorecards |
| Evidence layer | Capture receipts, snapshots, approvals, traces, versions, exports, and audit packets |

## Canonical Operating Layer

| Domain | First objects |
|---|---|
| Entity | Entity, EntityIdentifier, EntityParty, EntityRegistration, AgencyAccount, TaxAccount |
| Location | Location, Establishment, TaxNexusProfile |
| Workforce | Person, Worker, WorkRelationship, Position, ManagerAssignment, EmploymentStatusEvent |
| Compensation | CompensationAgreement, CompensationLine, DeductionAuthorization |
| Payroll | PaySchedule, PayPeriod, PayrollRun, PayStatement, PayrollLine, PayrollLiability, PayrollTrace |
| Time and leave | Schedule, TimeEntry, Timesheet, PTOPolicy, PTOBalance, LeaveCase |
| Filings | FilingRequirement, FilingCase, FilingArtifact, AgencyNotice |
| Payments | BankAccount, PaymentInstruction, PaymentTransaction, PaymentBatch, PaymentEvent, TaxDeposit |
| Documents | Document, DocumentTemplate, SignatureRequest, SignatureEvent, RetentionPolicy |
| AI operations | Worker, ModelRoute, IntelligencePool, BudgetAccount, BudgetAllocation, BudgetReservation, UsageEvent |
| Evidence | AuditEvent, EvidencePacket, EvidenceItem |

## Bootstrap Order

1. Define canonical object names and relationships for the MVP business graph.
2. Create the event log and task ledger as the first durable write surfaces.
3. Add the capability registry before any worker can mutate external state.
4. Add worker identity, mission, scope, manager, autonomy level, memory scope, and KPI definitions.
5. Add AI gateway budget accounts, model routes, usage events, reservations, and eval events.
6. Add generated UI contracts for owner briefs, lead reviews, quote approvals, task queues, and budget dashboards.
7. Add adapters for Gmail or Google Workspace, calendar, QuickBooks, Stripe, website forms, and one CRM or spreadsheet path.
8. Add evidence capture for messages, drafts, quote versions, approvals, sent receipts, invoices, and follow-ups.
9. Add eval harnesses using historical lead and quote simulations before increasing autonomy.
10. Add vertical packs only after the core Revenue Worker loop is stable.

## MVP Object Set

The first core slice should keep names direct and inferable:

| Area | Initial objects |
|---|---|
| Customer | Customer, Contact, CustomerSignal |
| Revenue | Lead, Opportunity, Offer, PriceRule, Quote, Proposal, Contract, Booking, Invoice, PaymentTransaction |
| Entity | Entity, EntityIdentifier, EntityParty, Location, AgencyAccount, TaxAccount |
| Workforce | Person, Worker, WorkRelationship, Position, Schedule, CompensationAgreement |
| Payroll | PaySchedule, PayPeriod, PayrollRun, PayStatement, PayrollLine |
| Compliance | RulePack, RuleVersion, Obligation, FilingRequirement, ThresholdMonitor |
| Filings | FilingCase, FilingArtifact, AgencyNotice |
| Payments | BankAccount, PaymentInstruction, PaymentBatch, PaymentTransaction, PaymentEvent |
| Documents | Document, DocumentTemplate, SignatureRequest, SignatureEvent, RetentionPolicy |
| Worker | Worker, Mission, Skill, Capability, CapabilityGrant, ToolCredential, MemoryScope, BudgetAccount, Evaluation |
| AI gateway | ModelProvider, ModelRoute, IntelligencePool, BudgetAccount, BudgetAllocation, BudgetReservation, UsageEvent |
| Systems | Connector, ExternalAccount, Webhook, SyncJob, DataQualityIssue |
| Governance | Policy, PolicyBinding, ApprovalPolicy, ApprovalRequest, Decision, RiskLevel, PermissionGrant, CapabilityGrant, AuditEvent, BudgetAllocation |
| Evidence | EvidencePacket, EvidenceItem |

## Task Ledger Requirements

Every worker action should become one or more durable records:

| Record | Required when |
|---|---|
| Task | Work is created, assigned, blocked, approved, completed, canceled, or escalated |
| WorkerRun | A worker is invoked by an operator, workflow, schedule, adapter, or policy trigger |
| Event | Something meaningful happened in Continuous or an external system |
| Decision | A human, worker, rule, or model selected one action over alternatives |
| Evidence | Proof is needed for trust, audit, support, evals, or reconstruction |

Minimum task fields:

| Field | Meaning |
|---|---|
| `task_id` | Stable identifier |
| `business_object_ref` | Lead, quote, job, invoice, worker, filing, or other object |
| `trigger_event_ref` | Event that caused the task |
| `owner_ref` | Human or worker responsible |
| `reviewer_ref` | Approval owner when required |
| `due_at` | Deadline |
| `priority` | Severity and business impact |
| `state` | Draft, active, waiting, approval_required, blocked, done, or canceled |
| `capability_ref` | Capability needed to complete the task |
| `evidence_required` | Proof required before completion |
| `outcome` | Completed result |
| `cost` | AI budget and human time cost |
| `kpi_impact` | Revenue, cash, time saved, risk avoided, or quality impact |

## Capability Rules

Workers must receive typed capability grants, not raw system credentials.

Default autonomy by capability class:

| Class | Default |
|---|---|
| Read | Allowed within declared scope |
| Classify | Allowed |
| Draft | Allowed |
| Recommend | Allowed |
| Create internal task | Allowed |
| Send communication | Configurable by policy |
| Update external system | Approval or policy based |
| Submit regulated item | Human approval required |
| Move money | Human approval and dual control required |
| Reveal sensitive data | Restricted and audited |
| Change worker policy | Human admin required |

## Open Workflow Slice

The first workflow slice should prove that Continuous is document-aware,
approval-aware, evidence-backed, and renderer-neutral:

| Workflow | Must prove |
|---|---|
| Entity setup | Entity, tax, agency, bank, and location facts become auditable setup state |
| Hire employee | Offer, classification, W-4, I-9, new-hire report, E-Verify when applicable, benefits, access, and payroll readiness become one workflow |
| Engage contractor | W-9, contract/SOW, classification, payment terms, 1099 readiness, and access scope are governed separately from employment |
| Termination | Final pay, PTO payout, benefits/COBRA, access removal, device return, unemployment evidence, and retention clocks are coordinated |
| Payroll preview | Source data, pay statements, earning/tax/deduction lines, liabilities, calculation trace, blockers, variance, approval, paystubs, and evidence are persisted, deterministic, and replayable |
| Filing draft | Applicability, source data, form version, validation, approval, submission state, receipt, rejection, and correction are explicit |
| AI budget cycle | Intelligence allocations, reservations, usage, overages, approvals, and chargebacks are ledgered |
| Synthetic-worker lifecycle | Manager, mission, scopes, capabilities, budget, model route, memory, evals, incidents, and retirement are governed |

## Revenue Worker Slice

The first worker should prove the whole platform loop:

1. Observe a new lead from email, website form, CRM, SMS, or another connector.
2. Classify need, urgency, service area, and missing facts.
3. Retrieve customer, offer, price, calendar, and prior job context.
4. Create or update lead, customer, quote, booking, invoice, and task records.
5. Reserve AI budget before expensive model work.
6. Draft a response, quote, schedule proposal, payment link, or owner brief.
7. Generate an approval card when policy requires human review.
8. Execute the approved capability through the adapter runtime.
9. Capture sent receipts, snapshots, quote versions, approval records, and traces.
10. Reconcile external state and update the task ledger.
11. Score the workflow for quality, cost, latency, correction rate, and KPI impact.

## Runtime Slice

The implementation keeps worker execution deterministic, policy-bound, and
registered behind one shared worker surface:

| Surface | Behavior |
|---|---|
| `POST /core` | Canonical Core command surface for `task.create`, `task.transition`, `object.upsert`, `adapter.upsert`, `connection.upsert`, `connection.health.record`, `entity.setup.record`, `worker.upsert`, `worker.transition`, `object.link`, `event.ingest`, `evidence.attach`, `document.create`, `packet.prepare`, `document.packet.prepare`, `decision.record`, `approval.request`, `adapter.intent.record`, `rule.change.record`, `external_action.record`, `capability.grant`, `budget.reserve`, `budget.charge`, `budget.release`, `ai.infer`, `view.publish`, `customer_signal.record`, `payroll.preview.record`, `payroll.preview.packet.prepare`, `control_plane.token_rotation.attest`, `control_plane.credential.upsert`, `control_plane.credential.revoke`, and `control_plane.session.review`; invalid credentials fail before body reads, command bodies are capped at 1 MiB, tenant selection and command fields live in structured `core` and `config` payloads, and no other top-level command fields are accepted |
| `GET /core?tenantSlug=...` | Tenant-scoped Core summary for active tasks, recent events, approvals, workers, capabilities, graph counts, and ledger counts |
| `POST /worker` with payload `view: "snapshot"` | Operator-only snapshot of worker state, active tasks, controls, budget usage, and recent events |
| `POST /worker` with payload `view: "approvals"` | Operator-only approval queue for worker decisions |
| `POST /worker` | Canonical worker command surface for Revenue `lead.read`, `lead.classify`, `response.draft`, `quote.prepare`, `run`, `continue`, `approval.decide`, `adapters.reconcile`, and `adapters.retry`; Owner `brief.generate`, `decision_queue.prepare`, `anomaly.triage`, `approval.decide`, and `continue`; Dispatch `schedule.propose`, `customer_update.draft`, `closeout.prepare`, and `exception.route`; Finance `invoice.prepare`, `ar_followup.draft`, `cash_forecast.generate`, and `payment_draft.prepare`; Workforce `hire.packet.prepare` and `payroll_input.prepare`; Compliance `filing.prepare`; and Systems `connector.health.scan`, `sync.repair.plan`, `data_quality.remediate`, `permission.review`, and `automation.plan`; invalid credentials fail before body reads, command bodies are capped at 1 MiB, and worker role, tenant selection, idempotency, and operation config live in structured payload fields |
| `/approval` | Shared operator approval inbox and decision surface across Core, workflow, and worker subjects; `POST /approval` uses auth-before-body, 1 MiB bounded command reads, and structured `approval` / `config` payloads |
| `/workflow` | Canonical workflow command surface for listing definitions/runs/steps and executing validated `start` / `transition` / `steps.execute` / `approval.decide` commands; `POST /workflow` uses auth-before-body, 1 MiB bounded command reads, top-level idempotency keys for mutation replay boundaries, and structured `workflow` / `config` payloads |
| `/workflow?view=approvals` | Operator-only approval queue for workflow decisions backed by the shared approval service |
| `worker-scheduler` | Internal production runner that calls the same `/workflow` and `/worker` command envelopes to drain workflow steps, poll Revenue lead sources through `command=lead.read`, hand returned selectors to `command=run`, and run Revenue adapter retry/reconciliation work |
| `bun run worker:tool worker.command` / `worker.view` | Canonical local command and read surfaces using the same worker/config payload shape |

Worker-specific HTTP paths are not part of the public API. New worker families
must extend `/worker` by registering role-scoped commands with structured
`worker`, `command`, `idempotencyKey`, and `config` fields rather than adding
route names per worker.

Approvals are platform records, not worker-specific records. Core, worker, and
workflow approvals share `approval_requests`, `audit_events`, and evidence;
`/approval` lists and decides those shared records with auth-before-body POST
handling plus structured `approval` and `config` payloads. Decision calls must send an explicit `approval.subject`
of `core`, `worker`, `workflow`, or `task`; `all` is only an inbox filter, never
a decision subject.

`command=lead.read` accepts direct source records or a read-only active
connection reference, including scheduler-triggered API polling when the
connection config opts in. It stores Core lead object/event/evidence rows,
writes a read-only worker run, attributes budget/usage, records connection
cursor proof, and returns stable `config.intake` selectors.
`command=lead.classify`,
`command=response.draft`, and
`command=quote.prepare` can consume those selectors as explicit persisted
substeps, writing worker run, inference, usage, event, evidence, and audit proof
while external send remains blocked. One full `command=run` then accepts the
same selectors, or exact Core object/event/evidence row references when an
internal workflow already holds them. The worker stores a source snapshot, binds
the idempotency key to a canonical input hash, derives classification, draft
response, and quote fields from the resolved intake packet, reserves budget,
records inference and usage, emits an idempotent
worker lifecycle event, captures trace and receipt evidence,
creates an owner approval packet, updates the task to `approval_required`, and
versions the quote object. `config.leadPacket` remains a direct operator/test
fallback. External sends and money movement remain blocked until human approval
and real adapter execution are implemented.

Core writes are platform-level, not worker-specific. `POST /core` now
creates and transitions accountable tasks, upserts typed business objects with
object versions, creates and transitions synthetic/human/robot/service workers
with worker object/version metadata, links objects into a navigable business
graph, ingests events, attaches evidence, creates document packets, records
decisions, requests platform approvals, prepares durable evidence packets,
grants scoped capabilities, moves AI budget through
reserve/charge/release ledger states, and publishes renderer-neutral generated
views. `worker.upsert` and `worker.transition` are the canonical generic
`/core` worker lifecycle commands; `/worker` remains the execution surface for
role-scoped worker commands and views. `worker.upsert` owns worker identity,
manager, mission, role, scope, memory, policy, KPI, and autonomy setup.
`worker.transition` owns lifecycle
movement through `draft`, `training`, `active`, `paused`, and `retired` with
reason and evidence packets; it does not execute tools or mutate external
systems. `entity.setup.record` records legal entity facts, identifiers, work
locations, masked bank-account references, blocked payment instructions, an
entity setup workflow run, a setup packet, trace evidence, and audit proof
through the same Core envelope. `adapter.upsert` and `connection.upsert` create or update connector
catalog and tenant account rows through the Core envelope; `connection.health.record`
stores connector readiness checks for state, source metadata, read scopes,
polling, scheduler proof, managed credential refs, and blocked external
execution without exposing credential values. Connection setup keeps external
execution blocked and rejects inline credential material while
allowing managed credential refs for read-only polling. `adapter.intent.record` writes dry-run adapter run/action intent rows
with event, audit, and trace proof while external mutation remains blocked;
`rule.change.record` writes a rule-change object, object version, decision,
event, audit, and trace evidence before rule packs or obligations are changed.
`ai.infer` is the Core AI gateway boundary: it selects an active model route,
redacts configured request fields, reserves and charges budget, writes the
inference and usage rows, and records event, audit, and trace evidence. V1 uses
deterministic no-provider execution, so live provider calls remain blocked
while every worker gets a reusable inference ledger.
`customer_signal.record` adds satisfaction, feedback, complaint,
testimonial, and review records as typed customer signals. `payroll.preview.record`
writes pay statements, payroll lines, liabilities, calculation traces, audit
events, and trace evidence without submission or money movement.
Queued workflow execution can also prepare durable Core packets from
`adapter_intent_record`, `rule_change_record`, `packet_prepare`,
`document_packet_prepare`, or `evidence_packet_prepare` steps, linking the
adapter intent or rule change plus packet, document, event, audit, trace
evidence, workflow output, and task outcome through the same workflow ledger.
`payroll.preview.packet.prepare` turns those preview artifacts into variance
reports, pay statement documents, an approval packet, approval request, and
blocked funding/tax handoff drafts. A shared approval decision applies the
payroll outcome to the payroll run, funding drafts, tax draft, filing draft,
packet document, evidence packet, audit trail, and handoff metadata while
external execution, submission, and money movement remain blocked. Every
`external_action.record` captures receipt/outcome facts for payment
instructions, payments, and filing drafts after a human or adapter-controlled
process produces a result; it updates the Core target state and writes receipt
evidence without executing the external action itself. Every command is
tenant-scoped, idempotent, audit-backed, and blocks external
execution.

## Non-Goals For The First Slice

Do not start with autonomous payroll, tax filing, legal advice, medical
decisioning, unlimited model spend, arbitrary UI code generation, or raw external
system mutation. The first slice should build the controls that make those
future workflows possible.
