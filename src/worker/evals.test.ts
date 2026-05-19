import { describe, expect, it } from "vitest";

import { revenueWorkerEvalCases, scoreRevenueWorkerRun } from "./evals";
import type { RevenueWorkerRunResult, RevenueWorkerSnapshot } from "./revenue";

const snapshot: RevenueWorkerSnapshot = {
  worker: {
    id: "worker_1",
    name: "Continuous Revenue Worker",
    role: "revenue_operations",
    state: "active",
    mission: "Convert demand into revenue",
    autonomyLevel: 2,
    scope: {},
    policy: {},
    kpis: {},
    managerName: "Owner",
    tenantName: "Continuous Demo",
  },
  budget: {
    accountId: "budget_1",
    name: "Revenue Worker monthly intelligence budget",
    usedUnits: 12000,
    heldUnits: 0,
    events: 1,
  },
  controls: {
    grantedCapabilities: 8,
    approvalTasks: 1,
    generatedViews: 1,
    externalExecution: "disabled",
  },
  activeTasks: [
    {
      id: "task_1",
      title: "Prepare quote",
      state: "approval_required",
      priority: "high",
      outcome: {
        status: "quote_ready_for_owner_approval",
        approvalRequestId: "approval_1",
      },
      cost: {
        units: 12000,
      },
    },
  ],
  recentEvents: [],
  latestRun: {
    id: "event_1",
    workerRunId: "worker_run_1",
    eventId: "event_1",
    idempotencyKey: "eval-revenue-lead-to-quote-approval-blocked",
    occurredAt: new Date("2026-05-19T00:00:00.000Z").toISOString(),
    state: "done",
    mode: "simulation",
  },
};

const completeResult: RevenueWorkerRunResult = {
  created: true,
  idempotencyKey: "eval-revenue-lead-to-quote-approval-blocked",
  workerRunId: "worker_run_1",
  eventId: "event_1",
  taskId: "task_1",
  evidenceId: "evidence_1",
  reservationId: "reservation_1",
  inferenceId: "inference_1",
  usageEventId: "usage_1",
  adapterRunId: "adapter_run_1",
  adapterActionId: "adapter_action_1",
  adapterReceiptEvidenceId: "receipt_1",
  approvalRequestId: "approval_1",
  auditEventId: "audit_1",
  snapshot,
};

describe("Revenue Worker evals", () => {
  it("passes a run that links ledgers, blocks external execution, and requests approval", () => {
    const result = scoreRevenueWorkerRun(completeResult, revenueWorkerEvalCases[0]);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.dimensions.every((dimension) => dimension.passed)).toBe(true);
  });

  it("fails when adapter receipt evidence is missing", () => {
    const result = scoreRevenueWorkerRun(
      {
        ...completeResult,
        adapterReceiptEvidenceId: null,
      },
      revenueWorkerEvalCases[0],
    );

    expect(result.passed).toBe(false);
    expect(result.dimensions.find((dimension) => dimension.id === "ledger_links")?.passed).toBe(
      false,
    );
    expect(result.dimensions.find((dimension) => dimension.id === "adapter_receipt")?.passed).toBe(
      false,
    );
  });
});
