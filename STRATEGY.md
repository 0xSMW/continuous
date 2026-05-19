**Continuous: final strategy for a scalable agentic worker platform**

Continuous should be built as a **worker platform**, not an HR platform, payroll platform, or generic AI automation tool. The core product is a headless operating substrate that lets SMBs hire, manage, govern, budget, evaluate, and coordinate both human workers and agentic workers.

The original Continuous thesis remains correct: build the canonical business graph, task ledger, workflow engine, rule engine, capability registry, generated UI layer, AI gateway, adapter runtime, and evidence layer. The important upgrade is that these components are not just infrastructure for an internal assistant. They become the foundation for **customer-facing agentic workers** that can own outcomes across revenue, operations, finance, compliance, workforce, and systems.

The strategic center of Continuous is:

```text
Business graph + task ledger + capability registry + AI gateway + evidence
=
the operating system for agentic workers
```

**Core decision**

Continuous should not first sell “AI for HR” or “AI payroll.” It should sell **AI workers for SMB operating flows**, beginning with service-heavy SMBs where the owner is overwhelmed by leads, quotes, scheduling, follow-up, billing, collections, reviews, and admin.

The first commercial wedge should be:

```text
Revenue Operations Worker for service SMBs
```

Its job is to help owner-led SMBs answer leads, qualify customers, quote faster, schedule work, collect deposits, generate invoices, follow up on unpaid balances, ask for reviews, and brief the owner daily.

The platform then expands into:

```text
Ops Worker
Finance Worker
Workforce Worker
Compliance Worker
Systems Worker
Owner Chief-of-Staff Worker
Vertical specialist workers
```

**Data-backed market thesis**

The SBA Office of Advocacy’s 2025 U.S. Small Business Profile reports 36.2 million U.S. small businesses, representing 99.9% of U.S. businesses, with 62.3 million small-business employees, or 45.9% of U.S. employees. Its industry table shows that the largest small-business sectors by count include professional/scientific/technical services, transportation and warehousing, other services, construction, real estate/rental/leasing, administrative/support/waste management, health care/social assistance, retail, arts/entertainment/recreation, and accommodation/food services. The same SBA table reports 29.8 million businesses without employees, 5.7 million with 1–19 employees, and 654,501 with 20–499 employees.  [oai_citation:0‡Office of Advocacy](https://advocacy.sba.gov/wp-content/uploads/2025/06/United_States_2025-State-Profile.pdf)

The Census Bureau describes NAICS as the standard used by federal statistical agencies to classify business establishments for collecting, analyzing, and publishing U.S. business economy data. Continuous should therefore use broad NAICS sectors as the top-level vertical taxonomy, but should not build the product around NAICS labels alone; the product should map NAICS sectors into operating flows, job families, workflows, evidence requirements, and agentic worker roles.  [oai_citation:1‡Census.gov](https://www.census.gov/programs-surveys/economic-census/year/2022/guidance/understanding-naics.html?utm_source=chatgpt.com)

The nonemployer base is especially important. Census reported 29.8 million nonemployer businesses in 2022, defined as businesses with no paid employees that are subject to federal income tax, with $1.7 trillion in receipts. This supports the thesis that many small businesses are structurally under-staffed and are ideal candidates for agentic workers that absorb coordination, admin, customer communication, and operational follow-through.  [oai_citation:2‡Census.gov](https://www.census.gov/library/stories/2025/05/smallest-businesses.html?utm_source=chatgpt.com)

Small-business AI adoption is still early but moving in the right direction. SBA’s 2025 research spotlight reported small-business AI usage rising from 6.3% to 8.8% for firms under 250 employees and suggested small businesses may be roughly a year behind large businesses in AI adoption. A Federal Reserve FEDS Note using Census and other public surveys reported that about 18% of firms had adopted AI by year-end 2025.  [oai_citation:3‡Office of Advocacy](https://advocacy.sba.gov/2025/09/24/new-advocacy-article-highlights-small-businesses-closing-the-ai-adoption-gap/?utm_source=chatgpt.com)

**Strategic implication**

The strongest thesis is not “AI replaces enterprises.” The stronger thesis is that **more economic activity becomes viable as small firms** because one owner, solo operator, or tiny team can use agentic workers to perform the coordination, administration, communication, marketing, finance, and compliance work that previously required staff, agencies, or expensive SaaS stacks.

Continuous should therefore optimize for:

| Strategic fact | Product implication |
|---|---|
| Most small businesses are nonemployers or very small employers | Agents must be useful before the customer has departments, managers, or process maturity |
| The largest SMB sectors are service-heavy and coordination-heavy | The first workers should own lead-to-cash, promise-to-delivery, and collections workflows |
| SMBs do not buy “platforms” first | They buy outcomes: more jobs booked, faster quotes, fewer missed leads, faster cash collection |
| AI adoption is early | Product must be easy, opinionated, and workflow-native rather than developer-only |
| SMB work is fragmented across inboxes, calendars, forms, calls, accounting tools, websites, and payments | The core system must be a system-of-action connector layer, not a standalone chat app |
| Regulated workflows still matter | Continuous must retain approvals, rules, evidence, and safe execution boundaries |

**Final product definition**

Continuous is a **headless worker platform for SMBs**.

It has three product planes:

| Plane | What it is | Customer-facing value |
|---|---|---|
| Continuous Core | Headless business graph, event log, task ledger, workflows, rule packs, capability registry, generated UI, evidence, adapters | Makes the business legible enough for agents to act |
| Continuous AI Gateway | Model routing, intelligence budgets, token/cost ledger, provider controls, agent authorization, synthetic-worker governance | Lets leaders manage AI spend and autonomy like operating capacity |
| Continuous Workers | Packaged agentic workers with missions, tools, workflows, budgets, approvals, vertical context, KPIs, and evidence | Gives SMBs outcome-owning AI labor they can “hire” |

**What changes from the prior plan**

The prior plan correctly focused on headless infrastructure. The upgraded plan makes the infrastructure commercially legible by turning it into a **worker deployment platform**.

| Prior emphasis | Improved emphasis |
|---|---|
| Build open-source alternative to Gusto/Rippling/Deel-like infrastructure | Build the operating substrate that lets SMBs hire and govern AI workers |
| HR, payroll, benefits, compliance, filings | Universal SMB flows: lead-to-cash, promise-to-delivery, input-to-output, hire-to-capacity, obligation-to-compliance, data-to-decision |
| Synthetic workers as internal actors | Agentic workers as the product customers buy |
| AI gateway for budgets | AI gateway as the control plane for purchased intelligence, worker autonomy, model routing, and ROI |
| Generated UI for workflows | Generated UI for every worker interaction: approvals, briefs, task queues, exception screens, evidence packets |
| Compliance-heavy first wedge | Revenue operations first, with compliance and payroll infrastructure as expansion and moat |

**The Continuous worker model**

An agentic worker should be modeled like an accountable business actor, not like a chatbot.

| Worker component | Definition |
|---|---|
| Identity | Stable worker identity, name, role, status, manager, team, cost center |
| Mission | Outcome the worker is responsible for |
| Scope | Customers, jobs, inboxes, workflows, entities, apps, and records it may access |
| Skills | Packaged capabilities such as qualify lead, draft quote, schedule job, invoice customer, reconcile payment |
| Tools | Typed capability grants, not raw app credentials |
| Budget | Monthly intelligence budget, per-task limits, model routes, overage policy |
| Memory | Customer memory, business memory, workflow memory, no-memory zones |
| Policies | What the worker may do autonomously, what requires approval, what is blocked |
| Evidence | Every action, draft, external message, tool call, approval, and result |
| KPIs | Outcome metrics tied to the worker’s mission |
| Evaluation | Quality, latency, cost, safety, human correction rate, ROI |
| Escalation | When to ask the owner, manager, expert, accountant, or human specialist |

**Worker object schema**

```yaml
id: worker.ai.revenue_ops.default
type: agentic_worker
display_name: Revenue Operations Worker
customer_facing_name: Continuous Revenue Worker
manager_required: true
mission: >
  Convert inbound demand into scheduled, quoted, invoiced, and collected revenue
  while keeping the owner informed and in control.
allowed_flows:
  - lead_to_cash
  - customer_experience
  - quote_to_cash
  - review_recovery
capability_grants:
  - inbox.read
  - sms.draft
  - email.draft
  - lead.qualify
  - quote.prepare
  - schedule.propose
  - invoice.prepare
  - payment_link.prepare
  - review_request.prepare
  - owner_brief.generate
approval_policy:
  autonomous:
    - classify_lead
    - draft_response
    - create_task
    - prepare_quote
    - send_reminder_under_policy
  approval_required:
    - send_quote_above_threshold
    - discount_price
    - change_contract_terms
    - charge_customer
    - issue_refund
    - mark_job_complete
blocked:
  - provide_legal_advice
  - provide_medical_advice
  - submit_tax_filing
  - move_money_without_approval
budget_policy:
  monthly_budget_units: 10000000
  per_task_budget_units: 250000
  overage_policy: manager_approval
model_route_policy:
  default: low_cost_fast
  pricing_or_contract: high_reasoning
  sensitive_customer_data: private_route
evidence:
  required:
    - source_message_snapshot
    - drafted_response
    - approval_if_required
    - sent_message_receipt
    - task_outcome
kpis:
  - leads_answered
  - median_response_time
  - quotes_sent
  - deposits_collected
  - invoices_collected
  - reviews_requested
  - owner_hours_saved
```

**Human workers and agentic workers**

Continuous should treat humans and agents symmetrically where it helps, and differently where law, risk, and accountability require it.

| Area | Human worker | Agentic worker |
|---|---|---|
| Identity | Person, employment, contractor, role | Synthetic identity, mission, manager, role |
| Authority | Based on employment, role, policy | Based on explicit capability grants |
| Budget | Payroll, expenses, tools | Intelligence budget, model routes, tool budget |
| Memory | Human knowledge, notes, documents | Scoped memory with retention and redaction policies |
| Compliance | I-9, payroll, taxes, benefits, labor rules | AI governance, privacy, safety, model/provider controls |
| Work output | Tasks, decisions, messages, deliverables | Drafts, actions, tool calls, recommendations, generated UI |
| Accountability | Employee/manager/company | Human manager/company; worker trace provides evidence |
| Evaluation | Performance review | Eval score, ROI, human correction rate, safety score |
| Offboarding | Final pay, access removal, benefits, retention | Disable tools, revoke memory, archive traces, reassign tasks |

**Universal SMB operating flows**

Continuous should build around flows, not departments. SMBs experience work as promises, exceptions, deadlines, customers, bills, employees, and risks.

| Universal flow | Real JTBD | Primary workers | Core platform objects |
|---|---|---|---|
| Lead to cash | Turn demand into paid, profitable work | Revenue Worker, CX Worker, Finance Worker | Lead, customer, offer, quote, booking, job, invoice, payment, review |
| Promise to delivery | Deliver what was sold without margin leakage | Ops Worker, Workforce Worker, Asset Worker | Job, schedule, checklist, staff, asset, material, status, closeout |
| Input to output | Convert inventory, labor, assets, and vendors into sellable output | Supply Worker, Ops Worker, Finance Worker | Vendor, inventory, purchase order, asset, work order, production run |
| Hire to productive capacity | Turn people into reliable delivery capacity | Workforce Worker, Compliance Worker, Payroll Worker | Candidate, worker, credential, schedule, training, payroll input |
| Obligation to compliance | Keep licenses, filings, insurance, contracts, tax, safety, and records current | Compliance Worker, Finance Worker, Workforce Worker | Obligation, rule, deadline, document, filing, receipt, evidence |
| Data to decision | Give the owner a current operating picture | Owner Chief-of-Staff Worker, Systems Worker | KPI, anomaly, forecast, task, recommendation, decision, approval |

**MECE worker family map**

| Worker family | Owns this outcome | First packaged worker |
|---|---|---|
| Owner / General Management | Allocate scarce attention, cash, capacity, and risk | Owner Chief-of-Staff Worker |
| Offer, Product, and Pricing | Turn capability into a profitable, sellable promise | Offer and Pricing Worker |
| Growth and Brand | Create qualified demand | Growth Worker |
| Sales and Revenue Capture | Convert interest into committed revenue | Revenue Operations Worker |
| Customer / Client / Patient Experience | Keep the promise before, during, and after delivery | Customer Experience Worker |
| Operations / Service Delivery | Fulfill work safely, profitably, and on time | Operations Worker |
| Supply Chain, Assets, and Facilities | Ensure inputs/assets are available at the right time and cost | Asset and Supply Worker |
| Workforce and HR | Acquire, schedule, retain, and de-risk human capacity | Workforce Worker |
| Finance and Admin | Keep cash visible, collectible, compliant, and usable | Finance Worker |
| Risk, Legal, Compliance, and Quality | Keep the business permitted, insured, contractually protected, and audit-ready | Compliance Worker |
| Data, Systems, and Automation | Make the business legible enough for agents to act | Systems Worker |

**Initial ICP**

Continuous should start with service-heavy SMBs, especially professional services, construction/home services, other local services, real estate services, administrative/support services, and adjacent expert-service businesses.

This cluster is attractive because it has high SMB volume, high owner-operator density, fragmented workflows, repeatable lead-to-cash pain, enough digital surface area for agents to act, and clear ROI when the product increases response speed, quotes, deposits, collections, reviews, and owner time.

| ICP cluster | Included sectors | Dominant pain | First worker | Expansion workers |
|---|---|---|---|---|
| Expert-service SMBs | Professional services, finance/insurance, information, education | Intake, proposals, documentation, retainers, billing | Revenue Operations Worker | Knowledge Delivery Worker, Billing Worker, Compliance Worker |
| Local field-service SMBs | Other services, construction, repair, maintenance, real estate maintenance | Missed calls, bad estimates, schedule chaos, change orders, collections | Quote-to-Cash Field Worker | Dispatch Worker, Review Worker, Change-Order Worker |
| Regulated care/trust SMBs | Health-adjacent, education, finance/insurance | Intake, eligibility, scheduling, documentation, privacy, compliance | Intake and Documentation Worker | Recall Worker, Eligibility Worker, Compliance QA Worker |
| Physical goods SMBs | Retail, wholesale, manufacturing, agriculture | Inventory, pricing, procurement, labor, waste | Inventory and Replenishment Worker | Pricing Worker, Supplier Worker, Production Planner |
| Hospitality/experience SMBs | Food, accommodation, arts, events, recreation | Local demand, guest experience, labor, reviews | Demand and Guest Experience Worker | Staffing Worker, Event/Menu Worker |
| Asset-heavy SMBs | Transportation, agriculture, utilities-like field service | Routes, maintenance, permits, utilization, safety | Dispatch and Asset Utilization Worker | Maintenance Worker, Safety Worker, Billing Worker |

**First worker: Revenue Operations Worker**

The first packaged worker should be narrow enough to succeed and broad enough to matter. It should not be a chatbot. It should be an always-on operational worker that reads communication channels, understands offers and availability, qualifies leads, drafts or sends approved responses, prepares quotes, follows up, schedules, creates invoices, collects deposits, requests reviews, and produces a daily owner brief.

| Capability | Autonomous by default | Approval required |
|---|---:|---:|
| Read inbound lead messages | Yes | No |
| Classify lead type and urgency | Yes | No |
| Ask clarifying questions using approved templates | Yes | Optional |
| Prepare quote or estimate | Yes | No |
| Send quote under policy threshold | Configurable | Yes above threshold |
| Offer discount | No | Yes |
| Schedule proposed job time | Yes | For conflicts/high-value jobs |
| Send reminder | Yes | No |
| Prepare invoice | Yes | No |
| Send payment link | Configurable | Yes if large/custom |
| Follow up on unpaid invoice | Yes | No |
| Ask for review after completion | Yes | No |
| Escalate complaint | Yes | Human handles |
| Change contract terms | No | Yes |
| Issue refund | No | Yes |
| Move money | No | Yes, always |

**Revenue Operations Worker operating loop**

```text
Observe new lead or customer event
→ retrieve customer, offer, pricing, calendar, capacity, prior history
→ classify urgency and intent
→ determine next best action
→ draft or send response within policy
→ create quote/proposal/booking/invoice task
→ request approval when required
→ update source systems
→ track outcome
→ follow up until closed, lost, completed, or collected
→ produce evidence and owner summary
```

**Why this worker wins**

| Pain | Worker value |
|---|---|
| Owner misses calls/messages | Always-on lead intake and response |
| Quotes are slow | Quote drafts from templates, pricing rules, and prior jobs |
| Scheduling is chaotic | Calendar/capacity-aware proposed times |
| Cash collection is delayed | Invoice and follow-up automation |
| Reviews are forgotten | Automated review request after closeout |
| Owner lacks visibility | Daily brief: leads, quotes, bookings, cash, exceptions |
| Systems are fragmented | Continuous task ledger ties email, calendar, accounting, CRM, payment, and website events together |

**Second wave workers**

| Worker | Mission | Ships after |
|---|---|---|
| Ops Worker | Convert sold work into scheduled, staffed, tracked, completed delivery | Revenue Worker |
| Finance Worker | Invoice, collect, code expenses, reconcile, forecast cash, prepare lender/accountant packets | Revenue Worker |
| Workforce Worker | Hiring, onboarding, credential tracking, scheduling, payroll-input readiness | Ops Worker |
| Compliance Worker | Licenses, permits, insurance, contracts, safety, filings, evidence binders | Workforce + Finance |
| Systems Worker | Connector health, data cleanup, workflow builder, permissions, automations | Core platform maturity |
| Owner Chief-of-Staff Worker | Daily operating brief, decisions, anomaly detection, cross-worker routing | Once multiple workers exist |

**Continuous platform architecture**

```text
Customer surfaces
  Web app, mobile cards, Slack/SMS/email, TUI, embedded partner UI, API

Generated UI layer
  Forms, approvals, task boards, briefs, exception views, evidence packets

Agentic worker layer
  Worker identities, missions, skills, memory, plans, tool calls, evals, KPIs

Control plane
  Capability registry, policies, approvals, intelligence budgets, risk gates

Core operating substrate
  Business graph, event log, task ledger, workflow engine, rule engine

Execution layer
  AI gateway, adapter runtime, document engine, filing/payment engines

External systems
  Email, phone/SMS, calendar, website forms, CRM, accounting, payroll,
  payments, POS, inventory, banks, tax agencies, E-Verify, state agencies,
  model providers, identity systems

Evidence and observability
  Audit log, receipts, snapshots, traces, cost ledger, reconciliation, exports
```

**Core platform primitives**

| Primitive | Why it matters |
|---|---|
| Business graph | Gives workers shared memory about customers, offers, jobs, workers, vendors, assets, documents, cash, obligations, and decisions |
| Event log | Lets the system know what happened and replay workflows |
| Task ledger | Makes work accountable: owner, due date, trigger, state, evidence, outcome |
| Capability registry | Defines what workers can safely do |
| Rule engine | Converts law, policy, pricing, workflow, and vertical context into executable logic |
| Workflow engine | Runs durable multi-step work across humans, workers, and external systems |
| AI gateway | Controls model access, token spend, routing, redaction, evaluations, and budgets |
| Adapter runtime | Lets workers act in the real world through systems of action |
| Generated UI | Produces the right interface at the right moment |
| Evidence layer | Proves what happened, why, under whose authority, with what result |

**Business graph object model**

| Domain | Core objects |
|---|---|
| Customer/revenue | Lead, Customer, Contact, Opportunity, Offer, Package, PriceRule, Quote, Proposal, Contract, Booking, Invoice, Payment, Review |
| Delivery | Job, WorkOrder, Task, Checklist, Appointment, Route, Crew, Material, Asset, Closeout, QualityRecord |
| Finance | Account, Vendor, Bill, Expense, Receipt, PaymentInstruction, CashForecast, ReconciliationItem |
| Workforce | HumanWorker, Contractor, Role, Schedule, Credential, Training, PayrollInput, TimeEntry |
| Agentic workers | AgenticWorker, Mission, Skill, CapabilityGrant, ToolCredential, MemoryScope, BudgetAccount, Evaluation |
| Compliance | Obligation, License, Permit, InsurancePolicy, Filing, Notice, EvidencePacket, RulePack |
| Systems | Connector, ExternalAccount, Webhook, SyncJob, DataQualityIssue, PermissionGrant |
| Governance | Policy, ApprovalRequest, Decision, RiskLevel, AuditEvent, BudgetAllocation |

**Task ledger model**

Every worker action should ultimately become a task, event, decision, or evidence item.

| Field | Purpose |
|---|---|
| `task_id` | Stable identifier |
| `business_object_ref` | Customer, job, worker, filing, invoice, etc. |
| `trigger_event_ref` | What caused the task |
| `owner_ref` | Human or agentic worker responsible |
| `reviewer_ref` | Human approval owner if required |
| `due_at` | Deadline |
| `priority` | Severity and business impact |
| `state` | Draft, active, waiting, approval_required, blocked, done, canceled |
| `capability_ref` | Capability needed to complete task |
| `evidence_required` | Required proof |
| `outcome` | Completed result |
| `cost` | AI budget and human time cost |
| `kpi_impact` | Revenue, cash, time saved, risk avoided |

**Capability registry**

Agents should never have raw permission to mutate arbitrary data or execute arbitrary external actions. Every action must be a typed capability.

| Capability class | Examples | Default worker permission |
|---|---|---|
| Read | Read lead, customer, calendar, invoice, job, offer, worker profile | Allowed within scope |
| Classify | Classify lead, urgency, customer intent, invoice risk | Allowed |
| Draft | Draft email, quote, invoice, schedule, owner brief | Allowed |
| Recommend | Recommend price, next action, staffing, reorder, escalation | Allowed |
| Create internal task | Create follow-up, quote task, scheduling task, review task | Allowed |
| Send communication | Send email/SMS/customer update | Configurable |
| Update external system | Update CRM, calendar, accounting, POS | Approval/policy-based |
| Submit regulated item | Filing, E-Verify, payroll tax, official report | Human approval required |
| Move money | Charge, refund, ACH, tax deposit, payroll | Human approval and dual control required |
| Reveal sensitive data | SSN, bank info, medical/health-adjacent data, I-9 docs | Restricted and audited |
| Change worker policy | Budget, permissions, model route, memory | Human admin required |

**Capability manifest example**

```yaml
id: quote.prepare
version: 1.0.0
description: Prepare a customer quote from offer, scope, price rules, and prior jobs
risk_level: medium
side_effects: internal_draft
input_schema: QuotePrepareInput
output_schema: QuoteDraft
allowed_actor_types:
  - human
  - agentic_worker
requires_approval: false
blocks_when:
  - missing_customer_contact
  - missing_offer
  - unknown_scope
approval_escalation:
  if:
    - quote_total_above_threshold
    - margin_below_floor
    - custom_terms_requested
evidence:
  snapshots:
    - customer_request
    - offer_version
    - price_rule_version
    - quote_draft
```

**AI gateway and intelligence budgets**

The AI gateway is the economic and safety control plane for Continuous. It should manage AI usage the way a company manages payroll, software spend, cards, or cloud spend.

Leaders should be able to allocate monthly intelligence buying power to:

| Budget target | Example |
|---|---|
| Company | 200 million normalized intelligence units per month |
| Department | 40 million units for sales, 30 million for operations |
| Human employee | 5 million units for an owner or manager |
| Agentic worker | 20 million units for Revenue Worker |
| Workflow | 10 million units reserved for year-end filings or lead surge |
| Customer/account | Accountant allocates 2 million units to each client |
| Vertical pack | Construction quote workflows get higher reasoning budget |
| Risk tier | High-risk actions require stronger, approved model routes |

**AI gateway objects**

| Object | Purpose |
|---|---|
| `ModelProvider` | OpenAI, Anthropic, Google, local, private, customer-provided |
| `ModelRoute` | Chooses provider/model by task, sensitivity, budget, latency, quality |
| `InferenceRequest` | One model call with actor, task, workflow, data scope, prompt hash |
| `InferenceResult` | Output, usage, latency, eval, cost, safety markers |
| `IntelligencePool` | Total monthly AI capacity purchased or assigned |
| `BudgetAccount` | Wallet for team, person, worker, workflow, customer, or project |
| `BudgetAllocation` | Monthly allocation from pool |
| `BudgetReservation` | Pre-flight hold for expected expensive work |
| `UsageEvent` | Actual token/cost/normalized-unit charge |
| `BudgetPolicy` | Soft limit, hard limit, overage, rollover, downgrade, approval |
| `AIEvaluation` | Quality, safety, cost, task completion, correction rate |
| `AIIncident` | Budget abuse, data leak risk, unsafe output, runaway loop |

**Budget policy example**

```yaml
id: budget.policy.revenue_worker.standard
budget_target: agentic_worker
monthly_units: 10000000
soft_limit_percent: 80
hard_limit_percent: 100
overage_policy: manager_approval
emergency_policy:
  allowed: true
  max_units: 1000000
  requires_reason: true
model_routing:
  routine_messages: low_cost_fast
  quotes_above_threshold: high_reasoning
  contract_terms: high_reasoning_private
  sensitive_data: private_route_only
per_task_limits:
  lead_response: 50000
  quote_prepare: 250000
  owner_brief: 150000
  proposal_draft: 500000
runaway_controls:
  max_tool_calls_per_task: 20
  max_retries: 3
  max_wall_clock_minutes: 15
```

**Why intelligence budgets matter**

| Problem | Continuous answer |
|---|---|
| Leaders do not know what AI costs | Every inference is metered and attributed |
| Agents can burn tokens without business value | Budgets, reservations, limits, and ROI dashboards constrain spend |
| Cheap models may fail high-value tasks | Model routes choose capability by task risk and budget |
| Employees may overuse AI tools | Monthly employee budgets and chargeback create accountability |
| AI workers need operating limits | Each worker has a budget, tools, manager, and evaluation |
| Customers need trust | The evidence layer shows what the model saw, did, cost, and produced |
| Vertical work varies in difficulty | More complex workflows can reserve higher intelligence budgets |

**AI governance standard**

Continuous should map its AI governance documentation to NIST’s AI Risk Management Framework. NIST describes the framework as a way to manage risks to individuals, organizations, and society associated with AI, and its AI Resource Center describes the framework as intended to improve trustworthiness considerations in AI design, development, use, and evaluation.  [oai_citation:4‡NIST](https://www.nist.gov/itl/ai-risk-management-framework?utm_source=chatgpt.com)

Continuous should operationalize this as:

| NIST-aligned area | Continuous implementation |
|---|---|
| Govern | Worker policies, model allowlists, approvals, budget controls, incident process |
| Map | Task risk, data sensitivity, workflow context, affected stakeholders |
| Measure | Evals, token spend, task success, latency, human correction, safety markers |
| Manage | Model routing, redaction, escalation, worker suspension, policy changes |

**Agentic worker execution lifecycle**

```text
Observe
→ retrieve context
→ classify situation
→ evaluate policy and rules
→ plan work
→ reserve intelligence budget
→ draft action
→ generate UI if needed
→ request approval if required
→ execute capability
→ capture evidence
→ reconcile external state
→ update task ledger
→ evaluate outcome
→ brief owner/manager
```

**Generated UI as worker interface**

A worker platform cannot depend on fixed screens. Every worker should be able to generate the right surface for the current task.

| Surface | Generated from |
|---|---|
| Owner daily brief | Events, KPIs, tasks, anomalies, decisions, budgets |
| Approval card | Draft action, policy, risk, evidence, valid actions |
| Quote review | Customer request, scope, pricing rules, margin, schedule, terms |
| Job board | Jobs, crews, assets, appointments, blockers, customer status |
| Collections view | Invoices, promises to pay, follow-up history, customer risk |
| Worker scorecard | KPIs, spend, evals, task outcomes, escalation rate |
| Budget dashboard | Allocations, burn, overages, ROI, model usage |
| Compliance binder | Obligations, filings, receipts, documents, audit history |
| Exception console | Blocked tasks, failed connectors, rejected actions, missing facts |

Generated UI contract example:

```json
{
  "view_id": "quote.approval.review",
  "target": "web",
  "actor": "owner",
  "object_ref": "quote:q_123",
  "worker_ref": "agentic_worker:revenue_worker",
  "risk_level": "medium",
  "sections": [
    {"component": "CustomerSummary"},
    {"component": "ScopeSummary"},
    {"component": "PriceAndMargin"},
    {"component": "ScheduleAvailability"},
    {"component": "DraftMessage"},
    {"component": "EvidenceTimeline"},
    {"component": "ActionBar"}
  ],
  "valid_actions": [
    "approve_and_send",
    "request_revision",
    "edit_price",
    "escalate_to_human"
  ],
  "blocked_actions": [
    {
      "capability": "collect_deposit",
      "reason": "quote_not_approved"
    }
  ]
}
```

**Compliance and regulated work**

Continuous should not start with autonomous payroll, tax filing, legal advice, or medical decisioning as the first commercial worker. It should start with revenue and operations workflows, while building the compliance foundation that later enables workforce, payroll, and regulated workers safely.

For US employment workflows, the system must encode key federal obligations. IRS says employers who withhold federal income, Social Security, or Medicare taxes generally file Form 941 quarterly; USCIS says employers must complete and retain Form I-9 for every person hired after November 6, 1986; ACF says employers must report new and rehired employees to the state where the employee works within 20 days of hire; and DOL states FLSA overtime requirements for covered nonexempt employees after 40 hours in a workweek.  [oai_citation:5‡IRS](https://www.irs.gov/businesses/small-businesses-self-employed/depositing-and-reporting-employment-taxes?utm_source=chatgpt.com)

Product implication:

| Workflow | Worker posture |
|---|---|
| New-hire report | Worker may prepare; human approves/submits until adapter authority is proven |
| I-9 | Worker may guide, remind, and validate completeness; human/employer representative attests |
| Payroll | Worker may prepare, explain, and detect blockers; human approves execution |
| Tax filings | Worker may draft and validate; authorized human or managed filing path submits |
| Legal contracts | Worker may summarize and flag; human/legal expert approves |
| Medical/clinical | Worker may handle administrative intake where allowed; no autonomous diagnosis/treatment |
| Money movement | Worker may prepare; human approval and dual control execute |

**Vertical overlays**

Continuous Core should be horizontal. Continuous Workers should become credible through vertical overlays.

| Vertical overlay | Adds |
|---|---|
| Professional services | Proposal templates, retainer logic, client intake, SOWs, time/billing, renewal workflows |
| Construction/home services | Estimates, crew scheduling, change orders, materials, permits, job photos, closeout |
| Real estate services | Listings, showings, tenants, maintenance, leases, rent, vendor coordination |
| Administrative/support | Staffing, recurring contracts, job assignment, service verification, invoicing |
| Health-adjacent services | Intake, reminders, privacy controls, documentation support, eligibility/admin workflows |
| Retail/wholesale | Inventory, reorder, vendor terms, promotions, pricing, stockout prevention |
| Transportation | Dispatch, route, vehicle/driver docs, safety, maintenance, billing |
| Hospitality/events | Reservations, guest recovery, reviews, staffing, menus/events, demand timing |

**Vertical pack format**

```yaml
id: vertical_pack.construction_service.v1
name: Construction and Home Services
objects:
  - estimate
  - change_order
  - crew
  - material
  - permit
  - job_photo
  - closeout
workers:
  - revenue_worker
  - dispatch_worker
  - change_order_worker
  - collections_worker
workflows:
  - lead_to_estimate
  - estimate_to_deposit
  - job_to_closeout
  - change_order_to_invoice
  - review_request
rules:
  - pricing_margin_floor
  - deposit_policy
  - change_order_approval
  - customer_communication_policy
generated_views:
  - estimate_review
  - crew_schedule
  - job_closeout
  - change_order_approval
```

**End-to-end documentation system**

Continuous should be built from documentation that acts as specification. Every doc should be machine-actionable where possible.

```text
/docs
  /00-strategy
  /01-market-and-icp
  /02-product-architecture
  /03-worker-platform
  /04-business-graph
  /05-task-ledger
  /06-capability-registry
  /07-workflows
  /08-generated-ui
  /09-ai-gateway
  /10-intelligence-budgets
  /11-agentic-worker-catalog
  /12-vertical-packs
  /13-adapters
  /14-evidence-and-audit
  /15-security-and-privacy
  /16-regulated-workflows
  /17-developer-platform
  /18-testing-and-evals
  /19-operations-and-support
  /20-commercialization
  /21-roadmap
```

**Required documentation artifacts**

| Doc family | What it must define |
|---|---|
| Market and ICP docs | Target sectors, worker wedges, pains, adoption barriers, ROI model |
| Worker platform docs | Worker identity, lifecycle, missions, capabilities, permissions, KPIs, evals |
| Business graph docs | Canonical objects, relationships, schemas, effective dating, data lineage |
| Task ledger docs | Task states, ownership, evidence, due dates, recurrence, escalation |
| Capability docs | Typed actions, side effects, schemas, risk levels, approval policies |
| Workflow docs | State machines, triggers, transitions, blockers, generated UIs, evidence |
| AI gateway docs | Model routing, budgets, token ledger, providers, evals, data controls |
| Generated UI docs | View contracts, component registry, render targets, action bars, masking |
| Adapter docs | Connectors, auth, retries, idempotency, receipts, reconciliation |
| Vertical pack docs | Industry vocabulary, workflows, objects, templates, rules, KPIs |
| Evidence docs | Audit packets, receipts, snapshots, traces, exports, retention |
| Security docs | Tenant isolation, PII, secrets, prompt security, data redaction |
| Eval docs | Worker task evals, budget evals, ROI evals, safety evals, regression suites |
| Commercial docs | Pricing, packaging, open-source boundary, managed service, marketplace |

**Documentation definition of done**

Every workflow, worker, adapter, and capability must include:

| Required section | Must answer |
|---|---|
| Mission | What outcome does this own? |
| Customer | Who uses or manages this? |
| Objects | Which canonical objects does it touch? |
| Events | What triggers it? |
| Capabilities | What typed actions can be invoked? |
| Policies | What is autonomous, approval-required, or blocked? |
| Budgets | Which intelligence budgets apply? |
| UI | Which views are generated? |
| Evidence | What proof is captured? |
| Metrics | How is success measured? |
| Risks | What can go wrong? |
| Tests | How do we know it works? |
| Evals | How do we know the worker performs well? |
| Escalation | When must a human or expert take over? |

**Worker lifecycle documentation**

| Stage | Product behavior |
|---|---|
| Create | Customer selects worker, mission, vertical pack, manager, connected systems |
| Scope | Define apps, customers, records, workflows, permissions, and no-go zones |
| Budget | Assign monthly intelligence budget, per-task limits, model routes |
| Train/contextualize | Load offers, policies, templates, FAQs, prior jobs, customer preferences |
| Simulate | Run in dry-run mode against historical events |
| Approve launch | Manager approves capabilities and autonomy level |
| Operate | Worker handles tasks, drafts actions, requests approvals, executes allowed work |
| Evaluate | Track KPIs, cost, quality, errors, human correction, customer outcomes |
| Tune | Adjust prompts, workflows, policies, tools, budgets, templates |
| Suspend | Pause worker on budget, safety, connector, or quality issue |
| Retire | Revoke tools, archive memory, reassign tasks, preserve evidence |

**Worker autonomy levels**

| Level | Name | What worker can do |
|---:|---|---|
| 0 | Observe | Read scoped data and produce summaries |
| 1 | Draft | Draft responses, quotes, tasks, invoices, and recommendations |
| 2 | Internal action | Create internal tasks, update internal records, prepare artifacts |
| 3 | External communication | Send approved-template emails/SMS and update external systems under policy |
| 4 | Transaction preparation | Prepare payments, filings, contracts, refunds, payroll, but not execute |
| 5 | Approved execution | Execute specific external actions after human approval |
| 6 | Autonomous execution | Execute low-risk bounded actions without case-by-case approval |
| 7 | Managed expert mode | Operate with human specialist/accountant/legal/operator review network |

For SMBs, most early worker actions should live between Levels 1 and 3. High-risk financial, legal, payroll, filing, and regulated actions should remain Level 4–5 until Continuous has strong controls, support, and liability coverage.

**Agentic worker catalog**

| Worker | First ICP | Mission | Core systems |
|---|---|---|---|
| Revenue Operations Worker | Service SMBs | Turn leads into quotes, bookings, invoices, deposits, and reviews | Email, SMS/phone, website forms, calendar, CRM, accounting, payments |
| Owner Chief-of-Staff Worker | Owner-led SMBs | Daily brief, anomaly detection, decision queue, task routing | All connected systems |
| Dispatch/Ops Worker | Field services, transportation, real estate maintenance | Schedule jobs, route crews, update customers, close out work | Calendar, job management, SMS, maps, inventory |
| Finance Worker | Service SMBs | Invoice, collect, code, reconcile, forecast cash | Accounting, payments, bank, invoices |
| Workforce Worker | 1–100 employee SMBs | Hiring, onboarding, credentials, schedules, payroll-input readiness | HRIS, payroll, calendar, docs |
| Compliance Worker | Regulated SMBs | Track licenses, insurance, permits, contracts, filings, evidence | Documents, calendars, government portals, task ledger |
| Systems Worker | All SMBs | Connect apps, clean data, monitor sync, build workflows | Connectors, APIs, permissions |
| Inventory Worker | Retail/wholesale/manufacturing | Replenish, detect stockouts, optimize vendor orders | POS, inventory, accounting, vendors |
| Guest Experience Worker | Hospitality/arts/events | Booking, reminders, guest recovery, reviews | Reservations, SMS, email, review platforms |
| Maintenance Worker | Asset-heavy SMBs | Preventive maintenance, incident tracking, asset utilization | Fleet/assets, calendar, work orders |

**Open-source versus commercial boundary**

| Layer | Open-source | Commercial/managed |
|---|---|---|
| Business graph schemas | Yes | Hosted schema management |
| Task ledger | Yes | Hosted multi-tenant task ops |
| Capability registry | Yes | Verified capability packs |
| Workflow engine | Yes | Managed workflow execution |
| Generated UI renderer | Yes | Branded/embedded renderers |
| AI gateway core | Yes, basic | Provider billing, enterprise routing, private inference, advanced controls |
| Intelligence budgets | Yes, core ledger | Managed billing, chargeback, budget analytics |
| Worker framework | Yes | Packaged workers, vertical packs, managed workers |
| Rule-pack framework | Yes | Verified rules and compliance support |
| Adapter SDK | Yes | Premium adapters and managed execution |
| Evidence layer | Yes | Audit exports, compliance packages, customer support |
| Payroll/filing execution | Limited/draft | Managed/authorized execution |

**Pricing and packaging**

| Segment | Customer profile | Product promise | Pricing logic |
|---|---|---|---|
| Solo/nonemployer | Owner does selling, delivery, and admin | Never miss a lead, quote faster, collect faster | Low base + worker usage + intelligence budget |
| 1–19 employees | Owner has staff but weak process | Run front office/back office without hiring a coordinator | Base platform + worker package + usage |
| 20–100 employees | Roles exist but systems are fragmented | Agentic ops layer across revenue, ops, finance, workforce, compliance | Platform fee + worker modules + budget pools |
| Accountant/operator firms | Manage many SMB clients | Multi-client command center with evidence, workers, and budgets | Firm platform + per-client + worker usage |
| Vertical SaaS partners | Embed workers into existing vertical product | Add agentic labor without building infra | API/embedded + revenue share |
| Developers/self-hosters | Want extensible open platform | Open substrate for worker apps | Open core + paid support/verified packs |

**Commercial packages**

| Package | Includes |
|---|---|
| Continuous Core | Business graph, task ledger, workflows, generated UI, basic AI gateway |
| Revenue Worker | Lead intake, quote/proposal, scheduling, invoice prep, collections follow-up, reviews |
| Ops Worker | Scheduling, job tasks, customer updates, closeout, QA checklist |
| Finance Worker | Invoicing, AR follow-up, expense coding, cash forecast |
| Workforce Worker | Hiring, onboarding, scheduling, credentials, payroll-input readiness |
| Compliance Worker | Licenses, insurance, permits, deadlines, evidence binders |
| Vertical Pack | Industry templates, workflows, terms, KPIs, pricing rules |
| Intelligence Budget | Monthly usage pool, model routing, token ledger, overage controls |
| Managed Worker | Human-reviewed expert mode with service guarantees |

**Roadmap**

| Phase | Build | Proof point |
|---|---|---|
| 0 | Continuous Core: graph, task ledger, capability registry, AI gateway, generated UI, CLI/TUI | Can reconstruct business state and produce generated task surfaces |
| 1 | Revenue Operations Worker for service SMBs | More leads answered, faster quotes, more deposits/invoices collected |
| 2 | Worker control plane: budgets, autonomy levels, evals, worker scorecards | Customers can hire, govern, budget, and evaluate workers |
| 3 | Ops Worker | Jobs scheduled, customers updated, closeouts completed, handoffs reduced |
| 4 | Finance Worker | Invoices issued, AR chased, expenses coded, cash forecast visible |
| 5 | Workforce Worker | Hiring, onboarding, credentials, schedules, payroll inputs coordinated |
| 6 | Compliance Worker | Licenses, insurance, contracts, permits, safety, and evidence tracked |
| 7 | Vertical packs | Construction, professional services, real estate services, transportation, retail/wholesale |
| 8 | Marketplace | Third-party workers, adapters, rule packs, workflow packs, vertical packs |
| 9 | Managed execution | Payroll, filings, payments, and expert-reviewed regulated workflows |

**MVP scope**

The MVP should be:

```text
Continuous Revenue Worker + Continuous Core
```

Minimum capabilities:

| Area | MVP requirement |
|---|---|
| Business graph | Customers, leads, offers, quotes, jobs, invoices, payments, tasks |
| Connectors | Email, calendar, website forms, accounting, payments, CRM or spreadsheet |
| Worker runtime | Revenue Worker identity, mission, tools, memory, budget, evals |
| AI gateway | Model routing, monthly budget, usage ledger, per-task limits |
| Capability registry | Read, classify, draft, prepare quote, schedule, invoice, follow up, brief owner |
| Generated UI | Owner brief, quote approval, task queue, lead review, budget dashboard |
| Task ledger | Every lead, quote, follow-up, invoice, review request, and exception |
| Evidence | Message snapshots, drafts, approvals, sent receipts, quote versions |
| Admin control | Autonomy level, templates, pricing guardrails, approval thresholds |
| Scorecard | Leads answered, response time, quotes sent, bookings, invoices, collections, reviews, budget burn |

**The first killer demo**

```text
Owner connects Gmail, calendar, QuickBooks, Stripe, and website form.

A lead comes in.

Revenue Worker reads the message, identifies the customer need, checks service area,
checks calendar availability, checks offer/pricing rules, drafts a response, prepares
a quote, proposes available times, and generates an approval card.

Owner approves.

Revenue Worker sends the quote, schedules the job, sends deposit link, updates the
task ledger, follows up automatically, prepares the invoice after completion, chases
payment, asks for a review, and includes the entire story in the daily owner brief.
```

This demo proves the whole thesis: business graph, task ledger, worker runtime, AI gateway, generated UI, capabilities, approvals, adapters, evidence, and measurable ROI.

**Metrics**

| Metric | Why it matters |
|---|---|
| Leads answered | Direct revenue capture |
| Median lead response time | SMB conversion advantage |
| Quotes prepared | Sales throughput |
| Quote approval rate | Worker quality |
| Quote-to-booking conversion | Revenue impact |
| Deposits collected | Cash acceleration |
| Invoices sent | Admin automation |
| AR follow-ups completed | Cash recovery |
| Reviews requested | Reputation loop |
| Owner approvals per week | Human control burden |
| Owner hours saved | Value narrative |
| Intelligence budget burn | Cost control |
| Cost per completed workflow | Unit economics |
| Human correction rate | Worker quality |
| Escalation rate | Autonomy readiness |
| Connector failure rate | Infrastructure reliability |
| Evidence completeness | Trust and auditability |

**Moat**

| Moat | Why it compounds |
|---|---|
| Business graph | Every connected system and completed workflow improves context |
| Task ledger | Continuous becomes the memory of what the business should do next |
| Worker catalog | Each packaged worker reuses the same infra and expands attach rate |
| Intelligence budgets | Continuous becomes the system of record for AI labor spend |
| Capability registry | Safe action contracts let workers execute, not just chat |
| Generated UI | Faster verticalization and lower product surface cost |
| Evidence layer | Trust, auditability, and regulated expansion |
| Vertical packs | Industry-specific workflows, templates, language, KPIs, and rules |
| Adapter network | More real-world action coverage |
| Evals | Worker quality improves with operational feedback |
| Open-source substrate | Developers and partners can extend the platform |

**What not to do**

| Temptation | Why to avoid it |
|---|---|
| Start with “AI employee for every SMB” | Too vague; customers need a concrete outcome |
| Start with autonomous payroll/tax/legal/medical workflows | High-risk and support-heavy before controls mature |
| Build a fixed SaaS dashboard first | Locks the architecture around screens instead of workers and capabilities |
| Let workers directly mutate systems | Unsafe; all actions need typed capabilities |
| Let workers spend unlimited tokens | Destroys gross margin and customer trust |
| Sell labor replacement | Sell operating leverage, capacity, and owner control |
| Build every vertical at once | Start with service SMBs and reusable universal flows |
| Let LLMs generate arbitrary UI code | Use structured generated UI contracts |
| Treat AI usage as a black-box cost | Budget, meter, evaluate, and attribute every call |

**Immediate build plan**

| Workstream | First deliverable |
|---|---|
| Core graph | Customer, lead, offer, quote, job, invoice, payment, task, evidence |
| Worker runtime | AgenticWorker, mission, skills, tools, autonomy, memory, manager |
| AI gateway | Provider routes, token ledger, budget accounts, reservations, usage events |
| Capability registry | Lead classify, response draft, quote prepare, schedule propose, invoice prepare |
| Generated UI | Owner brief, lead review, quote approval, budget dashboard |
| Connectors | Gmail/Google Workspace, calendar, QuickBooks, Stripe, website forms |
| Task ledger | Lead-to-cash task states and follow-up engine |
| Evidence | Message snapshots, quote versions, approvals, sent receipts |
| Eval harness | Historical lead simulation, quality scoring, budget scoring, conversion tracking |
| Vertical seed | Professional services and home/local services templates |

**Final strategy**

Continuous should become the platform where SMBs hire AI workers, not the place where they chat with AI.

The infrastructure should remain headless and open, but the commercial product should be concrete: workers that own outcomes. Start with the Revenue Operations Worker because it maps to the largest and most painful SMB flows: missed leads, slow quotes, weak follow-up, scheduling friction, delayed invoicing, collections, reviews, and owner overload.

The long-term platform is broader: a business graph that understands the company, a task ledger that knows what must happen, a capability registry that defines safe action, an AI gateway that budgets intelligence, generated UI that appears only when needed, and evidence that proves what every human or AI worker did.

That is the scalable worker platform: **Continuous turns SMB work into governed, budgeted, measurable agentic labor.**
