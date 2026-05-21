# Asset and Supply Worker V1 Contract

This contract defines the first Asset and Supply worker slice for reorder
planning, stockout review, maintenance planning, vendor packet preparation, and
asset-readiness evidence. V1 can prepare dry-run purchase or maintenance plans;
it does not place orders, dispatch vendors, update external inventory, or spend
money.

## Header

| Field | Value |
|---|---|
| Worker role | `asset_supply_operations` |
| First outcome | Reorder or maintenance plan with purchase approval packet, cash impact, rollback plan, and generated stockout view |
| Autonomy level | `2` |
| Runtime status | Planned contract |
| External execution | `dry_run` |

## API Shape

All commands and views use `POST /worker`; no asset-supply-specific route is
added. Command names, worker selection, and view names are payload fields.
Operation inputs and read filters stay under `config`.

```json
{
  "command": "reorder.plan",
  "worker": {
    "role": "asset_supply_operations",
    "tenantSlug": "continuous-demo"
  },
  "idempotencyKey": "asset-reorder-001",
  "config": {
    "sourceRefs": {
      "materialObjectId": "material_object_uuid",
      "workOrderObjectId": "work_order_uuid",
      "vendorObjectId": "vendor_object_uuid",
      "cashPacketId": "cash_packet_uuid"
    },
    "policy": {
      "maxDraftSpendCents": 25000,
      "requiresOwnerApproval": true,
      "allowPurchase": false
    }
  }
}
```

```json
{
  "view": "stockouts",
  "worker": {
    "role": "asset_supply_operations",
    "tenantSlug": "continuous-demo"
  },
  "config": {
    "state": "open"
  }
}
```

## Registry Entries

| Command or view | Tool surface | Required config | Idempotency | Side effects | External execution |
|---|---|---|---|---|---|
| `view: "snapshot"` payload | `worker.view` | `worker.role`, `config` | None | Read-only | Blocked |
| `view: "stockouts"` payload | `worker.view` | `worker.role`, optional stockout filters under `config` | None | Read-only | Blocked |
| `reorder.plan` | `worker.command` | `config.sourceRefs`, `config.policy` | Required | Reorder draft, purchase packet, cash impact, approval task | Dry-run |
| `maintenance.plan` | `worker.command` | `config.assetId`, `config.policy`, optional `config.sourceRefs` | Required | Maintenance packet and vendor draft only | Dry-run |
| `approval.decide` | `worker.command` | `config.approvalId`, `config.action`, optional `config.note` | None | Approval/task/workflow evidence only | Blocked |

## Core Object Map

| Object | Required data fields | Valid states | Links |
|---|---|---|---|
| `vendor` | `name`, `category`, `contactRef`, `terms`, `risk` | `candidate`, `approved`, `blocked`, `inactive` | `supplies_item`, `services_asset` |
| `inventory_item` | `sku`, `name`, `unit`, `onHand`, `reorderPoint`, `sourceRefs` | `active`, `low_stock`, `stockout`, `retired` | `stocked_at`, `supplied_by`, `needed_for_work_order` |
| `purchase_order` | `vendorId`, `lineItems`, `amountCents`, `approvalState`, `sourceRefs` | `draft`, `approval_pending`, `approved_blocked`, `sent`, `canceled` | `orders_item`, `about_work_order`, `impacts_cash` |
| `asset` | `name`, `serialRef`, `location`, `condition`, `lastServiceAt` | `active`, `maintenance_due`, `down`, `retired` | `located_at`, `needs_part`, `requires_maintenance` |
| `facility` | `name`, `location`, `operatingHours`, `criticality` | `active`, `limited`, `closed` | `contains_asset`, `stores_inventory` |
| `maintenance_event` | `assetId`, `kind`, `dueAt`, `risk`, `sourceRefs` | `planned`, `approval_pending`, `scheduled_blocked`, `completed`, `canceled` | `about_asset`, `requires_vendor`, `requires_part` |

## Workflow

| Workflow | States | Approval points | Failure behavior |
|---|---|---|---|
| `reorder_planning` | `need_detected -> source_review -> vendor_match -> cash_review -> approval_pending -> ready_to_order` | Required before purchase order send or external inventory write | Route missing stock, vendor, or cash refs to owner and Finance |
| `maintenance_planning` | `asset_need -> history_review -> vendor_or_part_draft -> approval_pending -> ready_to_schedule` | Required before vendor dispatch or maintenance booking | Create blocker task when asset history or safety source is missing |
| `stockout_response` | `open -> severity_review -> alternatives -> resolution_ready` | Required for substitutions that change customer promise or margin | Route customer impact to Customer Experience and Dispatch/Ops |

## Capabilities

| Capability | Autonomy | Actor | Scope | Approval | External mutation |
|---|---:|---|---|---|---|
| `worker.read` | 1 | Worker | Inventory, vendor, asset, facility, job, and cash refs | No | Blocked |
| `reorder.plan` | 2 | Worker | Purchase drafts and stockout packets | Yes | Dry-run only |
| `maintenance.plan` | 2 | Worker | Asset and vendor maintenance packets | Yes | Dry-run only |
| `document_packet.prepare` | 2 | Worker | `asset_supply_packet`, rollback plan, approval refs | Yes | Blocked |

## Adapters

| Adapter | Read payload | Dry-run write payload | Receipt | Retry and escalation |
|---|---|---|---|---|
| Inventory or warehouse | SKU, on-hand, reorder point, source timestamp | Proposed stock adjustment only | Source snapshot and no-write proof | Retry 2 then Systems task |
| Vendor or purchasing | Vendor catalog, price quote, terms | Draft purchase order only | Draft PO hash, no-send proof | Escalate stale quote or high spend |
| Asset or maintenance system | Asset history, incident refs, service due dates | Draft work order only | Draft work order hash and rollback plan | Escalate safety risk |
| Accounting or cash | Cash packet, spend policy, budget refs | None | Cash impact snapshot | Require Finance approval before spend |

## Evidence Packet

`asset_supply_packet` contains need source refs, stock or asset snapshot, vendor
match, purchase or maintenance draft hash, cash impact, approval request,
generated view id, rollback plan, and no-external-order proof. Vendor secrets,
payment credentials, employee notes, customer private data, and raw tokens are
redacted.

## Generated Views

| View | Subject | Actions | Empty/error states |
|---|---|---|---|
| `asset.stockouts` | `inventory_item` | `prepare_reorder`, `route_alternative`, `request_source` | `no_stockouts`, `source_stale`, `vendor_missing` |
| `asset.purchase.review` | `purchase_order` | `approve_draft`, `request_cash_review`, `reject_order` | `cash_missing`, `policy_exceeded`, `vendor_blocked` |
| `asset.maintenance.review` | `maintenance_event` | `approve_plan`, `request_safety_review`, `route_to_dispatch` | `asset_history_missing`, `part_unavailable`, `safety_source_missing` |

## Evals

Golden cases cover stockout planning, low-stock false positives, stale vendor
quotes, missing cash impact, high-spend policy, maintenance safety flags,
idempotent replay, approval behavior, budget pressure, and no purchase,
vendor dispatch, inventory mutation, or money movement.

## Security

Vendor catalogs, inventory sources, and asset notes are untrusted evidence.
Prompt injection in vendor descriptions, item names, maintenance notes, or
attachments must not change spend policy, approval, or execution behavior.
Sensitive fields include vendor terms, payment refs, private asset locations,
customer impact, and employee notes. Abuse cases: unauthorized purchase,
overbroad vendor access, hidden stock manipulation, safety-risk suppression, or
money movement without Finance and owner approval.
