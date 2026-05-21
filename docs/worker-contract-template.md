# Worker Contract Template

Every worker family needs a V1 contract before implementation. Keep the API
shape stable and add behavior through payload fields, not new worker-specific
routes.

## Header

| Field | Value |
|---|---|
| Worker role | `<role>` |
| API route | `/worker` |
| First outcome | `<operator-visible outcome>` |
| Autonomy level | `0`, `1`, or `2` for V1 |
| External execution | `blocked`, `dry_run`, or `approved_only` |

## API Shape

`/worker` is the only worker control-plane route. Use `POST /worker` for
commands and `POST /worker` for read views; do not add worker-family URLs such
as family-specific API paths, nested worker-role paths, or role-named worker
routes. Worker family names and catalog labels are payload selectors and
metadata only; they never become route aliases.

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

`worker.role` is required; the control plane must not default to the first
implemented worker. Role values are lower_snake_case capability roles, not
route nouns; reserved control-plane route words such as `api`, `worker`,
`workers`, `core`, `workflow`, `approval`, and `app_server` are invalid worker
roles. Define every supported command with required `config` fields, validation
errors, idempotent replay behavior, output fields, and external-execution
status.

Only `command`, `worker`, `idempotencyKey`, and `config` are accepted as
top-level command fields. Worker selection belongs under `worker`; operation
inputs such as source records, approval ids, retry limits, draft payloads, or
adapter selectors belong under `config`.
The `worker` object is only a selector and must not contain operation fields;
accepted worker selector fields are `role`, `id`, and `tenantSlug`.

Read views use the same worker selector and keep read filters under `config`.
HTTP, local, and app-server callers use the same read envelope:

```json
{
  "view": "<view>",
  "worker": {
    "role": "<role>",
    "tenantSlug": "continuous-demo"
  },
  "config": {}
}
```

## Command Registry

Every worker command must be registered before implementation. The registry
entry owns the `/worker` API route, command key, tool alias, handler, config validation, target
requirements, idempotency policy, output shape, side-effect level, and
external-execution status. `bun run worker:tool schema` must expose enough
metadata for agents to discover the command without adding a worker-specific
route.

| Field | Required behavior |
|---|---|
| API route | Always `/worker`; never role-specific |
| Command key | Plain action name used by `POST /worker`, such as `run` or `approval.decide` |
| Tool surface | Agent/toolbox surface, such as `worker.command`, mapped to the same handler |
| Role | Worker role allowed to execute the command |
| Target requirements | Required `worker` fields, especially `tenantSlug` for tenant-scoped jobs |
| Config schema | Required fields, validation errors, and defaults |
| Idempotency | `required` for replayable work and all approval decisions; `none` only for read-like maintenance commands with separate guards |
| Side effects | Internal-only, dry-run, approved-only, or blocked external execution |
| Output | Stable result fields and evidence/audit ids |

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
