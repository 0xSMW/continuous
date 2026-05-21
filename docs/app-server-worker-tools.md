# App-Server Worker Tools

Continuous exposes repo-owned app-server dynamic tool specs for worker
discovery plus registry-backed read and command execution:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.worker.schema` | Read-only | Returns worker contracts, runtime roles, registered commands, follow-up commands, planned future-worker metadata, worker tool schema, and integration boundary |
| `continuous.worker.view` | Registry-backed read | Reads registered worker views with the same `view`, `worker`, and `config` envelope used by local worker tooling and `POST /worker` read payloads |
| `continuous.worker.command` | Registry-backed command | Invokes an existing worker command with the same `command`, `worker`, `idempotencyKey`, and `config` envelope used by `/worker` |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`, and invokes dynamic tools with a payload
containing `tool`, `arguments`, `callId`, `threadId`, and `turnId`. The local
manifest and dynamic-call adapter in `src/worker/app-server-tools.ts` follow
that shape and delegate reads and commands to the shared worker registry.
`continuous.worker.schema` exposes each registered command's `configSchema`,
canonical `apiRoute: "/worker"`, the full `contracts` catalog, current `runtimeContracts`, and
`followUpCommands` that are contract-defined but not executable yet. Planned
future-worker commands also expose a non-executable `configSchema` so agents
can inspect payload requirements before handlers exist.
`continuous.worker.view`, `continuous.worker.command`, `/worker`, and
`worker:tool` all run through the same registry validation before dispatch.
The CI integration suite exercises `continuous.worker.command` on real
Revenue `lead.read`, `run`, `lead.classify`, `response.draft`, and
`quote.prepare`. It also exercises Owner `brief.generate`, Dispatch
`schedule.propose`, and Finance
`payment_draft.prepare` commands, proving the app-server boundary writes the
same worker run, approval, evidence, budget, event, adapter dry-run, generated
view, and workflow records as `/worker`.
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
validation, and policy live under `config`. The runtime writes filing draft
packets, approval requests, workflow/budget/audit proof, and keeps agency
submission and legal advice blocked. Obligation scan, notice response, license
renewal, evidence binder export, live credentials, broader rule sources, and
receipt capture remain follow-ups.

```sh
export WORKER_OPERATOR_EMAIL=owner@continuoushq.com
bun run app-server:worker-tools
bun run app-server:daemon:start
bun run app-server:daemon:version
bun run app-server:proxy
bun run app-server:worker-tools continuous.worker.schema
bun run app-server:worker-tools dynamic-call --payload='{"tool":"continuous.worker.schema","arguments":{},"callId":"local-schema-001","threadId":"local-thread-001","turnId":"local-turn-001"}'
bun run app-server:worker-tools continuous.worker.view --payload='{"view":"snapshot","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}'
```

The local app-server executor may accept a trusted-local context through
`--context` or `APP_SERVER_WORKER_TRANSPORT_CONTEXT_JSON`, but it rejects
`source: "control_plane"` context. Control-plane context must be constructed by
an authenticated bridge after it has verified route, access, command/view,
tenant, and worker-role scope.

```sh
bun run app-server:worker-tools continuous.worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-app-server-lead-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

Inbox and CRM lead intake use the same command surface with source-reader
metadata inside `config.reader`; the tool forwards that payload through the
registry without loading production tokens or executing external reads.

## Boundary

The app-server worker tools are intentionally narrow:

- Commands are resolved by the same registry as `/worker` and `worker:tool`.
- Reads are resolved by the same view registry as `POST /worker` view payloads
  and `worker.view`.
- Read envelopes are strict. `continuous.worker.view` accepts only `view`,
  `worker`, and `config`; send `{}` when there are no read filters, and put
  filters such as `state` under `config`.
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
tenant, and worker-role scope. Do not pass bearer tokens or operator identity
in the tool payload. Dynamic tool responses return Codex-compatible
`contentItems` with a JSON text body and set `success=false` for registry or
envelope errors instead of moving context into the payload.

## Remote Bridge

`POST /app-server` is the generic authenticated bridge for dynamic tool calls.
It is not a worker-family API route; worker execution still goes through the
same registry and payload envelope as `POST /worker`. The bridge accepts only
`tool`, `arguments`, `callId`, `threadId`, and `turnId` at the top level. Put
operation fields under `arguments.config`, and never send `operatorEmail`,
bearer tokens, transport context, tenant scope, or worker-role scope in the
payload.

`continuous.worker.command`, `continuous.worker.view`, `worker.command`, and
`worker.view` are tool names; `/worker` is the HTTP route; `command`, `view`,
`worker`, `idempotencyKey`, and `config` are payload fields.

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
`app_server:worker.view.snapshot`, or `app_server:worker.schema`. For commands
and views it also requires tenant and worker-role scope plus a durable managed
control-plane credential. After those checks pass, the route constructs
`source: "control_plane"` transport context itself and passes worker-registry
scope such as `worker:lead.read` or `worker:view.snapshot` into the dynamic-tool
executor.

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
