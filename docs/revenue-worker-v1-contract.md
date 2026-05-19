# Revenue Worker V1 Contract

This contract defines the first worker surface that can be expanded without
raising autonomy or permitting external sends.

## Inputs

| Input | Required | Notes |
|---|---:|---|
| `idempotencyKey` | Yes | Stable per operator-triggered run |
| `operatorEmail` | Yes | Must match an active user in the tenant |
| `tenantSlug` | No | Required when an operator email spans tenants |
| `workerId` | No | Required when multiple Revenue Workers match |
| `config.leadPacket` | Yes for useful runs | Source lead payload used to derive classification, draft, quote, evidence, and approval packet |

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
    "leadPacket": {
      "source": "website_form",
      "sourceEventId": "form-2026-05-19-001",
      "customerName": "Acme Roof Repair",
      "customerIntent": "roof leak inspection",
      "serviceArea": "roofing",
      "urgency": "high",
      "missingFacts": ["preferred_time_window"]
    }
  }
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

## Run Config

`config` is the worker-specific envelope. The route does not encode a worker
family, operation target, customer, source system, or draft type in the URL.

| Field | Required | Notes |
|---|---:|---|
| `leadPacket.source` | No | Defaults to `operator_payload`; use connector names such as `website_form` or `gmail` |
| `leadPacket.sourceEventId` | No | External event or message id when available |
| `leadPacket.customerName` | No | Defaults to `Customer` |
| `leadPacket.customerIntent` | No | Drives draft wording and quote line |
| `leadPacket.serviceArea` | No | Drives packet title and quote context |
| `leadPacket.urgency` | No | `low`, `normal`, `high`, `urgent`, `emergency`, or `same_day` |
| `leadPacket.missingFacts` | No | Array of facts required before any customer send |
| `pricing.baseCents` | No | Optional deterministic quote override for evals and controlled tests |

`config.externalSend=true` or `config.leadPacket.externalSend=true` is rejected.
The first runtime only prepares owner-review packets.

## Run Output

`POST /worker` with `command=run` returns a generic command response whose
`result.output` contains worker-derived data:

| Output | Required behavior |
|---|---|
| `sourceSnapshotEvidenceId` | Points to persisted source snapshot evidence |
| `classification` | Derived from lead urgency and missing facts |
| `draftResponse` | Owner-review draft; not externally sent |
| `quote` | Deterministic quote with lines, total, currency, and blocked money movement policy |
| `externalSend` | Always `false` in this runtime |
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

## Approval Actions

| Action | Approval state | Task state | External behavior |
|---|---|---|---|
| `approved` | `approved` | `waiting` | Still blocked until real adapter execution exists |
| `revision_requested` | `revision_requested` | `active` | Worker can prepare a revised draft |
| `rejected` | `rejected` | `blocked` | Worker should stop the prepared action |

## Non-Goals

- No autonomous customer sends.
- No payment link creation or money movement.
- No live CRM, inbox, calendar, quote, invoice, or payment adapter writes.
- No autonomy increase beyond read, classify, draft, prepare, and request approval.
