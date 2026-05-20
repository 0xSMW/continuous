# App-Server Worker Tools

Continuous exposes repo-owned app-server dynamic tool specs for worker
discovery and registry-backed command execution:

| Tool | Mode | Purpose |
|---|---|---|
| `continuous.worker.schema` | Read-only | Returns the registered Revenue, Owner, Dispatch, and Finance runtime commands, planned future-worker metadata, worker tool schema, and integration boundary |
| `continuous.worker.command` | Registry-backed command | Invokes an existing worker command with the same `command`, `worker`, `idempotencyKey`, and `config` envelope used by `/worker` |

The generated Codex app-server protocol defines a dynamic tool as `name`,
`description`, and `inputSchema`. The local manifest in
`src/worker/app-server-tools.ts` follows that shape and delegates commands to
the shared worker command registry.
`continuous.worker.schema` exposes each registered command's `configSchema`;
planned future-worker commands also expose a non-executable `configSchema` so
agents can inspect payload requirements before handlers exist.
`continuous.worker.command`, `/worker`, and `worker:tool` all run through that
same registry validation before dispatch.
The CI integration suite exercises `continuous.worker.command` on real
Revenue `lead.read` and `run`, Owner `brief.generate`, Dispatch
`schedule.propose`, and Finance `payment_draft.prepare` commands, proving the
app-server boundary writes the same worker run, approval, evidence, budget,
event, adapter dry-run, generated view, and workflow records as `/worker`.
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

```sh
bun run app-server:worker-tools
bun run app-server:worker-tools continuous.worker.schema
```

```sh
bun run app-server:worker-tools continuous.worker.command --payload='{"command":"lead.read","operatorEmail":"owner@continuoushq.com","worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-app-server-lead-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

Inbox and CRM lead intake use the same command surface with source-reader
metadata inside `config.reader`; the tool forwards that payload through the
registry without loading production tokens or executing external reads.

## Boundary

The app-server command tool is intentionally narrow:

- Commands are resolved by the same registry as `/worker` and `worker:tool`.
- Mutation envelopes are strict. Top-level fields are limited to `command`,
  `worker`, `operatorEmail`, `idempotencyKey`, and `config` for
  `continuous.worker.command`; top-level operation inputs such as `approvalId`,
  source records, retry limits, or lead payloads are rejected and must live
  under `config`.
- Worker-specific options stay inside `config` and are validated by the
  command registry's `configSchema`.
- Planned worker roles expose config schemas but remain non-executable until
  handlers are registered; promoted roles move into the registered command list.
- Caller supplies `operatorEmail`, `worker`, `idempotencyKey`, and `config`.
- No external execution is available.
- No production token is loaded.

The legacy local worker tool remains available for explicit operator-gated
commands:

```sh
bun run worker:tool worker.lead.read --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-lead-read-001","config":{"source":"website_form","records":[{"sourceEventId":"form-001","customerName":"Acme Roof Repair","customerIntent":"roof leak inspection","serviceArea":"roofing","urgency":"high"}]}}'
```

```sh
bun run worker:tool worker.run --payload='{"worker":{"role":"revenue_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-run-001","config":{"intake":{"source":"website_form","sourceEventId":"form-001"}}}'
```

```sh
bun run worker:tool worker.owner.brief.generate --payload='{"worker":{"role":"owner_chief_of_staff","tenantSlug":"continuous-demo"},"idempotencyKey":"local-owner-brief-001","config":{"window":{"from":"2026-05-19T00:00:00.000Z","to":"2026-05-20T00:00:00.000Z"},"scopes":["tasks","approvals","cash","capacity","obligations","workers"],"includeEvidence":true}}'
```

```sh
bun run worker:tool worker.finance.invoice.prepare --payload='{"worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-invoice-001","config":{"sourceRefs":{"jobObjectId":"33333333-3333-4333-8333-000000000005","closeoutObjectId":"closeout_object_uuid","customerObjectId":"33333333-3333-4333-8333-000000000001"},"policy":{"requireOwnerApproval":true}}}'
```

```sh
bun run worker:tool worker.finance.ar_followup.draft --payload='{"worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-ar-followup-001","config":{"invoiceId":"invoice_row_or_invoice_object_uuid","tonePolicy":"friendly_first_reminder","channel":"email","policy":{"requireOwnerApproval":true,"externalSend":"blocked","moneyMovement":"blocked"}}}'
```

```sh
bun run worker:tool worker.finance.cash_forecast.generate --payload='{"worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-cash-forecast-001","config":{"window":{"from":"2026-05-01T00:00:00.000Z","to":"2026-06-01T00:00:00.000Z"},"accounts":["Operating account"],"startingBalanceCents":500000,"policy":{"requireOwnerApproval":true,"moneyMovement":"blocked"}}}'
```

```sh
bun run worker:tool worker.finance.payment_draft.prepare --payload='{"worker":{"role":"finance_operations","tenantSlug":"continuous-demo"},"idempotencyKey":"local-finance-payment-draft-001","config":{"sourceRefs":{"paymentId":"payment_row_or_payment_object_uuid"},"payee":"Acme Roofing Supplies","method":"ach","policy":{"requireOwnerApproval":true,"requireDualControl":true,"moneyMovement":"blocked"}}}'
```

```http
POST /worker
```

Those mutation surfaces keep the same scalable payload shape:
`command`, `worker`, `idempotencyKey`, and `config`.
The local `worker:tool` command uses the tool name as the command selector and
keeps the same strict `worker`, `idempotencyKey`, `config`, and optional
`operatorEmail` envelope.
