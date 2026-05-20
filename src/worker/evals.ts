import type { JsonObject } from "../db/schema";
import type { OwnerBriefRunResult } from "./owner";
import type { RevenueWorkerRunResult } from "./revenue";

export type RevenueWorkerEvalCase = {
  id: string;
  name: string;
  idempotencyKey: string;
  worker: {
    role: "revenue_operations";
    tenantSlug: string;
  };
  config: JsonObject;
  expected: {
    classification: string;
    taskState: string;
    runState: string;
    runMode: string;
    externalExecution: "disabled";
    maxBudgetUnits: number;
    quoteTotalCents: number;
    draftIncludes: string;
    minScore: number;
  };
};

export type RevenueWorkerBlockedEvalCase = {
  id: string;
  name: string;
  idempotencyKey: string;
  worker: {
    role: "revenue_operations";
    tenantSlug: string;
  };
  config: JsonObject;
  expected: {
    errorCode: string;
    status: number;
    messageIncludes: string;
  };
};

export type RevenueWorkerEvalDimension = {
  id: string;
  passed: boolean;
  weight: number;
  detail: string;
};

export type RevenueWorkerEvalResult = {
  caseId: string;
  score: number;
  passed: boolean;
  dimensions: RevenueWorkerEvalDimension[];
};

export type OwnerBriefEvalCase = {
  id: string;
  name: string;
  idempotencyKey: string;
  worker: {
    role: "owner_chief_of_staff";
    tenantSlug: string;
  };
  config: JsonObject;
  expected: {
    requiredScopes: string[];
    maxBudgetUnits: number;
    minDecisionCount: number;
    minScore: number;
  };
};

const requiredIds: Array<keyof RevenueWorkerRunResult> = [
  "workerRunId",
  "eventId",
  "taskId",
  "sourceSnapshotEvidenceId",
  "evidenceId",
  "reservationId",
  "inferenceId",
  "usageEventId",
  "adapterRunId",
  "adapterActionId",
  "adapterReceiptEvidenceId",
  "approvalRequestId",
  "quoteApprovalViewId",
  "auditEventId",
  "workflowRunId",
];

export const revenueWorkerEvalCases: RevenueWorkerEvalCase[] = [
  {
    id: "revenue.lead_to_quote.approval_blocked",
    name: "Lead-to-quote run requests approval and blocks external execution",
    idempotencyKey: "eval-revenue-lead-to-quote-approval-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-lead-to-quote",
        customerName: "Acme Roof Repair",
        customerIntent: "roof leak inspection",
        urgency: "high",
        serviceArea: "roofing",
        missingFacts: ["preferred_time_window"],
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_ready_for_owner_approval",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 27400,
      draftIncludes: "roof leak inspection",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.urgent_service.approval_blocked",
    name: "Urgent lead packet changes classification, draft, and quote while blocking send",
    idempotencyKey: "eval-revenue-urgent-service-approval-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-urgent-service",
        customerName: "Beacon Bakery",
        customerIntent: "emergency HVAC repair",
        urgency: "emergency",
        serviceArea: "hvac",
        missingFacts: [],
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "urgent_quote_ready_for_owner_approval",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 29400,
      draftIncludes: "emergency HVAC repair",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.core_intake_refs.approval_blocked",
    name: "Persisted Core lead intake refs resolve into the same approval-blocked quote loop",
    idempotencyKey: "eval-revenue-core-intake-refs-approval-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      intake: {
        objectId: "lead_object_uuid",
        eventId: "lead_received_event_uuid",
        evidenceId: "lead_snapshot_evidence_uuid",
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_ready_for_owner_approval",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 27400,
      draftIncludes: "roof leak inspection",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.source_intake_selector.approval_blocked",
    name: "Source selector intake resolves into the same approval-blocked quote loop",
    idempotencyKey: "eval-revenue-source-intake-selector-approval-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      intake: {
        source: "website_form",
        sourceEventId: "eval-form-source-selector",
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_ready_for_owner_approval",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 27400,
      draftIncludes: "roof leak inspection",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.normal_gutter_quote.approval_blocked",
    name: "Normal-urgency gutter lead stays approval-blocked without urgency pricing",
    idempotencyKey: "eval-revenue-normal-gutter-approval-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-normal-gutter",
        customerName: "Oak Street Cafe",
        customerIntent: "gutter cleaning",
        urgency: "normal",
        serviceArea: "gutter",
        missingFacts: [],
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_ready_for_owner_approval",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 12900,
      draftIncludes: "gutter cleaning",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.missing_facts.owner_review",
    name: "Missing critical lead facts keep the quote in owner review before customer response",
    idempotencyKey: "eval-revenue-missing-facts-owner-review",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-missing-facts",
        customerName: "Summit Property Group",
        customerIntent: "window replacement",
        urgency: "normal",
        serviceArea: "windows",
        missingFacts: ["window_count", "rough_dimensions", "site_access_notes"],
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_needs_facts_for_owner_review",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 18900,
      draftIncludes: "window_count",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.pricing_override.approval_blocked",
    name: "Pricing override changes the quote total while preserving approval and no-send policy",
    idempotencyKey: "eval-revenue-pricing-override-approval-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-pricing-override",
        customerName: "Northline Office Park",
        customerIntent: "HVAC maintenance visit",
        urgency: "normal",
        serviceArea: "hvac",
        missingFacts: [],
      },
      pricing: {
        baseCents: 50100,
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_ready_for_owner_approval",
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "disabled",
      maxBudgetUnits: 12000,
      quoteTotalCents: 50100,
      draftIncludes: "$501.00",
      minScore: 0.9,
    },
  },
];

export const revenueWorkerBlockedEvalCases: RevenueWorkerBlockedEvalCase[] = [
  {
    id: "revenue.policy_risk.external_send_blocked",
    name: "Policy-risk request to send externally is rejected before worker ledgers are written",
    idempotencyKey: "eval-revenue-policy-risk-external-send-blocked",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-policy-risk",
        customerName: "Policy Risk Plumbing",
        customerIntent: "same-day leak repair",
        urgency: "high",
        serviceArea: "plumbing",
        missingFacts: [],
        externalSend: true,
      },
      expectedAction: "send_customer_response",
      externalSend: true,
    },
    expected: {
      errorCode: "worker_external_send_blocked",
      status: 403,
      messageIncludes: "cannot send externally",
    },
  },
];

export const ownerBriefEvalCases: OwnerBriefEvalCase[] = [
  {
    id: "owner.daily_brief.review_ready",
    name: "Owner brief summarizes Core sources, proposes decisions, and blocks external execution",
    idempotencyKey: "eval-owner-daily-brief-review-ready",
    worker: {
      role: "owner_chief_of_staff",
      tenantSlug: "continuous-demo",
    },
    config: {
      window: {
        from: "2026-05-19T00:00:00.000Z",
        to: "2026-05-20T00:00:00.000Z",
      },
      scopes: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
      includeEvidence: true,
    },
    expected: {
      requiredScopes: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
      maxBudgetUnits: 4000,
      minDecisionCount: 1,
      minScore: 0.9,
    },
  },
];

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return 0;
}

function addDimension(
  dimensions: RevenueWorkerEvalDimension[],
  id: string,
  passed: boolean,
  weight: number,
  detail: string,
) {
  dimensions.push({ id, passed, weight, detail });
}

export function scoreRevenueWorkerRun(
  result: RevenueWorkerRunResult,
  evalCase: RevenueWorkerEvalCase,
): RevenueWorkerEvalResult {
  const dimensions: RevenueWorkerEvalDimension[] = [];
  const missingIds = requiredIds.filter((key) => !result[key]);
  const matchingTask = result.snapshot.activeTasks.find((task) => {
    const outcome = objectValue(task.outcome);
    return outcome.approvalRequestId === result.approvalRequestId;
  });
  const matchingTaskOutcome = objectValue(matchingTask?.outcome);
  const matchingTaskCost = objectValue(matchingTask?.cost);
  const output = objectValue(result.output);
  const quote = objectValue(output.quote);
  const quotePolicy = objectValue(quote.policy);
  const budgetUnits = numberValue(matchingTaskCost.units);

  addDimension(
    dimensions,
    "ledger_links",
    missingIds.length === 0,
    2,
    missingIds.length === 0 ? "all required worker ledgers are linked" : `missing ${missingIds.join(", ")}`,
  );

  addDimension(
    dimensions,
    "external_execution",
    result.snapshot.controls.externalExecution === evalCase.expected.externalExecution,
    2,
    `external execution is ${result.snapshot.controls.externalExecution}`,
  );

  addDimension(
    dimensions,
    "approval_task",
    matchingTask?.state === evalCase.expected.taskState &&
      stringValue(matchingTaskOutcome.status) === evalCase.expected.classification,
    2,
    matchingTask
      ? `task ${matchingTask.id} is ${matchingTask.state} with status ${stringValue(matchingTaskOutcome.status)}`
      : "no approval task links to the approval request",
  );

  addDimension(
    dimensions,
    "latest_run",
    result.snapshot.latestRun?.state === evalCase.expected.runState &&
      result.snapshot.latestRun?.mode === evalCase.expected.runMode,
    1,
    result.snapshot.latestRun
      ? `latest run is ${result.snapshot.latestRun.state}/${result.snapshot.latestRun.mode}`
      : "latest run is missing",
  );

  addDimension(
    dimensions,
    "budget",
    budgetUnits > 0 && budgetUnits <= evalCase.expected.maxBudgetUnits,
    1,
    `task budget units ${budgetUnits}`,
  );

  addDimension(
    dimensions,
    "adapter_receipt",
    Boolean(result.adapterRunId && result.adapterActionId && result.adapterReceiptEvidenceId),
    2,
    result.adapterReceiptEvidenceId ? "adapter dry-run receipt evidence is linked" : "adapter receipt is missing",
  );

  addDimension(
    dimensions,
    "workflow_spine",
    Boolean(result.workflowRunId) &&
      result.workflowStepIds.length >= 4 &&
      stringValue(output.workflowRunId) === result.workflowRunId,
    2,
    result.workflowRunId
      ? `workflow ${result.workflowRunId} has ${result.workflowStepIds.length} steps`
      : "workflow spine is missing",
  );

  addDimension(
    dimensions,
    "quote_approval_view",
    Boolean(result.quoteApprovalViewId) &&
      stringValue(output.quoteApprovalViewId) === result.quoteApprovalViewId,
    1,
    result.quoteApprovalViewId
      ? `quote approval view ${result.quoteApprovalViewId} is linked`
      : "quote approval view is missing",
  );

  addDimension(
    dimensions,
    "input_derived_packet",
    result.sourceSnapshotEvidenceId === stringValue(output.sourceSnapshotEvidenceId) &&
      stringValue(output.classification) === evalCase.expected.classification &&
      stringValue(output.draftResponse).includes(evalCase.expected.draftIncludes) &&
      numberValue(quote.totalCents) === evalCase.expected.quoteTotalCents &&
      output.externalSend === false,
    2,
    `classification ${stringValue(output.classification)} quote ${numberValue(quote.totalCents)}`,
  );

  addDimension(
    dimensions,
    "policy_guardrails",
    quotePolicy.approvalRequired === true &&
      quotePolicy.externalSend === false &&
      quotePolicy.moneyMovement === "blocked" &&
      output.externalSend === false,
    2,
    quotePolicy.moneyMovement === "blocked"
      ? "quote policy blocks money movement and external send"
      : "quote policy guardrails are missing",
  );

  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const passedWeight = dimensions.reduce(
    (sum, dimension) => sum + (dimension.passed ? dimension.weight : 0),
    0,
  );
  const score = totalWeight > 0 ? Number((passedWeight / totalWeight).toFixed(3)) : 0;

  return {
    caseId: evalCase.id,
    score,
    passed: score >= evalCase.expected.minScore && dimensions.every((dimension) => dimension.passed),
    dimensions,
  };
}

const ownerRequiredIds: Array<keyof OwnerBriefRunResult> = [
  "workerRunId",
  "eventId",
  "objectId",
  "objectVersionId",
  "evidenceId",
  "documentId",
  "packetId",
  "approvalRequestId",
  "auditEventId",
  "reservationId",
  "usageEventId",
  "workflowRunId",
];

export function scoreOwnerBriefRun(
  result: OwnerBriefRunResult,
  evalCase: OwnerBriefEvalCase,
): RevenueWorkerEvalResult {
  const dimensions: RevenueWorkerEvalDimension[] = [];
  const missingIds = ownerRequiredIds.filter((key) => !result[key]);
  const output = objectValue(result.output);
  const sourceCounts = objectValue(output.sourceCounts);
  const redaction = objectValue(output.redaction);
  const sectionKeys = Array.isArray(output.sections)
    ? output.sections
        .map((section) => objectValue(section).key)
        .filter((key): key is string => typeof key === "string")
    : [];
  const externalExecution =
    output.externalExecution === "blocked" &&
    output.externalSend === false &&
    result.snapshot.controls.externalExecution === "disabled";

  addDimension(
    dimensions,
    "ledger_links",
    missingIds.length === 0 && result.workflowStepIds.length >= 3,
    2,
    missingIds.length === 0
      ? `owner brief links ${result.workflowStepIds.length} workflow steps`
      : `missing ${missingIds.join(", ")}`,
  );

  addDimension(
    dimensions,
    "source_coverage",
    evalCase.expected.requiredScopes.every((scope) => sectionKeys.includes(scope)) &&
      numberValue(sourceCounts.tasks) >= 0 &&
      numberValue(sourceCounts.workers) > 0,
    2,
    `sections ${sectionKeys.join(", ") || "none"}`,
  );

  addDimension(
    dimensions,
    "decision_queue",
    result.decisionIds.length >= evalCase.expected.minDecisionCount,
    1,
    `${result.decisionIds.length} decision proposals`,
  );

  addDimension(
    dimensions,
    "redaction",
    redaction.bankAccountNumbers === "redacted" &&
      redaction.payrollDetails === "redacted" &&
      redaction.privateMessageBodies === "redacted",
    2,
    "sensitive owner brief fields are redacted by default",
  );

  addDimension(
    dimensions,
    "external_execution",
    externalExecution,
    2,
    externalExecution ? "external execution blocked" : "external execution was not blocked",
  );

  addDimension(
    dimensions,
    "budget",
    numberValue(output.budgetBurn ? objectValue(output.budgetBurn).usedUnits : 0) >= 0 &&
      result.snapshot.budget.usedUnits <= evalCase.expected.maxBudgetUnits,
    1,
    `owner worker used ${result.snapshot.budget.usedUnits} units`,
  );

  addDimension(
    dimensions,
    "views",
    result.viewIds.length >= 3 && result.snapshot.controls.generatedViews >= 3,
    1,
    `${result.viewIds.length} owner views published`,
  );

  const totalWeight = dimensions.reduce((sum, dimension) => sum + dimension.weight, 0);
  const passedWeight = dimensions.reduce(
    (sum, dimension) => sum + (dimension.passed ? dimension.weight : 0),
    0,
  );
  const score = totalWeight > 0 ? Number((passedWeight / totalWeight).toFixed(3)) : 0;

  return {
    caseId: evalCase.id,
    score,
    passed: score >= evalCase.expected.minScore && dimensions.every((dimension) => dimension.passed),
    dimensions,
  };
}
