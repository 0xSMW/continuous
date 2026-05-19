# Dispatch Operations Worker V1 Contract

This contract defines the dispatch worker for promise-to-delivery workflows:
schedule proposal, customer update drafts, closeout packets, and exception
tasks. V1 prepares internal records and dry-run adapter actions only.

## Header

| Field | Value |
|---|---|
| Worker role | `dispatch_operations` |
| First outcome | Job schedule proposal and customer update packet |
| Autonomy level | `2` |
| External execution | `dry_run` for scheduling, `blocked` for customer sends |

## API Shape

All commands use `POST /worker`; no dispatch-specific route is added.

```json
{
  "command": "schedule.propose",
  "worker": {
    "role": "dispatch_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "dispatch-schedule-job-001",
  "config": {
    "jobId": "job_object_uuid",
    "constraints": {
      "serviceWindow": "2026-05-20",
      "durationMinutes": 120,
      "crewSkills": ["roofing"]
    }
  }
}
```

## Registry Entries

| Command or view | Tool alias | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.snapshot` | `worker.role` | None | Read-only | Blocked |
| `schedule.propose` | `worker.dispatch.schedule.propose` | `jobId`, `constraints` | Required | Appointment draft, adapter dry-run, approval request | Dry-run |
| `customer_update.draft` | `worker.dispatch.customer_update.draft` | `jobId`, `updateKind` | Required | Draft message, evidence packet, approval request | Blocked |
| `closeout.prepare` | `worker.dispatch.closeout.prepare` | `workOrderId`, `sourceRefs[]` | Required | Closeout document, QA checklist, evidence packet | Blocked |
| `exception.route` | `worker.dispatch.exception.route` | `jobId`, `reason`, `severity` | Required | Task and decision record | Blocked |
| `approval.decide` | `worker.approvals.decide` | `approvalId`, `action`, optional `note` | None | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `job` | `customerId`, `serviceArea`, `siteAddress`, `promiseWindow`, `status`, `quoteId` | `sold`, `ready_to_schedule`, `scheduled`, `in_progress`, `blocked`, `closed` | `for_customer`, `from_quote`, `has_work_order` |
| `work_order` | `jobId`, `scope`, `crewRequirements`, `materials`, `siteNotes`, `riskFlags` | `draft`, `ready`, `assigned`, `in_progress`, `closeout_ready`, `closed` | `fulfills_job`, `assigned_to`, `uses_material` |
| `appointment` | `jobId`, `startAt`, `endAt`, `crewId`, `timezone`, `constraints`, `conflicts` | `proposed`, `approval_required`, `scheduled`, `canceled`, `blocked` | `schedules_work_order`, `assigned_crew` |
| `crew` | `members`, `skills`, `homeBase`, `availability`, `capacity` | `available`, `assigned`, `unavailable` | `assigned_to`, `has_member` |
| `asset` | `kind`, `availability`, `location`, `maintenanceState` | `available`, `reserved`, `down` | `assigned_to`, `needed_for` |
| `material` | `sku`, `quantity`, `availability`, `requiredBy` | `needed`, `reserved`, `missing`, `used` | `needed_for`, `blocks` |
| `closeout` | `workOrderId`, `photos`, `notes`, `customerSignoff`, `invoiceReady` | `draft`, `review_ready`, `accepted`, `rework_required` | `closes_work_order`, `supports_invoice` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `promise_to_delivery` | `sold -> ready_to_schedule -> schedule_proposed -> approval_pending -> scheduled -> in_progress -> closeout_ready -> closed` | Schedule confirmation and customer update | Create exception task when schedule conflicts persist |
| `customer_update` | `draft -> evidence_ready -> approval_pending -> ready_to_send -> sent_receipt_recorded` | Every external message | Keep `ready_to_send` blocked until send worker exists |
| `closeout` | `draft -> source_review -> qa_ready -> approval_pending -> invoice_ready` | QA completion and invoice handoff | Mark `rework_required` with task and evidence |

Retry policy: three adapter dry-run attempts, then `exception.route`.

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `schedule.propose` | 2 | Worker | Tenant jobs, crews, calendars | Required before external calendar write | Dry-run |
| `response.draft` | 1 | Worker | Customer update drafts | Required before send | Blocked |
| `document_packet.prepare` | 2 | Worker | Closeout and QA packets | Required for closeout acceptance | Blocked |
| `approval.request` | 2 | Worker | Schedule, customer update, closeout | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Calendar | Availability, existing appointments, crew calendars | Proposed event with no external commit | Conflict list, event draft id, `externalMutation=false` | Retry 3 then exception task |
| Job system | Job/work-order status and notes | Draft internal status update | Work-order refs and dry-run status | Retry 3 then Systems task |
| Maps/routing | Travel time and route feasibility | None | Route estimate and confidence | Retry 2 then manual dispatch review |
| SMS/email | Customer thread metadata | Draft message only | Draft body hash, no-send proof | Retry 2 then approval task |
| Inventory | Material availability | Reservation draft only | Material blocker refs | Retry 2 then material exception |

## Evidence Packet

`dispatch_packet` contains source job facts, schedule rationale, conflict scan,
customer update draft, dry-run adapter receipt, material blockers, and approval
records. Site addresses, phone numbers, and private customer notes are redacted
unless the operator has reveal approval.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `dispatch.schedule.review` | `appointment` | `approve_schedule`, `request_revision`, `route_exception` | `no_slots`, `calendar_unavailable`, `crew_missing` |
| `dispatch.customer_update.review` | `job` | `approve_send`, `edit_message`, `request_revision` | `missing_customer_contact`, `source_partial` |
| `dispatch.closeout.review` | `closeout` | `accept_closeout`, `request_rework`, `prepare_invoice` | `missing_photos`, `qa_incomplete` |

## Evals

Golden cases cover conflict-free scheduling, double-booked crews, missing
materials, risky customer message content, closeout missing photos, idempotent
replay, adapter dry-run receipts, and no unapproved customer updates.

## Security

Customer contact data, addresses, photos, crew availability, and site notes are
sensitive. Adapter content is untrusted. Customer sends and calendar commits
require approval and receipt capture. Abuse cases: schedule overcommitment,
unapproved customer promises, hiding safety/material blockers, or leaking crew
or customer private details.
