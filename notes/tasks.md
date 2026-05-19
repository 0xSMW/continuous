# Tasks

## User

- Decide whether `www.continuoushq.com` and `www.getcontinuous.app` should serve the app; if yes, add those hostnames to `SITE_HOSTS` and rerun the domain deploy.

## Agent

- Implement canonical entity/workforce/payroll/filing/payment/AI-ops objects before widening the Revenue Worker runtime.
- Add customer satisfaction and feedback entities: SatisfactionSignal, FeedbackItem, Complaint, Testimonial, and Review.
- Implement open workflow state machines for entity setup, hire employee, contractor engagement, termination, payroll preview, AI budget cycle, and synthetic-worker lifecycle.
- Add document/evidence packet support for new-hire, contractor, payroll, filing, termination, AI action, and rule-change workflows.
- Add authenticated operator identity and approval UI to the persisted Revenue Worker runtime.
- Add real adapter credentials and approval UI before allowing external sends or money movement.
- Use `docs/revenue-worker-expansion.md` as the expansion gate list for the next worker iteration.
- Keep Next MCP for Next.js diagnostics; add direct Codex app-server worker tools if/when the repo needs app-server-owned controls.
