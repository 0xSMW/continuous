# Workforce Operations Worker V1 Contract

This contract defines the workforce worker for hiring, onboarding, contractor
engagement, credential renewal, schedule readiness, and payroll-input
readiness. V1 prepares packets and blockers; it does not submit payroll, sign
documents, or make employment/legal judgments autonomously.

## Header

| Field | Value |
|---|---|
| Worker role | `workforce_operations` |
| First outcome | New-hire or contractor packet with payroll blockers |
| Autonomy level | `2` |
| External execution | `blocked`; HR/payroll adapters dry-run only |

## API Shape

All commands use `POST /worker`; no workforce-specific route is added.

```json
{
  "command": "hire.packet.prepare",
  "worker": {
    "role": "workforce_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "workforce-hire-candidate-001",
  "config": {
    "personId": "person_object_uuid",
    "positionId": "position_object_uuid",
    "workLocationId": "location_object_uuid"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.view` | `worker.role` | None | Read-only | Blocked |
| `hire.packet.prepare` | `worker.command` | `config.personId`, `config.positionId`, `config.workLocationId` | Required | Packet, document checklist, approval request | Blocked |
| `contractor.packet.prepare` | `worker.command` | `config.personId`, `config.engagementId` | Required | Classification packet and blocker task | Blocked |
| `credential.review` | `worker.command` | `config.personId` or `config.credentialId` | Required | Credential renewal task and evidence | Blocked |
| `schedule_readiness.prepare` | `worker.command` | `config.personId`, `config.period` | Required | Readiness packet and exception tasks | Blocked |
| `payroll_input.prepare` | `worker.command` | `config.employmentId`, `config.period` | Required | Payroll input packet plus Core `payroll.preview.record` and `payroll.preview.packet.prepare` handoff | Dry-run |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | None | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `person` | `name`, `contactRef`, `workerType`, `jurisdiction`, `sensitiveRefs` | `candidate`, `active`, `inactive`, `blocked` | `held_by`, `has_document`, `has_credential` |
| `employment` | `personId`, `positionId`, `locationId`, `startDate`, `status`, `payBasis` | `draft`, `offer_pending`, `onboarding`, `active`, `terminated`, `blocked` | `held_by`, `assigned_position`, `assigned_location` |
| `contractor_engagement` | `personId`, `scope`, `classificationRationale`, `startDate`, `endDate` | `draft`, `classification_review`, `approval_required`, `active`, `closed` | `engages_person`, `supported_by` |
| `position` | `title`, `department`, `managerRef`, `requirements`, `budgetRef` | `open`, `filled`, `paused`, `closed` | `reports_to`, `funded_by` |
| `compensation_agreement` | `employmentId`, `rate`, `currency`, `effectiveAt`, `approvalRef` | `draft`, `approval_required`, `active`, `superseded` | `applies_to_employment`, `approved_by` |
| `credential` | `personId`, `kind`, `expiresAt`, `issuer`, `documentId`, `verificationState` | `missing`, `pending`, `verified`, `expiring`, `expired` | `required_for_position`, `documented_by` |
| `document` | Existing Core document fields plus `documentType`, `sensitivity`, `expiry` | Core document states | `belongs_to_person`, `supports_engagement` |
| `payroll_input` | `employmentId`, `period`, `hours`, `earnings`, `deductions`, `blockers` | `draft`, `review_ready`, `blocked`, `approved_for_preview` | `supports_payroll`, `blocked_by` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `hire_employee` | `draft -> facts_required -> document_packet -> approval_pending -> payroll_ready -> active` | Offer, compensation, payroll readiness | Create blocker task for missing docs or jurisdiction |
| `engage_contractor` | `draft -> classification_review -> packet_ready -> approval_pending -> active` | Classification and contract packet | Escalate classification uncertainty |
| `credential_renewal` | `watch -> renewal_required -> document_requested -> review_ready -> verified` | Restricted document review | Create due-date obligation and manager task |
| `payroll_input_readiness` | `draft -> source_review -> blocker_review -> review_ready -> approved_for_preview` | Payroll preview handoff | Keep payroll submission blocked |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Workforce graph reads | No | Blocked |
| `document_packet.prepare` | 2 | Worker | Hire, contractor, credential packets | Required for restricted docs | Blocked |
| `payroll_preview.prepare` | 2 | Worker | Core `payroll.preview.record` and `payroll.preview.packet.prepare` handoff for statements, lines, liabilities, traces, packet docs, approvals, and blocked funding/tax drafts | Required | Dry-run |
| `approval.request` | 2 | Worker | Hire, contractor, compensation, payroll blockers | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Docs/signature | Template status, signature status, document metadata | Draft packet/request only | Document refs and no-send proof | Retry 3 then owner task |
| Calendar | Start dates, onboarding meetings, availability | Draft event only | Proposed event refs | Retry 2 then schedule blocker |
| HRIS/payroll | Worker profile, pay setup, payroll blockers | Draft profile or payroll input only | Validation warnings, no-submit proof | Retry 2 then payroll blocker task |
| Email | Candidate/worker thread metadata | Draft message only | Draft body hash, no-send proof | Retry 2 then manager review |

## Evidence Packet

`workforce_packet` contains identity/source facts, document checklist, credential
proof, compensation approval, classification rationale, payroll blockers,
payroll preview artifact refs, and adapter receipts. Tax identifiers, government IDs, health information, bank
fields, background-check data, and private documents are redacted by default.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `workforce.hire.review` | `employment` | `approve_packet`, `request_document`, `block_start` | `missing_documents`, `jurisdiction_unknown` |
| `workforce.contractor.review` | `contractor_engagement` | `approve_engagement`, `request_revision`, `escalate_classification` | `classification_uncertain`, `contract_missing` |
| `workforce.payroll_input.review` | `payroll_input` | `approve_preview`, `request_fix`, `block_payroll` | `missing_hours`, `credential_expired` |

## Evals

Golden cases cover complete hire packet, missing I-9-like documents, contractor
classification uncertainty, expired credential, payroll blocker detection,
restricted data redaction, idempotent replay, and no payroll submission.

## Security

Employment, payroll, tax, identity, and credential records are high sensitivity.
The worker does not provide legal advice, does not decide protected-class
matters, does not sign documents, and does not submit payroll. Abuse cases:
misclassification, discriminatory routing, private document leakage, hidden
payroll blockers, or unapproved compensation changes.
