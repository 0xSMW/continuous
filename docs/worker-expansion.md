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

## Strategy-Wide Worker Crosswalk

The first seven workers are the initial implementation wave, not the full
strategy catalog. The broader strategy maps every SMB operating family to a
first packaged worker so expansion can stay MECE while still shipping through
the same `/worker` registry, Core object spine, workflow ledger, and evidence
packets.

| Strategy family | First packaged worker | Current coverage | First Core object spine | First promotion gate |
|---|---|---|---|---|
| Owner / General Management | Owner Chief-of-Staff Worker | Runtime started | Task, decision, KPI, anomaly, approval, worker run | Broader factuality evals, stale-source handling, read-only generated brief views |
| Offer, Product, and Pricing | Offer and Pricing Worker | Not yet planned in runtime docs | Offer, product/service, price book, margin rule, discount policy, quote line | Quote/margin policy fixture, approval for discounts, price-change evidence packet |
| Growth and Brand | Growth Worker | Not yet planned in runtime docs | Campaign, channel, audience, content draft, attribution event, review source | No external publish without approval, source-backed claims, budget and ROI ledger |
| Sales and Revenue Capture | Revenue Operations Worker | Runtime live | Lead, customer, offer, quote, booking, job, invoice, payment, review | First controlled external send with receipt, rollback/escalation, connector readiness |
| Customer / Client / Patient Experience | Customer Experience Worker | Partially covered by Dispatch customer updates and Revenue follow-up | Customer, conversation, promise, satisfaction signal, complaint, testimonial, review | Approved outbound message gate, escalation routing, complaint evidence packet |
| Operations / Service Delivery | Operations Worker | Partially covered by Dispatch/Ops | Job, work order, schedule, checklist, closeout, exception, asset/material ref | Live calendar/job-system credential gate, conflict exceptions, closeout completeness eval |
| Supply Chain, Assets, and Facilities | Asset and Supply Worker | Not yet planned in runtime docs | Vendor, inventory item, purchase order, asset, facility, maintenance event, stockout | Dry-run reorder/maintenance plan, approval for purchase/asset actions, rollback plan |
| Workforce and HR | Workforce Worker | Contract/planned | Person, employment, contractor engagement, position, credential, compensation, document | Restricted document handling, classification proof, payroll blocker visibility |
| Finance and Admin | Finance Worker | Runtime started | Invoice, bill, payment, expense, receipt, cash forecast, reconciliation item | Expense coding fixture, live accounting/payment readiness, dual-control approval |
| Risk, Legal, Compliance, and Quality | Compliance Worker | Contract/planned | Rule pack, obligation, filing requirement, notice, license, policy, evidence binder | Source-backed rule claims, human submission approval, exportable evidence binder |
| Data, Systems, and Automation | Systems Worker | Contract/planned | Adapter, connection, sync job, webhook, permission grant, data-quality issue | Sync repair dry-run, least-privilege permission review, rollback evidence |

## ICP Packaged Workers

Vertical workers are packaged operating bundles built from the strategy
families above. They should not introduce private APIs or private object
shapes; each one declares which family commands it composes and which Core
objects it must prove.

| ICP cluster | First packaged worker | Composed families | First packaged outcome | Required proof before runtime |
|---|---|---|---|---|
| Expert-service SMBs | Knowledge Delivery Worker | Revenue, Offer/Pricing, Customer Experience, Finance, Compliance | Intake, proposal, deliverable packet, retainer/billing draft, evidence-backed client update | Proposal/deliverable packet schema, billing handoff, source-backed knowledge claims |
| Expert-service SMBs | Billing Worker | Finance, Revenue, Owner | Retainer invoice, AR follow-up, cash brief, approval queue | Invoice/retainer object map, accounting dry-run, no money movement without dual control |
| Local field-service SMBs | Quote-to-Cash Field Worker | Revenue, Dispatch/Ops, Finance, Customer Experience | Lead response, quote, schedule proposal, closeout, invoice draft, review request | Revenue-to-dispatch-to-finance handoff, customer-send approval, adapter receipts |
| Local field-service SMBs | Change-Order Worker | Dispatch/Ops, Offer/Pricing, Finance, Compliance | Change-order packet with margin, customer approval, invoice impact | Price/margin rule proof, contract-term approval, customer communication receipt |
| Regulated care/trust SMBs | Intake and Documentation Worker | Customer Experience, Compliance, Workforce, Systems | Privacy-safe intake, eligibility/docs checklist, appointment/task packet | Restricted data policy, source evidence, no regulated advice without human review |
| Regulated care/trust SMBs | Compliance QA Worker | Compliance, Systems, Owner | Documentation quality review, deadline blocker, evidence binder | Rule-source traceability, exception queue, exportable audit packet |
| Physical goods SMBs | Inventory and Replenishment Worker | Asset/Supply, Finance, Systems | Stockout detection, reorder draft, vendor packet, cash impact | Inventory/source sync proof, purchase approval, vendor/accounting dry-run receipt |
| Physical goods SMBs | Production Planner Worker | Operations, Workforce, Asset/Supply, Finance | Production/run plan, labor/material readiness, exception routing | Capacity/material object map, no purchase/labor commitments without approval |
| Hospitality/experience SMBs | Demand and Guest Experience Worker | Growth, Customer Experience, Workforce, Finance | Demand campaign draft, booking/guest update, review recovery, staffing signal | Approved publish/send gate, review-source evidence, budget and staffing blockers |
| Hospitality/experience SMBs | Event/Menu Worker | Offer/Pricing, Operations, Asset/Supply, Customer Experience | Event/menu package, inventory/labor readiness, customer packet | Margin/inventory proof, staffing readiness, external publish approval |
| Asset-heavy SMBs | Dispatch and Asset Utilization Worker | Dispatch/Ops, Asset/Supply, Systems, Finance | Route/job dispatch, utilization view, maintenance blocker, billing handoff | Asset state proof, route conflict handling, maintenance rollback/escalation plan |
| Asset-heavy SMBs | Maintenance Worker | Asset/Supply, Compliance, Operations, Finance | Preventive maintenance schedule, incident packet, vendor/parts draft | Asset history, safety/compliance source refs, purchase approval gate |

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
