import { Bot, Database, FileText, Gauge, GitBranch, ShieldCheck, Workflow } from "lucide-react";

import { getHealth } from "../src/core/health";
import { getCoreSummarySafe, summarizeCoreReadiness } from "../src/core/summary";

export const dynamic = "force-dynamic";

const countLabels = {
  tenants: "Tenants",
  legalEntities: "Legal entities",
  people: "People",
  employments: "Employments",
  compensationAgreements: "Compensation",
  paySchedules: "Pay schedules",
  payrollRuns: "Payroll runs",
  rulePacks: "Rule packs",
  obligations: "Obligations",
  filingRequirements: "Filing requirements",
  filingDrafts: "Filing drafts",
  bankAccounts: "Bank accounts",
  paymentInstructions: "Payment instructions",
  workflowDefinitions: "Workflow definitions",
  workflowRuns: "Workflow runs",
  workerRuns: "Worker runs",
  approvalRequests: "Approval requests",
  auditEvents: "Audit events",
  objects: "Objects",
  objectLinks: "Object links",
  objectVersions: "Object versions",
  documents: "Documents",
  decisions: "Decisions",
  evaluations: "Evaluations",
  entityIdentifiers: "Entity identifiers",
  customers: "Customers",
  leads: "Leads",
  offers: "Offers",
  quotes: "Quotes",
  jobs: "Jobs",
  invoices: "Invoices",
  payments: "Payments",
  tasks: "Tasks",
  evidence: "Evidence",
  events: "Events",
  capabilities: "Capabilities",
  capabilityGrants: "Capability grants",
  workers: "Workers",
  modelProviders: "Model providers",
  modelRoutes: "Model routes",
  budgetPolicies: "Budget policies",
  budgetPools: "Budget pools",
  budgetAccounts: "Budget accounts",
  budgetAllocations: "Budget allocations",
  budgetReservations: "Budget reservations",
  usageEvents: "Usage events",
  generatedViews: "Generated views",
  adapters: "Adapters",
  connections: "Connections",
  adapterRuns: "Adapter runs",
  adapterActions: "Adapter actions",
  inferences: "Inferences",
};

const primitives = [
  {
    name: "Business graph",
    icon: GitBranch,
    text: "Customers, leads, offers, quotes, jobs, invoices, and payments are modeled as persisted records.",
  },
  {
    name: "Task ledger",
    icon: Workflow,
    text: "Work is tracked with owner, state, capability, evidence requirements, cost, and outcome.",
  },
  {
    name: "Capability registry",
    icon: ShieldCheck,
    text: "Agentic actions are typed, risk-scored, approval-aware contracts instead of raw credentials.",
  },
  {
    name: "Evidence layer",
    icon: FileText,
    text: "Actions can attach snapshots, receipts, approvals, traces, and subject references.",
  },
  {
    name: "AI gateway ledger",
    icon: Gauge,
    text: "Budget accounts and usage events attribute model spend to workers, tasks, and routes.",
  },
  {
    name: "Adapter model",
    icon: Database,
    text: "External systems are represented as scoped connector records before executable adapters ship.",
  },
];

export default async function AdminPage() {
  const result = await getCoreSummarySafe();
  const summary = result.summary;
  const readiness = summarizeCoreReadiness(summary);
  const health = getHealth({
    dbOk: result.ok,
    dbError: result.error,
    counts: summary.counts,
  });
  const workerRuntimeReady =
    summary.counts.workers > 0 &&
    summary.counts.capabilities > 0 &&
    summary.counts.budgetAccounts > 0 &&
    summary.counts.workerRuns > 0 &&
    summary.counts.approvalRequests > 0 &&
    summary.counts.auditEvents > 0 &&
    summary.counts.tasks > 0 &&
    summary.counts.evidence > 0 &&
    summary.counts.events > 0 &&
    summary.counts.adapters > 0 &&
    summary.counts.connections > 0 &&
    summary.counts.generatedViews > 0;

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="label">Continuous Core</p>
          <h1>Worker platform substrate</h1>
          <p className="lede">
            Persisted graph, task, capability, budget, authority, adapter, generated UI, event, and evidence primitives for
            governed SMB workers.
          </p>
        </div>
        <nav className="api-links" aria-label="API endpoints">
          <a href="/api/health">Health</a>
          <a href="/api/core">Core API</a>
        </nav>
      </header>

      <section className="status-grid" aria-label="Operational status">
        <div className="stat">
          <span>Status</span>
          <strong>{health.status}</strong>
          <small>{result.ok ? "Postgres connected" : "Database check failed"}</small>
        </div>
        <div className="stat">
          <span>Tenant</span>
          <strong>{summary.tenantName ?? "None"}</strong>
          <small>{summary.counts.tenants} persisted</small>
        </div>
        <div className="stat">
          <span>Tasks</span>
          <strong>{summary.counts.tasks}</strong>
          <small>{summary.activeTasks.length} active shown</small>
        </div>
        <div className="stat">
          <span>Capabilities</span>
          <strong>{summary.counts.capabilities}</strong>
          <small>typed action contracts</small>
        </div>
      </section>

      {result.error ? <p className="error">Database error: {result.error}</p> : null}

      <section className="layout">
        <section className="panel span-3">
          <div className="section-head">
            <div>
              <p className="label">Continuous Revenue Worker</p>
              <h2>Operator-gated lead-to-cash runtime</h2>
            </div>
            <span className="stamp">Detailed snapshot requires operator token</span>
          </div>
          {workerRuntimeReady ? (
            <div className="worker-grid">
              <article className="worker-card primary">
                <Bot aria-hidden="true" size={22} />
                <div>
                  <span className="label">Runtime</span>
                  <h3>Revenue Worker installed</h3>
                  <p>
                    The first worker is backed by persisted worker, run, task, budget, approval, audit, evidence, and adapter records.
                  </p>
                </div>
              </article>
              <article className="worker-card">
                <span className="label">Execution</span>
                <dl>
                  <div>
                    <dt>External adapters</dt>
                    <dd>Blocked</dd>
                  </div>
                  <div>
                    <dt>HTTP runs</dt>
                    <dd>Token gated</dd>
                  </div>
                  <div>
                    <dt>Owner approval</dt>
                    <dd>Required</dd>
                  </div>
                </dl>
              </article>
              <article className="worker-card">
                <span className="label">Budget ledger</span>
                <strong>{summary.counts.budgetAccounts.toLocaleString()}</strong>
                <p>{summary.counts.budgetReservations.toLocaleString()} reservations and {summary.counts.usageEvents.toLocaleString()} usage events recorded across worker accounts.</p>
              </article>
              <article className="worker-card">
                <span className="label">Governance</span>
                <strong>{summary.counts.approvalRequests.toLocaleString()}</strong>
                <p>{summary.counts.auditEvents.toLocaleString()} audit events, {summary.counts.workerRuns.toLocaleString()} worker runs, and {summary.counts.evidence.toLocaleString()} evidence records.</p>
              </article>
            </div>
          ) : (
            <p className="empty">Revenue Worker bootstrap data is not available yet.</p>
          )}
        </section>

        <section className="panel span-2">
          <div className="section-head">
            <div>
              <p className="label">Readiness</p>
              <h2>Core persistence</h2>
            </div>
            <span className="stamp">Checked {new Date(health.checkedAt).toLocaleTimeString()}</span>
          </div>
          <div className="readiness">
            {Object.entries(readiness).map(([key, value]) => (
              <div key={key} className={value ? "ready" : "watch"}>
                <strong>{key.replace(/^has/, "").replace(/([A-Z])/g, " $1").trim()}</strong>
                <span>{value ? "Ready" : "Needs data"}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="section-head compact">
            <div>
              <p className="label">Health</p>
              <h2>Checks</h2>
            </div>
          </div>
          <ul className="checks">
            {health.checks.map((check) => (
              <li key={check.id} className={check.state}>
                <strong>{check.id.replaceAll("_", " ")}</strong>
                <span>{check.detail}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className="panel span-3">
          <div className="section-head">
            <div>
              <p className="label">Object counts</p>
              <h2>Persisted primitives</h2>
            </div>
          </div>
          <div className="count-grid">
            {Object.entries(summary.counts).map(([key, value]) => (
              <div key={key}>
                <span>{countLabels[key as keyof typeof countLabels] ?? key}</span>
                <strong>{value}</strong>
              </div>
            ))}
          </div>
        </section>

        <section className="panel span-2">
          <div className="section-head">
            <div>
              <p className="label">Task ledger</p>
              <h2>Active work</h2>
            </div>
          </div>
          <div className="task-list">
            {summary.activeTasks.length > 0 ? (
              summary.activeTasks.map((task) => (
                <article key={task.id} className="task">
                  <div>
                    <span className={`priority ${task.priority}`}>{task.priority}</span>
                    <h3>{task.title}</h3>
                    <p>{task.id}</p>
                  </div>
                  <dl>
                    <div>
                      <dt>State</dt>
                      <dd>{task.state}</dd>
                    </div>
                    <div>
                      <dt>Owner</dt>
                      <dd>{task.ownerRef}</dd>
                    </div>
                  </dl>
                </article>
              ))
            ) : (
              <p className="empty">No active tasks yet. Bootstrap worker tasks will appear here after seed data is loaded.</p>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="section-head compact">
            <div>
              <p className="label">Event log</p>
              <h2>Recent events</h2>
            </div>
          </div>
          <ul className="events">
            {summary.recentEvents.length > 0 ? (
              summary.recentEvents.map((event) => (
                <li key={event.id}>
                  <strong>{event.type}</strong>
                  <span>{event.source}</span>
                  <small>{new Date(event.occurredAt).toLocaleString()}</small>
                </li>
              ))
            ) : (
              <li className="empty">No events recorded yet.</li>
            )}
          </ul>
        </section>

        <section className="panel span-3">
          <div className="section-head">
            <div>
              <p className="label">Platform</p>
              <h2>Core contracts</h2>
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
