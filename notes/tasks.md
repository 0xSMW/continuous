# Tasks

## User

- Decide whether `www.continuoushq.com` and `www.getcontinuous.app` should serve the app; if yes, add those hostnames to `SITE_HOSTS` and rerun the domain deploy.

## Agent

- Implement canonical entity/workforce/payroll/filing/payment/AI-ops objects before widening the Revenue Worker runtime.
- Add customer satisfaction and feedback entities: SatisfactionSignal, FeedbackItem, Complaint, Testimonial, and Review.
- Implement open workflow state machines for entity setup, hire employee, contractor engagement, termination, payroll preview, AI budget cycle, and synthetic-worker lifecycle.
- Expand `/workflow` execution from approval-aware transitions into step handlers, leases, retries, and durable run-step records.
- Add document/evidence packet support for new-hire, contractor, payroll, filing, termination, AI action, and rule-change workflows.
- Build the approval UI on top of the persisted `approval_requests` and `audit_events` API.
- Keep all new worker-family HTTP controls on `/worker` with structured `worker`, `command`, and `config` fields; do not add new worker-family-specific URL shapes.
- Add real adapter credentials and dry-run reconciliation before allowing external sends or money movement.
- Convert the deterministic Revenue Worker run into the state machine defined by `docs/revenue-worker-v1-contract.md`.
- Use `docs/revenue-worker-expansion.md` as the expansion gate list for the next worker iteration.
- Use `docs/revenue-worker-v1-contract.md` as the machine-actionable contract for run and approval effects.
- Keep Next MCP for Next.js diagnostics; add direct Codex app-server worker tools if/when the repo needs app-server-owned controls.
