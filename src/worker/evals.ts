import type { JsonObject } from "../db/schema";
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
  "auditEventId",
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
    "input_derived_packet",
    result.sourceSnapshotEvidenceId === stringValue(output.sourceSnapshotEvidenceId) &&
      stringValue(output.classification) === evalCase.expected.classification &&
      stringValue(output.draftResponse).includes(evalCase.expected.draftIncludes) &&
      numberValue(quote.totalCents) === evalCase.expected.quoteTotalCents &&
      output.externalSend === false,
    2,
    `classification ${stringValue(output.classification)} quote ${numberValue(quote.totalCents)}`,
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
