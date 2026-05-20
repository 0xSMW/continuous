# Revenue Operations Worker V1 Contract

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
| `config.source` + `config.records[]` | Required for `lead.read` | Reads inbound lead records into persisted Core source object/event/evidence rows |
| `config.intake` | Preferred for useful runs | References persisted Core lead source identity or object/event/evidence rows used to derive classification, draft, quote, evidence, and approval packet |
| `config.leadPacket` | Fallback only | Direct source payload for operator tests and controlled evals |

## API Shape

The canonical worker control-plane route is `/worker`.

Only `command`, `worker`, `idempotencyKey`, and `config` are accepted as
top-level command fields. Worker role, tenant selection, and worker id live
under `worker`; operation-specific inputs such as source records, approval ids,
retry limits, pricing overrides, and direct fallback lead payloads live under
`config`.

Read inbound lead source records before running the worker:

```json
{
  "command": "lead.read",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "lead-read-001",
  "config": {
    "source": "website_form",
    "records": [
      {
        "sourceEventId": "form-2026-05-19-001",
        "customerName": "Acme Roof Repair",
        "customerIntent": "roof leak inspection",
        "serviceArea": "roofing",
        "urgency": "high",
        "missingFacts": ["preferred_time_window"]
      }
    ]
  }
}
```

The command returns `result.selectors[]`; pass one selector's
`intake.source` and `intake.sourceEventId` to `command=run`:

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
      "source": "website_form",
      "sourceEventId": "form-2026-05-19-001"
    }
  }
}
```

Internal workflow handlers that already hold Core row ids can send exact
references in the same `config.intake` object:

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "rev-worker-row-001",
  "config": {
    "intake": {
      "objectId": "lead_object_uuid",
      "eventId": "lead_received_event_uuid",
      "evidenceId": "lead_snapshot_evidence_uuid"
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

Due adapter retries use the same tenant-scoped command envelope and remain
dry-run only:

```json
{
  "command": "adapters.retry",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "limit": 25
  }
}
```

Worker-family-specific routes are not part of the public API. There is no
Revenue Operations compatibility path or worker-specific local mutation
shortcut; HTTP and CLI callers both go through the registered `/worker` command
envelope. Future workers must use `/worker` with role, command, idempotency,
and config in structured fields; ad hoc top-level operation fields are rejected.

## Registry Entries

The Revenue Worker owns the first registered `/worker` commands. HTTP commands
and local toolbox aliases resolve to the same handlers and validation rules.

| HTTP command or view | Tool alias | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.snapshot` | None | None | Read-only | Blocked |
| `GET view=approvals` | `worker.approvals.list` | Optional `state` | None | Read-only | Blocked |
| `lead.read` | `worker.lead.read` | `source`, `records[]` or `record` | Required | Core lead object/event/evidence, worker run, budget/usage, audit | Blocked |
| `run` | `worker.run` | `config.intake` preferred, `config.leadPacket` fallback | Required | Internal records, budget, approval, dry-run adapter receipt | Blocked |
| `continue` | `worker.continue` | `approvalId` | Required | Approved execution packet, revised approval packet, or rejected stop packet, workflow step, task outcome, audit/evidence | Blocked |
| `approval.decide` | `worker.approvals.decide` | `approvalId`, `action`, optional `note` | None | Approval/task/workflow evidence only | Blocked |
| `adapters.reconcile` | `worker.adapters.reconcile` | Tenant-scoped `worker.tenantSlug`, optional integer `limit` | None | Adapter reconciliation audit/evidence plus retry/review system tasks | Blocked |
| `adapters.retry` | `worker.adapters.retry` | Tenant-scoped `worker.tenantSlug`, optional integer `limit` | None | Executes due dry-run retry rows, closes retry tasks, and writes blocked receipt evidence with live-credential readiness and rollback proof | Blocked |

## Run Config

`config` is the command payload envelope. The route does not encode a worker
family, operation target, customer, source system, or draft type in the URL.

For `command=lead.read`, use:

| Field | Required | Notes |
|---|---:|---|
| `source` | Yes | Source system name, for example `website_form` or later `gmail` |
| `records[].sourceEventId` | Yes | Stable external source event, form, message, or row id |
| `records[].customerName` | No | Used to name the Core lead object; defaults to `Customer` |
| `records[].customerIntent` | No | Used for downstream classification; defaults to `service request` |
| `records[].serviceArea` | No | Used for quote defaults; defaults to `field service` |
| `records[].urgency` | No | `low`, `normal`, `high`, `urgent`, `emergency`, or `same_day` |
| `records[].missingFacts` | No | Missing facts carried forward to the approval packet |
| `records[].payload` | No | Raw source payload retained in evidence with external execution blocked |

| Field | Required | Notes |
|---|---:|---|
| `intake.source` | Preferred for external callers | Source system name, for example `website_form`, used with `intake.sourceEventId` to resolve persisted Core records |
| `intake.sourceEventId` | Preferred for external callers | External event or message id; this is not the DB event id |
| `intake.objectId` | Internal workflows | Core `objects.id` for the lead spine |
| `intake.eventId` | Internal workflows | Core `events.id` for the `lead.received` event |
| `intake.evidenceId` | Internal workflows | Core `evidence.id` for the source snapshot |
| `leadPacket.*` | No | Backward-compatible direct payload alias for evals and operator tests |
| `pricing.baseCents` | No | Optional deterministic quote override for evals and controlled tests |

If `config.intake` includes a source selector or Core row references, do not
also send `config.leadPacket` or `config.lead`. Mixed authoritative sources are
rejected with `worker_intake_conflict`; direct payloads are fallback-only when
no Core intake selector is present.

`config.externalSend=true` or `config.leadPacket.externalSend=true` is rejected.
The first runtime only prepares owner-review packets.

## Run Output

`POST /worker` with `command=lead.read` returns a generic command response
whose `result.output.selectors[]` contains:

| Output | Required behavior |
|---|---|
| `source` | Source system name used for lookup |
| `sourceEventId` | External source id used as the stable selector |
| `objectId` | Core lead object row persisted from the source record |
| `eventId` | Core `lead.received` event row persisted or reused for the source record |
| `evidenceId` | Source snapshot evidence row |
| `intake` | Minimal `{source, sourceEventId}` payload for a later `command=run` |

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
| `worker_runs` | Owns lifecycle, idempotency, lead-read input/output, run input/output, and continuations |
| `workflow_runs` | Owns the lead-to-cash state machine for the prepared worker action |
| `workflow_steps` | Records intake resolved, packet prepared, adapter dry-run recorded, approval requested, approval decision transitions, worker continuations, and adapter reconciliation transitions |
| `budget_reservations` | Reserves and marks deterministic simulation units as used |
| `adapter_runs` | Records dry-run adapter execution, attempt metadata, retry execution, receipt state, and reconciliation state |
| `inferences` | Stores prompt/result/safety trace |
| `usage_events` | Attributes units to budget, task, capability, and worker |
| `events` | Emits source `lead.received`, `revenue_worker.lead_read.completed`, and `revenue_worker.run.completed` records with linked output ids |
| `evidence` | Stores source snapshots, trace, adapter receipt, and later approval decision evidence |
| `adapter_actions` | Links to the adapter run and drafts customer-response intent with `externalSend=false` |
| `approval_requests` | Creates pending operator approval for the prepared action |
| `audit_events` | Records run request, approval request, and approval decision |
| `tasks` | Moves active work to `approval_required`; decision later moves to `waiting`, `active`, or `blocked`; reconciliation creates retry/review system tasks and retry execution closes due retry tasks |
| `object_versions` | Records approval-required state against the object spine |

Adapter reconciliation is also workflow-scoped when the adapter row carries a
Revenue `workflowRunId`. Retryable adapter failures append
`workflow_steps.kind=adapter_reconciliation` and move `lead_to_cash` to
`adapter_retry_scheduled`; exhausted or unsafe failures move it to
`adapter_failure_review`; matched rows after retry execution move it to
`post_retry_reconciled`. These states remain no-send and keep external
execution blocked.

`POST /worker` with `command=continue` creates a separate idempotent
`worker_runs` continuation record and `workflow_steps.kind=worker_continuation`
entry. V1 supports `approved`, `revision_requested`, and `rejected` approvals.
Approved continuation prepares a no-send execution packet, stores
evidence/document packet records, moves the workflow to `execution_blocked`,
leaves the task in `waiting`, and keeps adapter execution blocked. Revision
continuation prepares a revised no-send quote packet, stores the revised packet
evidence/document packet, creates a fresh pending `quote_revision_approval`,
moves the workflow back to `approval_requested`, updates the task back to
`approval_required`, and keeps adapter execution blocked. Rejected continuation
stores a closed no-send stop packet, appends a terminal worker continuation
step, keeps the task blocked, and closes the workflow in `rejected`.

## Approval Actions

| Action | Approval state | Task state | Workflow state | External behavior |
|---|---|---|---|---|
| `approved` | `approved` | `waiting`; after `command=continue`, still `waiting` on live execution prerequisites | `approved`; after `command=continue`, `execution_blocked` | `command=continue` prepares an approved no-send execution packet and blocks on scoped live credentials/rollback readiness |
| `revision_requested` | `revision_requested`; after `command=continue`, a new `quote_revision_approval` is `pending` | `approval_required` after the revised packet is prepared | `approval_requested` after the revised packet is prepared | `command=continue` prepares a revised no-send packet and requests owner approval again |
| `rejected` | `rejected` | `blocked`; after `command=continue`, still `blocked` with a rejected stop packet | `rejected`; after `command=continue`, remains `rejected` with a terminal continuation step | `command=continue` stores a closed no-send rejected packet and stops the prepared action |

## Non-Goals

- No autonomous customer sends.
- No payment link creation or money movement.
- No live CRM, inbox, calendar, quote, invoice, or payment adapter writes.
- No autonomy increase beyond read, classify, draft, prepare, and request approval.
