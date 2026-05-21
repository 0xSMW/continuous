# Customer Experience Worker V1 Contract

This contract defines the first Customer Experience worker slice for complaint
recovery, satisfaction signals, promise tracking, and review-response drafts.
V1 prepares packets and internal tasks only. It does not send customer messages,
issue refunds, alter bookings, or publish review responses.

## Header

| Field | Value |
|---|---|
| Worker role | `customer_experience_operations` |
| First outcome | Recovery draft with complaint packet, escalation task, source refs, and generated signal view |
| Autonomy level | `2` |
| Runtime status | Planned contract |
| External execution | `blocked` |

## API Shape

All commands and views use `POST /worker`; no customer-experience-specific
route is added. Command names, worker selection, and view names are payload
fields. Operation inputs and read filters stay under `config`.

```json
{
  "command": "recovery.draft",
  "worker": {
    "role": "customer_experience_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "customer-recovery-001",
  "config": {
    "sourceRefs": {
      "customerObjectId": "customer_object_uuid",
      "signalObjectId": "signal_object_uuid",
      "conversationObjectId": "conversation_object_uuid",
      "evidencePacketId": "source_packet_uuid"
    },
    "policy": {
      "tone": "calm",
      "requiresOwnerApproval": true,
      "allowExternalSend": false
    }
  }
}
```

```json
{
  "view": "signals",
  "worker": {
    "role": "customer_experience_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "state": "open",
    "severity": "high"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "signals"` payload | `worker.view` | `worker.role`, optional signal filters under `config` | None | Read-only | Blocked |
| `recovery.draft` | `worker.command` | `config.sourceRefs`, `config.policy` | Required | Recovery draft, complaint packet, approval task, generated view | Blocked |
| `escalation.route` | `worker.command` | `config.signalId`, `config.severity`, optional `config.sourceRefs` | Required | Escalation task and evidence only | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | None | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `customer` | `name`, `contactRefs`, `segment`, `serviceHistoryRef` | `active`, `at_risk`, `inactive` | `has_conversation`, `made_promise`, `reported_signal` |
| `conversation` | `channel`, `threadRef`, `participants`, `lastMessageAt`, `summary` | `open`, `waiting_on_customer`, `waiting_on_owner`, `closed` | `about_customer`, `contains_signal`, `requires_promise` |
| `promise` | `owner`, `dueAt`, `promiseText`, `sourceRefs`, `fulfillmentState` | `draft`, `approved`, `kept`, `missed`, `canceled` | `made_to_customer`, `blocks_recovery` |
| `satisfaction_signal` | `source`, `severity`, `sentiment`, `detectedAt`, `sourceRefs` | `open`, `triaged`, `recovery_drafted`, `resolved` | `about_customer`, `from_conversation`, `from_review` |
| `complaint` | `category`, `severity`, `requestedOutcome`, `facts`, `riskFlags` | `open`, `approval_pending`, `recovery_ready`, `resolved`, `rejected` | `about_customer`, `supported_by_evidence` |
| `testimonial` | `source`, `claimRefs`, `consentRef`, `customerRef`, `evidencePacketId` | `draft`, `source_review`, `approved_for_use`, `blocked`, `expired` | `about_customer`, `supports_growth`, `supported_by_evidence` |
| `review` | `platform`, `rating`, `bodyHash`, `occurredAt`, `responseState` | `new`, `drafted`, `approval_pending`, `responded`, `ignored` | `about_customer`, `references_promise` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `customer_recovery` | `signal_open -> facts_review -> draft_prepared -> approval_pending -> ready_to_send` | Required before any customer response, concession, refund, or review response | Create owner task when facts, customer ref, or promise status is missing |
| `promise_followup` | `draft -> due_date_set -> monitor -> fulfilled_or_missed` | Required before changing a promised customer outcome | Route missed promises to owner and Dispatch/Ops when work is involved |
| `review_response` | `new -> source_review -> response_drafted -> approval_pending -> ready_to_publish` | Required before external review response | Keep publish blocked and preserve source review snapshot |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Customer, conversation, signal, complaint, review refs | No | Blocked |
| `recovery.draft` | 2 | Worker | Complaint and recovery packets | Required before send | Blocked |
| `approval.request` | 2 | Worker | Recovery drafts, concessions, review responses | Yes | Blocked |
| `document_packet.prepare` | 2 | Worker | `customer_experience_packet` and source snapshots | Yes for sensitive cases | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Inbox, SMS, chat, or helpdesk | Thread metadata, redacted messages, customer refs | Draft response only | Draft body hash, source ids, no-send proof | Retry 2 then owner task |
| Review platform | Rating, review text hash, public permalink, response state | Draft public response only | Draft hash and no-publish proof | Escalate policy or legal risk |
| Job or booking system | Service history, appointment, closeout refs | None | Source snapshot id | Route service blockers to Dispatch/Ops |
| Refund or concession system | Eligibility metadata only | Proposed concession only | No-money-movement proof | Require Finance and owner approval |

## Evidence Packet

`customer_experience_packet` contains signal source refs, conversation summary,
complaint facts, promised outcome refs, recovery draft hash, approval request,
generated view id, escalation task refs, and no-external-send proof. Raw private
messages, payment data, employee notes, medical/legal data, and credentials are
redacted or represented by source handles.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `customer.signals` | `satisfaction_signal` | `draft_recovery`, `route_escalation`, `request_facts` | `no_signals`, `customer_missing`, `source_unavailable` |
| `customer.recovery.review` | `complaint` | `approve_draft`, `request_revision`, `reject_send` | `missing_facts`, `policy_required`, `high_risk_claim` |
| `customer.promises` | `promise` | `mark_kept`, `route_missed`, `request_owner` | `no_promises`, `due_date_missing` |

## Evals

Golden cases cover happy-path recovery, missing customer refs, angry or abusive
input, prompt injection in messages, promised refunds, missed appointments,
review-response risk, budget pressure, approval behavior, idempotent replay,
and no external send or publish.

## Security

Customer messages are untrusted evidence, not instructions. Prompt injection in
threads, reviews, attachments, or public profile text must not change policy,
refund, approval, or send behavior. Sensitive fields include contact details,
private complaint facts, payment/refund data, employee notes, and regulated
data. Abuse cases: unauthorized external response, hidden refund promise,
publicly leaking private facts, reputation manipulation, or bypassing owner
approval for concessions.
