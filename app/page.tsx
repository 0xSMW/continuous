import { Bot, Database, FileText, GitBranch, LockKeyhole, ShieldCheck, Workflow } from "lucide-react";

export const dynamic = "force-static";

const publicContracts = [
  {
    name: "Worker API",
    status: "Generic",
    detail: "POST /worker with view or command, worker selectors, idempotencyKey when needed, and config.",
  },
  {
    name: "Core API",
    status: "Canonical",
    detail: "POST /core with command, core selectors, idempotencyKey, and config.",
  },
  {
    name: "Workflow API",
    status: "Ledgered",
    detail: "POST /workflow with command, workflow selectors, idempotencyKey, and config.",
  },
  {
    name: "Approval API",
    status: "Shared",
    detail: "POST /approval with approval selectors, decision command, idempotencyKey, and config.",
  },
];

const primitives = [
  {
    name: "Business graph",
    icon: GitBranch,
    text: "Customers, leads, jobs, invoices, payments, workers, and operating facts share the same persisted substrate.",
  },
  {
    name: "Task ledger",
    icon: Workflow,
    text: "Work is tracked through clear state, owner, capability, evidence, and outcome fields.",
  },
  {
    name: "Capability registry",
    icon: ShieldCheck,
    text: "Agentic actions are typed, scoped, risk-aware contracts instead of loose credentials.",
  },
  {
    name: "Evidence layer",
    icon: FileText,
    text: "Actions can attach packets, documents, approvals, traces, and external receipts.",
  },
  {
    name: "Worker runtime",
    icon: Bot,
    text: "Worker families extend role, command, view, and config metadata without creating family-specific URLs.",
  },
  {
    name: "Adapter model",
    icon: Database,
    text: "External systems are represented as scoped connectors before live execution is allowed.",
  },
];

export default function PublicPage() {
  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="label">Continuous Core</p>
          <h1>Operating layer for human, AI, and robot workforces</h1>
          <p className="lede">
            The public root stays static. Operational data lives behind the control-plane APIs, where tokens,
            tenant scope, worker role scope, command scope, approvals, and evidence can be enforced before any
            business record is read or changed.
          </p>
        </div>
        <nav className="api-links" aria-label="Public endpoints">
          <a href="/health">Health</a>
        </nav>
      </header>

      <section className="status-grid" aria-label="Public status">
        <div className="stat">
          <span>Status</span>
          <strong>Locked</strong>
          <small>Operational summary requires control-plane auth</small>
        </div>
        <div className="stat">
          <span>Route</span>
          <strong>/worker</strong>
          <small>Worker role and config stay in the payload</small>
        </div>
        <div className="stat">
          <span>Public</span>
          <strong>/health</strong>
          <small>Safe liveness only</small>
        </div>
        <div className="stat">
          <span>Execution</span>
          <strong>Blocked</strong>
          <small>External actions require scoped approval proof</small>
        </div>
      </section>

      <section className="layout">
        <section className="panel span-3">
          <div className="section-head">
            <div>
              <p className="label">Control plane</p>
              <h2>Public dashboard locked</h2>
            </div>
            <span className="stamp">Only /health is unauthenticated</span>
          </div>
          <div className="worker-grid">
            <article className="worker-card primary">
              <LockKeyhole aria-hidden="true" size={22} />
              <div>
                <span className="label">Security posture</span>
                <h3>No public operational records</h3>
                <p>
                  Counts, task titles, event names, worker runs, approvals, and database errors are not rendered
                  from the public root. Operator views should be built as authenticated consoles over the same
                  generic APIs.
                </p>
              </div>
            </article>
            {publicContracts.slice(0, 3).map((contract) => (
              <article key={contract.name} className="worker-card">
                <span className="label">{contract.name}</span>
                <strong>{contract.status}</strong>
                <p>{contract.detail}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="panel span-3">
          <div className="section-head">
            <div>
              <p className="label">API shape</p>
              <h2>Generic routes, typed payloads</h2>
            </div>
          </div>
          <div className="count-grid">
            {publicContracts.map((contract) => (
              <div key={contract.name}>
                <span>{contract.name}</span>
                <strong>{contract.status}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel span-3">
          <div className="section-head">
            <div>
              <p className="label">Platform</p>
              <h2>Core primitives</h2>
            </div>
          </div>
          <div className="primitive-grid">
            {primitives.map((primitive) => {
              const Icon = primitive.icon;
              return (
                <article key={primitive.name}>
                  <Icon aria-hidden="true" size={20} />
                  <h3>{primitive.name}</h3>
                  <p>{primitive.text}</p>
                </article>
              );
            })}
          </div>
        </section>
      </section>
    </main>
  );
}
