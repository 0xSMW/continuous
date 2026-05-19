# Tasks

## User

- Decide whether `www.continuoushq.com` and `www.getcontinuous.app` should serve the app; if yes, add those hostnames to `SITE_HOSTS` and rerun the domain deploy.

## Agent

- Implement canonical entity/workforce/payroll/filing/payment/AI-ops objects before widening the Revenue Worker runtime.
- Extend customer-signal workflows, generated views, and eval fixtures beyond the seeded SatisfactionSignal, FeedbackItem, Complaint, Testimonial, and Review primitives.
- Wire implementation handlers, retries, approvals, packets, and generated views into the expanded operating workflow catalog.
- Wire workflow step handlers into capability execution, retry workers, and adapter reconciliation.
- Add more specialized Core commands for adapter intents and rule changes.
- Extend `packet.prepare` coverage into new-hire, contractor, payroll, filing, termination, AI action, and rule-change workflow packet tests.
- Build the approval UI on top of the shared `approval_requests`, `audit_events`, and evidence API.
- Implement runtime handlers and CI evals for Dispatch, Finance, Workforce, Compliance, and Systems from their registered contract metadata.
- Extend the Owner Chief-of-Staff Worker beyond the first read-only brief slice into approval/revision continuations, stale-source handling, and broader factuality evals.
- Keep all worker-family HTTP controls on `/worker` with registered `worker`, `command`, `idempotencyKey`, and `config` fields; do not add worker-family-specific URL shapes.
- Keep local worker mutation controls on `worker:tool`; do not add worker-family-specific package scripts that bypass the command registry.
- Provision the production object-storage bucket/key, run `scripts/install-backup-timer.sh`, and prove scheduled off-host Postgres dump retention before customer data.
- Complete production hardening with tag-based deploy rollback, observability/alerts, scoped tokens, non-root host access, and a restore drill before using the droplet for real customer data.
- Extend adapter reconciliation tasks into live retry execution, scoped live credentials, and rollback paths before allowing external sends or money movement.
- Extend the Revenue Worker state machine with retry, failure, reconciliation, and later approved-execution branches after the revised-packet continuation path.
- Expand read-only real lead intake from `config.intake` Core references into connected source readers.
- Use `docs/revenue-operations-worker-expansion.md` as the expansion gate list for the next worker iteration.
- Use `docs/revenue-operations-worker-v1-contract.md` as the machine-actionable contract for run and approval effects.
- Extend Revenue Worker evals beyond the first two lead-to-quote golden cases.
- Keep Next MCP for Next.js diagnostics; keep app-server worker tooling read-only until a real repo-owned daemon integration needs mutation.
