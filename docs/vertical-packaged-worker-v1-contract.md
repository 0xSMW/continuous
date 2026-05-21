# Vertical Packaged Worker V1 Contract

This contract defines the first packaged-worker catalog slice. Packaged workers
compose existing worker families through one canonical `/worker` envelope,
using `worker.role: "vertical_packages"` and `config.packageKey` to select a
bundle. V1 prepares readiness packets and connection-gated flow plans only. It
does not create private package APIs, bypass family approvals, or execute
external actions.

## Header

| Field | Value |
|---|---|
| Worker role | `vertical_packages` |
| First outcome | Package readiness packet with required connectors, family flow plan, least-privilege grants, rollback proof, and generated package view |
| Autonomy level | `2` |
| Runtime status | Planned contract |
| External execution | `blocked` |

## API Shape

All commands and views use `POST /worker`; no package-specific route is added.
Command names, package selection, worker selection, and view names are payload
fields. Operation inputs and read filters stay under `config`.

```json
{
  "command": "package.flow.prepare",
  "worker": {
    "role": "vertical_packages",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "package-flow-quote-to-cash-001",
  "config": {
    "packageKey": "quote_to_cash_field",
    "sourceRefs": {
      "connectionId": "connection_uuid",
      "permissionGrantId": "permission_grant_uuid",
      "workflowRunId": "workflow_run_uuid"
    },
    "policy": {
      "allowExternalExecution": false,
      "requireRollbackProof": true
    }
  }
}
```

```json
{
  "view": "package_readiness",
  "worker": {
    "role": "vertical_packages",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "packageKey": "quote_to_cash_field"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "package_readiness"` payload | `worker.view` | `worker.role`, `config.packageKey` | None | Read-only | Blocked |
| `package.flow.prepare` | `worker.command` | `config.packageKey`, `config.sourceRefs`, `config.policy` | Required | Package readiness packet, family flow plan, generated view, approval task | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | Required | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `connection` | `adapterId`, `status`, `scopes`, `lastSyncAt`, `healthState` | `draft`, `active`, `degraded`, `paused`, `revoked` | `enables_package`, `requires_permission` |
| `permission_grant` | `connectionId`, `scopes`, `actorRef`, `expiresAt`, `reviewState` | `proposed`, `active`, `overbroad`, `revoked` | `authorizes_package`, `grants_family` |
| `workflow_run` | `definitionKey`, `packageKey`, `state`, `stepRefs`, `sourceRefs` | `planned`, `readiness_review`, `approval_pending`, `ready_blocked`, `closed` | `orchestrates_family`, `requires_connection` |
| `evidence_packet` | `kind`, `sourceRefs`, `documentRefs`, `approvalRefs`, `redactionPolicy` | `draft`, `review_ready`, `approved_blocked`, `archived` | `supports_package`, `proves_readiness` |
| `generated_view` | `key`, `version`, `purpose`, `contract`, `actions`, `data` | `draft`, `published`, `superseded` | `reviews_package`, `shows_blocker` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `package_readiness` | `package_selected -> connector_check -> grant_review -> family_flow_plan -> approval_pending -> ready_blocked` | Required before any family command is promoted to package execution | Create Systems task for missing connection, stale sync, or overbroad grant |
| `package_flow_plan` | `draft -> family_sequence -> handoff_check -> rollback_check -> review_ready` | Required before external execution can be requested | Block package if any family contract or handoff is missing |
| `package_launch_review` | `review_ready -> owner_review -> approved_blocked -> launch_blocked` | Required before live launch smoke | Preserve blocked external execution until family-level receipts exist |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Package catalog, connection, grant, workflow, evidence refs | No | Blocked |
| `package.flow.prepare` | 2 | Worker | Package readiness and family flow packets | Yes | Blocked |
| `approval.request` | 2 | Worker | Launch, connector, and family-flow review | Yes | Blocked |
| `document_packet.prepare` | 2 | Worker | `package_readiness_packet`, rollback proof, grant review | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Systems connections | Health state, scope list, last sync, grant state | None | Connector freshness and grant proof | Route stale or overbroad grants to Systems |
| Family worker registries | Runtime command/view metadata, contract paths, handoffs | None | Registry snapshot and missing-contract list | Block missing contract or private API shape |
| Workflow ledger | Existing package workflow refs and step states | Planned flow steps only | Flow plan hash and no-execution proof | Route conflict to owner |
| Generated UI | View contract and package blockers | Publish internal readiness view | View id and blocked action set | Require owner approval before launch |

## Evidence Packet

`package_readiness_packet` contains package key, composed family list,
connection freshness, least-privilege grant proof, handoff refs, family contract
paths, workflow plan, rollback plan, generated view id, approval request, and
no-external-execution proof. Tokens, secrets, bearer headers, raw customer data,
employee private fields, and package-specific credentials are redacted.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `package.readiness` | `workflow_run` | `approve_launch_blocked`, `request_connection`, `route_to_family` | `package_missing`, `connection_stale`, `grant_overbroad` |
| `package.family_flow` | `workflow_run` | `inspect_handoff`, `request_contract`, `block_launch` | `family_contract_missing`, `handoff_missing`, `private_route_detected` |
| `package.rollback` | `evidence_packet` | `approve_rollback_plan`, `request_receipt`, `reject_launch` | `rollback_missing`, `receipt_missing`, `scope_unknown` |

## Evals

Golden cases cover quote-to-cash field service readiness, knowledge delivery,
inventory replenishment, compliance QA, maintenance, missing connection,
overbroad grant, missing family contract, route-shape regression, approval
behavior, idempotent replay, budget pressure, and no external execution.

## Security

Package selection is not an authorization grant. The package worker must
enforce tenant isolation, least-privilege connection scopes, family contract
availability, and blocked external execution. Prompt injection in source data,
package labels, connector names, or generated views must not change approval,
credential, route, or execution policy. Abuse cases: private package API
creation, broad connector grants, hidden family execution, rollback omission,
and launching external mutations without family-level receipts and owner
approval.
