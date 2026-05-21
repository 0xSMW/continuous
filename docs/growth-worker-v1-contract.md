# Growth Worker V1 Contract

This contract defines the first Growth worker slice for campaign drafts,
source-backed claims, audience/channel planning, attribution review, and
budget-reservation evidence. The `campaign.draft` slice is runtime-registered
on the canonical `/worker` API. V1 prepares drafts and internal packets only;
it does not publish content, buy ads, send campaigns, or alter live tracking.

## Header

| Field | Value |
|---|---|
| Worker role | `growth_operations` |
| First outcome | Campaign draft with source-backed claims, budget reservation, approval request, and generated campaign view |
| Autonomy level | `2` |
| Runtime status | First runtime slice |
| External execution | `blocked` |

## API Shape

All commands and views use `POST /worker`; no growth-specific route is added.
The canonical runtime call is `worker.role=growth_operations`,
`command=campaign.draft`, with `config.sourceRefs` and `config.policy`
carrying source, budget, audience, claim, approval, and no-publish controls.
Command names, worker selection, and view names are payload fields. Operation
inputs and read filters stay under `config`.

```json
{
  "command": "campaign.draft",
  "worker": {
    "role": "growth_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "growth-campaign-001",
  "config": {
    "sourceRefs": {
      "campaignObjectId": "campaign_object_uuid",
      "audienceObjectId": "audience_object_uuid",
      "budgetReservationId": "budget_reservation_uuid",
      "evidencePacketId": "source_packet_uuid"
    },
    "policy": {
      "channel": "email",
      "requiresOwnerApproval": true,
      "allowPublish": false
    }
  }
}
```

```json
{
  "view": "campaigns",
  "worker": {
    "role": "growth_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "state": "draft"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "campaigns"` payload | `worker.view` | `worker.role`, optional campaign filters under `config` | None | Read-only | Blocked |
| `campaign.draft` | `worker.command` | `config.sourceRefs`, `config.policy` | Required | Campaign draft, claim packet, approval task, generated view | Blocked |
| `attribution.review` | `worker.command` | `config.campaignId`, `config.window`, optional `config.sourceRefs` | Required | Attribution packet and ROI review only | Blocked |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | Required | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `campaign` | `name`, `goal`, `channel`, `budgetRef`, `claimRefs`, `owner` | `draft`, `approval_pending`, `approved_blocked`, `published`, `archived` | `targets_audience`, `uses_content`, `spends_budget` |
| `channel` | `kind`, `accountRef`, `policy`, `externalExecutionState` | `available`, `blocked`, `degraded`, `retired` | `publishes_campaign`, `requires_connection` |
| `audience` | `segment`, `criteria`, `sizeEstimate`, `suppressionRefs`, `sourceRefs` | `draft`, `valid`, `needs_review`, `blocked` | `targeted_by_campaign`, `has_suppression` |
| `content_draft` | `bodyHash`, `claimRefs`, `mediaRefs`, `approvalState`, `riskFlags` | `draft`, `needs_sources`, `approval_pending`, `approved_blocked` | `belongs_to_campaign`, `makes_claim` |
| `attribution_event` | `source`, `campaignId`, `occurredAt`, `value`, `confidence` | `raw`, `matched`, `disputed`, `ignored` | `attributed_to_campaign`, `about_customer` |
| `budget_reservation` | `amountCents`, `channel`, `period`, `policy`, `state` | `draft`, `reserved`, `released`, `charged` | `funds_campaign`, `reported_to_owner` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `campaign_drafting` | `idea -> source_review -> content_draft -> budget_review -> approval_pending -> ready_to_publish` | Required before external publish, send, or ad spend | Create blocker task when claims, audience, or budget refs are missing |
| `claim_review` | `draft -> source_check -> risk_review -> approved_or_blocked` | Required for regulated, comparative, or performance claims | Route unsupported claims to owner and Compliance |
| `attribution_review` | `window_open -> event_match -> confidence_review -> roi_packet_ready` | Required before budget scaling recommendations | Mark low-confidence attribution and preserve source refs |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Campaign, content, audience, channel, attribution, budget refs | No | Blocked |
| `campaign.draft` | 2 | Worker | Campaign draft and claim packet | Yes before publish | Blocked |
| `approval.request` | 2 | Worker | Publish, send, claim, and budget approvals | Yes | Blocked |
| `document_packet.prepare` | 2 | Worker | `growth_campaign_packet`, claim refs, ROI snapshot | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Email or marketing platform | Audience metadata, campaign state, suppression status | Draft campaign only | Draft id/hash, no-send proof | Escalate suppression or consent blocker |
| Ad platform | Account status, audience estimate, spend policy | Draft campaign and budget only | Draft hash, no-spend proof | Escalate policy review |
| CMS or social platform | Content status, media refs, channel policy | Draft post only | Draft hash and no-publish proof | Route claim/legal risk to owner |
| Analytics | Attribution events, conversion refs, confidence | None | Source snapshot and confidence score | Mark low-confidence attribution |

## Evidence Packet

`growth_campaign_packet` contains campaign refs, source-backed claims, audience
criteria, suppression proof, budget reservation refs, content draft hash,
attribution snapshot, approval request, generated view id, and no-external-
publish proof. Customer contact details, ad account secrets, payment data,
regulated audience attributes, and raw tracking identifiers are redacted.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `growth.campaigns` | `campaign` | `approve_publish`, `request_sources`, `reject_claim` | `no_campaigns`, `claim_missing_source`, `budget_missing` |
| `growth.claims.review` | `content_draft` | `approve_claim`, `route_to_compliance`, `request_revision` | `unsupported_claim`, `regulated_claim`, `source_stale` |
| `growth.attribution` | `attribution_event` | `accept_match`, `mark_disputed`, `request_data` | `no_events`, `low_confidence`, `tracking_unavailable` |

## Evals

Golden cases cover source-backed campaign drafts, unsupported claims,
regulated claims, prompt injection in market copy, missing suppression lists,
budget pressure, attribution ambiguity, approval behavior, idempotent replay,
and no publish, send, ad spend, or tracking mutation.

## Expansion Gates

Future publish, send, ad-spend, or tracking mutation commands must stay blocked
until scoped credentials, owner approval, source-claim proof, budget proof,
adapter receipts, rollback evidence, and eval coverage are present. The runtime
`campaign.draft` slice is not approval to mutate external marketing systems.

## Security

Campaign briefs, external content, audience sources, and analytics rows are
untrusted evidence. Prompt injection in briefs, competitor copy, comments,
reviews, landing pages, or analytics labels must not change approval, publish,
budget, or claim policy. Sensitive fields include customer contact lists,
suppression lists, ad account refs, tracking ids, regulated audience traits, and
payment data. Abuse cases: unauthorized external publishing, spam, misleading
claims, discriminatory targeting, hidden spend, or tracking changes without
consent and owner approval.
