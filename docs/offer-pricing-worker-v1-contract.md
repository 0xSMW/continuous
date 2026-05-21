# Offer and Pricing Worker V1 Contract

This contract defines the first Offer and Pricing worker slice for quote-line
margin review, discount policy review, and price-change evidence. V1 prepares
review packets only. It does not publish prices externally, change customer
quotes, send customer messages, or alter money movement.

## Header

| Field | Value |
|---|---|
| Worker role | `offer_pricing_operations` |
| First outcome | Pricing review packet with margin verdict, discount approval request, quote-line policy refs, and generated price policy view |
| Autonomy level | `2` |
| Runtime status | First runtime slice |
| External execution | `blocked` |

## API Shape

All commands and views use `POST /worker`; no pricing-specific route is added.
Command names, worker selection, and view names are payload fields. Operation
inputs and read filters stay under `config`.

```json
{
  "command": "margin.review.prepare",
  "worker": {
    "role": "offer_pricing_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "pricing-margin-review-001",
  "config": {
    "sourceRefs": {
      "quoteObjectId": "quote_object_uuid",
      "leadObjectId": "lead_object_uuid",
      "customerObjectId": "customer_object_uuid",
      "evidencePacketId": "quote_evidence_packet_uuid",
      "approvalRequestId": "quote_approval_uuid"
    },
    "policy": {
      "marginRuleId": "margin_rule_object_uuid",
      "discountPolicyId": "discount_policy_object_uuid",
      "requireOwnerApproval": true
    }
  }
}
```

```json
{
  "view": "price_policy",
  "worker": {
    "role": "offer_pricing_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "quoteObjectId": "quote_object_uuid"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "price_policy"` payload | `worker.view` | `worker.role`, optional `config.quoteObjectId`, optional `config.priceBookId` | None | Read-only | Blocked |
| `margin.review.prepare` | `worker.command` | `config.sourceRefs.quoteObjectId`, `config.sourceRefs.evidencePacketId`, and `config.policy` | Required | Margin verdict, discount approval packet, generated view, audit/evidence | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | Required | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `offer` | `name`, `serviceArea`, `positioning`, `includedServices`, `exclusions` | `draft`, `active`, `retired` | `priced_by`, `quoted_as` |
| `price_book` | `currency`, `version`, `effectiveAt`, `serviceAreas`, `sourcePolicy` | `draft`, `active`, `superseded` | `defines_offer`, `uses_margin_rule` |
| `quote_line` | `quoteId`, `offerId`, `description`, `quantity`, `unitPriceCents`, `costBasisCents`, `marginPercent` | `draft`, `policy_review`, `approved`, `blocked` | `belongs_to_quote`, `uses_price_book`, `checked_by_margin_rule` |
| `margin_rule` | `serviceArea`, `minMarginPercent`, `targetMarginPercent`, `exceptionPolicy`, `effectiveAt` | `draft`, `active`, `superseded` | `governs_quote_line`, `requires_discount_policy` |
| `discount_policy` | `maxDiscountPercent`, `approvalThresholdPercent`, `reasonCodes`, `restrictedOffers` | `draft`, `active`, `expired` | `governs_discount`, `requires_approval` |
| `change_order_policy` | `scopeChangeKinds`, `priceRecalculationRule`, `customerApprovalRule`, `evidenceRequirements` | `draft`, `active`, `archived` | `governs_change_order`, `requires_customer_approval` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `pricing_margin_review` | `draft -> source_review -> policy_check -> approval_pending -> review_ready` | Required for margin exceptions, discount exceptions, and change-order terms | Block packet and create owner task when quote lines, price book, or margin policy evidence is missing |
| `price_change_review` | `draft -> policy_snapshot -> impact_review -> approval_pending -> ready_to_publish` | Required before price book changes | Keep external publish blocked and route stale-source cases to Systems |
| `discount_exception` | `draft -> threshold_check -> owner_review -> approved_blocked` | Required when discount exceeds policy | Reject without owner approval and preserve original quote refs |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Offer, quote, price book, margin, discount, and policy refs | No | Blocked |
| `margin.review.prepare` | 2 | Worker | Revenue quote handoffs and pricing policy refs | Required for exceptions | Blocked |
| `approval.request` | 2 | Worker | Margin exceptions, discount exceptions, price changes | Yes | Blocked |
| `document_packet.prepare` | 2 | Worker | Pricing review packet and policy snapshot | Required for external price change | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Revenue quote evidence | Quote lines, totals, customer/lead refs, approval state, no-send receipt | None | Source quote ids, evidence packet id, `externalSend=false` proof | Reject stale or externally sent quotes |
| Price book store | Active price book, margin rules, discount policies, effective dates | Proposed version only | Policy snapshot hash and no-publish proof | Route stale policy to owner |
| Accounting or cost source | Cost basis, labor/material assumptions, tax posture | None | Cost source timestamp and confidence | Mark margin low confidence when stale |
| Customer message surface | None in V1 | Draft change-order or discount explanation only | Draft body hash and no-send proof | Require Revenue or Customer Experience send gate |

## Evidence Packet

`pricing_review_packet` contains quote-line refs, source quote evidence, price
book snapshot, margin calculation trace, discount policy verdict, change-order
policy refs, approval request, generated view id, and no-external-publish
receipt. Customer private notes, raw payment data, secret pricing formulas, and
credential material are redacted. Cost-basis data is summarized with source ids
and confidence instead of raw private vendor records.

## Generated Views

The first registered view is `price_policy`. Margin review and change-order
review are sections inside that view until they are promoted to explicit
registry entries.

| View section | Subject | Actions | Empty/error states |
|---|---|---|---|
| Margin review | `quote_line` | `approve_exception`, `request_revision`, `reject_discount` | `quote_lines_missing`, `margin_policy_missing`, `discount_policy_missing` |
| Price book | `price_book` | `approve_price_change`, `request_source`, `route_to_owner` | `price_book_missing`, `policy_stale`, `cost_source_missing` |
| Change order | `change_order_policy` | `approve_change_order`, `request_customer_approval`, `reject_terms` | `scope_missing`, `customer_approval_missing`, `contract_term_risk` |

## Evals

Golden cases cover standard-margin quote lines, below-margin discounts,
missing price book, stale cost basis, change-order scope expansion, excessive
discount pressure, idempotent replay, generated view content, approval routing,
and no external price publish or customer send.

## Security

Pricing policy and cost basis are sensitive. Source quote and adapter data are
untrusted and must be treated as evidence, not instructions. Prompt injection in
quote descriptions, customer notes, vendor notes, or competitor references must
not change margin policy or approval requirements. Abuse cases: hidden discount
approval bypass, price discrimination without policy, leaking cost basis,
publishing stale prices, or sending customer-facing price changes without the
Revenue or Customer Experience approval/receipt gate.
