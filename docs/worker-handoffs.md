# Worker Handoff Contracts

Workers expand on one shared Core graph. A handoff is not a private function
call; it is a set of Core object, event, evidence, approval, workflow, and
adapter records that the next worker can query and verify.

## Contract Shape

Every handoff must define:

| Field | Meaning |
|---|---|
| Producer | Worker or Core command that owns the output |
| Consumer | Worker that may act on the output |
| Trigger | Event, approval decision, workflow state, or schedule that opens the handoff |
| Required Core refs | Object ids, event ids, evidence ids, packet ids, workflow ids, approval ids, and adapter receipt ids the consumer must receive or resolve |
| Input selector | Minimal `config.intake`, `config.sourceRefs`, or `config.packet` payload the consumer may accept |
| Acceptance checks | The consumer-side invariants that must pass before the next worker writes anything |
| External execution posture | Whether the handoff is read-only, dry-run, approval-required, or blocked |

## Handoff Matrix

| Handoff | Producer | Consumer | Trigger | Required Core refs | Input selector | Acceptance checks | External execution posture |
|---|---|---|---|---|---|---|---|
| `revenue.lead_to_owner_review` | Revenue Operations | Owner Chief-of-Staff | Revenue `run` creates an owner approval packet | `leadObjectId`, `quoteObjectId`, `approvalRequestId`, `evidencePacketId`, `workflowRunId`, `workerRunId` | `config.packet.approvalRequestId` plus `config.packet.workflowRunId` | Approval is pending, quote policy requires owner review, source snapshot exists, external send is false | read-only review |
| `revenue.quote_to_dispatch` | Revenue Operations | Dispatch/Ops | Owner approves a quote but external execution remains blocked | `customerObjectId`, `quoteObjectId`, `jobObjectId`, `approvalRequestId`, `adapterReceiptEvidenceId`, `workflowRunId` | `config.sourceRefs.quoteObjectId` plus `config.sourceRefs.jobObjectId` | Approval action is `approved`, quote has total/currency/policy, job is not already scheduled, adapter receipt says `externalSend=false` | schedule proposal only |
| `dispatch.closeout_to_finance` | Dispatch/Ops | Finance | Dispatch marks a job closeout packet review-ready | `jobObjectId`, `closeoutObjectId`, `customerObjectId`, `evidencePacketId`, `approvalRequestId` | `config.sourceRefs.closeoutObjectId` plus `config.sourceRefs.customerObjectId` | Closeout packet includes completion proof, customer update state, billable line summary, and no unresolved exception task | invoice/payment draft only |
| `finance.invoice_to_owner_review` | Finance | Owner Chief-of-Staff | Finance prepares invoice or AR action requiring approval | `invoiceObjectId`, `cashPacketId`, `approvalRequestId`, `workflowRunId`, `usageEventId` | `config.packet.approvalRequestId` plus `config.packet.cashPacketId` | Money movement is blocked, invoice math is deterministic, source receipt/evidence docs are attached | read-only review |
| `workforce.payroll_to_compliance` | Workforce | Compliance | Payroll preview packet is prepared or approved-blocked | `payrollRunId`, `payrollStatementIds`, `filingDraftId`, `paymentInstructionIds`, `approvalRequestId`, `evidencePacketId` | `config.sourceRefs.payrollRunId` plus `config.sourceRefs.filingDraftId` | Payroll state is preview/approved-blocked, tax draft has source trace, payment instructions have money movement blocked | filing draft review only |
| `compliance.obligation_to_owner_review` | Compliance | Owner Chief-of-Staff | Compliance creates notice, filing, license, or insurance packet | `obligationObjectId`, `filingDraftId`, `rulePackId`, `evidencePacketId`, `approvalRequestId` | `config.packet.approvalRequestId` plus `config.packet.obligationObjectId` | Rule source ref exists, due date exists, sensitive-data reveal is policy gated, submission is blocked | read-only review |
| `systems.sync_issue_to_worker` | Systems | Any worker | Systems detects sync failure, stale source, or permission mismatch | `connectionId`, `syncJobObjectId`, `dataQualityIssueObjectId`, `evidenceId`, `rollbackPlanDocumentId` | `config.sourceRefs.connectionId` plus `config.sourceRefs.dataQualityIssueObjectId` | Connection scope is tenant-bound, issue severity is set, repair plan is dry-run, rollback evidence exists | repair approval required |

## Fixture Requirements

Before a planned worker becomes executable, add at least one fixture for its
incoming handoff. Dispatch/Ops now has executable fixtures through
`/worker command=schedule.propose`, blocked
`/worker command=customer_update.draft`, blocked
`/worker command=closeout.prepare`, and blocked
`/worker command=exception.route`. Finance now consumes
`dispatch.closeout_to_finance` through `/worker command=invoice.prepare` and
produces a cash packet, invoice draft, accounting dry-run receipt, and
`finance.invoice_to_owner_review` approval handoff. Live calendar,
customer-send, accounting, payment, and bank credentials remain launch
blockers.

| Worker | Required first fixture |
|---|---|
| Owner Chief-of-Staff | `revenue.lead_to_owner_review` approval packet with Revenue source evidence |
| Dispatch/Ops | implemented: `revenue.quote_to_dispatch` approved quote with blocked adapter receipt produces a dry-run schedule proposal, blocked customer update draft, blocked closeout packet, and blocked exception route task |
| Finance | implemented: `dispatch.closeout_to_finance` closeout packet with billable line summary produces a dry-run invoice draft, cash packet, owner approval request, and blocked money-movement posture |
| Workforce | seeded employment or contractor packet with payroll preview blockers |
| Compliance | `workforce.payroll_to_compliance` payroll preview with filing draft |
| Systems | failing connection sync issue with dry-run repair and rollback plan |

## Consumer Rules

1. Consumers must resolve handoffs from Core records, not from worker-private
   output blobs alone.
2. Consumers must reject missing evidence, stale approval state, mismatched
   tenant ids, and any input that asks for external execution above its gate.
3. Handoff selectors must stay small: ids and source refs belong in `config`,
   while the full packet remains in Core evidence/documents/views.
4. Every cross-worker handoff must create or update an audit event naming both
   producer and consumer roles before external execution can be considered.
