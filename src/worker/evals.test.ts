import { describe, expect, it } from "vitest";

import {
  ownerBriefEvalCases,
  revenueWorkerBlockedEvalCases,
  revenueWorkerEvalCases,
  scoreOwnerBriefRun,
  scoreRevenueWorkerRun,
} from "./evals";
import type { OwnerBriefRunResult, OwnerWorkerSnapshot } from "./owner";
import type { RevenueWorkerRunResult, RevenueWorkerSnapshot } from "./revenue";

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

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
  sourceSnapshotEvidenceId: "source_snapshot_1",
  evidenceId: "evidence_1",
  reservationId: "reservation_1",
  inferenceId: "inference_1",
  usageEventId: "usage_1",
  adapterRunId: "adapter_run_1",
  adapterActionId: "adapter_action_1",
  adapterReceiptEvidenceId: "receipt_1",
  approvalRequestId: "approval_1",
  quoteApprovalViewId: "quote_view_1",
  auditEventId: "audit_1",
  workflowRunId: "workflow_run_1",
  workflowStepIds: ["workflow_step_1", "workflow_step_2", "workflow_step_3", "workflow_step_4"],
  output: {
    sourceSnapshotEvidenceId: "source_snapshot_1",
    quoteApprovalViewId: "quote_view_1",
    workflowRunId: "workflow_run_1",
    workflowStepIds: ["workflow_step_1", "workflow_step_2", "workflow_step_3", "workflow_step_4"],
    classification: "quote_ready_for_owner_approval",
    draftResponse: "Prepared roof leak inspection quote for owner approval.",
    quote: {
      totalCents: 27400,
      currency: "USD",
      policy: {
        approvalRequired: true,
        externalSend: false,
        moneyMovement: "blocked",
      },
    },
    externalSend: false,
  },
  snapshot,
};

const ownerSnapshot: OwnerWorkerSnapshot = {
  worker: {
    id: "owner_worker_1",
    name: "Owner Chief-of-Staff Worker",
    role: "owner_chief_of_staff",
    state: "active",
    mission: "Summarize operations for the owner",
    autonomyLevel: 1,
    scope: {},
    policy: {},
    kpis: {},
    managerName: "Owner",
    tenantName: "Continuous Demo",
  },
  budget: {
    accountId: "owner_budget_1",
    name: "Owner Worker monthly intelligence budget",
    usedUnits: 4000,
    heldUnits: 0,
    events: 1,
  },
  controls: {
    pendingApprovals: 1,
    openDecisions: 1,
    generatedViews: 3,
    externalExecution: "disabled",
  },
  activeTasks: [],
  recentBriefs: [],
  recentEvents: [],
  latestRun: {
    id: "owner_run_1",
    workerRunId: "owner_run_1",
    eventId: "owner_event_1",
    idempotencyKey: "eval-owner-daily-brief-review-ready",
    occurredAt: new Date("2026-05-19T00:00:00.000Z").toISOString(),
    state: "done",
    mode: "read_only",
  },
};

const completeOwnerResult: OwnerBriefRunResult = {
  created: true,
  idempotencyKey: "eval-owner-daily-brief-review-ready",
  workerRunId: "owner_run_1",
  eventId: "owner_event_1",
  objectId: "owner_brief_1",
  objectVersionId: "owner_brief_version_1",
  evidenceId: "owner_evidence_1",
  documentId: "owner_document_1",
  packetId: "owner_packet_1",
  auditEventId: "owner_audit_1",
  reservationId: "owner_reservation_1",
  usageEventId: "owner_usage_1",
  workflowRunId: "owner_workflow_1",
  workflowStepIds: ["owner_step_1", "owner_step_2", "owner_step_3"],
  decisionIds: ["owner_decision_1"],
  viewIds: ["owner_brief_view", "owner_decision_view", "owner_anomaly_view"],
  output: {
    sections: [
      { key: "tasks" },
      { key: "approvals" },
      { key: "cash" },
      { key: "capacity" },
      { key: "obligations" },
      { key: "workers" },
    ],
    sourceCounts: {
      tasks: 2,
      workers: 2,
    },
    budgetBurn: {
      usedUnits: 4000,
      heldUnits: 0,
      events: 1,
    },
    redaction: {
      bankAccountNumbers: "redacted",
      payrollDetails: "redacted",
      privateMessageBodies: "redacted",
    },
    externalExecution: "blocked",
    externalSend: false,
  },
  snapshot: ownerSnapshot,
};

describe("Revenue Worker evals", () => {
  it("covers direct lead packets and both canonical persisted-intake shapes", () => {
    const configs = revenueWorkerEvalCases.map((evalCase) => objectValue(evalCase.config));
    const intakeConfigs = configs.map((config) => objectValue(config.intake));

    expect(revenueWorkerEvalCases).toHaveLength(7);
    expect(configs.some((config) => Object.keys(objectValue(config.leadPacket)).length > 0)).toBe(true);
    expect(
      intakeConfigs.some((intake) => Boolean(intake.objectId && intake.eventId && intake.evidenceId)),
    ).toBe(true);
    expect(intakeConfigs.some((intake) => intake.source === "website_form" && intake.sourceEventId)).toBe(
      true,
    );
    expect(
      revenueWorkerEvalCases.some(
        (evalCase) =>
          evalCase.id === "revenue.normal_gutter_quote.approval_blocked" &&
          evalCase.expected.quoteTotalCents === 12900,
      ),
    ).toBe(true);
    expect(
      revenueWorkerEvalCases.some(
        (evalCase) =>
          evalCase.id === "revenue.missing_facts.owner_review" &&
          evalCase.expected.classification === "quote_needs_facts_for_owner_review" &&
          evalCase.expected.draftIncludes === "window_count",
      ),
    ).toBe(true);
    expect(
      revenueWorkerEvalCases.some(
        (evalCase) =>
          evalCase.id === "revenue.pricing_override.approval_blocked" &&
          evalCase.expected.quoteTotalCents === 50100,
      ),
    ).toBe(true);
  });

  it("covers policy-risk requests as blocked eval fixtures", () => {
    expect(revenueWorkerBlockedEvalCases).toEqual([
      expect.objectContaining({
        id: "revenue.policy_risk.external_send_blocked",
        expected: expect.objectContaining({
          errorCode: "worker_external_send_blocked",
          status: 403,
        }),
      }),
    ]);

    const blockedConfig = objectValue(revenueWorkerBlockedEvalCases[0]?.config);
    const leadPacket = objectValue(blockedConfig.leadPacket);

    expect(blockedConfig.externalSend).toBe(true);
    expect(leadPacket.externalSend).toBe(true);
  });

  it("passes a run that links ledgers, blocks external execution, and requests approval", () => {
    const result = scoreRevenueWorkerRun(completeResult, revenueWorkerEvalCases[0]);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.dimensions.every((dimension) => dimension.passed)).toBe(true);
    expect(result.dimensions.find((dimension) => dimension.id === "policy_guardrails")?.passed).toBe(
      true,
    );
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

describe("Owner Chief-of-Staff Worker evals", () => {
  it("passes a brief that links ledgers, covers sources, redacts data, and blocks execution", () => {
    const result = scoreOwnerBriefRun(completeOwnerResult, ownerBriefEvalCases[0]);

    expect(result.passed).toBe(true);
    expect(result.score).toBe(1);
    expect(result.dimensions.every((dimension) => dimension.passed)).toBe(true);
  });

  it("fails when sensitive redaction proof is missing", () => {
    const result = scoreOwnerBriefRun(
      {
        ...completeOwnerResult,
        output: {
          ...completeOwnerResult.output,
          redaction: {},
        },
      },
      ownerBriefEvalCases[0],
    );

    expect(result.passed).toBe(false);
    expect(result.dimensions.find((dimension) => dimension.id === "redaction")?.passed).toBe(false);
  });
});
