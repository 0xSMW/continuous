# App-Server Worker Tools

Continuous exposes repo-owned app-server dynamic tool specs for worker
discovery plus registry-backed read and command execution:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.worker.schema` | Read-only | Returns worker contracts, runtime roles, registered commands, follow-up commands, planned future-worker metadata, worker tool schema, and integration boundary |
| `continuous.worker.view` | Registry-backed read | Reads registered worker views with the same `view`, `worker`, and `config` envelope used by local worker tooling and `/worker` query selectors |
| `continuous.worker.command` | Registry-backed command | Invokes an existing worker command with the same `command`, `worker`, `idempotencyKey`, and `config` envelope used by `/worker` |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`. The local manifest in
`src/worker/app-server-tools.ts` follows that shape and delegates reads and
commands to the shared worker registry.
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

```sh
bun run app-server:worker-tools
bun run app-server:worker-tools continuous.worker.schema
bun run app-server:worker-tools continuous.worker.view --payload='{"view":"snapshot","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"config":{}}'
```

```sh
bun run app-server:worker-tools continuous.worker.command --payload='{"command":"lead.read","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-app-server-lead-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

Inbox and CRM lead intake use the same command surface with source-reader
metadata inside `config.reader`; the tool forwards that payload through the
registry without loading production tokens or executing external reads.

## Boundary

The app-server worker tools are intentionally narrow:

- Commands are resolved by the same registry as `/worker` and `worker:tool`.
- Reads are resolved by the same view registry as `/worker?view=...` and
  `worker.view`.
- Read envelopes are strict. `continuous.worker.view` accepts only `view`,
  `worker`, and `config`; read filters such as `state` belong under `config`.
- Mutation envelopes are strict. `continuous.worker.command` accepts only
  `command`, `worker`, `idempotencyKey`, and `config`; `approvalId`, source
  records, retry limits, lead payloads, and every other operation input belong
  under `config`.
- Worker-specific options stay inside `config` and are validated by the
  command registry's `configSchema`.
- Planned worker roles expose config schemas but remain non-executable until
  handlers are registered; promoted roles move into the registered command list.
- Caller supplies `command`, `worker`, `idempotencyKey`, and `config`.
- Operator identity comes from the trusted local `WORKER_OPERATOR_EMAIL`
  environment, matching the authenticated identity that `/worker` derives from
  its bearer credential.
- No external execution is available.
- No production token is loaded.
- Local read and mutation tools are trusted-local by default; in
  `APP_ENV=production`, set `CONTINUOUS_TRUSTED_LOCAL_WORKER_TOOLS=true` only
  for an explicitly trusted operator shell or app-server bridge.

The generic local worker tool remains available for explicit operator-gated
commands:

```sh
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
