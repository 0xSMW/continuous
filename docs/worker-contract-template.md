# Worker Contract Template

Every worker family needs a V1 contract before implementation. Keep the API
shape stable and add behavior through payload fields, not new worker-specific
routes.

## Header

| Field | Value |
|---|---|
| Worker role | `<role>` |
| First outcome | `<operator-visible outcome>` |
| Autonomy level | `0`, `1`, or `2` for V1 |
| External execution | `blocked`, `dry_run`, or `approved_only` |

## API

`POST /worker` is the only worker mutation surface.

```json
{
  "command": "<command>",
  "worker": {
    "role": "<role>",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "<stable-operation-key>",
  "config": {}
}
```

Define every supported command with required `config` fields, validation
errors, idempotent replay behavior, output fields, and external-execution
status.

## Core Commands

List the exact Core writes the worker needs:

| Command | Purpose | Required fields |
|---|---|---|
| `task.create` | Accountable work item | `title`, optional references, owner, evidence, cost, KPI |
| `task.transition` | Task lifecycle movement | `taskId`, `toState`, `reason`, evidence or outcome |
| `object.upsert` | Typed business record | `type`, `name`, `source`, `externalId`, `data` |
| `object.link` | Relationship in the business graph | `fromObjectId`, `toObjectId`, `type`, `data` |
| `event.ingest` | Source or lifecycle event | `type`, `source`, `objectId`, `data` |
| `evidence.attach` | Snapshot, draft, receipt, trace, approval, or note | `kind`, `name`, references, `data` |
| `document.create` | Document record | `kind`, `name`, `state`, references |
| `packet.prepare` / `document.packet.prepare` | Durable evidence packet with linked evidence and document refs | `kind`, `name`, references, `evidenceIds`, `documentIds`, sections |
| `decision.record` | Proposed or decided worker judgment | `kind`, `decision`, `state`, references |
| `approval.request` | Human or manager review gate | `kind`, `title`, task/object/event refs, action, policy |
| `capability.grant` | Scoped worker or user authority | `capabilityId` or `capabilityKey`, actor, reason, scope, policy |
| `budget.reserve` | Hold AI budget before work | `budgetAccountId`, `units`, reason, optional task/capability refs |
| `budget.charge` | Convert a reservation into usage | `reservationId`, actor, reason, optional task/capability/inference refs |
| `budget.release` | Release unused held budget | `reservationId`, reason |
| `view.publish` | Generated operator view | `key`, `version`, `name`, `purpose`, `contract`, `actions`, `data` |

## Objects And Links

Define each object type, required `data` fields, valid states, source identity,
versioning rule, and link types. Link names should be plain relationship names
such as `about_customer`, `assigned_to`, `prepared_from`, or `blocked_by`.

## Workflow

List the workflow definitions, starting state, allowed transitions, terminal
states, approval points, retry policy, and failure task behavior.

## Capabilities

List each capability key, allowed autonomy level, allowed actor, grant scope,
approval requirement, and external mutation status.

## Adapters

For each adapter, define read payloads, dry-run write payloads, receipt shape,
reconciliation states, retry limit, rollback/escalation path, and auth scope.

## Evidence Packet

Define required evidence item kinds, redaction rules, immutable source refs,
approval linkage, generated document refs, and export format.

## Generated Views

Each operator-facing view must be published with `view.publish` and include:

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `<view key>` | `<object/task/workflow>` | `<action list>` | `<states>` |

## Evals

Golden cases must cover happy path, missing facts, risky input, budget pressure,
approval behavior, idempotent replay, and no external mutation.

## Security

Name tenant-isolation assumptions, sensitive fields, prompt-injection handling,
redaction, approval/dual-control requirements, audit retention, and abuse cases.
