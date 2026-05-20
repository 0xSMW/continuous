import { describe, expect, it } from "vitest";

import {
  ownerBriefEvalCases,
  revenueWorkerActionEvalCases,
  revenueWorkerBlockedEvalCases,
  revenueWorkerEvalCases,
  scoreOwnerBriefRun,
  scoreRevenueWorkerAction,
  scoreRevenueWorkerRun,
} from "./evals";
import type { OwnerBriefRunResult, OwnerWorkerSnapshot } from "./owner";
import type {
  RevenueWorkerActionResult,
  RevenueWorkerRunResult,
  RevenueWorkerSnapshot,
} from "./revenue";

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

const completeClassifyActionResult: RevenueWorkerActionResult = {
  created: true,
  idempotencyKey: "eval-revenue-lead-classify-missing-facts-trace",
  workerRunId: "worker_run_classify_1",
  eventId: "event_classify_1",
  reservationId: "reservation_classify_1",
  inferenceId: "inference_classify_1",
  usageEventId: "usage_classify_1",
  evidenceId: "evidence_classify_1",
  auditEventId: "audit_classify_1",
  output: {
    command: "lead.classify",
    source: "website_form",
    sourceEventId: "eval-form-action-classify",
    customerName: "Circuit City But Not That One",
    customerIntent: "panel upgrade estimate",
    serviceArea: "electrical",
    urgency: "normal",
    missingFacts: ["panel_amperage", "permit_jurisdiction", "photos"],
    classification: "quote_needs_facts_for_owner_review",
    expectedAction: "draft_customer_response",
    externalExecution: "blocked",
    externalSend: false,
    reason: "Lead needs owner-visible missing-fact review before any external send.",
  },
  snapshot: {
    ...snapshot,
    latestRun: {
      id: "event_classify_1",
      workerRunId: "worker_run_classify_1",
      eventId: "event_classify_1",
      idempotencyKey: "eval-revenue-lead-classify-missing-facts-trace",
      occurredAt: new Date("2026-05-19T00:01:00.000Z").toISOString(),
      state: "done",
      mode: "classification",
    },
  },
};

const completeDraftActionResult: RevenueWorkerActionResult = {
  created: true,
  idempotencyKey: "eval-revenue-response-draft-owner-review-packet",
  workerRunId: "worker_run_draft_1",
  eventId: "event_draft_1",
  reservationId: "reservation_draft_1",
  inferenceId: "inference_draft_1",
  usageEventId: "usage_draft_1",
  evidenceId: "evidence_draft_1",
  auditEventId: "audit_draft_1",
  output: {
    command: "response.draft",
    source: "website_form",
    sourceEventId: "eval-form-action-draft",
    customerName: "Mario's Midnight Plumbing",
    customerIntent: "burst pipe repair",
    serviceArea: "plumbing",
    urgency: "high",
    missingFacts: [],
    classification: "quote_ready_for_owner_approval",
    expectedAction: "draft_customer_response",
    externalExecution: "blocked",
    externalSend: false,
    draftResponse:
      "Hi Mario's, we can help with burst pipe repair. I prepared a $184.00 plumbing quote packet for owner review.",
    quote: {
      totalCents: 18400,
      currency: "USD",
      policy: {
        approvalRequired: true,
        externalSend: false,
        moneyMovement: "blocked",
      },
    },
  },
  snapshot: {
    ...snapshot,
    latestRun: {
      id: "event_draft_1",
      workerRunId: "worker_run_draft_1",
      eventId: "event_draft_1",
      idempotencyKey: "eval-revenue-response-draft-owner-review-packet",
      occurredAt: new Date("2026-05-19T00:02:00.000Z").toISOString(),
      state: "done",
      mode: "draft",
    },
  },
};

const ownerSnapshot: OwnerWorkerSnapshot = {
  worker: {
    id: "owner_chief_of_staff_1",
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
  approvalRequestId: "owner_approval_1",
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

  it("covers split classify and draft command eval fixtures", () => {
    expect(revenueWorkerActionEvalCases).toEqual([
      expect.objectContaining({
        id: "revenue.lead_classify.missing_facts_trace",
        command: "lead.classify",
        expected: expect.objectContaining({
          classification: "quote_needs_facts_for_owner_review",
          runMode: "classification",
          missingFact: "panel_amperage",
        }),
      }),
      expect.objectContaining({
        id: "revenue.response_draft.owner_review_packet",
        command: "response.draft",
        expected: expect.objectContaining({
          classification: "quote_ready_for_owner_approval",
          runMode: "draft",
          quoteTotalCents: 18400,
        }),
      }),
    ]);
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

  it("passes split command runs that link ledgers and block external execution", () => {
    const classifyScore = scoreRevenueWorkerAction(
      completeClassifyActionResult,
      revenueWorkerActionEvalCases[0],
    );
    const draftScore = scoreRevenueWorkerAction(
      completeDraftActionResult,
      revenueWorkerActionEvalCases[1],
    );

    expect(classifyScore.passed).toBe(true);
    expect(classifyScore.score).toBe(1);
    expect(classifyScore.dimensions.every((dimension) => dimension.passed)).toBe(true);
    expect(draftScore.passed).toBe(true);
    expect(draftScore.score).toBe(1);
    expect(draftScore.dimensions.every((dimension) => dimension.passed)).toBe(true);
  });

  it("keeps split command score tolerant when snapshot ordering points at another run", () => {
    const result = scoreRevenueWorkerAction(
      {
        ...completeClassifyActionResult,
        snapshot: {
          ...completeClassifyActionResult.snapshot,
          latestRun: {
            id: "event_old",
            workerRunId: "worker_run_old",
            eventId: "event_old",
            idempotencyKey: "stale-run",
            occurredAt: new Date("2026-05-18T00:00:00.000Z").toISOString(),
            state: "done",
            mode: "simulation",
          },
        },
      },
      revenueWorkerActionEvalCases[0],
    );

    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(revenueWorkerActionEvalCases[0].expected.minScore);
    expect(result.dimensions.find((dimension) => dimension.id === "snapshot_run")?.passed).toBe(
      false,
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
