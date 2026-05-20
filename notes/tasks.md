# Tasks

## User

- Decide whether `www.continuoushq.com` and `www.getcontinuous.app` should serve the app; if yes, add those hostnames to `SITE_HOSTS` and rerun the domain deploy.

## Agent

- Continue canonical entity/workforce/filing/payment/AI-ops object coverage before widening the Revenue Worker runtime; payroll preview now has persisted statements, lines, liabilities, traces, and a Core record command.
- Extend approved payroll handoffs into scoped live credential checks, rollback paths, and dual-control execution workers before any submission or money movement.
- Extend customer-signal workflows, generated views, and eval fixtures beyond the seeded SatisfactionSignal, FeedbackItem, Complaint, Testimonial, and Review primitives.
- Wire implementation handlers, retries, and generated views into the expanded operating workflow catalog; queued approval and packet handoffs now execute through `/workflow`.
- Extend adapter-intent, rule-change, capability-backed, approval-backed, and packet-backed workflow execution into additional domain-specific handlers; scheduled command drain now covers workflow steps plus Revenue adapter retry/reconciliation.
- Extend Core adapter intent and rule-change workflow handlers into future worker contract fixtures.
- Implement runtime handlers and CI evals for Dispatch, Finance, Workforce, Compliance, and Systems from their registered contract metadata.
- Extend the Owner Chief-of-Staff Worker beyond the first read-only brief slice into approval/revision continuations, stale-source handling, and broader factuality evals.
- Keep all worker-family HTTP controls on `/worker` with registered `worker`, `command`, `idempotencyKey`, and `config` fields; do not add worker-family-specific URL shapes.
- Keep local worker mutation controls on `worker:tool` or `continuous.worker.command`; do not add worker-family-specific package scripts or app-server tools that bypass the command registry.
- Provision the production object-storage bucket/key, run `scripts/install-backup-timer.sh`, and prove scheduled off-host Postgres dump retention before customer data.
- Complete production hardening with tag-based deploy rollback, observability/alerts, scoped tokens, non-root host access, and a restore drill before using the droplet for real customer data.
- Replace the bootstrap shared operator token with first-class operator auth, per-command scopes, token rotation, and session-level audit trails before broad customer use.
- Provision scoped adapter credentials, tested rollback playbooks, and a first controlled send only after retry readiness evidence stays green.
- Provision actual inbox and CRM connector polling behind the persisted `lead.read` source-reader shape.
- Use `docs/revenue-operations-worker-expansion.md` as the expansion gate list for the next worker iteration.
- Use `docs/revenue-operations-worker-v1-contract.md` as the machine-actionable contract for run and approval effects.
- Keep Core HTTP controls on `/core` with registered `command`, `core`, `idempotencyKey`, and `config` fields; do not add `/api/*` command paths or command-specific URLs.
- Keep Next MCP for Next.js diagnostics; keep app-server worker tooling registry-backed and free of production-token plumbing.
