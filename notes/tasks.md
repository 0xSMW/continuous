# Tasks

## User

- Decide whether `www.continuoushq.com` and `www.getcontinuous.app` should serve the app; if yes, add those hostnames to `SITE_HOSTS` and rerun the domain deploy.

## Agent

- Continue canonical entity/workforce/filing/payment object coverage before widening the Revenue Worker runtime; payroll preview now has persisted statements, lines, liabilities, traces, and Core record/packet commands, and AI-ops now has a deterministic Core `ai.infer` gateway with route, redaction, budget, inference, usage, audit, and evidence proof.
- Extend approved payroll handoffs into scoped live credential checks, rollback paths, and dual-control execution workers before any submission or money movement.
- Extend customer-signal workflows, generated views, and eval fixtures beyond the seeded SatisfactionSignal, FeedbackItem, Complaint, Testimonial, and Review primitives.
- Wire implementation handlers, retries, and generated views into the expanded operating workflow catalog; queued approval and packet handoffs now execute through `/workflow`.
- Extend adapter-intent, rule-change, capability-backed, approval-backed, and packet-backed workflow execution into additional domain-specific handlers; scheduled command drain now covers workflow steps, Revenue lead polling, and Revenue adapter retry/reconciliation.
- Extend Core adapter intent and rule-change workflow handlers into future worker contract fixtures.
- Extend Dispatch beyond the registered `schedule.propose`, `customer_update.draft`, `closeout.prepare`, and `exception.route` slices into scoped live credential checks and external execution gates; extend Finance beyond the registered `invoice.prepare`, `ar_followup.draft`, `cash_forecast.generate`, and `payment_draft.prepare` slices into live-accounting/payment readiness and dual-control execution gates; implement runtime handlers and CI evals for Workforce, Compliance, and Systems from their registered contract metadata.
- Extend the Owner Chief-of-Staff Worker beyond approval/revision continuations into stale-source handling and broader factuality evals.
- Keep all worker-family HTTP controls on `/worker` with registered `worker`, `command`, `idempotencyKey`, and `config` fields; do not add worker-family-specific URL shapes.
- Keep worker identities role-based, such as `revenue_operations` and `dispatch_operations`; do not reintroduce legacy family-worker identifiers or `/api/*-worker` naming in examples, docs, routes, scripts, or event namespaces.
- Keep local worker mutation controls on `worker:tool worker.command` or `continuous.worker.command` with the same `command`, `worker`, `idempotencyKey`, and `config` envelope as `/worker`; do not add worker-family-specific package scripts, app-server tools, or top-level operator/context fields that bypass the command registry.
- Keep the production object-storage Postgres backup timer healthy; `scripts/check-production-readiness.sh` now proves the timer, backup env, fresh local dump, and latest DigitalOcean Spaces backup object.
- Run `scripts/recovery-drill.sh` against a disposable droplet, then install the observability timer with a real alert webhook, run `scripts/install-non-root-access.sh`, verify a deploy with `SSH_USER=continuous-deploy`, and make `scripts/check-production-readiness.sh` pass before using the production droplet for real customer data.
- Keep deploy-produced token rotation, control-plane credential inventory, disposable revocation drill, operator session review evidence, and `control_plane_auth_sessions` audit references current in readiness before broad customer use.
- Provision scoped adapter credentials, tested rollback playbooks, and a first controlled send only after retry readiness evidence stays green.
- Provision production inbox and CRM managed credential refs, create pollable active live-provider connections through `/core connection.upsert`, record readiness through `/core connection.health.record`, and monitor scheduler coverage behind the persisted connection-backed `lead.read` source-reader shape.
- Align worker contract metadata so Revenue uses the same implementation-grade contract shape as the future workers and runtime-worker planned follow-up commands remain visible in app-server schema.
- Build a DigitalOcean release gate that deploys a CI-built image digest, runs Postgres 17 parity smoke, and reuses a parameterized host smoke script before customer-data mode.
- Use `docs/revenue-operations-worker-expansion.md` as the expansion gate list for the next worker iteration.
- Use `docs/revenue-operations-worker-v1-contract.md` as the machine-actionable contract for run and approval effects.
- Keep `docs/worker-readiness.md` and `docs/worker-handoffs.md` updated in the same change as any worker promotion or new cross-worker fixture; Dispatch now has schedule proposal, customer update draft, closeout packet, and exception routing proof, Finance now has invoice draft, AR follow-up, cash forecast, and payment draft cash-packet proof, and the next launch slices are live credential gating plus dual-control execution readiness.
- Keep Core HTTP controls on `/core` with registered `command`, `core`, `idempotencyKey`, and `config` fields; do not add `/api/*` command paths or command-specific URLs.
- Keep Next MCP for Next.js diagnostics; keep app-server worker tooling registry-backed, trusted-local, and free of production-token plumbing; CI now proves `continuous.worker.command` can execute real Revenue `lead.read`, `run`, `lead.classify`, and `response.draft`, plus Owner, Dispatch, and Finance payment-depth commands, so add a production-grade auth boundary before remote app-server use.
