# Revenue Operations Worker V1 Contract

This contract defines the first worker surface that can be expanded without
raising autonomy or permitting external sends.

## Inputs

| Input | Required | Notes |
|---|---:|---|
| `idempotencyKey` | Yes | Stable per operator-triggered run |
| Operator identity | Yes | Resolved from the authenticated control-plane credential or trusted local `WORKER_OPERATOR_EMAIL`; it is not part of the command payload |
| `worker.role` | Yes | Explicit lower_snake_case role selector such as `revenue_operations`; no default role is assumed, and route nouns such as `worker` or `api`, hyphenated family names, `api/*-worker` route fragments, or `*_worker` suffixes are invalid |
| `worker.tenantSlug` | No | Required when an operator email spans tenants |
| `worker.id` | No | Required when multiple Revenue Workers match |
| `config.source` plus direct `config.records[]` / `config.record` or `config.reader` | Required for `lead.read` | Reads direct, connection-buffered, or read-only API-polled website-form, inbox, or CRM lead records into persisted Core source object/event/evidence rows |
| `config.intake`, `config.leadPacket`, or `config.lead` | Required for `run`, `lead.classify`, `response.draft`, and `quote.prepare` | Prefer persisted Core lead source identity or object/event/evidence rows in `config.intake`; direct payloads are explicit operator/test fallbacks |
| `config.invoiceId`, `config.invoiceObjectId`, or keyed `config.sourceRefs` | Required for `payment_link.prepare` | Tenant-scoped invoice row or invoice object anchor; payment-link prep writes a blocked payment packet, not a provider-side link |

## API Shape

The canonical worker control-plane route is `/worker`.
Revenue does not expose a family-specific route alias; the Revenue role is only
selected through `worker.role: "revenue_operations"` in the request payload.

Only `command`, `worker`, `idempotencyKey`, and `config` are accepted as
top-level command fields. Worker role, tenant selection, and worker id live
under `worker`; operation-specific inputs such as source records, approval ids,
retry limits, pricing overrides, and direct fallback lead payloads live under
`config`.
The `worker` object is a strict selector; it accepts only `role`, `id`, and
`tenantSlug`, so operation fields cannot move there as a second ad hoc payload
shape.
`worker.role` is a role selector, not a route alias: `revenue_operations` is
valid, while `worker`, `api`, hyphenated family names, `_worker` suffixes, and
`worker/revenue_operations` are rejected before registry dispatch.

Read views use the same route with `view`, `worker`, and `config` as the only
top-level fields. `view: "readiness"` reports dry-run checks, latest proof refs,
and generic launch gates without adding a Revenue-specific URL.

```json
{
  "view": "readiness",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {}
}
```

Prepare a blocked payment-link packet from a persisted invoice:

```json
{
  "command": "payment_link.prepare",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "payment-link-001",
  "config": {
    "invoiceId": "44444444-4444-4444-8444-000000000006",
    "sourceRefs": {
      "invoiceObjectId": "33333333-3333-4333-8333-000000000006",
      "quoteObjectId": "33333333-3333-4333-8333-000000000004"
    },
    "policy": {
      "requireOwnerApproval": true,
      "providerPaymentLinkCreation": "blocked",
      "moneyMovement": "blocked"
    }
  }
}
```

Read inbound lead source records before running the worker:

```json
{
  "command": "lead.read",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "lead-read-001",
  "config": {
    "source": "website_form",
    "records": [
      {
        "sourceEventId": "form-2026-05-19-001",
        "customerName": "Acme Roof Repair",
        "customerIntent": "roof leak inspection",
        "serviceArea": "roofing",
        "urgency": "high",
        "missingFacts": ["preferred_time_window"]
      }
    ]
  }
}
```

The command returns `result.selectors[]`; pass one selector's
`intake.source` and `intake.sourceEventId` to `command: "lead.classify"`,
`command: "response.draft"`, `command: "quote.prepare"`, or the full
`command: "run"`:

```json
{
  "command": "lead.classify",
  "worker": {
    "role": "revenue_operations",
    "id": null,
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "worker-command-001",
  "config": {
    "intake": {
      "source": "website_form",
      "sourceEventId": "form-2026-05-19-001"
    }
  }
}
```

```json
{
  "command": "response.draft",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "worker-draft-001",
  "config": {
    "intake": {
      "source": "website_form",
      "sourceEventId": "form-2026-05-19-001"
    }
  }
}
```

The full run command consumes the same intake selector and prepares the
approval packet plus dry-run adapter receipt:

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "worker-run-001",
  "config": {
    "intake": {
      "source": "website_form",
      "sourceEventId": "form-2026-05-19-001"
    }
  }
}
```

Internal workflow handlers that already hold Core row ids can send exact
references in the same `config.intake` object:

```json
{
  "command": "run",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "worker-run-row-001",
  "config": {
    "intake": {
      "objectId": "lead_object_uuid",
      "eventId": "lead_received_event_uuid",
      "evidenceId": "lead_snapshot_evidence_uuid"
    }
  }
}
```

The referenced Core records should carry the same flat lead packet in object,
event, and evidence data:

```json
{
  "source": "website_form",
  "sourceEventId": "form-2026-05-19-001",
  "customerName": "Acme Roof Repair",
  "customerIntent": "roof leak inspection",
  "serviceArea": "roofing",
  "urgency": "high",
  "missingFacts": ["preferred_time_window"]
}
```

Approval decisions use the same route:

```json
{
  "command": "approval.decide",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "worker-approval-decision-001",
  "config": {
    "approvalId": "approval_uuid",
    "action": "approved",
    "note": "optional operator note"
  }
}
```

Worker continuations also stay on the same route. The command consumes persisted
approval state; the URL does not encode the worker family or continuation type.
For an approved controlled send, execution data stays under `config.execution`
and must include an explicit `connectionId`, managed credential reference,
recipient, receipt, and rollback/escalation proof. No continuation uses a
worker-family API route or top-level operation fields.

```json
{
  "command": "continue",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "worker-continue-001",
  "config": {
    "approvalId": "approval_uuid",
    "execution": {
      "connectionId": "connection_uuid",
      "credentialRef": "managed:customer-message-sender",
      "requiredScopes": ["customer_message.send"],
      "channel": "email",
      "recipient": "buyer@example.com",
      "receipt": {
        "receiptId": "provider_receipt_id",
        "providerMessageId": "provider_message_id"
      },
      "rollback": {
        "strategy": "send_followup_correction",
        "escalationOwner": "owner@continuoushq.com"
      }
    }
  }
}
```

Adapter reconciliation also stays on the same command surface:

```json
{
  "command": "adapters.reconcile",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "adapter-reconcile-001",
  "config": {
    "limit": 25
  }
}
```

Due adapter retries use the same tenant-scoped command envelope and remain
dry-run only:

```json
{
  "command": "adapters.retry",
  "worker": {
    "role": "revenue_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "adapter-retry-001",
  "config": {
    "limit": 25
  }
}
```

Worker-family-specific routes are not part of the public API. There is no
Revenue Operations compatibility path or worker-specific local mutation
shortcut; HTTP and CLI callers both go through the registered `/worker` command
envelope. Future workers must use `/worker` with role, command, idempotency,
and config in structured fields; operation inputs are valid only under `config`.

## Registry Entries

The Revenue Worker owns the first registered `/worker` commands. HTTP commands
and local toolbox aliases resolve to the same handlers and validation rules.

| HTTP command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "approvals"` payload | `worker.view` | `worker.role`, optional `config.state` | None | Read-only | Blocked |
| `view: "readiness"` payload | `worker.view` | `worker.role`, empty `config` | None | Read-only Revenue dry-run proof, launch blockers, launch gates, and latest proof refs | Blocked |
| `lead.read` | `worker.command` | `config.source`, direct `config.records[]` / `config.record`, or `config.reader` referencing an active connection | Required | Core lead object/event/evidence, worker run, budget/usage, connection cursor proof, audit | Blocked |
| `lead.classify` | `worker.command` | One of `config.intake`, `config.leadPacket`, or `config.lead` | Required | Classification worker run, budget/usage, inference, trace evidence, audit | Blocked |
| `response.draft` | `worker.command` | One of `config.intake`, `config.leadPacket`, or `config.lead` | Required | Draft worker run, budget/usage, inference, draft evidence, audit | Blocked |
| `quote.prepare` | `worker.command` | One of `config.intake`, `config.leadPacket`, or `config.lead` | Required | Quote-preparation worker run, budget/usage, inference, source evidence, dry-run adapter receipt, approval request, generated quote review view, audit | Blocked |
| `payment_link.prepare` | `worker.command` | `config.invoiceId`, `config.invoiceObjectId`, or keyed `config.sourceRefs`; optional `config.quoteObjectId`, `config.bankAccountId`, `config.policy` | Required | Payment object, payment row, payment instruction when a bank account exists, payment-link packet, approval request, generated payment review view, dry-run adapter receipt, workflow, budget/usage, audit | Blocked |
| `run` | `worker.command` | One of `config.intake`, `config.leadPacket`, or `config.lead` | Required | Internal records, budget, approval, dry-run adapter receipt | Blocked |
| `continue` | `worker.command` | `config.approvalId`; optional `config.execution` for approved controlled-send receipt recording | Required | Approved execution packet, optional controlled-send receipt, revised approval packet, or rejected stop packet, workflow step, task outcome, audit/evidence | Approved only |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | Required | Approval/task/workflow evidence only | Blocked |
| `adapters.reconcile` | `worker.command` | Tenant-scoped `worker.tenantSlug`, optional integer `config.limit` | None | Adapter reconciliation audit/evidence plus retry/review system tasks | Blocked |
| `adapters.retry` | `worker.command` | Tenant-scoped `worker.tenantSlug`, optional integer `config.limit` | None | Executes due dry-run retry rows, closes retry tasks, and writes blocked receipt evidence with live-credential readiness and rollback proof | Blocked |

## Run Config

`config` is the command payload envelope. The route does not encode a worker
family, operation target, customer, source system, or draft type in the URL.

For `command: "lead.read"`, use:

| Field | Required | Notes |
|---|---:|---|
| `source` | Yes | Source system name, for example `website_form`, `google_workspace_inbox`, or `hubspot_crm` |
| `reader.kind` | For inbox/CRM readers | `inbox` or `crm`; defaults are inferred for website-form and generic source records |
| `reader.provider` | No | External source family, such as `google_workspace` or `hubspot`; stored as source-reader metadata |
| `reader.credentialRef` | Required for inbox/CRM readers | Opaque credential or `connection:<id>` reference; never embed credential material in `config.reader` |
| `reader.connectionRef` | For connection-backed reads | Optional explicit active connection id, name, or external account id; if no `records[]` are sent, the worker reads buffered source records or a read-only API poll from the connection config |
| `connection.config.polling.enabled` | For API-polled connections | When `true`, the active connection may poll supported read-only providers such as Google Workspace/Gmail metadata or HubSpot CRM search using an environment-backed credential reference; access tokens are never accepted in the request payload |
| `records[].sourceEventId` | Required for direct records | Stable external source event, form, message, deal, or row id; inbox readers may provide `messageId`, and CRM readers may provide `externalId` |
| `records[].messageId`, `threadId`, `from`, `subject`, `snippet`, `receivedAt` | Inbox readers | Used to normalize inbox messages into lead source snapshots |
| `records[].externalId`, `companyName`, `contactName`, `dealName`, `stage`, `updatedAt` | CRM readers | Used to normalize CRM lead or deal rows into lead source snapshots |
| `records[].customerName` | No | Used to name the Core lead object; defaults to `Customer` |
| `records[].customerIntent` | No | Used for downstream classification; defaults to `service request` |
| `records[].serviceArea` | No | Used for quote defaults; defaults to `field service` |
| `records[].urgency` | No | `low`, `normal`, `high`, `urgent`, `emergency`, or `same_day` |
| `records[].missingFacts` | No | Missing facts carried forward to the approval packet |
| `records[].payload` | No | Raw source payload retained in evidence with external execution blocked |

| Field | Required | Notes |
|---|---:|---|
| `intake.source` | Preferred for external callers | Source system name, for example `website_form`, used with `intake.sourceEventId` to resolve persisted Core records |
| `intake.sourceEventId` | Preferred for external callers | External event or message id; this is not the DB event id |
| `intake.objectId` | Internal workflows | Core `objects.id` for the lead spine |
| `intake.eventId` | Internal workflows | Core `events.id` for the `lead.received` event |
| `intake.evidenceId` | Internal workflows | Core `evidence.id` for the source snapshot |
| `config.leadPacket.*` | Explicit fallback | Backward-compatible direct payload alias for evals and operator tests |
| `config.lead.*` | Explicit fallback | Direct payload alias for controlled local tooling that cannot yet persist intake |
| `pricing.baseCents` | No | Optional deterministic quote override for evals and controlled tests |

If `config.intake` includes a source selector or Core row references, do not
also send `config.leadPacket` or `config.lead`. Mixed authoritative sources are
rejected with `worker_intake_conflict`; direct payloads are fallback-only when
no Core intake selector is present.

`config.externalSend=true` or `config.leadPacket.externalSend=true` is rejected
for `run`, `quote.prepare`, and split draft/classification commands. Approved
external-send continuation is only accepted as `config.execution` on
`command: "continue"`, after approval, and only with scoped connection proof,
managed credential reference, provider receipt, rollback strategy, and
escalation owner.

## Run Output

`POST /worker` with `command: "lead.read"` returns a generic command response
whose `result.output.selectors[]` contains:

| Output | Required behavior |
|---|---|
| `source` | Source system name used for lookup |
| `sourceEventId` | External source id used as the stable selector |
| `sourceReader` | Read-only reader metadata, including kind, provider, credential reference, optional connection id, source mode, and blocked external-execution state |
| `objectId` | Core lead object row persisted from the source record |
| `eventId` | Core `lead.received` event row persisted or reused for the source record |
| `evidenceId` | Source snapshot evidence row |
| `intake` | Minimal `{source, sourceEventId}` payload for a later `command: "run"` |

When records are read from a connection, `result.output.connectionId` and
`result.output.cursor` are set. Buffered reads report `sourceMode:
connection_buffer`; read-only provider polls report `sourceMode:
connection_api` and include a redacted `pollingReceipt`. The connection
receives `lastLeadRead` metadata with the worker run id, source mode, cursor,
optional provider cursor, read count, timestamp, redacted polling receipt, and
blocked external-execution posture.

`POST /worker` with `command: "quote.prepare"` or `command: "run"` returns a generic
command response whose `result.output` contains worker-derived data:

| Output | Required behavior |
|---|---|
| `sourceSnapshotEvidenceId` | Points to persisted source snapshot evidence |
| `intake` | Resolved Core intake metadata used for the run |
| `sourceObjectId` | Core source object id when resolved from persisted intake |
| `sourceEventRowId` | Core source event row id when resolved from persisted intake |
| `sourceEvidenceId` | Core source evidence id when resolved from persisted intake |
| `classification` | Derived from lead urgency and missing facts |
| `draftResponse` | Owner-review draft; not externally sent |
| `quote` | Deterministic quote with lines, total, currency, and blocked money movement policy |
| `externalSend` | `false` for run and draft outputs; approved continuation may become `true` only when `config.execution` records a controlled-send receipt |
| `workflowRunId` | Lead-to-cash workflow run tied to the worker run |

`POST /worker` with `command: "payment_link.prepare"` returns a generic command
response whose `result.output` contains a blocked payment-link packet:

| Output | Required behavior |
|---|---|
| `paymentObjectId` / `paymentId` | Payment primitive and row prepared from the invoice |
| `paymentInstructionId` | Present when a tenant-scoped bank account is available |
| `invoiceId` / `invoiceObjectId` | Source invoice refs that drove the packet |
| `approvalRequestId` | Owner approval for reviewing the packet |
| `paymentReviewViewId` | Generated payment review view |
| `adapterReceiptEvidenceId` | Dry-run receipt proving provider creation stayed blocked |
| `providerPaymentLinkCreation` | Always `blocked` until live provider credentials, receipt, and rollback gates exist |
| `moneyMovement` | Always `blocked` |
| `externalExecution` / `externalMutation` | `blocked` and `false` |
| `workflowStepIds` | Durable workflow steps for intake, packet, adapter dry-run, and approval request |
| `inputHash` | Canonical hash binding idempotency key to the normalized input payload |

`POST /worker` with `view: "readiness"` returns a read-only readiness object:

| Output | Required behavior |
|---|---|
| `status` | `ready` only when worker registration, capability grants, budget, workflow definition, latest dry-run proof, quote approval view, and latest payment-review view checks pass |
| `dryRunReady` | `true` when the persisted dry-run gates pass; live external execution can still be blocked |
| `launchStatus` | `ready` only when dry-run checks and every launch gate pass |
| `launchReady` | `true` only when Revenue is ready for customer-data launch, not merely dry-run operation |
| `checks[]` | Named checks with `ready` or `blocked` state plus evidence details |
| `blockers[]` | The subset of failed dry-run checks |
| `launchGates[]` | Explicit source-coverage, connection-health, scheduler-cursor, production sender, receipt/rollback, and cash/payment handoff gates until those gates are proven |
| `proof` | Latest worker run, workflow definition, quote review view, payment review view, and adapter receipt evidence ids |

## Preconditions

| Check | Failure code |
|---|---|
| One active/training Revenue Worker selected | `worker_not_found` or `worker_selector_ambiguous` |
| Operator user exists and is active | `operator_not_found` |
| Budget account and active policy exist | `worker_budget_missing` or `worker_budget_policy_missing` |
| Budget capacity remains under policy | `worker_budget_exceeded` |
| Required capability exists and is actively granted to the worker | `worker_capability_missing` or `worker_capability_not_granted` |
| Referenced adapter connection exists and is active | `worker_lead_read_connection_missing` |
| Referenced connection matches the requested source/provider/kind | `worker_lead_read_connection_incompatible` |
| Connection-backed read has unread buffered source records after the last cursor | `worker_lead_read_connection_records_missing` or `worker_lead_read_connection_records_exhausted` |
| API-polled connection has an environment-backed credential reference and readable source records | `worker_lead_read_live_credential_missing` or `worker_lead_read_live_records_missing` |

## Effects

| Record | Required behavior |
|---|---|
| `worker_runs` | Owns lifecycle, idempotency, lead-read input/output, run input/output, and continuations |
| `workflow_runs` | Owns the lead-to-cash state machine for the prepared worker action |
| `workflow_steps` | Records intake resolved, packet prepared, adapter dry-run recorded, approval requested, approval decision transitions, worker continuations, and adapter reconciliation transitions |
| `budget_reservations` | Reserves and marks deterministic simulation units as used |
| `adapter_runs` | Records dry-run adapter execution, approved controlled-send receipt recording, attempt metadata, retry execution, receipt state, and reconciliation state |
| `inferences` | Stores prompt/result/safety trace |
| `usage_events` | Attributes units to budget, task, capability, and worker |
| `events` | Emits source lead and worker lifecycle records with linked output ids |
| `evidence` | Stores source snapshots, trace, adapter receipt, and later approval decision evidence |
| `adapter_actions` | Links to the adapter run and drafts customer-response intent with `externalSend=false`; approved continuation may update the row to `mode=controlled_record`, `operation=customer_message.send`, `externalSend=true`, and a redacted controlled-send receipt |
| `approval_requests` | Creates pending operator approval for the prepared action |
| `audit_events` | Records run request, approval request, and approval decision |
| `tasks` | Moves active work to `approval_required`; decision later moves to `waiting`, `active`, or `blocked`; reconciliation creates retry/review system tasks and retry execution closes due retry tasks |
| `object_versions` | Records approval-required state against the object spine |

Adapter reconciliation is also workflow-scoped when the adapter row carries a
Revenue `workflowRunId`. Retryable adapter failures append
`workflow_steps.kind=adapter_reconciliation` and move `lead_to_cash` to
`adapter_retry_scheduled`; exhausted or unsafe failures move it to
`adapter_failure_review`; matched rows after retry execution move it to
`post_retry_reconciled`. These states remain no-send and keep external
execution blocked.

`POST /worker` with `command=continue` creates a separate idempotent
`worker_runs` continuation record and `workflow_steps.kind=worker_continuation`
entry. V1 supports `approved`, `revision_requested`, and `rejected` approvals.
Approved continuation prepares a no-send execution packet, stores
evidence/document packet records, moves the workflow to `execution_blocked`,
leaves the task in `waiting`, and keeps adapter execution blocked when
`config.execution` is absent. Approved continuation with `config.execution`
records a controlled customer-message receipt, hashes the managed credential
reference instead of storing it, persists only a safe summary of
`config.execution`, requires write scope plus rollback/escalation proof, moves
the workflow to `execution_recorded`, and rejects replay when the same
idempotency key is reused with changed or unhashed execution config. Revision
continuation prepares a revised no-send quote packet, stores the revised packet
evidence/document packet, creates a fresh pending `quote_revision_approval`,
moves the workflow back to `approval_requested`, updates the task back to
`approval_required`, and keeps adapter execution blocked. Rejected continuation
stores a closed no-send stop packet, appends a terminal worker continuation
step, keeps the task blocked, and closes the workflow in `rejected`.

## Approval Actions

| Action | Approval state | Task state | Workflow state | External behavior |
|---|---|---|---|---|
| `approved` | `approved` | `waiting` without `config.execution`; `done` after controlled receipt recording | `approved`; after `command=continue`, `execution_blocked` without execution config or `execution_recorded` with controlled receipt config | `command=continue` prepares an approved no-send execution packet by default; with `config.execution`, it records an approved controlled-send receipt with scoped credential, receipt, rollback, and replay-conflict proof |
| `revision_requested` | `revision_requested`; after `command=continue`, a new `quote_revision_approval` is `pending` | `approval_required` after the revised packet is prepared | `approval_requested` after the revised packet is prepared | `command=continue` prepares a revised no-send packet and requests owner approval again |
| `rejected` | `rejected` | `blocked`; after `command=continue`, still `blocked` with a rejected stop packet | `rejected`; after `command=continue`, remains `rejected` with a terminal continuation step | `command=continue` stores a closed no-send rejected packet and stops the prepared action |

## Non-Goals

- No autonomous customer sends.
- No live provider payment-link creation or money movement.
- No live CRM, inbox, calendar, quote, invoice, or payment adapter writes.
- No autonomy increase beyond read, classify, draft, prepare, and request approval.
