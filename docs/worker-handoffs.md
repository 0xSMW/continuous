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
| `owner.staffing_need_to_workforce` | Owner Chief-of-Staff | Workforce | Owner decision or capacity review creates a staffing, hiring, credential, or payroll-input need | `positionObjectId`, optional `personObjectId`, optional `employmentObjectId`, `approvalRequestId`, `evidencePacketId`, `budgetReservationId` | `config.sourceRefs.positionObjectId` plus `config.sourceRefs.approvalRequestId` | Owner decision is approved or review-ready, budget posture is visible, restricted document handling is blocked until workforce packet review | workforce packet only |
| `workforce.payroll_to_compliance` | Workforce | Compliance | Payroll preview packet is prepared or approved-blocked | `payrollRunId`, `payrollStatementIds`, `filingDraftId`, `paymentInstructionIds`, `approvalRequestId`, `evidencePacketId` | `config.sourceRefs.payrollRunId` plus `config.sourceRefs.filingDraftId` | Payroll state is preview/approved-blocked, tax draft has source trace, payment instructions have money movement blocked | filing draft review only |
| `compliance.obligation_to_owner_review` | Compliance | Owner Chief-of-Staff | Compliance creates notice, filing, license, or insurance packet | `obligationObjectId`, `filingDraftId`, `rulePackId`, `evidencePacketId`, `approvalRequestId` | `config.packet.approvalRequestId` plus `config.packet.obligationObjectId` | Rule source ref exists, due date exists, sensitive-data reveal is policy gated, submission is blocked | read-only review |
| `core.connection_to_systems_review` | Core connection health | Systems | `connection.health.record`, scheduler, or auth audit detects stale, failing, overbroad, or missing connector state | `connectionId`, `adapterId`, `healthEventId`, `evidenceId`, optional `lastAuthSessionId` | `config.sourceRefs.connectionId` plus `config.sourceRefs.healthEventId` | Connection is tenant-scoped, provider and credential refs are non-secret, issue state and severity are explicit, external repair is blocked | systems repair plan only |
| `systems.sync_issue_to_worker` | Systems | Any worker | Systems detects sync failure, stale source, or permission mismatch | `connectionId`, `syncJobObjectId`, `dataQualityIssueObjectId`, `evidenceId`, `rollbackPlanDocumentId` | `config.sourceRefs.connectionId` plus `config.sourceRefs.dataQualityIssueObjectId` | Connection scope is tenant-bound, issue severity is set, repair plan is dry-run, rollback evidence exists | repair approval required |
| `revenue.quote_to_pricing` | Revenue Operations | Offer and Pricing | Revenue quote draft needs margin, discount, or change-order policy review | `quoteObjectId`, `leadObjectId`, `customerObjectId`, `evidencePacketId`, `approvalRequestId`, `workflowRunId` | `config.sourceRefs.quoteObjectId` plus `config.sourceRefs.evidencePacketId` | Quote has line items, service area, policy refs, and no approved external send | pricing review only |
| `customer.signal_to_experience` | Revenue Operations or Dispatch/Ops | Customer Experience | Feedback, complaint, testimonial, review, or promise record is ingested | `customerSignalObjectId`, `customerObjectId`, `eventId`, `evidenceId`, optional `jobObjectId` | `config.sourceRefs.customerSignalObjectId` plus `config.sourceRefs.customerObjectId` | Signal type, source, severity/topic, and customer ref are present; outbound recovery is blocked | customer recovery draft only |
| `customer.signal_to_growth` | Customer Experience, Revenue Operations, or Dispatch/Ops | Growth | Review, testimonial, referral opportunity, campaign idea, or customer signal is ready for campaign drafting | `customerSignalObjectId` or `customerSignalId`, `customerObjectId`, `reviewObjectId`, `evidencePacketId`, `budgetReservationId` | `config.sourceRefs.customerSignalObjectId` or `config.sourceRefs.customerSignalId` plus `config.sourceRefs.budgetReservationId` | Signal or review source exists, customer ref is tenant-scoped, source-backed claims exist or are explicitly missing, budget is reserved, and external publish is false | campaign draft only |
| `dispatch.asset_need_to_supply` | Dispatch/Ops | Asset and Supply | Closeout, exception, schedule, or work-order evidence names a material, asset, or vendor need | `jobObjectId`, `workOrderObjectId`, `assetObjectId`, `materialObjectId`, `evidencePacketId`, optional `cashPacketId` | `config.sourceRefs.assetObjectId` or `config.sourceRefs.materialObjectId` | Need is tied to a job/work order, purchase action is unapproved, and cash impact is visible or explicitly missing | purchase/maintenance draft only |
| `growth.campaign_to_owner_review` | Growth | Owner Chief-of-Staff | Campaign, content, channel, audience, or attribution packet is ready for publish review | `campaignObjectId`, `contentDraftObjectId`, `budgetReservationId`, `evidencePacketId`, `approvalRequestId` | `config.packet.approvalRequestId` plus `config.sourceRefs.campaignObjectId` | Claims have source refs, budget is reserved, audience/channel are explicit, and external publish is false | read-only review |
| `systems.connection_to_packaged_worker` | Systems | Vertical packaged workers | Connector health, permission review, or data-quality repair unblocks a packaged worker flow | `connectionId`, `permissionGrantId`, `dataQualityIssueObjectId`, `evidenceId`, `rollbackPlanDocumentId` | `config.sourceRefs.connectionId` plus `config.sourceRefs.permissionGrantId` | Tenant scope, least-privilege grant, freshness, and rollback evidence pass before the packaged worker reads the connection | read-only unlock |

## Consumer Map

Executable handoffs must define the producer event, object states, rejection
codes, and expected consumer output before a consuming worker writes records.

| Handoff | Producer event / state | Consumer command | Reject when | Expected consumer output |
|---|---|---|---|---|
| `revenue.quote_to_pricing` | `revenue.quote.prepared`, quote line items and policy refs present, external send `blocked` | `offer_pricing_operations.margin.review.prepare` | `handoff.quote_missing_lines`, `handoff.margin_policy_missing`, `handoff.discount_policy_missing`, `handoff.external_send_already_true`, `handoff.evidence_packet_missing` | Pricing review packet with margin verdict, discount approval request, quote-line policy refs, and generated `price_policy` view |
| `revenue.quote_to_dispatch` | `revenue.quote.prepared`, approval `approved`, quote/job objects not externally sent | `dispatch_operations.schedule.propose` | `handoff.approval_not_approved`, `handoff.quote_missing_policy`, `handoff.job_already_scheduled`, `handoff.external_send_already_true` | Appointment draft, conflict evidence, approval request, dry-run calendar receipt |
| `dispatch.closeout_to_finance` | `dispatch.closeout.prepared`, closeout `review_ready`, no unresolved critical exception task | `finance_operations.invoice.prepare` | `handoff.closeout_missing_proof`, `handoff.billable_lines_missing`, `handoff.exception_open`, `handoff.customer_ref_missing` | Invoice draft, cash packet, accounting dry-run receipt, owner approval request |
| `finance.invoice_to_owner_review` | `finance.invoice.prepared` or `finance.cash_forecast.generated`, money movement `blocked` | `owner_chief_of_staff.decision_queue.prepare` | `handoff.money_movement_not_blocked`, `handoff.cash_packet_missing`, `handoff.source_evidence_missing` | Owner decision proposal with cash/evidence refs and no external execution |
| `owner.staffing_need_to_workforce` | `owner.decision.proposed` or capacity review packet with staffing need and budget posture | `workforce_operations.hire.packet.prepare` or `workforce_operations.payroll_input.prepare` | `handoff.owner_decision_missing`, `handoff.position_missing`, `handoff.budget_posture_missing`, `handoff.restricted_docs_uncontrolled` | Workforce packet, restricted-document proof, approval request, and payroll blocker visibility |
| `workforce.payroll_to_compliance` | `workforce.payroll_input.prepared`, payroll preview `approved_blocked` or `preview` | `compliance_operations.filing.prepare` | `handoff.payroll_state_invalid`, `handoff.tax_trace_missing`, `handoff.payment_instruction_unblocked` | Filing draft review packet with tax trace, source refs, and blocked submission/legal-advice posture |
| `core.connection_to_systems_review` | `core.connection.health.recorded` or scheduler/audit finding with stale, failed, or overbroad connector state | `systems_operations.connector.health.scan` or `systems_operations.sync.repair.plan` | `handoff.connection_missing`, `handoff.credential_ref_secret`, `handoff.issue_state_missing`, `handoff.external_repair_requested` | Systems health view, dry-run repair plan, rollback document, and blocked permission/automation tasks |
| `customer.signal_to_experience` | `customer.signal.recorded`, signal `open`, customer and evidence refs present | `customer_experience_operations.recovery.draft` | `handoff.customer_signal_missing`, `handoff.customer_ref_missing`, `handoff.signal_source_missing`, `handoff.external_send_requested` | Recovery draft packet, escalation task, owner approval request, generated `signals` view, and no-send proof |
| `dispatch.asset_need_to_supply` | `dispatch.closeout.prepared` or `dispatch.exception.routed`, material/asset need present | `asset_supply_operations.reorder.plan` | `handoff.work_order_missing`, `handoff.asset_or_material_missing`, `handoff.cash_posture_missing`, `handoff.purchase_already_allowed` | Reorder or maintenance packet, vendor/cash impact review, approval request, rollback plan, and no-purchase proof |
| `customer.signal_to_growth` | `customer.signal.recorded`, review/testimonial/referral opportunity present, budget reservation available | `growth_operations.campaign.draft` | `handoff.customer_signal_missing`, `handoff.budget_reservation_missing`, `handoff.claim_source_missing`, `handoff.external_publish_requested` | Campaign draft packet with source-backed claims, audience/channel plan, owner approval request, generated `campaigns` view, and no-publish proof |
| `systems.sync_issue_to_worker` | `systems.sync.repair.planned`, repair action `dry_run`, rollback document present | Consuming worker command named in source refs | `handoff.connection_scope_mismatch`, `handoff.repair_not_dry_run`, `handoff.rollback_missing`, `handoff.issue_severity_missing` | Consumer task or blocked action plan referencing the repair evidence |
| `systems.connection_to_packaged_worker` | `systems.connector.health.scanned`, connection active/fresh, least-privilege grant present | `vertical_packages.package.flow.prepare` | `handoff.connection_stale`, `handoff.permission_grant_missing`, `handoff.grant_overbroad`, `handoff.rollback_missing` | Package readiness packet, family flow plan, generated `package_readiness` view, and no-execution proof |

## Fixture Requirements

Before a planned worker becomes executable, add at least one fixture for its
incoming handoff. Dispatch/Ops now has executable fixtures through `POST /worker`
payloads with `command: "schedule.propose"`, blocked
`command: "customer_update.draft"`, blocked `command: "closeout.prepare"`, and
blocked `command: "exception.route"`. Finance now consumes
`dispatch.closeout_to_finance` through `command: "invoice.prepare"`, consumes
persisted invoice evidence through `command: "ar_followup.draft"`,
and consumes forecast window/account refs through
`command: "cash_forecast.generate"`, and prepares blocked payment drafts through
`command: "payment_draft.prepare"` from bill/payment selectors.
It produces cash packets, invoice or AR drafts, cash forecasts, payment
instruction drafts, dual-control approval requests, generated review views, and
`finance.invoice_to_owner_review` approval handoffs while customer sends,
payment links, external execution, and money movement remain blocked. Live
calendar, customer-send, accounting, payment, and bank credentials remain
launch blockers. Systems now has a first runtime fixture shape on the generic
`/worker` envelope: connection and sync issues produce dry-run repair evidence,
rollback packets, permission review proof, and blocked external execution for
the consuming worker to verify before it trusts recovered data.
Compliance now has a first runtime fixture shape on the same generic `/worker`
envelope: `filing.prepare` consumes source refs from `config`, prepares filing
draft packets and approval views, and blocks agency submission and legal advice.
Live agency credentials, broader rule-source coverage, and receipt capture
remain launch blockers.
Growth now has a first runtime fixture shape on the same generic `/worker`
envelope: `campaign.draft` consumes `customer.signal_to_growth` refs and policy
from `config`, prepares a source-backed campaign draft packet and `campaigns`
view, and blocks publish, send, spend, and tracking mutation.
Offer and Pricing now has a first runtime fixture shape on the same generic
`/worker` envelope: `margin.review.prepare` consumes
`revenue.quote_to_pricing` refs and policy from `config`, prepares a margin and
discount review packet plus the `price_policy` view, and blocks price publish,
quote mutation, and customer send. Customer Experience now has a first runtime
fixture shape on the same generic `/worker` envelope: `recovery.draft` consumes
`customer.signal_to_experience` refs and policy from `config`, prepares a
recovery packet plus the `signals` view, and blocks customer sends, refunds,
concessions, and promise mutation.

| Worker | Required first fixture |
|---|---|
| Owner Chief-of-Staff | `revenue.lead_to_owner_review` approval packet with Revenue source evidence |
| Dispatch/Ops | implemented: `revenue.quote_to_dispatch` approved quote with blocked adapter receipt produces a dry-run schedule proposal, blocked customer update draft, blocked closeout packet, and blocked exception route task |
| Finance | implemented: `dispatch.closeout_to_finance` closeout packet with billable line summary produces a dry-run invoice draft; persisted invoice refs produce a blocked AR follow-up draft; and forecast window/account refs produce a blocked cash forecast, cash packet, owner approval request, and blocked money-movement posture |
| Workforce | implemented: `owner.staffing_need_to_workforce` and direct workforce refs can feed `hire.packet.prepare` for workforce packets with restricted-document proof and payroll blockers; `payroll_input.prepare` produces a dry-run payroll-input packet and readiness view while payroll submission and money movement stay blocked |
| Compliance | implemented: `workforce.payroll_to_compliance` payroll preview feeds `filing.prepare` through `config.sourceRefs`, producing a filing draft packet, approval view, and blocked submission/legal-advice posture |
| Systems | implemented: `core.connection_to_systems_review` can feed connection health scan and repair planning; failing connection sync issues produce dry-run repair plans, rollback packets, permission review evidence, and blocked external execution |
| Offer and Pricing | implemented: `revenue.quote_to_pricing` quote draft with margin, discount, or change-order policy evidence feeds `margin.review.prepare`; Offer and Pricing then emits pricing review objects, packet/document/evidence, owner approval, generated `price_policy` view, budget/audit proof, and idempotent replay while price publish, quote mutation, and customer sends stay blocked |
| Customer Experience | implemented: `customer.signal_to_experience` customer signal with source evidence feeds `recovery.draft`; Customer Experience then emits a recovery draft packet, escalation task, owner approval request, generated `signals` view, workflow/budget/audit proof, and no-send posture while customer sends, review responses, refunds, and concessions stay blocked |
| Asset and Supply | `dispatch.asset_need_to_supply` material, asset, or vendor need tied to a work order and cash posture |
| Growth | implemented: `customer.signal_to_growth` customer signal, review, or testimonial with source-backed claims and budget evidence feeds `campaign.draft`; Growth then emits `growth.campaign_to_owner_review` for owner publish review while publish/send/spend/tracking mutation stays blocked |
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
