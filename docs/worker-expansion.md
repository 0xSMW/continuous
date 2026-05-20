# Worker Expansion Map

Continuous expands by adding worker families on the same Core graph, task
ledger, capability registry, budget ledger, generated UI contracts, and
evidence layer. A new worker ships only after its object map, capability grants,
workflow states, adapter posture, evidence packet, eval set, and autonomy gate
are explicit.

Use [Worker execution roadmap](worker-roadmap.md) for the phase-by-phase
implementation gates from the first worker to the broader worker catalog.
Use [Worker readiness matrix](worker-readiness.md) to track gate proof and
blockers for each worker family.
Use [Worker handoff contracts](worker-handoffs.md) to keep cross-worker inputs
grounded in Core records instead of worker-private payloads.
Use [Worker contract template](worker-contract-template.md) before coding any
new worker family.

## Launch Order

| Order | Worker | First outcome | Launch gate |
|---:|---|---|---|
| 1 | Revenue Operations Worker | Turn leads into quotes, bookings, invoices, collections, and reviews | Stable lead-to-cash simulation plus approval-backed dry-run adapters |
| 2 | Owner Chief-of-Staff Worker | Daily decision queue, anomalies, cash/capacity brief, and task routing | Read-only cross-system summary with evidence links and no external mutation |
| 3 | Dispatch/Ops Worker | Schedule jobs, update customers, close out work, and reduce handoff misses | `schedule.propose`, `customer_update.draft`, `closeout.prepare`, and `exception.route` are runtime; launch still needs live credential gates |
| 4 | Finance Worker | Draft invoices, AR follow-ups, cash forecasts, and blocked payment drafts | Accounting/payment adapters in draft mode, cash evidence packet, dual-control proof, no money movement |
| 5 | Workforce Worker | Hiring, onboarding, credentials, schedules, and payroll-input readiness | New-hire/contractor workflow packets, restricted document controls, payroll blockers |
| 6 | Compliance Worker | Licenses, insurance, permits, notices, filings, and evidence binders | Rule-pack coverage, due-date obligations, source refs, and human submission approval |
| 7 | Systems Worker | Connector health, sync repair, data quality, and workflow automation | Tenant-scoped adapter grants, rollback plans, and sync reconciliation tests |

## Per-Worker Contracts

Every worker needs an implementation-grade V1 contract before runtime code. The
contract must name the exact `/worker` `command`, `worker`, `config`, and
`idempotencyKey` shape; required Core commands; object fields and link types;
workflow states and transitions; capability grants; adapter dry-run payloads;
evidence packet schema; generated view contract; eval fixtures; and security
boundaries.

Implementation-grade contracts:

| Worker | Contract |
|---|---|
| Revenue Operations | [Revenue Operations Worker V1 Contract](revenue-operations-worker-v1-contract.md) |
| Owner Chief-of-Staff | [Owner Chief-of-Staff Worker V1 Contract](owner-chief-of-staff-worker-v1-contract.md) |
| Dispatch/Ops | [Dispatch Operations Worker V1 Contract](dispatch-operations-worker-v1-contract.md) |
| Finance | [Finance Operations Worker V1 Contract](finance-operations-worker-v1-contract.md) |
| Workforce | [Workforce Operations Worker V1 Contract](workforce-operations-worker-v1-contract.md) |
| Compliance | [Compliance Operations Worker V1 Contract](compliance-operations-worker-v1-contract.md) |
| Systems | [Systems Operations Worker V1 Contract](systems-operations-worker-v1-contract.md) |

| Worker | Core objects | Capabilities | Workflows | Adapters | Evidence packet | Eval gate |
|---|---|---|---|---|---|---|
| Revenue | Lead, Customer, Offer, Quote, Booking, Job, Invoice, Payment, Review | `lead.read`, `lead.classify`, `response.draft`, `quote.prepare`, `schedule.propose`, `invoice.prepare`, `payment_link.prepare`, `owner_brief.generate` | Lead intake, quote approval, schedule proposal, invoice prep, collections follow-up, review request | Website forms, email, calendar, CRM/spreadsheet, accounting, payments | Lead-to-cash packet with source message, classification, quote draft, approval, adapter receipt, object versions | Classification accuracy, quote policy adherence, approval rate, response latency, budget per workflow |
| Owner Chief-of-Staff | Task, Event, KPI, BudgetAccount, Obligation, Worker, Decision | `worker.read`, `owner_brief.generate`, `approval.request`, `sensitive_data.reveal` | Daily brief, weekly review, anomaly triage, decision queue | Read-only email/calendar/accounting/CRM/payments/jobs | Owner brief packet with data sources, unresolved decisions, risk flags, and budget burn | Brief factuality, missing-critical-item rate, owner correction rate |
| Dispatch/Ops | Job, WorkOrder, Appointment, Crew, Asset, Material, Closeout | `schedule.propose`, `response.draft`, `approval.request`, `document_packet.prepare`, `exception.route` | Promise-to-delivery, dispatch, customer update, closeout, QA checklist, exception routing | Calendar, job management, maps, SMS/email, inventory | Job packet with schedule rationale, customer updates, closeout proof, exceptions | Schedule conflict rate, on-time update rate, closeout completeness |
| Finance | Invoice, Payment, Bill, Expense, Receipt, CashForecast, ReconciliationItem | `invoice.prepare`, `payment_link.prepare`, `ach_draft.prepare`, `approval.request` | Invoice draft, AR follow-up, expense coding, cash forecast, payment draft | Accounting, payments, bank feeds, inbox, receipts | Cash packet with source docs, invoice drafts, payment instructions, approval receipts | Coding accuracy, AR recovery, cash forecast error, no unauthorized money movement |
| Workforce | Person, Employment, ContractorEngagement, Position, CompensationAgreement, Credential, Document | `worker.read`, `document_packet.prepare`, `approval.request`, `payroll.preview.record`, `payroll.preview.packet.prepare` | Hire employee, engage contractor, credential renewal, schedule readiness, payroll input readiness | Docs/signature, calendar, HRIS/payroll, email | New-hire or contractor packet with documents, signatures, classification rationale, payroll blockers, payroll preview refs, approval packet, and blocked funding/tax draft refs | Document completeness, classification review pass rate, payroll blocker detection |
| Compliance | RulePack, Obligation, FilingRequirement, FilingDraft, Notice, License, Permit, InsurancePolicy | `filing.prepare`, `document_packet.prepare`, `approval.request`, `sensitive_data.reveal` | Obligation intake, notice response, license renewal, filing draft, evidence export | Document stores, calendar, agency portals/manual upload, email | Compliance packet with source refs, rule snapshot, draft, approval, receipt/rejection | Deadline coverage, rule-source traceability, false-positive blocker rate |
| Systems | Adapter, Connection, SyncJob, Webhook, PermissionGrant, DataQualityIssue | `worker.read`, `approval.request`, `document_packet.prepare` | Connector setup, sync repair, data-quality remediation, permission review | All platform adapters | Systems packet with scoped grant, sync logs, reconciliation, rollback plan | Sync success, data-quality improvement, least-privilege grant check |

## Autonomy Gate

| Level | Allowed before gate | Required before promotion |
|---:|---|---|
| 0 | Read scoped records and summarize | Tenant/worker scope check and audit event |
| 1 | Draft messages, packets, decisions, and recommendations | Golden evals for factuality and missing-fact handling |
| 2 | Create internal tasks and update internal records | Idempotent workflow run plus evidence packet |
| 3 | Send bounded external communications under policy | Approval UI, live credential scope, retry worker, and failure reconciliation path |
| 4 | Prepare transactions, filings, contracts, payroll, or payments | Deterministic non-LLM calculation/validation and dual-control approval |
| 5 | Execute approved external actions | Human approval event, credential scope, receipt, rollback/escalation plan |

No worker starts above Level 2. Money movement, payroll submission, filing
submission, legal advice, medical advice, refunds, and contract-term changes
remain blocked until managed execution exists.
