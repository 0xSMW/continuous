# Finance Operations Worker V1 Contract

This contract defines the finance worker for invoice drafts, AR follow-up,
expense coding, cash forecast, and payment draft preparation. V1 never moves
money and never sends external payment communications without approval.
The first executable slices are `invoice.prepare` and `ar_followup.draft`; the
remaining Finance commands stay contract-defined until their runtime handlers
are promoted through the same generic worker registry.

## Header

| Field | Value |
|---|---|
| Worker role | `finance_operations` |
| First outcome | Cash packet with invoice draft, AR queue, and forecast evidence |
| Autonomy level | `2` |
| External execution | `dry_run`; money movement blocked |

## API Shape

All commands use `POST /worker`; no finance-specific route is added.

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

## Registry Entries

| Command or view | Tool alias | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `GET view=snapshot` | `worker.snapshot` | `worker.role` | None | Read-only | Blocked |
| `invoice.prepare` | `worker.finance.invoice.prepare` | `jobId`, `closeoutId`, or `sourceRefs` | Required | Invoice draft, cash packet, approval request, accounting dry-run receipt | Dry-run |
| `ar_followup.draft` | `worker.finance.ar_followup.draft` | `invoiceId`, `tonePolicy` | Required | AR follow-up draft, cash packet, approval request, generated review view | Blocked |
| `expense_code.propose` | `worker.finance.expense_code.propose` | `receiptId` or `expenseId` | Required | Coding proposal and evidence | Blocked |
| `cash_forecast.generate` | `worker.finance.cash_forecast.generate` | `window`, `accounts[]` | Required | Forecast object and packet | Blocked |
| `payment_draft.prepare` | `worker.finance.payment_draft.prepare` | `billId` or `paymentId` | Required | Payment instruction draft only | Blocked |
| `approval.decide` | `worker.approvals.decide` | `approvalId`, `action`, optional `note` | None | Approval/task/workflow evidence only | Blocked |

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
| `payment_link.prepare` | 2 | Worker | Invoice draft only | Required | Blocked |
| `ach_draft.prepare` | 2 | Worker | Bill/payment instruction drafts | Dual-control required | Blocked |
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
invoice, disputed and paid invoice blocking, expense coding accuracy, stale bank
feed forecast, budget pressure, idempotent replay, no unauthorized sends, and no
money movement.

## Security

Money movement, refunds, payment links, ACH, payroll, and tax advice remain
blocked. Dual-control is required for payment drafts. Source docs can contain
prompt injection and must remain evidence, not instructions. Abuse cases:
creating fraudulent invoices, hiding cash shortfalls, miscoding expenses,
revealing bank data, or preparing payments outside approved policy.
