# Revenue Worker V1 Contract

This contract defines the first worker surface that can be expanded without
raising autonomy or permitting external sends.

## Inputs

| Input | Required | Notes |
|---|---:|---|
| `idempotencyKey` | Yes | Stable per operator-triggered run |
| `operatorEmail` | Yes | Must match an active user in the tenant |
| `worker.role` | Yes | Explicit worker family selector; no default role is assumed |
| `worker.tenantSlug` | No | Required when an operator email spans tenants |
| `worker.id` | No | Required when multiple Revenue Workers match |
| `config.intake` | Preferred for useful runs | References persisted Core lead object/event/evidence rows used to derive classification, draft, quote, evidence, and approval packet |
| `config.leadPacket` | Fallback only | Direct source payload for operator tests and controlled evals |

## API Shape

The canonical worker control-plane route is `/worker`.

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "id": null,
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "rev-worker-001",
  "config": {
    "intake": {
      "objectId": "lead_object_uuid",
      "eventId": "lead_received_event_uuid",
      "evidenceId": "lead_snapshot_evidence_uuid",
      "sourceEventId": "form-2026-05-19-001"
    }
  }
}
```

The referenced Core records should carry the same flat lead packet in object,
event, and evidence data:

```json
{
  "source": "website_form",
  "sourceEventId": "form-2026-05-19-001",
  "customerName": "Acme Roof Repair",
  "customerIntent": "roof leak inspection",
  "serviceArea": "roofing",
  "urgency": "high",
  "missingFacts": ["preferred_time_window"]
}
```

Approval decisions use the same route:

```json
{
  "command": "approval.decide",
  "worker": {
    "role": "revenue_operations"
  },
  "config": {
    "approvalId": "approval_uuid",
    "action": "approved",
    "note": "optional operator note"
  }
}
```

Worker continuations also stay on the same route. The command consumes persisted
approval state; the URL does not encode the worker family or continuation type.

```json
{
  "command": "continue",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "rev-worker-continue-001",
  "config": {
    "approvalId": "approval_uuid"
  }
}
```

Adapter reconciliation also stays on the same command surface:

```json
{
  "command": "adapters.reconcile",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "limit": 25
  }
}
```

Worker-family-specific routes are not part of the public API. Future workers
must use `/worker` with role, command, idempotency, and config in structured
fields.

## Registry Entries

The Revenue Worker owns the first registered `/worker` commands. HTTP commands
and local toolbox aliases resolve to the same handlers and validation rules.

| HTTP command or view | Tool alias | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.snapshot` | None | None | Read-only | Blocked |
| `GET view=approvals` | `worker.approvals.list` | Optional `state` | None | Read-only | Blocked |
| `run` | `worker.run` | `config.intake` preferred, `config.leadPacket` fallback | Required | Internal records, budget, approval, dry-run adapter receipt | Blocked |
| `continue` | `worker.continue` | `approvalId` | Required | Worker continuation records, workflow step, task outcome, audit/evidence | Blocked |
| `approval.decide` | `worker.approvals.decide` | `approvalId`, `action`, optional `note` | None | Approval/task/workflow evidence only | Blocked |
| `adapters.reconcile` | `worker.adapters.reconcile` | Tenant-scoped `worker.tenantSlug`, optional integer `limit` | None | Adapter reconciliation audit/evidence | Blocked |

## Run Config

`config` is the command payload envelope. The route does not encode a worker
family, operation target, customer, source system, or draft type in the URL.

| Field | Required | Notes |
|---|---:|---|
| `intake.objectId` | Preferred | Core `objects.id` for the lead spine |
| `intake.eventId` | Preferred | Core `events.id` for the `lead.received` event; this is not the external source event id |
| `intake.evidenceId` | Preferred | Core `evidence.id` for the source snapshot |
| `intake.sourceEventId` | No | External event or message id when available; trace metadata, not the DB event id |
| `leadPacket.*` | No | Backward-compatible direct payload alias for evals and operator tests |
| `pricing.baseCents` | No | Optional deterministic quote override for evals and controlled tests |

`config.externalSend=true` or `config.leadPacket.externalSend=true` is rejected.
The first runtime only prepares owner-review packets.

## Run Output

`POST /worker` with `command=run` returns a generic command response whose
`result.output` contains worker-derived data:

| Output | Required behavior |
|---|---|
| `sourceSnapshotEvidenceId` | Points to persisted source snapshot evidence |
| `intake` | Resolved Core intake metadata used for the run |
| `sourceObjectId` | Core source object id when resolved from persisted intake |
| `sourceEventRowId` | Core source event row id when resolved from persisted intake |
| `sourceEvidenceId` | Core source evidence id when resolved from persisted intake |
| `classification` | Derived from lead urgency and missing facts |
| `draftResponse` | Owner-review draft; not externally sent |
| `quote` | Deterministic quote with lines, total, currency, and blocked money movement policy |
| `externalSend` | Always `false` in this runtime |
| `workflowRunId` | Lead-to-cash workflow run tied to the worker run |
| `workflowStepIds` | Durable workflow steps for intake, packet, adapter dry-run, and approval request |
| `inputHash` | Canonical hash binding idempotency key to the normalized input payload |

## Preconditions

| Check | Failure code |
|---|---|
| One active/training Revenue Worker selected | `worker_not_found` or `worker_selector_ambiguous` |
| Operator user exists and is active | `operator_not_found` |
| Budget account and active policy exist | `worker_budget_missing` or `worker_budget_policy_missing` |
| Budget capacity remains under policy | `worker_budget_exceeded` |
| Required capability exists and is actively granted to the worker | `worker_capability_missing` or `worker_capability_not_granted` |
| Adapter connection exists and is active | `worker_connection_missing` |

## Effects

| Record | Required behavior |
|---|---|
| `worker_runs` | Owns lifecycle, idempotency, run input, and run output |
| `workflow_runs` | Owns the lead-to-cash state machine for the prepared worker action |
| `workflow_steps` | Records intake resolved, packet prepared, adapter dry-run recorded, approval requested, and approval decision transitions |
| `budget_reservations` | Reserves and marks deterministic simulation units as used |
| `adapter_runs` | Records dry-run adapter execution, attempt metadata, receipt state, and reconciliation state |
| `inferences` | Stores prompt/result/safety trace |
| `usage_events` | Attributes units to budget, task, capability, and worker |
| `events` | Emits `revenue_worker.run.completed` with linked output ids |
| `evidence` | Stores trace, adapter receipt, and later approval decision evidence |
| `adapter_actions` | Links to the adapter run and drafts customer-response intent with `externalSend=false` |
| `approval_requests` | Creates pending operator approval for the prepared action |
| `audit_events` | Records run request, approval request, and approval decision |
| `tasks` | Moves active work to `approval_required`; decision later moves to `waiting`, `active`, or `blocked` |
| `object_versions` | Records approval-required state against the object spine |

`POST /worker` with `command=continue` creates a separate idempotent
`worker_runs` continuation record and `workflow_steps.kind=worker_continuation`
entry. V1 supports `revision_requested` approvals only; it queues the revised
packet work, updates the task outcome, and keeps adapter execution blocked.

## Approval Actions

| Action | Approval state | Task state | Workflow state | External behavior |
|---|---|---|---|---|
| `approved` | `approved` | `waiting` | `approved` when the definition allows it | Still blocked until real adapter execution exists |
| `revision_requested` | `revision_requested` | `active` | `revision_requested` when the definition allows it | `command=continue` queues revised packet work |
| `rejected` | `rejected` | `blocked` | `rejected` when the definition allows it | Worker should stop the prepared action |

## Non-Goals

- No autonomous customer sends.
- No payment link creation or money movement.
- No live CRM, inbox, calendar, quote, invoice, or payment adapter writes.
- No autonomy increase beyond read, classify, draft, prepare, and request approval.
