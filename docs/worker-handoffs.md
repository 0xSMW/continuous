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
| `finance.invoice_to_owner_review` | Finance | Owner Chief-of-Staff | Finance prepares invoice, AR, or cash forecast action requiring approval | `invoiceObjectId`, optional `arFollowupObjectId`, optional `cashForecastObjectId`, `cashPacketId`, `approvalRequestId`, `workflowRunId`, `usageEventId` | `config.packet.approvalRequestId` plus `config.packet.cashPacketId` | Money movement is blocked, invoice math, AR draft, or forecast source is deterministic, source receipt/evidence docs are attached | read-only review |
| `workforce.payroll_to_compliance` | Workforce | Compliance | Payroll preview packet is prepared or approved-blocked | `payrollRunId`, `payrollStatementIds`, `filingDraftId`, `paymentInstructionIds`, `approvalRequestId`, `evidencePacketId` | `config.sourceRefs.payrollRunId` plus `config.sourceRefs.filingDraftId` | Payroll state is preview/approved-blocked, tax draft has source trace, payment instructions have money movement blocked | filing draft review only |
| `compliance.obligation_to_owner_review` | Compliance | Owner Chief-of-Staff | Compliance creates notice, filing, license, or insurance packet | `obligationObjectId`, `filingDraftId`, `rulePackId`, `evidencePacketId`, `approvalRequestId` | `config.packet.approvalRequestId` plus `config.packet.obligationObjectId` | Rule source ref exists, due date exists, sensitive-data reveal is policy gated, submission is blocked | read-only review |
| `systems.sync_issue_to_worker` | Systems | Any worker | Systems detects sync failure, stale source, or permission mismatch | `connectionId`, `syncJobObjectId`, `dataQualityIssueObjectId`, `evidenceId`, `rollbackPlanDocumentId` | `config.sourceRefs.connectionId` plus `config.sourceRefs.dataQualityIssueObjectId` | Connection scope is tenant-bound, issue severity is set, repair plan is dry-run, rollback evidence exists | repair approval required |
| `revenue.quote_to_pricing` | Revenue Operations | Offer and Pricing | Revenue quote draft needs margin, discount, or change-order policy review | `quoteObjectId`, `leadObjectId`, `customerObjectId`, `evidencePacketId`, `approvalRequestId`, `workflowRunId` | `config.sourceRefs.quoteObjectId` plus `config.sourceRefs.evidencePacketId` | Quote has line items, service area, policy refs, and no approved external send | pricing review only |
| `customer.signal_to_experience` | Revenue Operations or Dispatch/Ops | Customer Experience | Feedback, complaint, testimonial, review, or promise record is ingested | `customerSignalObjectId`, `customerObjectId`, `eventId`, `evidenceId`, optional `jobObjectId` | `config.sourceRefs.customerSignalObjectId` plus `config.sourceRefs.customerObjectId` | Signal type, source, severity/topic, and customer ref are present; outbound recovery is blocked | customer recovery draft only |
| `dispatch.asset_need_to_supply` | Dispatch/Ops | Asset and Supply | Closeout, exception, schedule, or work-order evidence names a material, asset, or vendor need | `jobObjectId`, `workOrderObjectId`, `assetObjectId`, `materialObjectId`, `evidencePacketId`, optional `cashPacketId` | `config.sourceRefs.assetObjectId` or `config.sourceRefs.materialObjectId` | Need is tied to a job/work order, purchase action is unapproved, and cash impact is visible or explicitly missing | purchase/maintenance draft only |
| `growth.campaign_to_owner_review` | Growth | Owner Chief-of-Staff | Campaign, content, channel, audience, or attribution packet is ready for publish review | `campaignObjectId`, `contentDraftObjectId`, `budgetReservationId`, `evidencePacketId`, `approvalRequestId` | `config.packet.approvalRequestId` plus `config.sourceRefs.campaignObjectId` | Claims have source refs, budget is reserved, audience/channel are explicit, and external publish is false | read-only review |
| `systems.connection_to_packaged_worker` | Systems | Vertical packaged workers | Connector health, permission review, or data-quality repair unblocks a packaged worker flow | `connectionId`, `permissionGrantId`, `dataQualityIssueObjectId`, `evidenceId`, `rollbackPlanDocumentId` | `config.sourceRefs.connectionId` plus `config.sourceRefs.permissionGrantId` | Tenant scope, least-privilege grant, freshness, and rollback evidence pass before the packaged worker reads the connection | read-only unlock |

## Fixture Requirements

Before a planned worker becomes executable, add at least one fixture for its
incoming handoff. Dispatch/Ops now has executable fixtures through
`/worker command=schedule.propose`, blocked
`/worker command=customer_update.draft`, blocked
`/worker command=closeout.prepare`, and blocked
`/worker command=exception.route`. Finance now consumes
`dispatch.closeout_to_finance` through `/worker command=invoice.prepare`,
consumes persisted invoice evidence through `/worker command=ar_followup.draft`,
and consumes forecast window/account refs through
`/worker command=cash_forecast.generate`, and prepares blocked payment drafts
through `/worker command=payment_draft.prepare` from bill/payment selectors.
It produces cash packets, invoice or AR drafts, cash forecasts, payment
instruction drafts, dual-control approval requests, generated review views, and
`finance.invoice_to_owner_review` approval handoffs while customer sends,
payment links, external execution, and money movement remain blocked. Live
calendar, customer-send, accounting, payment, and bank credentials remain
launch blockers.

| Worker | Required first fixture |
|---|---|
| Owner Chief-of-Staff | `revenue.lead_to_owner_review` approval packet with Revenue source evidence |
| Dispatch/Ops | implemented: `revenue.quote_to_dispatch` approved quote with blocked adapter receipt produces a dry-run schedule proposal, blocked customer update draft, blocked closeout packet, and blocked exception route task |
| Finance | implemented: `dispatch.closeout_to_finance` closeout packet with billable line summary produces a dry-run invoice draft; persisted invoice refs produce a blocked AR follow-up draft; and forecast window/account refs produce a blocked cash forecast, cash packet, owner approval request, and blocked money-movement posture |
| Workforce | implemented: `hire.packet.prepare` produces a workforce packet with restricted-document proof and payroll blockers; `payroll_input.prepare` produces a dry-run payroll-input packet and readiness view while payroll submission and money movement stay blocked |
| Compliance | `workforce.payroll_to_compliance` payroll preview with filing draft |
| Systems | failing connection sync issue with dry-run repair and rollback plan |
| Offer and Pricing | `revenue.quote_to_pricing` quote draft with margin, discount, or change-order policy evidence |
| Customer Experience | `customer.signal_to_experience` customer signal with source evidence and blocked recovery draft |
| Asset and Supply | `dispatch.asset_need_to_supply` material, asset, or vendor need tied to a work order and cash posture |
| Growth | `growth.campaign_to_owner_review` content or campaign draft with source-backed claims and budget evidence |
| Vertical packaged workers | `systems.connection_to_packaged_worker` scoped connector unlock with permission, freshness, and rollback evidence |

## Consumer Rules

1. Consumers must resolve handoffs from Core records, not from worker-private
   output blobs alone.
2. Consumers must reject missing evidence, stale approval state, mismatched
   tenant ids, and any input that asks for external execution above its gate.
3. Handoff selectors must stay small: ids and source refs belong in `config`,
   while the full packet remains in Core evidence/documents/views.
4. Every cross-worker handoff must create or update an audit event naming both
   producer and consumer roles before external execution can be considered.
