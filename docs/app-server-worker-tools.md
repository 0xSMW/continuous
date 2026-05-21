# App-Server Tools

Continuous exposes repo-owned app-server dynamic tool specs for Core, worker,
workflow, and approval discovery plus registry-backed read and command
execution:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.core.schema` | Read-only | Returns the Core app-server registry, command/view names, canonical `apiRoute: "/core"`, and excluded credential-admin commands |
| `continuous.core.view` | Registry-backed read | Reads registered Core views such as `summary` and `ledger` with the same `view`, `core`, and `config` envelope used by `POST /core` read payloads |
| `continuous.core.command` | Registry-backed command | Invokes an existing Core command with the same `command`, `core`, `idempotencyKey`, and `config` envelope used by `/core` |
| `continuous.worker.schema` | Read-only | Returns worker contracts, runtime roles, registered commands, follow-up commands, planned future-worker metadata, worker tool schema, and integration boundary |
| `continuous.worker.view` | Registry-backed read | Reads registered worker views with the same `view`, `worker`, and `config` envelope used by local worker tooling and `POST /worker` read payloads |
| `continuous.worker.command` | Registry-backed command | Invokes an existing worker command with the same `command`, `worker`, `idempotencyKey`, and `config` envelope used by `/worker` |
| `continuous.workflow.schema` | Read-only | Returns workflow command/view names, canonical `apiRoute: "/workflow"`, and app-server bridge metadata |
| `continuous.workflow.view` | Registry-backed read | Reads shared workflow views with the same `view`, `workflow`, and `config` envelope used by `POST /workflow` |
| `continuous.workflow.command` | Registry-backed command | Invokes shared workflow commands with the same `command`, `workflow`, `idempotencyKey` when required, and `config` envelope used by `POST /workflow` |
| `continuous.approval.schema` | Read-only | Returns shared approval command/view names, canonical `apiRoute: "/approval"`, and app-server bridge metadata |
| `continuous.approval.view` | Registry-backed read | Reads the shared approval inbox with the same `view`, `approval`, and `config` envelope used by `POST /approval` |
| `continuous.approval.command` | Registry-backed command | Invokes shared approval decisions with the same `command`, `approval`, `idempotencyKey`, and `config` envelope used by `POST /approval`; decisions require `approval.id` plus a concrete `approval.subject` of `core`, `worker`, `workflow`, or `task` |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`, and invokes dynamic tools with a payload
containing `tool`, `arguments`, `callId`, `threadId`, and `turnId`. The local
manifest and dynamic-call adapters follow that shape: Core tools live in
`src/core/app-server-tools.ts`, worker tools live in
`src/worker/app-server-tools.ts`, shared workflow and approval tools live in
`src/core/app-server-control-tools.ts`, and all delegate reads and commands to
registered handlers rather than worker-family-specific routes.
`continuous.core.schema` exposes registered Core command and view names for the
app-server bridge. Credential and token-rotation administration remains on
`POST /core` and is intentionally excluded from dynamic app-server tools.
`continuous.worker.schema` exposes each registered command's `configSchema`,
canonical `apiRoute: "/worker"`, the full `contracts` catalog, current
`runtimeContracts`, `plannedContracts`, and `followUpCommands` that are
contract-defined for runtime workers but not executable yet. Planned
future-worker commands expose a separate non-executable `configSchema` so agents
can inspect payload requirements for candidate and packaged workers before
handlers exist.
The same schema response includes `lifecycle`, a machine-readable first-worker
build/run/inspect plan. It points worker identity and state changes at
`continuous.core.command` with `worker.upsert` and `worker.transition`, then
points business reads and commands at `continuous.worker.view` and
`continuous.worker.command`. It exists to keep app-server agents on the generic
`/core`, `/worker`, and `/app-server` surfaces while putting every operation
input under `arguments.config`.
`continuous.worker.view`, `continuous.worker.command`, `/worker`, and
`worker:tool` all run through the same registry validation before dispatch.
`continuous.workflow.view`, `continuous.workflow.command`, `/workflow`,
`continuous.approval.view`, `continuous.approval.command`, and `/approval`
share the same control-plane service functions and keep workflow/approval
operation inputs under `config`.
`continuous.core.command` owns reusable worker lifecycle control through
`worker.upsert`, `worker.transition`, `worker.run.start`, and
`worker.run.complete`, using the Core envelope with worker identity, capability,
budget, evidence, and settlement data under `config`.
Lifecycle commands that act on a worker role require that role under `config`
and a matching authenticated transport scope before dispatch. Registered worker
business commands stay on `/worker` and `continuous.worker.command`; promoted
commands adopt the Core lifecycle gate instead of adding worker-family-specific
tool names or routes.
The CI integration suite exercises `continuous.worker.command` on real
Revenue `lead.read`, `run`, `lead.classify`, `response.draft`,
`quote.prepare`, `payment_link.prepare`, and `continue` for both controlled-send
receipt recording and blocked payment-link continuations. It also exercises Owner `brief.generate`, Dispatch
`schedule.propose`, and Finance
`payment_draft.prepare` commands, proving the app-server boundary writes the
same worker run, approval, evidence, budget, event, adapter dry-run, generated
view, and workflow records as `/worker`.
The Revenue payment-link command can be executed through
`continuous.worker.command` or `worker:tool`, but it only prepares an internal
packet through the Core worker-run lifecycle; live provider payment-link
creation and money movement remain blocked.
Deploy smoke also exercises Core worker lifecycle commands, Revenue
`lead.read -> run`, Offer and Pricing `margin.review.prepare`, and the
`price_policy` view through `POST /app-server`, proving Core primitives,
Revenue worker execution, and post-Revenue workers can use the same dynamic-tool
envelope without a worker-specific route and with worker-role scope enforced
before lifecycle dispatch.
The bridge also exposes shared workflow and approval controls through
`continuous.workflow.*` and `continuous.approval.*`, so remote agents can inspect
workflow runs, drain workflow steps, read approval inboxes, and decide approvals
without inventing query URLs or worker-family app-server tools.
Customer Experience `recovery.draft` and `signals` are runtime-registered the
same way: customer, signal, evidence, channel, and no-send policy selectors
live under `config`, while the app-server tool still sends only `command`,
`worker`, `idempotencyKey`, and `config`.
Growth `campaign.draft` is runtime-registered on that same path. The canonical
call uses `worker.role=growth_operations`, `command=campaign.draft`, and
`config.sourceRefs` plus `config.policy`; it writes campaign draft proof while
publish, send, spend, and tracking mutations stay blocked.
Revenue `readiness` is exposed through `continuous.worker.view` with the same
`view`, `worker`, and `config` payload as `/worker`; it returns dry-run launch
checks, latest quote-review proof refs, and live credential blockers without a
family-specific app-server tool.
Dispatch `customer_update.draft`,
`closeout.prepare`, and `exception.route` are also schema-discoverable through
the same registry-backed command list and keep customer-send, QA, Finance
handoff, exception reason, severity, and related Core refs under `config`.
Finance `invoice.prepare` uses the same envelope with job, closeout, customer,
and evidence selectors under `config.sourceRefs`, prepares an invoice draft,
cash packet, owner approval request, and accounting dry-run receipt, and keeps
external sends and money movement blocked.
Finance `ar_followup.draft` extends that same registry path from a persisted
invoice id, keeps `tonePolicy`, channel, message context, and approval policy
under `config`, prepares an AR follow-up draft, cash packet, approval request,
and generated review view, and still blocks customer sends, payment links, and
money movement.
Finance `cash_forecast.generate` stays on the same command path with forecast
window, account refs, optional cash drivers, and approval policy under
`config`, then writes a cash forecast object, cash packet, approval request,
generated review view, workflow, budget, and audit proof while external
execution and money movement remain blocked.
Finance `payment_draft.prepare` is also registry-backed: bill or payment
selectors, bank account refs, amount/method overrides, evidence refs, and
dual-control policy live under `config`; the command writes payment draft,
payment instruction, cash packet, approval, generated review view, workflow,
budget, and audit proof while ACH, payment links, bank writes, and money
movement remain blocked.
Workforce `hire.packet.prepare` and `payroll_input.prepare` use the same
envelope. Hire packet config carries person, position, work-location,
document, and policy fields under `config`; payroll input config carries
employment, period, payroll-run, earnings, deductions, and blockers under
`config`. The runtime writes workforce packets, restricted-document proof,
approvals, generated review views, workflow/budget/audit proof, and a
`readiness` view while external execution, payroll submission, tax filing, and
money movement remain blocked or dry-run.
Compliance uses that same envelope for `filing.prepare` plus the `snapshot`,
`obligations`, and `packet` views. Filing requirement, period, source refs,
validation, and policy live under `config`. Core `obligation.scan` supplies the
shared obligation intake ledger; the worker runtime writes filing draft packets,
approval requests, workflow/budget/audit proof, and keeps agency submission and
legal advice blocked. Notice response, license renewal, evidence binder export,
live credentials, broader rule sources, and receipt capture remain follow-ups.
Asset and Supply and Vertical Packaged Worker contracts are discoverable as
planned future-worker metadata. Their first commands still use `/worker`, keep
operation inputs under `config`, and remain non-executable until runtime
handlers are registered.

## App-Server Worker Registry Map

`continuous.worker.schema` returns this top-level response:

| Key | Meaning |
|---|---|
| `manifest` | App-server tool manifest, tool names, schemas, and boundary metadata |
| `registry` | Machine-readable worker registry used by app-server, `/worker`, and `worker:tool` |
| `lifecycle` | Machine-readable first-worker lifecycle plan for app-server build, run, inspect, and expansion flows |
| `plannedWorkers` | Alias for `registry.plannedContracts` for older consumers |
| `workerToolSchema` | Full worker tool schema, including `$defs` plus the same `registry` object |

The lifecycle plan is not a new execution surface. It is schema metadata that
keeps agents from inventing `/api/*-worker`, `/worker/<role>`, or
worker-family-specific app-server tools. Its steps use only registered tools:

| Lifecycle area | Tool | Operation location | Config location |
|---|---|---|---|
| Worker identity | `continuous.core.command` | `arguments.command=worker.upsert` | `arguments.config` |
| Worker activation | `continuous.core.command` | `arguments.command=worker.transition` | `arguments.config` |
| Business reads | `continuous.worker.view` | `arguments.view` | `arguments.config` |
| Business commands | `continuous.worker.command` | `arguments.command` | `arguments.config` |
| Schema inspection | `continuous.worker.schema` | Tool name only | None |

First-worker run steps currently cover Revenue Operations readiness,
`lead.read`, `lead.classify`, `response.draft`, `run`, `quote.prepare`,
`payment_link.prepare`, and approval `continue`. Future workers should extend
the registry and this lifecycle metadata, not the route tree.

The `registry` buckets have distinct execution meaning:

| Bucket | Execution meaning |
|---|---|
| `commands` | Registered executable worker commands available now through `continuous.worker.command` and `/worker` |
| `views` | Registered executable worker reads available now through `continuous.worker.view` and `/worker` |
| `contracts` | Full worker contract catalog, including runtime, planned, candidate, and packaged entries |
| `runtimeContracts` | Worker contracts with at least one registered executable runtime surface |
| `plannedContracts` | Worker contracts that are not runtime-registered yet |
| `followUpCommands` / `plannedCommands` | Contract-defined commands for runtime workers that are not executable yet |
| `followUpViews` / `plannedViews` | Contract-defined reads for runtime workers that are not executable yet |
| `plannedFutureWorkerCommands` | Non-executable command schemas for worker families that have no runtime handler yet |
| `plannedFutureWorkerViews` | Non-executable read schemas for worker families that have no runtime handler yet |
| `expansion` | Launch-order catalog with Core object spines, handoffs, acceptance checks, blockers, and gates |
| `expansionPromotionPlan` | Derived promotion payload templates and proof checklist for each expansion entry |

Expansion status values are `runtime`, `partial`, `planned_contract`,
`candidate`, and `packaged`. `runtime` means executable through the registry
now. `partial` means at least one runtime slice exists, but launch gates remain
open. `planned_contract` means a contract exists without runtime promotion.
`candidate` means catalog and contract planning only. `packaged` means a
composed bundle that must still execute through family commands and `/worker`,
not through package-specific routes.

`expansionPromotionPlan` is derived from the expansion catalog and is safe for
app-server agents to follow. Each entry includes a generic
`continuous.worker.command` payload template, a matching
`continuous.worker.view` payload template, the worker role or package key, the
incoming handoff, required Core refs, contract and evidence packet paths, and a
promotion checklist. It does not create an execution surface; candidates and
packaged workers remain schema-only until their handlers move into the
registered command list.

Worker selectors support `worker.role`, optional `worker.tenantSlug`, and
optional `worker.id`. Use `worker.id` only when targeting a specific persisted
worker instance; otherwise prefer role plus tenant. Operation inputs, package
keys, source refs, approvals, execution receipts, and filters must remain under
`config`.

```sh
export WORKER_OPERATOR_EMAIL=owner@continuoushq.com
bun run app-server:tools
bun run app-server:daemon:start
bun run app-server:daemon:version
bun run app-server:proxy
bun run app-server:tools continuous.core.schema
bun run app-server:tools continuous.core.view --payload='{"view":"summary","core":{"tenantSlug":"continuous-demo"},"config":{}}'
bun run app-server:tools continuous.core.view --payload='{"view":"ledger","core":{"tenantSlug":"continuous-demo"},"config":{"collections":["objects","tasks","events"],"limit":5}}'
bun run app-server:tools continuous.worker.schema
bun run app-server:tools continuous.workflow.schema
bun run app-server:tools continuous.workflow.view --payload='{"view":"overview","workflow":{"tenantSlug":"continuous-demo"},"config":{}}'
bun run app-server:tools continuous.approval.schema
bun run app-server:tools continuous.approval.view --payload='{"view":"inbox","approval":{"tenantSlug":"continuous-demo","subject":"worker"},"config":{"state":"pending"}}'
bun run app-server:tools dynamic-call --payload='{"tool":"continuous.worker.schema","arguments":{},"callId":"local-schema-001","threadId":"local-thread-001","turnId":"local-turn-001"}'
bun run app-server:tools continuous.worker.view --payload='{"view":"snapshot","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}'
bun run app-server:tools continuous.worker.view --payload='{"view":"readiness","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}'
```

The local app-server executor may accept a trusted-local context through
`--context` or `APP_SERVER_TRANSPORT_CONTEXT_JSON`, but it rejects
`source: "control_plane"` context. Control-plane context must be constructed by
an authenticated bridge after it has verified route, access, command/view,
tenant, and worker-role scope.

```sh
bun run app-server:tools continuous.core.command --payload='{"command":"task.create","core":{"tenantSlug":"continuous-demo"},"idempotencyKey":"local-core-task-001","config":{"title":"Confirm app-server Core bridge","priority":"high"}}'
```

```sh
bun run app-server:tools continuous.worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-app-server-lead-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

Inbox and CRM lead intake use the same command surface with source-reader
metadata inside `config.reader`; the tool forwards that payload through the
registry without loading production tokens or executing external reads.

## Boundary

The app-server Core and worker tools are intentionally narrow:

- Core commands are resolved by the registered Core app-server command list and
  invoke the same persisted primitive handlers used by `POST /core`.
- Worker commands are resolved by the same registry as `/worker` and
  `worker:tool`.
- Workflow commands are resolved by the shared workflow command list and invoke
  the same persisted handlers used by `POST /workflow`.
- Approval commands are resolved by the shared approval command list and invoke
  the same approval service used by `POST /approval`.
- Core reads currently expose the `summary` view through the same `view`,
  `core`, and `config` envelope as `POST /core`.
- Reads are resolved by the same view registry as `POST /worker` view payloads
  and `worker.view`.
- Workflow reads accept only `view`, `workflow`, and `config`; read filters
  belong under `config`.
- Approval reads accept only `view`, `approval`, and `config`; subject and
  approval id selectors belong under `approval`, while filters belong under
  `config`.
- Core read envelopes are strict. `continuous.core.view` accepts only `view`,
  `core`, and `config`; send `{}` when there are no read filters.
- Read envelopes are strict. `continuous.worker.view` accepts only `view`,
  `worker`, and `config`; send `{}` when there are no read filters, and put
  filters such as `state` under `config`.
- Core mutation envelopes are strict. `continuous.core.command` accepts only
  `command`, `core`, `idempotencyKey`, and `config`; operation inputs belong
  under `config`.
- Mutation envelopes are strict. `continuous.worker.command` accepts only
  `command`, `worker`, `idempotencyKey`, and `config`; `approvalId`, source
  records, retry limits, lead payloads, and every other operation input belong
  under `config`.
- Workflow mutation envelopes are strict. `continuous.workflow.command` accepts
  only `command`, `workflow`, optional `idempotencyKey`, and `config`;
  `workflow.start`, `workflow.transition`, and `workflow.approval.decide`
  require payload idempotency keys, while `steps.execute` remains an execution
  drain command without an idempotency key requirement.
- Approval mutation envelopes are strict. `continuous.approval.command` accepts
  only `command`, `approval`, `idempotencyKey`, and `config`; approval actions
  and notes belong under `config`. `approval.decide` requires `approval.id`
  and a concrete `approval.subject` of `core`, `worker`, `workflow`, or `task`;
  broad `subject: "all"` is only valid for reads.
- Worker-specific options stay inside `config` and are validated by the
  command registry's `configSchema`.
- Follow-up commands expose config schemas but remain non-executable until
  handlers are registered; promoted commands move into the registered command
  list without changing the `/worker` route shape.
- Caller supplies either `view`, `worker`, and `config` for reads, or
  `command`, `worker`, `idempotencyKey`, and `config` for commands.
- `worker.role` is a lower_snake_case role selector, such as
  `revenue_operations`. Do not send hyphenated family names, `api/*-worker`
  route fragments, or `*_worker` suffixes.
- Operator identity and scope must be supplied by authenticated transport
  context or, for local CLI use, by the trusted local transport through
  `WORKER_OPERATOR_EMAIL`; there is no fallback operator and identity is never
  accepted in the payload.
- No external execution is available.
- No production token is loaded.
- Local read and mutation tools are trusted-local by default; in
  `APP_ENV=production`, set `CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true` only
  for an explicitly trusted operator shell or app-server bridge.

Remote app-server bridges should authenticate against the control plane first,
then call the repo dynamic-tool executor with transport context containing the
authorized operator identity, access mode, route-qualified command or view,
tenant, and worker-role scope where the tool needs it. Do not pass bearer
tokens or operator identity in the tool payload. Dynamic tool responses return Codex-compatible
`contentItems` with a JSON text body and set `success=false` for registry or
envelope errors instead of moving context into the payload.

## Remote Bridge

`POST /app-server` is the generic authenticated bridge for dynamic tool calls.
It is not a worker-family or command-specific API route; worker execution still
goes through the same registry and payload envelope as `POST /worker`, and Core
execution still uses registered Core command/view envelopes. The bridge accepts
only `tool`, `arguments`, `callId`, `threadId`, and `turnId` at the top level.
Put Core or worker envelope fields under `arguments`, put operation-specific
inputs under `arguments.config`, and never send `operatorEmail`, bearer tokens,
transport context, tenant scope, or worker-role scope in the payload.

`continuous.core.command`, `continuous.core.view`,
`continuous.worker.command`, `continuous.worker.view`,
`continuous.workflow.command`, `continuous.workflow.view`,
`continuous.approval.command`, `continuous.approval.view`, `worker.command`,
and `worker.view` are tool names; `/core`, `/worker`, `/workflow`, and
`/approval` are HTTP routes; `command`, `view`, `core`, `worker`, `workflow`,
`approval`, `idempotencyKey`, and `config` are payload fields.

```http
POST /app-server
content-type: application/json
authorization: Bearer <control-plane-token>
```

```json
{
  "tool": "continuous.worker.command",
  "arguments": {
    "command": "lead.read",
    "worker": {
      "role": "revenue_operations",
      "tenantSlug": "continuous-demo"
    },
    "idempotencyKey": "remote-app-server-lead-001",
    "config": {
      "source": "website_form",
      "records": [
        {
          "sourceEventId": "form-001",
          "customerName": "Acme Roof Repair",
          "customerIntent": "roof leak inspection"
        }
      ]
    }
  },
  "callId": "call-001",
  "threadId": "thread-001",
  "turnId": "turn-001"
}
```

The route authorizes against the `app_server` control-plane route with exact
bridge command scope, such as `app_server:worker.command.lead.read`,
`app_server:worker.view.snapshot`, `app_server:worker.view.readiness`, or
`app_server:worker.schema` for workers, and `app_server:core.command.task.create`,
`app_server:core.view.summary`, `app_server:core.view.ledger`, or
`app_server:core.schema` for Core. Core
commands and views require tenant scope; worker commands and views require
tenant and worker-role scope. Mutation and read tools require a durable managed
control-plane credential except schema discovery. After those checks pass, the
route constructs `source: "control_plane"` transport context itself and passes
Core scope such as `core:task.create` or worker-registry scope such as
`worker:lead.read`, `worker:view.snapshot`, or `worker:view.readiness` into the
dynamic-tool executor.

The generic local worker tool remains available for explicit operator-gated
commands:

```sh
export WORKER_OPERATOR_EMAIL=owner@continuoushq.com
bun run worker:tool worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"run","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-run-001","config":{"intake":{"source":"website_form","sourceEventId":"form-001"}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"payment_link.prepare","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-revenue-payment-link-001","config":{"invoiceId":"invoice_row_or_invoice_object_uuid","sourceRefs":{"invoiceObjectId":"invoice_object_uuid","quoteObjectId":"quote_object_uuid"},"policy":{"requireOwnerApproval":true,"providerPaymentLinkCreation":"blocked","moneyMovement":"blocked"}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"brief.generate","worker":{"role":"owner_chief_of_staff","tenantSlug":"continuous-demo"},"idempotencyKey":"local-owner-brief-001","config":{"window":{"from":"2026-05-19T00:00:00.000Z","to":"2026-05-20T00:00:00.000Z"},"scopes":["tasks","approvals","cash","capacity","obligations","workers"],"includeEvidence":true}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"invoice.prepare","worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-invoice-001","config":{"sourceRefs":{"jobObjectId":"33333333-3333-4333-8333-000000000005","closeoutObjectId":"closeout_object_uuid","customerObjectId":"33333333-3333-4333-8333-000000000001"},"policy":{"requireOwnerApproval":true}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"ar_followup.draft","worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-ar-followup-001","config":{"invoiceId":"invoice_row_or_invoice_object_uuid","tonePolicy":"friendly_first_reminder","channel":"email","policy":{"requireOwnerApproval":true,"externalSend":"blocked","moneyMovement":"blocked"}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"cash_forecast.generate","worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-cash-forecast-001","config":{"window":{"from":"2026-05-01T00:00:00.000Z","to":"2026-06-01T00:00:00.000Z"},"accounts":["Operating account"],"startingBalanceCents":500000,"policy":{"requireOwnerApproval":true,"moneyMovement":"blocked"}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"payment_draft.prepare","worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-payment-draft-001","config":{"sourceRefs":{"paymentId":"payment_row_or_payment_object_uuid"},"payee":"Acme Roofing Supplies","method":"ach","policy":{"requireOwnerApproval":true,"requireDualControl":true,"moneyMovement":"blocked"}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"hire.packet.prepare","worker":{"role":"workforce_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-workforce-hire-001","config":{"personId":"person_uuid","positionId":"field_operations_lead","workLocationId":"work_location_object_uuid","documents":[{"type":"employment_eligibility","state":"verified","sensitivity":"high"}],"policy":{"restrictedData":"redacted_by_default"}}}'
```

```sh
bun run worker:tool worker.command --payload='{"command":"payroll_input.prepare","worker":{"role":"workforce_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-workforce-payroll-input-001","config":{"employmentId":"employment_uuid","period":"2026-05","hours":80,"earnings":[{"code":"regular_hours","amountCents":336000,"currency":"USD"}],"deductions":[]}}'
```

```http
POST /worker
```

Those mutation surfaces keep the same scalable payload shape:
`command`, `worker`, `idempotencyKey`, and `config`.
The local `worker:tool` command uses `worker.command` for mutations and
`worker.view` for reads; command/view names live in the payload instead of in
worker-family-specific tool names.
