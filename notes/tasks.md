# Tasks

## User

- Decide whether `www.continuoushq.com` and `www.getcontinuous.app` should serve the app; if yes, add those hostnames to `SITE_HOSTS` and rerun the domain deploy.

## Agent

- Implement canonical entity/workforce/payroll/filing/payment/AI-ops objects before widening the Revenue Worker runtime.
- Add customer satisfaction and feedback entities: SatisfactionSignal, FeedbackItem, Complaint, Testimonial, and Review.
- Extend the broader workflow catalog beyond the first seven seeded workflows: open new state, compensation change, location change, payroll run, off-cycle payroll, quarter close, year-end, leave, injury/incident, benefits renewal, and agency notice.
- Wire workflow step handlers into capability execution, retry workers, and adapter reconciliation.
- Add more specialized Core commands for object links, workflow packets, generated UI views, and rule changes.
- Add document/evidence packet support for new-hire, contractor, payroll, filing, termination, AI action, and rule-change workflows.
- Build the approval UI on top of the shared `approval_requests`, `audit_events`, and evidence API.
- Keep all worker-family HTTP controls on `/worker` with structured `worker`, `command`, `idempotencyKey`, and `config` fields; do not add worker-family-specific URL shapes.
- Extend adapter reconciliation into retry execution, failure tasks, scoped live credentials, and rollback paths before allowing external sends or money movement.
- Convert the deterministic Revenue Worker run into the state machine defined by `docs/revenue-worker-v1-contract.md`.
- Add read-only real lead intake that feeds the same `config.leadPacket` worker contract.
- Use `docs/revenue-worker-expansion.md` as the expansion gate list for the next worker iteration.
- Use `docs/revenue-worker-v1-contract.md` as the machine-actionable contract for run and approval effects.
- Extend Revenue Worker evals beyond the first two lead-to-quote golden cases.
- Keep Next MCP for Next.js diagnostics; add direct Codex app-server worker tools if/when the repo needs app-server-owned controls.
