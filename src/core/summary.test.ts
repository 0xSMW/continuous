import { describe, expect, it } from "vitest";

import { summarizeCoreReadiness, type CoreSummary } from "./summary";

const emptySummary: CoreSummary = {
  tenantName: null,
  counts: {
    tenants: 0,
    customers: 0,
    leads: 0,
    quotes: 0,
    jobs: 0,
    invoices: 0,
    payments: 0,
    tasks: 0,
    evidence: 0,
    events: 0,
    capabilities: 0,
    workers: 0,
    budgetAccounts: 0,
    usageEvents: 0,
    generatedViews: 0,
    adapters: 0,
  },
  activeTasks: [],
  recentEvents: [],
};

describe("summarizeCoreReadiness", () => {
  it("reports readiness from persisted primitive counts", () => {
    expect(
      summarizeCoreReadiness({
        ...emptySummary,
        counts: {
          ...emptySummary.counts,
          tenants: 1,
          customers: 1,
          leads: 1,
          tasks: 2,
          capabilities: 3,
          evidence: 1,
          budgetAccounts: 1,
        },
      }),
    ).toEqual({
      hasTenant: true,
      hasGraph: true,
      hasTaskLedger: true,
      hasCapabilities: true,
      hasEvidence: true,
      hasBudgets: true,
    });
  });
});
