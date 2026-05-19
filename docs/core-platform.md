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
Continuous Revenue Worker + Continuous Core
```

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
| Revenue | Lead, Customer, Contact, Offer, PriceRule, Quote, Booking, Invoice, Payment, Review |
| Delivery | Job, WorkOrder, Task, Appointment, Checklist, Closeout |
| Worker | Worker, Mission, Skill, Capability, ToolCredential, MemoryScope, BudgetAccount, Evaluation |
| Systems | Connector, ExternalAccount, Webhook, SyncJob, PermissionGrant, DataQualityIssue |
| Governance | Policy, ApprovalRequest, Decision, RiskLevel, AuditEvent, BudgetAllocation |
| Evidence | EvidencePacket, Snapshot, Receipt, Trace, Export |

## Task Ledger Requirements

Every worker action should become one or more durable records:

| Record | Required when |
|---|---|
| Task | Work is created, assigned, blocked, approved, completed, canceled, or escalated |
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

## Non-Goals For The First Slice

Do not start with autonomous payroll, tax filing, legal advice, medical
decisioning, unlimited model spend, arbitrary UI code generation, or raw external
system mutation. The first slice should build the controls that make those
future workflows possible.
