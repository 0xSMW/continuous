# Finance Operations Worker V1 Contract

This contract defines the finance worker for invoice drafts, AR follow-up,
expense coding, cash forecast, and payment draft preparation. V1 never moves
money and never sends external payment communications without approval.
The current executable slices are `invoice.prepare`, `ar_followup.draft`,
`cash_forecast.generate`, and `payment_draft.prepare`. Expense coding is a
planned follow-up command and is not registered in the current runtime. Live
execution gates stay contract-defined until their runtime handlers are promoted
through the same generic worker registry.

## Header

| Field | Value |
|---|---|
| Worker role | `finance_operations` |
| First outcome | Cash packet with invoice draft, AR queue, forecast evidence, and blocked payment draft |
| Autonomy level | `2` |
| External execution | `dry_run`; money movement blocked |

## API Shape

All commands and read views use `POST /worker`; no finance-specific route is
added. Operation inputs and read filters stay under `config`.

```json
{
  "command": "invoice.prepare",
  "worker": {
    "role": "finance_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "finance-invoice-job-001",
  "config": {
    "sourceRefs": {
      "jobObjectId": "job_object_uuid",
      "closeoutObjectId": "closeout_object_uuid",
      "customerObjectId": "customer_object_uuid"
    },
    "policy": {
      "requireOwnerApproval": true
    }
  }
}
```

AR follow-up uses the same envelope:

```json
{
  "command": "ar_followup.draft",
  "worker": {
    "role": "finance_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "finance-ar-followup-001",
  "config": {
    "invoiceId": "invoice_row_or_invoice_object_uuid",
    "tonePolicy": "friendly_first_reminder",
    "channel": "email",
    "messageContext": {
      "customerName": "Acme Roof Repair"
    },
    "policy": {
      "requireOwnerApproval": true,
      "externalSend": "blocked",
      "moneyMovement": "blocked"
    }
  }
}
```

Cash forecast uses the same envelope with account and cash-driver refs inside
`config`:

```json
{
  "command": "cash_forecast.generate",
  "worker": {
    "role": "finance_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "finance-cash-forecast-001",
  "config": {
    "window": {
      "from": "2026-05-01T00:00:00.000Z",
      "to": "2026-06-01T00:00:00.000Z"
    },
    "accounts": ["Operating account"],
    "startingBalanceCents": 500000,
    "policy": {
      "requireOwnerApproval": true,
      "moneyMovement": "blocked"
    }
  }
}
```

Payment draft preparation uses bill or payment selectors plus dual-control
policy under `config`; it prepares review artifacts only and does not submit ACH,
payment links, refunds, settlements, or bank writes:

```json
{
  "command": "payment_draft.prepare",
  "worker": {
    "role": "finance_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "finance-payment-draft-001",
  "config": {
    "sourceRefs": {
      "paymentId": "payment_row_or_payment_object_uuid"
    },
    "payee": "Acme Roofing Supplies",
    "method": "ach",
    "policy": {
      "requireOwnerApproval": true,
      "requireDualControl": true,
      "moneyMovement": "blocked"
    }
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `invoice.prepare` | `worker.command` | `config.jobId`, `config.closeoutId`, or `config.sourceRefs` | Required | Core worker-run lifecycle, invoice draft, cash packet, approval request, accounting dry-run receipt | Dry-run |
| `ar_followup.draft` | `worker.command` | `config.invoiceId`, `config.tonePolicy` | Required | AR follow-up draft, cash packet, approval request, generated review view | Blocked |
| `cash_forecast.generate` | `worker.command` | `config.window`, `config.accounts[]` | Required | Forecast object, cash packet, approval request, generated review view | Blocked |
| `payment_draft.prepare` | `worker.command` | `config.billId`, `config.paymentId`, or `config.sourceRefs` | Required | Payment object, Payment instruction draft, cash packet, dual-control approval request, generated review view | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | Required | Approval/task/workflow evidence only | Blocked |

Planned follow-up command:

| Command | Future surface | Required config | Promotion gate | Side effects | External execution |
|---|---|---|---|---|---|
| `expense_code.propose` | planned `worker.command` | `config.receiptId` or `config.expenseId` | Receipt intake fixture, policy exception eval, and approval evidence | Coding proposal and evidence | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `invoice` | `customerId`, `jobId`, `lines`, `subtotalCents`, `taxCents`, `totalCents`, `dueAt`, `currency` | `draft`, `approval_required`, `ready_to_send`, `sent`, `paid`, `void` | `bills_customer`, `prepared_from`, `collected_by` |
| `ar_followup` | `invoiceId`, `tonePolicy`, `channel`, `draft`, `amountCents`, `currency`, `blockers` | `draft`, `approval_required`, `blocked`, `ready_to_send`, `receipt_recorded` | `follows_up_invoice`, `for_customer`, `about_job` |
| `payment` | `invoiceId`, `amountCents`, `method`, `processor`, `status`, `receiptRef` | `draft`, `approval_required`, `prepared`, `settled`, `failed` | `pays_invoice`, `has_receipt` |
| `bill` | `vendorId`, `amountCents`, `dueAt`, `category`, `sourceRef` | `received`, `coding_review`, `approval_required`, `ready_to_pay`, `paid` | `owed_to_vendor`, `supported_by` |
| `expense` | `merchant`, `amountCents`, `category`, `receiptId`, `policyFlags` | `uncoded`, `proposed`, `approved`, `rejected` | `has_receipt`, `coded_as` |
| `receipt` | `source`, `capturedAt`, `amountCents`, `merchant`, `documentId` | `captured`, `matched`, `needs_review` | `supports_expense`, `supports_payment` |
| `cash_forecast` | `window`, `startingBalanceCents`, `expectedInflowCents`, `expectedOutflowCents`, `confidence` | `draft`, `review_ready`, `published`, `stale` | `summarizes_account`, `uses_invoice`, `uses_bill` |
| `reconciliation_item` | `accountId`, `sourceRef`, `amountCents`, `matchState`, `reason` | `unmatched`, `matched`, `review_required`, `cleared` | `matches_payment`, `matches_invoice` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `invoice_draft` | `draft -> source_review -> invoice_ready -> approval_pending -> ready_to_send` | Invoice send approval | Create task when closeout evidence is missing |
| `ar_followup` | `draft -> policy_review -> approval_pending -> ready_to_send -> receipt_recorded` | Every external AR message | Mark blocked when disputed or risky |
| `expense_coding` | `uncoded -> source_review -> proposed -> approval_pending -> approved` | Policy exceptions and high value expenses | Route to owner/accountant task |
| `cash_forecast` | `draft -> source_snapshot -> forecast_ready -> review_ready -> published` | Sensitive cash reveal approval | Mark low confidence when accounts are stale |
| `payment_draft` | `draft -> validation -> dual_control_pending -> ready_to_pay` | Dual-control approval | Never execute payment in V1 |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `invoice.prepare` | 2 | Worker | Jobs, closeouts, customers | Required before send | Dry-run |
| `ar_followup.draft` | 2 | Worker | Invoice evidence only | Required | Blocked |
| `payment_draft.prepare` | 2 | Worker | Bill/payment instruction drafts | Dual-control required | Blocked |
| `approval.request` | 2 | Worker | Invoices, bills, payment drafts | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Accounting | Customers, invoices, bills, ledger accounts | Draft invoice or coding proposal | Draft id, validation warnings, no-post proof | Retry 3 then accountant task |
| Payments | Payment status, failed payments, deposit refs | Payment link or ACH instruction draft only | Processor draft ref, `moneyMovement=false` | Retry 2 then owner task |
| Bank feeds | Balances and transactions | None | Balance timestamp and account refs | Retry 2 then forecast confidence low |
| Inbox/receipts | Receipt and bill source docs | None | Source doc refs and OCR confidence | Retry 3 then missing-doc task |

## Evidence Packet

`cash_packet` contains source docs, invoice draft, AR rationale, expense coding
trace, cash forecast inputs, payment instruction draft, approval records, and
adapter receipts. Bank account numbers, tax identifiers, payment tokens, payroll
details, and private memo fields are redacted.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `finance.invoice.review` | `invoice` | `approve_invoice`, `request_revision`, `void_draft` | `missing_closeout`, `customer_missing` |
| `finance.ar_followup.review` | `ar_followup` | `approve_ar_followup`, `request_revision`, `void_draft` | `invoice_paid`, `invoice_disputed`, `payment_link_blocked` |
| `finance.cash.review` | `cash_forecast` | `publish_forecast`, `request_revision`, `route_risk` | `accounts_stale`, `source_partial` |
| `finance.payment.review` | `payment` | `approve_draft`, `reject`, `request_dual_control` | `bank_unavailable`, `policy_blocked` |

## Evals

Golden cases cover invoice accuracy from closeout, AR follow-up drafting from an
invoice, payment draft preparation from payment evidence, disputed and paid
invoice blocking, expense coding accuracy, stale bank feed forecast, budget
pressure, idempotent replay, no unauthorized sends, and no money movement.

## Security

Money movement, refunds, payment links, ACH, payroll, and tax advice remain
blocked. Dual-control is required for payment drafts. Source docs can contain
prompt injection and must remain evidence, not instructions. Abuse cases:
creating fraudulent invoices, hiding cash shortfalls, miscoding expenses,
revealing bank data, or preparing payments outside approved policy.
