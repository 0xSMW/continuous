export type CheckState = "pass" | "warn" | "fail";

export type Check = {
  id: string;
  state: CheckState;
  detail: string;
};

export type Health = {
  service: string;
  status: "ok" | "degraded" | "down";
  checkedAt: string;
  mode: string;
  version: string;
  summary: {
    tenants: number;
    graphObjects: number;
    tasks: number;
    events: number;
    evidence: number;
    capabilities: number;
    workers: number;
    budgets: number;
    adapters: number;
  };
  checks: Check[];
};

export type HealthInput = {
  dbOk: boolean;
  dbError?: string | null;
  counts: {
    tenants: number;
    customers: number;
    leads: number;
    quotes: number;
    jobs: number;
    invoices: number;
    payments: number;
    tasks: number;
    evidence: number;
    events: number;
    capabilities: number;
    workers: number;
    budgetAccounts: number;
    adapters: number;
  };
};

export function getHealth(input: HealthInput): Health {
  const graphObjects =
    input.counts.customers +
    input.counts.leads +
    input.counts.quotes +
    input.counts.jobs +
    input.counts.invoices +
    input.counts.payments;

  const summary = {
    tenants: input.counts.tenants,
    graphObjects,
    tasks: input.counts.tasks,
    events: input.counts.events,
    evidence: input.counts.evidence,
    capabilities: input.counts.capabilities,
    workers: input.counts.workers,
    budgets: input.counts.budgetAccounts,
    adapters: input.counts.adapters,
  };

  const checks: Check[] = [
    {
      id: "database",
      state: input.dbOk ? "pass" : "fail",
      detail: input.dbOk ? "Postgres is reachable" : (input.dbError ?? "Postgres is unavailable"),
    },
    {
      id: "capability_registry",
      state: input.counts.capabilities >= 6 ? "pass" : "fail",
      detail: `${input.counts.capabilities} typed capabilities persisted`,
    },
    {
      id: "task_ledger",
      state: input.counts.tasks > 0 ? "pass" : "warn",
      detail: `${input.counts.tasks} persisted tasks visible`,
    },
    {
      id: "business_graph",
      state: graphObjects > 0 ? "pass" : "warn",
      detail: `${graphObjects} persisted graph objects visible`,
    },
    {
      id: "evidence",
      state: input.counts.evidence > 0 ? "pass" : "warn",
      detail: `${input.counts.evidence} evidence records visible`,
    },
    {
      id: "adapter_runtime",
      state: "warn",
      detail: `${input.counts.adapters} adapter records visible; external execution is not enabled yet`,
    },
  ];

  const status = checks.some((check) => check.state === "fail") ? "down" : "ok";

  return {
    service: "Continuous Core",
    status,
    checkedAt: new Date().toISOString(),
    mode: process.env.APP_ENV ?? "development",
    version: "0.1.0",
    summary,
    checks,
  };
}
