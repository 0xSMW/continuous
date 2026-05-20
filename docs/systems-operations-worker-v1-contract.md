# Systems Operations Worker V1 Contract

This contract defines the systems worker for connector health, sync repair,
data quality, permission review, and workflow automation planning. V1 creates
repair plans, dry-run actions, and rollback packets; live connector mutation is
approval-gated and blocked until scoped credentials exist.

## Header

| Field | Value |
|---|---|
| Worker role | `systems_operations` |
| First outcome | Connector health and sync repair packet with rollback plan |
| Autonomy level | `2` |
| External execution | `dry_run`; live connector mutation blocked |

## API Shape

All commands use `POST /worker`; no systems-specific route is added.

```json
{
  "command": "connector.health.scan",
  "worker": {
    "role": "systems_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "systems-health-2026-05-19",
  "config": {
    "adapterIds": ["adapter_uuid"],
    "checks": ["auth", "sync_lag", "schema_drift", "error_rate"]
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.view` | `worker.role` | None | Read-only | Blocked |
| `connector.health.scan` | `worker.command` | `config.checks[]` | Required | Health evidence and tasks | Blocked |
| `sync.repair.plan` | `worker.command` | `config.connectionId`, `config.issueId` | Required | Repair plan, dry-run adapter actions | Dry-run |
| `data_quality.remediate` | `worker.command` | `config.issueId`, `config.policy` | Required | Proposed object updates and evidence | Dry-run |
| `permission.review` | `worker.command` | `config.connectionId` or `config.grantId` | Required | Permission audit packet | Blocked |
| `automation.plan` | `worker.command` | `config.workflowKey`, `config.trigger` | Required | Automation proposal only | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | None | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `adapter` | `kind`, `capabilities`, `authMode`, `risk`, `ownerRef` | `draft`, `active`, `paused`, `error`, `archived` | `has_connection`, `grants_capability`; credentials live on connection `credentialRef` fields |
| `connection` | `adapterId`, `externalAccountRef`, `scopes`, `status`, `lastSyncAt`, `errorState` | `draft`, `active`, `degraded`, `paused`, `revoked` | `connects_adapter`, `has_sync_job` |
| `sync_job` | `connectionId`, `cursor`, `startedAt`, `completedAt`, `counts`, `errors` | `queued`, `running`, `done`, `failed`, `canceled` | `syncs_connection`, `produced_issue` |
| `webhook` | `connectionId`, `eventTypes`, `lastReceivedAt`, `signatureState` | `active`, `stale`, `failed`, `disabled` | `belongs_to_connection` |
| `permission_grant` | `connectionId`, `scopes`, `actorRef`, `expiresAt`, `reviewState` | `proposed`, `active`, `overbroad`, `revoked` | `authorizes_connection`, `requires_review` |
| `data_quality_issue` | `objectType`, `field`, `detectedAt`, `severity`, `suggestedFix`, `sourceRefs` | `open`, `proposed_fix`, `approval_required`, `fixed`, `ignored` | `about_object`, `caused_by_sync` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `connector_health` | `draft -> checks_running -> health_ready -> review_ready -> closed` | None unless reveal is needed | Create degraded connection task |
| `sync_repair` | `draft -> diagnosis -> repair_plan -> dry_run -> approval_pending -> ready_to_execute` | Required before live repair | Keep execution blocked until live scope exists |
| `data_quality_remediation` | `open -> proposed_fix -> approval_pending -> ready_to_apply -> fixed` | Required before data write | Route conflicting fixes to owner |
| `permission_review` | `draft -> scope_scan -> risk_review -> approval_pending -> remediated` | Required for revoke or scope change | Escalate overbroad active grants |
| `automation_plan` | `draft -> trigger_review -> simulation_ready -> approval_pending -> ready_to_enable` | Required before enablement | Keep automation disabled in V1 |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Adapter, connection, sync, object metadata | No | Blocked |
| `document_packet.prepare` | 2 | Worker | Systems packets and rollback plans | Required for repair | Blocked |
| `approval.request` | 2 | Worker | Sync repair, permission, automation | Yes | Blocked |
| `adapter.reconcile` | 2 | Worker | Dry-run adapter runs/actions | Required for live retry | Dry-run |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| All platform adapters | Auth status, scopes, sync lag, error rates | Dry-run repair or no-op validation | Health status, scoped grant, rollback plan | Retry 2 then owner task |
| Webhooks | Signature status, recent event ids | None | Last seen event and validation state | Retry 2 then degraded connection |
| Object store/Core | Object quality scan | Proposed internal patch only | Diff, affected ids, no-write proof | Require approval for apply |

## Evidence Packet

`systems_packet` contains connection health, sync logs, failed action refs,
permission scope diff, proposed fix diff, dry-run receipt, rollback plan, and
approval record. Tokens, secrets, raw auth headers, customer private fields, and
employee data are never included; store only secret handles and redacted scopes.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `systems.connector.health` | `connection` | `acknowledge`, `pause_connection`, `route_repair` | `no_connections`, `auth_unavailable` |
| `systems.sync.repair.review` | `sync_job` | `approve_repair`, `request_revision`, `reject` | `missing_rollback`, `dry_run_failed` |
| `systems.permission.review` | `permission_grant` | `approve_scope`, `revoke`, `request_owner` | `scope_unknown`, `secret_missing` |

## Evals

Golden cases cover expired auth, sync lag, schema drift, duplicate object
repair, overbroad permissions, rollback completeness, idempotent replay,
least-privilege checks, and no live connector mutation.

## Security

Secrets never enter prompts, evidence, generated views, or logs. Permission
changes, sync repair, and automation enablement require approval and rollback
evidence. Source adapter data is untrusted. Abuse cases: privilege escalation,
secret leakage, destructive sync repair, hidden data corruption, or automation
loops that mutate business records without approval.
