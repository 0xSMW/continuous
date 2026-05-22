# Worker Readiness Matrix

This matrix turns the worker roadmap into reusable launch gates. The criteria are
generic on purpose: a domain worker, vertical package, or packaged family flow must
prove the same Core lifecycle before it can move from a configured worker to
real-world execution.

Runtime requests use the generic `/worker` envelope. Worker-specific behavior
belongs in registry metadata and the request payload, not in package-specific
routes. A packaged worker may add commands, views, policies, fixtures, and
adapters, but it does not bypass lifecycle, capabilities, evidence, budget,
approval, telemetry, or launch gates.

## Generic Request Payload

| Field | Readiness expectation |
|---|---|
| `command` or `view` | Registered operation name such as `lead.read`, `payment_link.prepare`, `continue`, `readiness`, or a package catalog command |
| `worker` | Role, optional worker id, and tenant/business scope; package workers use role plus package config instead of package-specific routes |
| `idempotencyKey` | Required for mutations and replays; command identity stays in the body, not headers or URLs |
| `config` | Operation input, source refs, connection refs, cursor refs, package key/version, policy refs, capability grant refs, budget account, approval policy, adapter mode, rollout flags, dry-run setting, and execution config |
| Output refs | Source refs, generated artifact refs, adapter intents and receipts, approval refs, budget events, telemetry ids, rollback refs, and reconciliation refs are persisted as Core records and returned as refs instead of becoming URL shape |

## Status Taxonomy

| Status | Meaning | Promotion rule |
|---|---|---|
| `candidate` | Contract or package idea is named, but the runtime contract is not ready to register | May appear in planning docs and catalog metadata only |
| `packaged` | A reusable package profile is described with package key, selectors, grants, policies, fixtures, and expected views | May be installed or configured, but cannot execute until the same live gates are proven for the business scope |
| `planned` | Contract exists and expected registry metadata is known, but runtime handling is not registered | May be discovered by schema/catalog tooling, but operations remain non-executable |
| `partial` | Runtime slice exists, but at least one named launch gate is missing, dry-run only, or insufficiently proven | May run only inside the proven scope and mode |
| `blocked` | A gate requires credentials, approval UI, external execution policy, security review, or production evidence before promotion | Must name the blocker and the next proof needed |
| `live` | Gate is implemented, exercised by current tests or deploy smoke, and has current evidence for the configured scope | May run only within the proven grants, budget, approvals, and adapter posture |

## Core Lifecycle Taxonomy

These are runtime lifecycle states for Core worker records. They are separate
from the gate statuses above.

| State | Required Core proof |
|---|---|
| `registered` | Registry metadata names package key, commands, views, policies, default mode, and required config fields |
| `configured` | Business scope, manager, mission, grant refs, budget account, approval policy, adapter mode, and package config are recorded |
| `ready` | Required connections, object refs, grant health, budget availability, and policy checks pass without external mutation |
| `running` | Worker run has idempotency key, selected objects, budget reservation, started-at event, telemetry correlation id, and audit trail |
| `waiting_approval` | Approval packet, proposed action, budget impact, evidence refs, expiry, and continuation config are recorded |
| `executing` | Approved external mutation has grant ref, adapter intent, idempotency key, rollback posture, and telemetry span |
| `completed` | Output objects, evidence refs, budget usage, adapter receipts, generated views, and run completion event are recorded |
| `failed` | Error class, retry posture, partial effects, evidence refs, and operator-visible remediation are recorded |
| `blocked` | Missing grant, approval, credential, budget, policy, or launch proof is recorded with next action |
| `retired` | Package or worker is disabled with replacement posture, revoked grants, and audit proof |

## Gate Legend

| Gate | Required proof |
|---|---|
| Contract | V1 contract names the generic `/worker` envelope, commands, views, config fields, Core writes, workflow, capabilities, evidence, budget, approvals, generated views, evals, telemetry, and security boundaries |
| Registry | Runtime command and view metadata is registered, or planned/package metadata exists for non-runtime workers |
| Object Map | Canonical Core objects and links needed by the worker are named and seeded or produced by commands |
| Lifecycle | Core lifecycle writes prove identity, manager, mission, scope, autonomy, state transition, object version, event, evidence, and audit records before runtime promotion |
| Workflow | Workflow definition, run/step shape, approval step, retry posture, and terminal states are defined |
| Capabilities | Typed capability grants define read, draft, prepare, approve, continue, execute, connection, adapter, and package boundaries |
| Evidence | Source refs, generated artifacts, adapter intents/receipts, approval refs, rollback refs, and reconciliation refs are linked to the run |
| Budget | Budget account, reservation, usage event, cap, overage posture, and settlement behavior are present |
| Approval | Shared approval inbox can carry subject, proposed action, risk, budget impact, evidence refs, decision, signer, expiry, and continuation config |
| Adapter | Dry-run adapter intent, receipt, retry, reconciliation, and rollback posture exist; live execution gate is named |
| Eval | Golden cases or deploy smoke prove key behavior, idempotency, stale-source handling, and blocked external mutation |
| UI | Generated views or route output are sufficient for operator review and approval |
| Telemetry | Structured events cover lifecycle transition, command/view, package key, grant ref, budget event, adapter receipt, approval ref, error class, and redacted correlation id |
| Launch | Production smoke or readiness gate proves the worker can run without unauthorized external mutation |
| Proof | Current files, tests, or deploy smoke substantiate the row status |

## Matrix

| Worker | Contract | Registry | Object Map | Lifecycle | Workflow | Capabilities | Evidence | Budget | Approval | Adapter | Eval | UI | Telemetry | Launch | Proof | Primary blocker | Next action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Revenue Operations | live | live | live | live | live | live | live | live | live | partial | live | partial | partial | partial | `docs/revenue-operations-worker-v1-contract.md`; `src/worker/revenue.ts`; `src/core/adapters.ts`; `src/worker/revenue.integration.test.ts`; `app/worker/route.test.ts`; deploy smoke in `.github/workflows/deploy.yml` proves read, draft, prepare, continuation, retry, reconciliation, blocked execution, and Core-approved receipt recording through the generic `/worker` envelope; `/worker` `view: "readiness"` reports `launchStatus`, `launchReady`, generic launch gates, and first-class `launchProofs` | Production connector credentials, live provider payment-link creation, money movement, and live provider egress remain blocked; scheduler polling now requires verified scheduler-owned connection-backed cursor proof | Provision managed credential refs, create active connection records, record health through Core, then run production send and payment-link receipt proofs with rollback evidence |
| Owner Chief-of-Staff | live | live | live | live | live | live | partial | live | live | blocked | partial | partial | partial | partial | `docs/owner-chief-of-staff-worker-v1-contract.md`; `src/worker/owner.ts`; `src/worker/planned-workers.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke proves brief, decision queue, anomaly triage, Core run source, budget proof, and shared approval continuation | Read-only factuality, stale-source handling, and review view coverage need broader evals before mutation-capable actions | Expand brief, decision queue, and anomaly eval cases plus generated review views |
| Dispatch/Ops | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | `docs/dispatch-operations-worker-v1-contract.md`; `src/worker/dispatch.ts`; `src/worker/tools.test.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke proves schedule proposal, customer update draft, closeout prep, exception routing, Core worker-run lifecycle, and Core budget settlement through generic selectors | Live calendar and customer-send credentials remain blocked | Prove scoped live calendar and customer-send gates with approval, receipt, rollback, and telemetry evidence |
| Finance | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | `docs/finance-operations-worker-v1-contract.md`; `src/worker/finance.ts`; `src/worker/tools.test.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke proves invoice prep, Core worker-run source/state, Core budget settlement, follow-up draft, cash forecast, and payment draft from Core refs and selectors | Live accounting/payment credentials, bank adapter readiness, and dual-control execution gates remain blocked; expense coding is still planned | Implement expense-coding receipt fixture, live accounting/payment readiness checks, and dual-control execution gates using the generic envelope |
| Workforce | partial | partial | partial | partial | partial | partial | partial | partial | partial | blocked | partial | partial | partial | partial | `docs/workforce-operations-worker-v1-contract.md`; `src/worker/workforce.ts`; `src/worker/planned-workers.ts`; `src/db/seed.ts`; `src/worker/tools.test.ts`; `src/worker/app-server-tools.test.ts`; `src/worker/revenue.integration.test.ts`; deploy smoke proves hire packet, payroll input, restricted-document proof, approvals, generated views, workflow, budget, and audit proof | Contractor, credential, schedule readiness, live HR, and payroll credentials remain blocked | Implement contractor packet, credential review, schedule readiness, and live credential readiness gates with grant, approval, receipt, and rollback proof |
| Compliance | partial | partial | partial | partial | partial | partial | partial | partial | partial | blocked | partial | partial | partial | partial | `docs/compliance-operations-worker-v1-contract.md`; Core obligation scan in `src/core/obligations.ts`; `src/worker/compliance.ts`; `src/worker/registry.ts`; `app/core/route.test.ts`; `app/worker/route.test.ts`; deploy smoke proves filing draft packet, document, approval, view, workflow steps, Core worker-run lifecycle, Core budget settlement, handoff, and blocked submission/legal-advice posture | Live agency credentials, broader rule-source coverage, and receipt/rejection capture remain blocked | Broaden live agency credential scope, rule-source coverage, validation, human approval, and receipt/rejection capture |
| Systems | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | partial | `docs/systems-operations-worker-v1-contract.md`; `src/worker/planned-workers.ts`; Core connection health primitives in `src/core/primitives.ts`; deploy smoke proves connection upsert, health recording, dry-run repair planning, and blocked permission/automation execution | Live connector mutation, permission changes, automation enablement, and external repair execution remain blocked | Add scoped live credential checks, approval receipts, rollback evidence, telemetry, and launch smoke |
| Offer and Pricing | partial | partial | partial | partial | partial | partial | partial | partial | partial | blocked | partial | partial | partial | partial | `docs/offer-pricing-worker-v1-contract.md`; `docs/worker-expansion.md`; `docs/worker-handoffs.md`; `src/worker/offer-pricing.ts`; `src/worker/registry.ts`; `src/db/seed.ts`; `src/worker/offer-pricing.integration.test.ts`; deploy smoke proves pricing review packet, Core run lifecycle, budget settlement, generated price policy view, approval, and idempotent replay | Price publish, quote mutation, customer sends, stale-cost rejection breadth, and live credentials remain blocked | Broaden price-change, discount-exception, stale-cost-source, live publish, and customer-send gates |
| Customer Experience | partial | partial | partial | partial | partial | partial | partial | partial | partial | blocked | partial | partial | partial | partial | `docs/customer-experience-worker-v1-contract.md`; `docs/worker-expansion.md`; `docs/worker-handoffs.md`; `src/worker/customer-experience.ts`; `src/worker/registry.ts`; `src/db/seed.ts`; contract coverage in `src/worker/worker-contracts.test.ts`; schema discovery through `/worker` runtime metadata | Customer messages, review responses, refunds, concessions, promise mutation, and approved send credentials remain blocked | Add escalation routing, promise follow-up, review-response draft, approved-send credentials, rollback proof, receipt capture, and telemetry |
| Asset and Supply | candidate | candidate | candidate | candidate | candidate | candidate | candidate | candidate | candidate | planned | planned | planned | planned | planned | `docs/asset-supply-worker-v1-contract.md`; `docs/worker-expansion.md`; `docs/worker-handoffs.md`; `src/worker/planned-workers.ts`; contract coverage in `src/worker/worker-contracts.test.ts`; schema discovery through `/worker` candidate metadata | No executable runtime handler exists yet; purchase orders, vendor dispatch, inventory writes, and spend remain dry-run or blocked | Build reorder and maintenance fixtures, purchase approval packet, cash handoff, dry-run adapter receipts, and package-ready selectors |
| Growth | partial | partial | partial | partial | partial | partial | partial | partial | partial | blocked | partial | partial | partial | partial | `docs/growth-worker-v1-contract.md`; `docs/worker-expansion.md`; `docs/worker-handoffs.md`; `src/worker/growth.ts`; `src/worker/growth.integration.test.ts`; contract coverage in `src/worker/worker-contracts.test.ts`; schema discovery through `/worker` runtime metadata | External publish, sends, ad spend, tracking mutation, and broader claim-source evals remain blocked | Add publish, send, spend, tracking, approval, scoped credentials, adapter receipts, rollback proof, and claim-source evals |
| Vertical packaged workers | packaged | packaged | packaged | packaged | packaged | packaged | packaged | packaged | packaged | blocked | planned | planned | planned | planned | `docs/vertical-packaged-worker-v1-contract.md`; `docs/worker-expansion.md`; `docs/worker-handoffs.md`; `src/worker/planned-workers.ts`; contract coverage in `src/worker/worker-contracts.test.ts`; schema discovery through `/worker` packaged-catalog metadata | Package selection, connection refs, grant refs, family flow, rollout policy, and rollback proof are described in config, but no executable runtime handler exists yet | Build package readiness fixtures for knowledge delivery, billing, quote-to-cash field work, change order, intake/documentation, compliance QA, inventory replenishment, production planning, demand/guest experience, event/menu, dispatch/asset utilization, and maintenance bundles |

## Operation-Level Launch Gates

These rows keep external execution gates explicit without binding readiness to
worker-specific URL paths. Every operation is addressed through `/worker` with
`command` or `view`, `worker`, `idempotencyKey` when needed, and operation
details in `config`.

| Operation pattern | Current posture | Required live gate | First proof to add |
|---|---|---|---|
| Source read or ingest | Internal read/persist can be proven with selected object and connection refs | Scoped credential ref, connection health, redacted polling receipt, cursor evidence, and stale-source policy | Production-safe connection fixture plus scheduler/cursor smoke |
| Draft or proposal generation | Internal packet, document, and generated view creation is allowed inside proven selectors | Source refs, policy refs, budget reservation, evidence refs, and no external mutation | Golden case proving packet, view, evidence, budget, and telemetry linkage |
| Approval continuation | Continuation can record approved, revised, rejected, or expired decisions | Approval ref, signer, expiry, decision payload, budget impact, continuation selector, and idempotency key | Approval smoke proving decision replay safety and blocked execution without live grant |
| Customer or partner send | Sends stay blocked unless Core records approved execution through a scoped grant | Channel credential, send policy, approval, delivery receipt, retry/reconcile path, rollback/escalation packet, and redaction proof | Controlled send receipt with no token leakage |
| Payment, payroll, or money movement | Provider creation and money movement stay blocked | Dual-control approval, bank or provider credential, deterministic preview, receipt, reversal/escalation plan, and budget settlement | Dry-run-to-approved proof that records preview, approval, receipt, and rollback posture |
| Calendar, schedule, inventory, or operational mutation | Mutation is dry-run until live grant and rollback proof exist | Scoped credential, conflict or constraint receipt, owner approval, undo/cancel posture, and reconciliation evidence | Approved dry-run fixture with rollback evidence |
| Filing or regulated submission | Draft packet can be prepared; legal advice and agency submission stay blocked | Live agency credential, rule-source coverage, validation, human submission approval, receipt/rejection capture, and audit proof | Rule-source breadth plus receipt/rejection fixture |
| Price, policy, permission, or connector change | Change planning is allowed; live publish or permission mutation is blocked | Least-privilege diff, owner approval, scoped credential, rollback document, reconciliation evidence, and telemetry | Dry-run change packet plus approved rollback proof |
| Spend, publish, tracking, or external automation | External publish, ad spend, analytics mutation, and automation enablement stay blocked | Source-claim proof, budget proof, scoped channel/ad/analytics credential, adapter receipt, rollback plan, and approval | Publish/spend/tracking dry-run-to-approved fixture with secret-redaction proof |
| Packaged family flow | Package catalog and configuration may be registered; execution waits for selected business scope | `config.packageKey`, package version, package grants, package budget, connection selectors, rollout policy, fixture set, and package rollback proof | Package install fixture proving configured lifecycle, grants, budget, approvals, evidence, and telemetry without package-specific routes |

## Promotion Rules

1. A worker may not move to `live` until Contract, Registry, Object Map,
   Lifecycle, Workflow, Capabilities, Evidence, Budget, Approval, Adapter,
   Eval, UI, Telemetry, Launch, and Proof have named current evidence.
2. A worker may not execute external sends, filings, payroll, payments,
   permission changes, connector repairs, spend, or data writes outside
   Continuous until Adapter, Approval, Capabilities, Budget, Telemetry, and
   Launch gates are `live` for that operation pattern.
3. Packaged workers must use the generic `/worker` envelope with package
   configuration and operation input in `config`; package-specific
   routes are not readiness proof.
4. Capability grants must be least-privilege, typed by operation mode, connected to
   managed credentials or internal Core scopes, and visible in approval and
   telemetry records.
5. Evidence must link source refs, generated artifacts, approval refs, adapter
   receipts, budget events, telemetry ids, rollback posture, and reconciliation
   output to the same worker run.
6. Every promotion must update this matrix, the Proof column, the worker
   contract, and the applicable eval or deploy smoke in the same change.
