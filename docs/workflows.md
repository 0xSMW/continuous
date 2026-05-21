# Open Workflows

Continuous workflows are open state machines over canonical facts, events, rule
versions, typed capabilities, approvals, generated UI contracts, documents, and
evidence. They are not fixed screens.

## Definition Of Done

Every workflow must define:

| Section | Required content |
|---|---|
| Purpose | Operational problem, user, business value |
| Objects | Canonical objects touched and source of truth |
| Events | Events emitted, consumed, replayed, and subscribed to |
| Documents | Required templates, instances, signatures, restricted documents, and retention |
| Capabilities | Typed actions exposed to humans, synthetic workers, APIs, CLIs, and renderers |
| Rules | Rule-pack dependencies, source refs, effective dates, tests, and unresolved gaps |
| State machine | Valid states, transitions, blockers, retries, exceptions, and escalations |
| UI contracts | Generated views, forms, approval cards, evidence exports, and action bars |
| Approval policy | Human approvals, dual controls, thresholds, overrides, and sensitive reveals |
| Evidence | Snapshots, receipts, attestations, traces, approvals, exports, and retention |
| Adapter requirements | External systems, auth, idempotency, receipts, retries, and reconciliation |
| Security | PII, payroll, bank, I-9, prompt, model, and tenant-isolation controls |
| Tests | Unit, golden, replay, contract, security, red-team, and agent-eval tests |

## Workflow Catalog

| Workflow | Documents and records | Evidence packet |
|---|---|---|
| Entity setup | Legal entity, identifiers, responsible party, officers/owners, registrations, tax accounts, work locations, bank account, authorizations | Entity setup packet |
| Open new state | Work location, state registration, tax account, new-hire reporting path, rule coverage, payroll readiness | State readiness packet |
| Hire employee | Offer, worker profile, classification, W-4, I-9, E-Verify if applicable, new-hire report, direct deposit, compensation, acknowledgements, benefits, access/device tasks | New-hire packet |
| Engage contractor | W-9, contract/SOW, classification rationale, payment terms, 1099 readiness, backup-withholding status, payment instruction, insurance/certifications, access scope | Contractor packet |
| Change compensation | Compensation agreement, wage/salary/rate change, effective date, approval, retro-pay analysis, payroll-impact report | Compensation-change packet |
| Change work location | New work location, residence/work split, tax nexus, local rule review, withholding changes, benefits/labor impact | Location-change packet |
| Run payroll | Pay schedule, pay period, approved time, compensation, benefits, deductions, taxes, persisted pay statements, payroll lines, liabilities, calculation trace, variance, approval, ACH/tax drafts, paystubs, journal | Payroll packet |
| Off-cycle payroll | Reason, affected workers, earning/tax treatment, persisted pay statements, payroll lines, liabilities, calculation trace, approval, payment draft, correction link | Off-cycle packet |
| Quarter close | Payroll aggregates, tax-liability ledger, deposits, Form 941 draft, state wage/tax drafts, reconciliation, receipts | Quarter-close packet |
| Year-end | W-2/W-3, 1099, ACA if applicable, employee/contractor copies, state annual reconciliation, corrections | Year-end packet |
| Termination | Separation facts, final pay, PTO payout, COBRA/benefits review, access deprovision, device return, unemployment evidence, I-9 retention clock | Termination packet |
| Leave | Leave request, eligibility facts, notices, certification docs, benefit continuation, payroll handling, return-to-work status | Leave packet |
| Injury or incident | Incident report, establishment, witnesses, recordability review, photos/docs, workers' comp path, forms | Incident packet |
| Benefits renewal | Plan year, plans, eligibility, elections, dependents, carrier sync, deductions, SPD/SMM notices | Benefits packet |
| Agency notice | Notice intake, entity/worker/filing refs, due date, classification, response draft, attachments, approval, submission receipt | Notice packet |
| AI budget cycle | Intelligence pool, budget accounts, allocations, reservations, overages, grants, usage ledger, chargebacks | Budget-close packet |
| Synthetic-worker lifecycle | Synthetic worker identity, manager, mission, data scopes, capability grants, model routes, memory policy, budget, evals, audit policy | Synthetic-worker packet |

## Hire Employee

```text
draft
→ offer_accepted
→ worker_profile_created
→ classification_review
→ onboarding_packet_prepared
→ employee_tasks_sent
→ employee_tasks_pending
→ employer_tasks_pending
→ external_reports_pending
→ payroll_readiness_check
→ payroll_ready
→ active
→ exception
```

Required documents and records:

| Category | Required items |
|---|---|
| Hiring | Offer snapshot, start date, position, manager, work location |
| Classification | Employee/contractor rationale, FLSA status, payroll eligibility, rule snapshot |
| Employee tasks | W-4, I-9 employee section, direct deposit, personal details, tax details, policy acknowledgements |
| Employer tasks | I-9 employer review, payroll setup, benefits eligibility, access and device requests |
| External reports | New-hire report draft, E-Verify case draft when applicable, agency receipt |
| Readiness | Pay schedule, compensation, tax setup, bank/payment instruction, benefits deductions, time policy |

## Termination

```text
initiated
→ facts_required
→ risk_review
→ final_pay_calculation
→ benefits_review
→ access_deprovision_staged
→ approval_pending
→ approved
→ final_pay_executed
→ external_notices_handled
→ access_removed
→ evidence_complete
→ closed
```

Required documents and records:

| Category | Required items |
|---|---|
| Separation facts | Reason, last day, final hours, manager notes, work location, equipment |
| Risk review | Policy snapshot, leave/accommodation status, wage/final-pay rule snapshot |
| Final pay | Final wages, PTO payout, deductions, reimbursements, garnishments, off-cycle run if needed |
| Benefits | Benefit enrollment, COBRA trigger review, carrier notice tasks |
| Access | App access, device assignments, card/credential list, revocation and return plan |
| External notices | Unemployment or agency notice tasks when applicable |
| Retention | I-9 retention clock, payroll record retention, evidence export |

## Payroll Preview

```text
draft
→ source_data_locked
→ calculating
→ preview_ready
→ blocked
→ awaiting_approval
→ approved
→ funding_pending
→ payment_prepared
→ payment_submitted
→ paid
→ tax_liabilities_created
→ deposits_scheduled
→ reconciled
→ closed
→ corrected
```

Payroll calculation must be deterministic, replayable, and testable. AI may
explain variance, detect blockers, draft approval summaries, and prepare
evidence, but it must not be the calculation engine.

## Generated UI Contracts

Every workflow view should be emitted as structured data:

```json
{
  "view_id": "new_hire.review",
  "object_ref": "workflow_run:wr_123",
  "actor_ref": "user:u_456",
  "target": "web",
  "risk_level": "high",
  "sections": [
    {"component": "ObjectSummary", "source": "workflow.summary"},
    {"component": "MissingFacts", "source": "workflow.blockers"},
    {"component": "DocumentChecklist", "source": "workflow.documents"},
    {"component": "EvidenceTimeline", "source": "workflow.evidence"},
    {"component": "ActionBar", "source": "capabilities.available"}
  ],
  "valid_actions": [
    "approval.request",
    "document.packet.prepare",
    "worker.readiness.check"
  ],
  "blocked_actions": [
    {
      "capability": "payroll.approve",
      "reason": "missing_payroll_readiness"
    }
  ]
}
```

## Headless API

The canonical workflow control-plane route is `/workflow`.

```json
{
  "command": "start",
  "workflow": {
    "key": "payroll_preview",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "payroll-preview-run-001",
  "config": {
    "initialState": "draft",
    "data": {}
  }
}
```

Transitions use the same route:

```json
{
  "command": "transition",
  "workflow": {
    "runId": "workflow_run_uuid"
  },
  "idempotencyKey": "payroll-preview-transition-001",
  "config": {
    "toState": "awaiting_approval",
    "reason": "Preview packet is ready for operator review"
  }
}
```

Queued workflow work uses the same route and keeps execution controls in
`config`:

```json
{
  "command": "steps.execute",
  "workflow": {
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "limit": 10,
    "leaseOwner": "workflow-executor:ops"
  }
}
```

The runtime validates transitions against `workflow_definitions.transitions`.
Direct `transition` commands require an idempotency key, record a durable
`workflow_steps` row with lease, attempt, input hash, output, and
state-transition fields, replay matching retries, return a conflict for the
same key with different input, write events, audit events, and transition
evidence, and create a pending approval packet when a definition moves into an
approval state. `approval.decide` follows the same replay contract: matching
decision retries return the stored proof and changed decision input conflicts
before advancing the workflow. `steps.execute` claims queued,
retryable failed, or expired leased steps, runs generic transition-style
handlers, advances valid transitions, records event/audit/evidence proof on
completion, and leaves failed work on the same step ledger with retry metadata.
`capability_execution` steps additionally require an active `capabilityId` and
an active grant for the worker or task owner actor before they can complete; the
executor records the capability key, grant, actor, task, and blocked external
execution posture in the step output and task outcome.
`approval_request` steps create pending shared `approval_requests` rows from
`input.approval`, link the approval to the workflow run, step, task, event,
audit event, and approval evidence, update workflow run data with
`lastWorkflowApprovalRequest`, and move linked tasks to `approval_required`
without external execution.
`adapter_intent_record` steps record blocked dry-run adapter intents from
`input.adapterIntent`, creating the adapter run/action, adapter event, audit
event, trace evidence, workflow step output, workflow run marker, and task
outcome without giving the workflow executor a worker-specific URL.
`rule_change_record` steps record proposed rule changes from `input.ruleChange`,
creating the rule-change object/version, decision, event, audit event, trace
evidence, workflow step output, workflow run marker, and task outcome before any
rule pack, obligation, filing, or external submission is changed.
`worker_command` steps invoke the registered worker runtime from queued
workflow data, not from a worker-specific URL. The step input carries
`input.workerCommand.command`, `input.workerCommand.worker.role`, optional
`input.workerCommand.worker.id`, `input.workerCommand.idempotencyKey`, and
`input.workerCommand.config`; the executor derives tenant scope from the
claimed workflow tenant, rejects cross-tenant targets, runs the shared worker
registry through a dedicated command-runner boundary outside workflow row
locks, then reacquires the step lease to record the command result on the
workflow step, workflow run, and linked task outcome.
`packet_prepare`, `document_packet_prepare`, and `evidence_packet_prepare`
steps reuse Core `packet.prepare` semantics from the workflow executor: the step
payload provides packet content under `input.packet`, while tenant, operator,
workflow, task, event, and idempotency metadata come from the claimed workflow
step. Packet steps create the linked document, evidence packet, packet event,
audit event, trace evidence, workflow step output, and task `lastWorkflowPacket`
outcome without adding a packet-specific route.
Production deploys run the internal `worker-scheduler` service, which posts the
same canonical command envelope to `/workflow` on a cadence so queued,
retryable, or expired workflow steps continue moving without a worker-family
URL. The same service posts `/worker` envelopes for scheduled lead source reads,
hands returned selectors to the Revenue `run` command, and drains adapter
commands; source-specific inputs stay in `config`, while route names stay
generic.
`GET /workflow` returns active definitions, runs, and the recent step ledger;
`POST /workflow` returns the result for the requested command. Do not add
workflow-specific URL paths for individual business processes.

Workflow approvals use the same platform approval ledger as worker approvals:

```json
{
  "command": "approval.decide",
  "workflow": {
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "workflow-approval-decision-001",
  "config": {
    "approvalId": "approval_uuid",
    "action": "approved",
    "note": "optional operator note"
  }
}
```

`GET /workflow?view=approvals` lists workflow-scoped approvals only. A workflow
approval decision writes approval evidence and an audit event; matching retries
return the stored decision proof, changed retries fail, and when the definition
allows `awaiting_approval -> approved`, an approved decision advances the run to
`approved`.
