# App-Server Tools

Continuous exposes repo-owned app-server dynamic tool specs for Core and worker
discovery plus registry-backed read and command execution:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.core.schema` | Read-only | Returns the Core app-server registry, command/view names, canonical `apiRoute: "/core"`, and excluded credential-admin commands |
| `continuous.core.view` | Registry-backed read | Reads registered Core views with the same `view`, `core`, and `config` envelope used by `POST /core` read payloads |
| `continuous.core.command` | Registry-backed command | Invokes an existing Core command with the same `command`, `core`, `idempotencyKey`, and `config` envelope used by `/core` |
| `continuous.worker.schema` | Read-only | Returns worker contracts, runtime roles, registered commands, follow-up commands, planned future-worker metadata, worker tool schema, and integration boundary |
| `continuous.worker.view` | Registry-backed read | Reads registered worker views with the same `view`, `worker`, and `config` envelope used by local worker tooling and `POST /worker` read payloads |
| `continuous.worker.command` | Registry-backed command | Invokes an existing worker command with the same `command`, `worker`, `idempotencyKey`, and `config` envelope used by `/worker` |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`, and invokes dynamic tools with a payload
containing `tool`, `arguments`, `callId`, `threadId`, and `turnId`. The local
manifest and dynamic-call adapters follow that shape: Core tools live in
`src/core/app-server-tools.ts`, worker tools live in
`src/worker/app-server-tools.ts`, and both delegate reads and commands to
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
`continuous.worker.view`, `continuous.worker.command`, `/worker`, and
`worker:tool` all run through the same registry validation before dispatch.
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
`quote.prepare`, and `payment_link.prepare`. It also exercises Owner `brief.generate`, Dispatch
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
Revenue-specific app-server tool.
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

```sh
export WORKER_OPERATOR_EMAIL=owner@continuoushq.com
bun run app-server:tools
bun run app-server:daemon:start
bun run app-server:daemon:version
bun run app-server:proxy
bun run app-server:tools continuous.core.schema
bun run app-server:tools continuous.core.view --payload='{"view":"summary","core":{"tenantSlug":"continuous-demo"},"config":{}}'
bun run app-server:tools continuous.worker.schema
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
- Core reads currently expose the `summary` view through the same `view`,
  `core`, and `config` envelope as `POST /core`.
- Reads are resolved by the same view registry as `POST /worker` view payloads
  and `worker.view`.
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
`continuous.worker.command`, `continuous.worker.view`, `worker.command`, and
`worker.view` are tool names; `/core` and `/worker` are HTTP routes; `command`,
`view`, `core`, `worker`, `idempotencyKey`, and `config` are payload fields.

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
`app_server:core.view.summary`, or `app_server:core.schema` for Core. Core
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
