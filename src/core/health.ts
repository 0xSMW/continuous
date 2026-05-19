import type { CoreSummary } from "./summary";

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
    objectSpine: number;
    operatingObjects: number;
    workflows: number;
    workerRuns: number;
    tasks: number;
    events: number;
    evidence: number;
    capabilities: number;
    workers: number;
    aiGateway: number;
    budgets: number;
    budgetLedger: number;
    adapters: number;
    adapterLedger: number;
  };
  checks: Check[];
};

export type HealthInput = {
  dbOk: boolean;
  dbError?: string | null;
  counts: CoreSummary["counts"];
};

export function getHealth(input: HealthInput): Health {
  const graphObjects =
    input.counts.objects +
    input.counts.customers +
    input.counts.leads +
    input.counts.offers +
    input.counts.quotes +
    input.counts.jobs +
    input.counts.invoices +
    input.counts.payments;
  const objectSpine =
    input.counts.objects + input.counts.objectLinks + input.counts.objectVersions;
  const operatingObjects =
    input.counts.legalEntities +
    input.counts.entityIdentifiers +
    input.counts.people +
    input.counts.employments +
    input.counts.compensationAgreements +
    input.counts.paySchedules +
    input.counts.payrollRuns +
    input.counts.rulePacks +
    input.counts.obligations +
    input.counts.filingRequirements +
    input.counts.filingDrafts +
    input.counts.bankAccounts +
    input.counts.paymentInstructions;
  const aiGateway =
    input.counts.modelProviders +
    input.counts.modelRoutes +
    input.counts.inferences +
    input.counts.usageEvents;
  const budgetLedger =
    input.counts.budgetPolicies +
    input.counts.budgetPools +
    input.counts.budgetAccounts +
    input.counts.budgetAllocations +
    input.counts.budgetReservations;
  const adapterLedger =
    input.counts.adapters +
    input.counts.connections +
    input.counts.adapterRuns +
    input.counts.adapterActions;

  const summary = {
    tenants: input.counts.tenants,
    graphObjects,
    objectSpine,
    operatingObjects,
    workflows: input.counts.workflowRuns,
    workerRuns: input.counts.workerRuns,
    tasks: input.counts.tasks,
    events: input.counts.events,
    evidence: input.counts.evidence,
    capabilities: input.counts.capabilities,
    workers: input.counts.workers,
    aiGateway,
    budgets: input.counts.budgetAccounts,
    budgetLedger,
    adapters: input.counts.adapters,
    adapterLedger,
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
      id: "object_spine",
      state: input.counts.objects > 0 && input.counts.objectVersions > 0 ? "pass" : "warn",
      detail: `${input.counts.objects} objects, ${input.counts.objectLinks} links, and ${input.counts.objectVersions} versions visible`,
    },
    {
      id: "business_graph",
      state: graphObjects > 0 ? "pass" : "warn",
      detail: `${graphObjects} persisted graph objects visible`,
    },
    {
      id: "canonical_operating_layer",
      state: operatingObjects >= 10 ? "pass" : "warn",
      detail: `${operatingObjects} entity, workforce, payroll, filing, compliance, and payment records visible`,
    },
    {
      id: "workflow_spine",
      state: input.counts.workflowDefinitions > 0 && input.counts.workflowRuns > 0 ? "pass" : "warn",
      detail: `${input.counts.workflowDefinitions} workflow definitions and ${input.counts.workflowRuns} workflow runs visible`,
    },
    {
      id: "worker_run_ledger",
      state: input.counts.workerRuns > 0 ? "pass" : "warn",
      detail: `${input.counts.workerRuns} worker run lifecycle records visible`,
    },
    {
      id: "evidence",
      state: input.counts.evidence > 0 && input.counts.documents > 0 ? "pass" : "warn",
      detail: `${input.counts.evidence} evidence records and ${input.counts.documents} document packets visible`,
    },
    {
      id: "ai_gateway",
      state:
        input.counts.modelProviders > 0 &&
        input.counts.modelRoutes > 0 &&
        input.counts.budgetAccounts > 0
          ? "pass"
          : "warn",
      detail: `${input.counts.modelProviders} providers, ${input.counts.modelRoutes} routes, ${input.counts.inferences} inferences, and ${input.counts.usageEvents} usage records visible`,
    },
    {
      id: "budget_ledger",
      state:
        input.counts.budgetPolicies > 0 &&
        input.counts.budgetAllocations > 0 &&
        input.counts.budgetAccounts > 0
          ? "pass"
          : "warn",
      detail: `${input.counts.budgetPolicies} policies, ${input.counts.budgetAllocations} allocations, ${input.counts.budgetReservations} reservations, and ${input.counts.usageEvents} usage records visible`,
    },
    {
      id: "adapter_runtime",
      state: input.counts.adapters > 0 && input.counts.connections > 0 ? "pass" : "warn",
      detail: `${input.counts.adapters} adapters, ${input.counts.connections} connections, ${input.counts.adapterRuns} runs, and ${input.counts.adapterActions} actions visible; external execution is not enabled yet`,
    },
  ];

  const status = checks.some((check) => check.state === "fail")
    ? "down"
    : checks.some((check) => check.state === "warn")
      ? "degraded"
      : "ok";

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
