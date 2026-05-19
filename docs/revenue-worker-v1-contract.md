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
  "config": {}
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

Worker-family-specific routes such as `/api/revenue-worker/run` are not part of
the public API. Future workers must use `/worker` with role, command,
idempotency, and config in structured fields.

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
