# Compliance Operations Worker V1 Contract

This contract defines the compliance worker for obligations, notices, licenses,
permits, insurance, filing drafts, and evidence binders. V1 prepares drafts and
review packets; agency submissions remain human-approved and blocked.

## Header

| Field | Value |
|---|---|
| Worker role | `compliance_operations` |
| First outcome | Compliance packet with obligation, rule source, draft, and approval path |
| Autonomy level | `2` |
| External execution | `blocked`; agency adapters manual or dry-run only |

## API Shape

All commands use `POST /worker`; no compliance-specific route is added.

```json
{
  "command": "filing.prepare",
  "worker": {
    "role": "compliance_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "compliance-filing-941-2026q2",
  "config": {
    "filingRequirementId": "filing_requirement_object_uuid",
    "period": "2026-Q2",
    "sourceRefs": ["payroll_run_object_uuid"]
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.view` | `worker.role` | None | Read-only | Blocked |
| `obligation.scan` | `worker.command` | `config.scope`, `config.jurisdiction` | Required | Obligation proposals and evidence | Blocked |
| `notice.response.prepare` | `worker.command` | `config.noticeId` | Required | Response draft, packet, approval request | Blocked |
| `license.renewal.prepare` | `worker.command` | `config.licenseId` | Required | Renewal packet and blocker tasks | Blocked |
| `filing.prepare` | `worker.command` | `config.filingRequirementId`, `config.period` | Required | Filing draft packet | Blocked |
| `evidence_binder.export` | `worker.command` | `config.objectIds[]`, `config.purpose` | Required | Export document and audit evidence | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | None | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `rule_pack` | `jurisdiction`, `sourceUrl`, `effectiveAt`, `summary`, `version`, `confidence` | `draft`, `reviewed`, `active`, `superseded` | `governs`, `source_for` |
| `obligation` | `kind`, `dueAt`, `jurisdiction`, `ownerRef`, `rulePackId`, `status`, `risk` | `open`, `blocked`, `draft_ready`, `approval_required`, `closed` | `derived_from_rule`, `about_entity`, `satisfied_by` |
| `filing_requirement` | `agency`, `form`, `frequency`, `thresholds`, `sourceRefs` | `active`, `paused`, `superseded` | `requires_filing`, `governed_by` |
| `filing_draft` | `requirementId`, `period`, `sourceFacts`, `validation`, `submissionState` | `draft`, `source_review`, `review_ready`, `approval_required`, `ready_to_file`, `filed` | `satisfies_obligation`, `prepared_from` |
| `notice` | `agency`, `receivedAt`, `dueAt`, `noticeType`, `sourceDocumentId`, `risk` | `received`, `classified`, `response_draft`, `approval_required`, `closed` | `about_obligation`, `requires_response` |
| `license` | `issuer`, `jurisdiction`, `numberRef`, `expiresAt`, `renewalWindow` | `active`, `expiring`, `renewal_ready`, `expired`, `blocked` | `permits_activity`, `renewed_by` |
| `permit` | `issuer`, `locationId`, `activity`, `expiresAt`, `conditions` | `active`, `expiring`, `blocked`, `closed` | `permits_location`, `requires_license` |
| `insurance_policy` | `carrier`, `coverageType`, `limits`, `expiresAt`, `certificateDocumentId` | `active`, `expiring`, `lapsed`, `blocked` | `covers_entity`, `supports_contract` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `obligation_intake` | `draft -> rule_review -> obligation_open -> owner_review -> active` | Rule source and owner assignment | Create task when rule source is missing |
| `notice_response` | `received -> classification -> response_draft -> approval_pending -> ready_to_submit -> receipt_recorded` | Response and submission | Submission blocked until receipt path exists |
| `license_renewal` | `watch -> renewal_required -> packet_ready -> approval_pending -> ready_to_submit` | Renewal packet | Escalate expired licenses immediately |
| `filing_draft` | `draft -> source_data_review -> validation -> review_ready -> approval_pending -> ready_to_file` | Filing draft approval | Keep external submission blocked |
| `evidence_export` | `draft -> source_collect -> redaction_review -> export_ready -> closed` | Sensitive reveal approval | Block export when redactions fail |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `filing.prepare` | 2 | Worker | Filing drafts and validation traces | Required | Blocked |
| `document_packet.prepare` | 2 | Worker | Compliance binder packets | Required for export | Blocked |
| `approval.request` | 2 | Worker | Notices, filings, renewals, exports | Yes | Blocked |
| `sensitive_data.reveal` | 1 | Worker | Redacted compliance docs | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Document store | Source documents, certificates, forms | Export draft only | Document refs and redaction map | Retry 3 then missing-doc task |
| Calendar | Compliance due dates | Draft reminder only | Reminder draft id, no external commit | Retry 2 then obligation task |
| Agency portal/manual upload | Requirement metadata, receipt upload | Submission draft only | Validation warnings, `submitted=false` | No auto retry; owner task |
| Email | Notice intake and agency correspondence | Draft response only | Draft body hash and no-send proof | Retry 2 then owner review |

## Evidence Packet

`compliance_packet` contains source rule refs, rule snapshot, obligation, draft,
validation trace, approval record, redaction map, and receipt or rejection refs.
Tax identifiers, agency account numbers, legal documents, employee/customer
data, and credentials are redacted by default.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `compliance.obligation.review` | `obligation` | `approve_obligation`, `assign_owner`, `request_source` | `rule_source_missing`, `jurisdiction_unknown` |
| `compliance.filing.review` | `filing_draft` | `approve_draft`, `request_revision`, `export_packet` | `source_data_missing`, `validation_failed` |
| `compliance.notice.review` | `notice` | `approve_response`, `request_revision`, `escalate` | `due_date_missing`, `source_scan_required` |

## Evals

Golden cases cover obligation due-date detection, rule-source traceability,
notice classification, filing validation failure, false-positive blocker rate,
sensitive export redaction, idempotent replay, and no agency submission.

## Security

The worker does not provide legal advice, does not submit filings, and does not
represent final compliance status without source refs. Agency portal content and
notice text are untrusted. Abuse cases: fabricated rule citations, missed due
dates, unapproved submissions, leaking tax/legal docs, or treating a draft as a
filed receipt.
