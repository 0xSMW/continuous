import { afterEach, describe, expect, it, vi } from "vitest";

import type { CoreSummary } from "../../src/core/summary";

const mocks = vi.hoisted(() => ({
  getCoreSummarySafe: vi.fn(),
}));

vi.mock("../../src/core/summary", () => ({
  getCoreSummarySafe: mocks.getCoreSummarySafe,
}));

const emptySummary: CoreSummary = {
  tenantName: null,
  counts: {
    tenants: 0,
    legalEntities: 0,
    people: 0,
    employments: 0,
    compensationAgreements: 0,
    paySchedules: 0,
    payrollRuns: 0,
    payrollStatements: 0,
    payrollLines: 0,
    payrollLiabilities: 0,
    payrollTraces: 0,
    rulePacks: 0,
    obligations: 0,
    filingRequirements: 0,
    filingDrafts: 0,
    bankAccounts: 0,
    paymentInstructions: 0,
    workflowDefinitions: 0,
    workflowRuns: 0,
    workflowSteps: 0,
    workerRuns: 0,
    approvalRequests: 0,
    auditEvents: 0,
    objects: 0,
    objectLinks: 0,
    objectVersions: 0,
    documents: 0,
    decisions: 0,
    evaluations: 0,
    entityIdentifiers: 0,
    customers: 0,
    customerSignals: 0,
    leads: 0,
    offers: 0,
    quotes: 0,
    jobs: 0,
    invoices: 0,
    payments: 0,
    tasks: 0,
    evidence: 0,
    evidencePackets: 0,
    events: 0,
    capabilities: 0,
    capabilityGrants: 0,
    workers: 0,
    modelProviders: 0,
    modelRoutes: 0,
    budgetPolicies: 0,
    budgetPools: 0,
    budgetAccounts: 0,
    budgetAllocations: 0,
    budgetReservations: 0,
    usageEvents: 0,
    generatedViews: 0,
    adapters: 0,
    connections: 0,
    adapterRuns: 0,
    adapterActions: 0,
    inferences: 0,
  },
  activeTasks: [],
  recentEvents: [],
};

function readySummary(): CoreSummary {
  return {
    ...emptySummary,
    tenantName: "Continuous Demo",
    counts: {
      ...emptySummary.counts,
      tenants: 1,
      legalEntities: 1,
      entityIdentifiers: 1,
      people: 1,
      employments: 1,
      compensationAgreements: 1,
      paySchedules: 1,
      payrollRuns: 1,
      payrollStatements: 1,
      payrollLines: 1,
      payrollLiabilities: 1,
      payrollTraces: 1,
      rulePacks: 1,
      obligations: 1,
      filingRequirements: 1,
      filingDrafts: 1,
      bankAccounts: 1,
      paymentInstructions: 1,
      workflowDefinitions: 1,
      workflowRuns: 1,
      workflowSteps: 1,
      workerRuns: 1,
      approvalRequests: 1,
      auditEvents: 1,
      objects: 1,
      objectLinks: 1,
      objectVersions: 1,
      documents: 1,
      customers: 1,
      customerSignals: 1,
      leads: 1,
      offers: 1,
      quotes: 1,
      jobs: 1,
      invoices: 1,
      payments: 1,
      tasks: 1,
      evidence: 1,
      evidencePackets: 1,
      events: 1,
      capabilities: 6,
      workers: 1,
      modelProviders: 1,
      modelRoutes: 1,
      budgetPolicies: 1,
      budgetAccounts: 1,
      budgetAllocations: 1,
      budgetReservations: 1,
      usageEvents: 1,
      adapters: 1,
      connections: 1,
      adapterRuns: 1,
      adapterActions: 1,
      inferences: 1,
    },
  };
}

describe("/health route", () => {
  afterEach(() => {
    vi.resetAllMocks();
  });

  it("serializes healthy Core checks from the canonical route", async () => {
    mocks.getCoreSummarySafe.mockResolvedValue({
      ok: true,
      error: null,
      summary: readySummary(),
    });

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body).toMatchObject({
      service: "Continuous Core",
      status: "ok",
      mode: "test",
      version: "0.1.0",
    });
    expect(body.checkedAt).toEqual(expect.any(String));
    expect(body.checks).toEqual([
      { id: "database", state: "pass" },
      { id: "capability_registry", state: "pass" },
      { id: "task_ledger", state: "pass" },
      { id: "object_spine", state: "pass" },
      { id: "business_graph", state: "pass" },
      { id: "canonical_operating_layer", state: "pass" },
      { id: "workflow_spine", state: "pass" },
      { id: "worker_run_ledger", state: "pass" },
      { id: "authority_ledger", state: "pass" },
      { id: "evidence", state: "pass" },
      { id: "ai_gateway", state: "pass" },
      { id: "budget_ledger", state: "pass" },
      { id: "adapter_runtime", state: "pass" },
    ]);
  });

  it("returns 503 and failed database check when Core summary is unavailable", async () => {
    mocks.getCoreSummarySafe.mockResolvedValue({
      ok: false,
      error: "database unavailable",
      summary: emptySummary,
    });

    const { GET } = await import("./route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.status).toBe("down");
    expect(body.checks[0]).toEqual({ id: "database", state: "fail" });
    expect(body.checks).toContainEqual({ id: "capability_registry", state: "fail" });
  });

  it("keeps the legacy /api/health alias on the same response contract", async () => {
    mocks.getCoreSummarySafe.mockResolvedValue({
      ok: true,
      error: null,
      summary: readySummary(),
    });

    const { GET } = await import("../api/health/route");
    const response = await GET();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.service).toBe("Continuous Core");
    expect(body.checks.map((check: { id: string }) => check.id)).toEqual([
      "database",
      "capability_registry",
      "task_ledger",
      "object_spine",
      "business_graph",
      "canonical_operating_layer",
      "workflow_spine",
      "worker_run_ledger",
      "authority_ledger",
      "evidence",
      "ai_gateway",
      "budget_ledger",
      "adapter_runtime",
    ]);
  });
});
