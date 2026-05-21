import type { JsonObject } from "../db/schema";
import type { ComplianceFilingPrepareResult } from "./compliance";
import type { OwnerBriefRunResult } from "./owner";
import type { RevenueWorkerActionResult, RevenueWorkerRunResult } from "./revenue";

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

export type RevenueWorkerActionEvalCase = {
  id: string;
  name: string;
  command: "lead.classify" | "response.draft";
  idempotencyKey: string;
  worker: {
    role: "revenue_operations";
    tenantSlug: string;
  };
  config: JsonObject;
  expected: {
    classification: string;
    runState: string;
    runMode: "classification" | "draft";
    externalExecution: "disabled";
    quoteTotalCents?: number;
    draftIncludes?: string;
    missingFact?: string;
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

export type ComplianceWorkerEvalCase = {
  id: string;
  name: string;
  idempotencyKey: string;
  worker: {
    role: "compliance_operations";
    tenantSlug: string;
  };
  config: JsonObject;
  expected: {
    taskState: "approval_required" | "blocked";
    runState: string;
    runMode: string;
    externalExecution: "blocked";
    agencySubmission: "blocked";
    legalAdvice: "blocked";
    sensitiveData: "redacted";
    minSourceRefs: number;
    minWorkflowSteps: number;
    minGeneratedViews: number;
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

const actionRequiredIds: Array<keyof RevenueWorkerActionResult> = [
  "workerRunId",
  "eventId",
  "reservationId",
  "inferenceId",
  "usageEventId",
  "evidenceId",
  "auditEventId",
];

const complianceRequiredIds = [
  "workerRunId",
  "eventId",
  "taskId",
  "filingObjectId",
  "filingDraftId",
  "filingRequirementId",
  "obligationId",
  "rulePackId",
  "approvalRequestId",
  "evidenceId",
  "packetId",
  "documentId",
  "workflowRunId",
  "complianceViewId",
] as const;

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

export const revenueWorkerActionEvalCases: RevenueWorkerActionEvalCase[] = [
  {
    id: "revenue.lead_classify.missing_facts_trace",
    name: "Lead classify records a trace and keeps missing-fact review blocked",
    command: "lead.classify",
    idempotencyKey: "eval-revenue-lead-classify-missing-facts-trace",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-action-classify",
        customerName: "Circuit City But Not That One",
        customerIntent: "panel upgrade estimate",
        urgency: "normal",
        serviceArea: "electrical",
        missingFacts: ["panel_amperage", "permit_jurisdiction", "photos"],
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_needs_facts_for_owner_review",
      runState: "done",
      runMode: "classification",
      externalExecution: "disabled",
      missingFact: "panel_amperage",
      minScore: 0.9,
    },
  },
  {
    id: "revenue.response_draft.owner_review_packet",
    name: "Response draft records a no-send customer draft with quote guardrails",
    command: "response.draft",
    idempotencyKey: "eval-revenue-response-draft-owner-review-packet",
    worker: {
      role: "revenue_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      leadPacket: {
        source: "website_form",
        sourceEventId: "eval-form-action-draft",
        customerName: "Mario's Midnight Plumbing",
        customerIntent: "burst pipe repair",
        urgency: "high",
        serviceArea: "plumbing",
        missingFacts: [],
      },
      expectedAction: "draft_customer_response",
      externalSend: false,
    },
    expected: {
      classification: "quote_ready_for_owner_approval",
      runState: "done",
      runMode: "draft",
      externalExecution: "disabled",
      quoteTotalCents: 18400,
      draftIncludes: "burst pipe repair",
      minScore: 0.9,
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

export const complianceWorkerEvalCases: ComplianceWorkerEvalCase[] = [
  {
    id: "compliance.filing_prepare.review_packet",
    name: "Filing prepare records source-backed review packet and blocks agency submission",
    idempotencyKey: "eval-compliance-filing-prepare-review-packet",
    worker: {
      role: "compliance_operations",
      tenantSlug: "continuous-demo",
    },
    config: {
      filingRequirementId: "filing_requirement_uuid",
      obligationId: "obligation_uuid",
      period: {
        label: "April payroll tax filing",
        from: "2026-04-01T00:00:00.000Z",
        to: "2026-05-01T00:00:00.000Z",
      },
      sourceRefs: {
        ruleCitation: "Demo Revenue Code 12-34",
        payrollRunId: "payroll_run_uuid",
        ownerNote: "Do not let the spreadsheet wear a little crown.",
      },
      validation: {
        blockers: [],
      },
      policy: {
        legalAdvice: "blocked",
        sensitiveData: "redacted",
      },
    },
    expected: {
      taskState: "approval_required",
      runState: "done",
      runMode: "simulation",
      externalExecution: "blocked",
      agencySubmission: "blocked",
      legalAdvice: "blocked",
      sensitiveData: "redacted",
      minSourceRefs: 2,
      minWorkflowSteps: 2,
      minGeneratedViews: 1,
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

export function scoreRevenueWorkerAction(
  result: RevenueWorkerActionResult,
  evalCase: RevenueWorkerActionEvalCase,
): RevenueWorkerEvalResult {
  const dimensions: RevenueWorkerEvalDimension[] = [];
  const missingIds = actionRequiredIds.filter((key) => !result[key]);
  const output = objectValue(result.output);
  const quote = objectValue(output.quote);
  const quotePolicy = objectValue(quote.policy);
  const missingFacts = Array.isArray(output.missingFacts)
    ? output.missingFacts.filter((fact): fact is string => typeof fact === "string")
    : [];
  const latestRun = result.snapshot.latestRun;
  const latestRunMatches =
    latestRun?.workerRunId === result.workerRunId &&
    latestRun.state === evalCase.expected.runState &&
    latestRun.mode === evalCase.expected.runMode;
  const snapshotHasActionEvent = result.snapshot.recentEvents.some(
    (event) => event.id === result.eventId,
  );

  addDimension(
    dimensions,
    "ledger_links",
    missingIds.length === 0,
    2,
    missingIds.length === 0
      ? "action run links budget, inference, usage, evidence, event, and audit ledgers"
      : `missing ${missingIds.join(", ")}`,
  );

  addDimension(
    dimensions,
    "command_output",
    stringValue(output.command) === evalCase.command &&
      stringValue(output.classification) === evalCase.expected.classification,
    2,
    `command ${stringValue(output.command)} classified ${stringValue(output.classification)}`,
  );

  addDimension(
    dimensions,
    "snapshot_run",
    latestRunMatches || snapshotHasActionEvent,
    1,
    latestRunMatches
      ? `latest run is ${latestRun?.state}/${latestRun?.mode}`
      : snapshotHasActionEvent
        ? "action event is present in recent worker events"
        : "action run is missing from latest run and recent events",
  );

  addDimension(
    dimensions,
    "external_execution",
    result.snapshot.controls.externalExecution === evalCase.expected.externalExecution &&
      output.externalExecution === "blocked" &&
      output.externalSend === false,
    2,
    `snapshot=${result.snapshot.controls.externalExecution} output=${stringValue(output.externalExecution)}`,
  );

  addDimension(
    dimensions,
    "input_specific_output",
    (!evalCase.expected.missingFact || missingFacts.includes(evalCase.expected.missingFact)) &&
      (!evalCase.expected.draftIncludes ||
        stringValue(output.draftResponse).includes(evalCase.expected.draftIncludes)) &&
      (evalCase.expected.quoteTotalCents === undefined ||
        numberValue(quote.totalCents) === evalCase.expected.quoteTotalCents),
    2,
    evalCase.command === "lead.classify"
      ? `missing facts ${missingFacts.join(", ") || "none"}`
      : `draft quote ${numberValue(quote.totalCents)}`,
  );

  addDimension(
    dimensions,
    "policy_guardrails",
    evalCase.command === "lead.classify" ||
      (quotePolicy.approvalRequired === true &&
        quotePolicy.externalSend === false &&
        quotePolicy.moneyMovement === "blocked"),
    2,
    evalCase.command === "lead.classify"
      ? "classification has no external action surface"
      : "draft quote policy blocks external send and money movement",
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
    passed: score >= evalCase.expected.minScore,
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

export function scoreComplianceWorkerRun(
  result: ComplianceFilingPrepareResult,
  evalCase: ComplianceWorkerEvalCase,
): RevenueWorkerEvalResult {
  const dimensions: RevenueWorkerEvalDimension[] = [];
  const output = objectValue(result.output);
  const sourceRefs = objectValue(output.sourceRefs);
  const validation = objectValue(output.validation);
  const checks = objectValue(validation.checks);
  const policy = objectValue(output.policy);
  const redaction = objectValue(output.redaction);
  const handoff = objectValue(output.handoff);
  const sourceRefCount = Object.keys(sourceRefs).length;
  const outputStepIds = Array.isArray(output.workflowStepIds)
    ? output.workflowStepIds.filter((step): step is string => typeof step === "string")
    : [];
  const missingIds = complianceRequiredIds.filter((key) => !result[key]);
  const outputMismatches = complianceRequiredIds.filter((key) => stringValue(output[key]) !== result[key]);
  const approval = result.snapshot.approvals.find((item) => item.id === result.approvalRequestId);
  const filingDraft = result.snapshot.filingDrafts.find((draft) => draft.id === result.filingDraftId);
  const taskState =
    stringValue(output.taskState) ||
    (approval?.state === "pending" && filingDraft?.state === "review_ready" ? "approval_required" : "");
  const latestRun = result.snapshot.latestRun;
  const latestRunMatches =
    latestRun?.workerRunId === result.workerRunId &&
    latestRun.state === evalCase.expected.runState &&
    latestRun.mode === evalCase.expected.runMode;
  const ruleEvidence =
    Boolean(result.evidenceId && result.rulePackId) &&
    stringValue(output.rulePackId) === result.rulePackId &&
    sourceRefCount >= evalCase.expected.minSourceRefs &&
    checks.sourceRefs === true &&
    checks.rulePackActive === true;
  const legalAdvice = stringValue(output.legalAdvice) || stringValue(policy.legalAdvice);
  const guardrails =
    result.externalExecution === evalCase.expected.externalExecution &&
    output.externalExecution === evalCase.expected.externalExecution &&
    output.agencySubmission === evalCase.expected.agencySubmission &&
    result.snapshot.controls.externalExecution === evalCase.expected.externalExecution &&
    result.snapshot.controls.agencySubmission === evalCase.expected.agencySubmission &&
    legalAdvice === evalCase.expected.legalAdvice;
  const redactionProof =
    policy.sensitiveData === evalCase.expected.sensitiveData ||
    redaction.sensitiveData === evalCase.expected.sensitiveData ||
    (redaction.taxIdentifiers === "redacted" &&
      redaction.bankFields === "redacted" &&
      (redaction.rawAgencyCredentials === "never" ||
        redaction.rawAgencyCredentials === "blocked" ||
        redaction.rawAgencyCredentials === "redacted"));
  const handoffMatches =
    stringValue(handoff.name) === "compliance.obligation_to_owner_review" &&
    stringValue(handoff.filingDraftId) === result.filingDraftId &&
    stringValue(handoff.approvalRequestId) === result.approvalRequestId &&
    stringValue(handoff.packetId) === result.packetId &&
    stringValue(handoff.documentId) === result.documentId &&
    stringValue(handoff.workflowRunId) === result.workflowRunId &&
    handoff.externalExecution === evalCase.expected.externalExecution &&
    handoff.agencySubmission === evalCase.expected.agencySubmission;
  const workflowMatches =
    Boolean(result.workflowRunId) &&
    stringValue(output.workflowRunId) === result.workflowRunId &&
    result.workflowStepIds.length >= evalCase.expected.minWorkflowSteps &&
    result.workflowStepIds.every((stepId) => outputStepIds.includes(stepId));
  const viewMatches =
    Boolean(result.complianceViewId) &&
    stringValue(output.complianceViewId) === result.complianceViewId &&
    result.snapshot.controls.generatedViews >= evalCase.expected.minGeneratedViews;

  addDimension(
    dimensions,
    "primitive_ids",
    missingIds.length === 0 && outputMismatches.length === 0,
    2,
    missingIds.length === 0 && outputMismatches.length === 0
      ? "all compliance primitive ids are linked in output"
      : `missing ${missingIds.join(", ") || "none"} mismatched ${outputMismatches.join(", ") || "none"}`,
  );

  addDimension(
    dimensions,
    "source_rule_evidence",
    ruleEvidence,
    2,
    `source refs ${sourceRefCount}, rule pack ${result.rulePackId ?? "missing"}`,
  );

  addDimension(
    dimensions,
    "submission_guardrails",
    guardrails,
    2,
    `external=${stringValue(output.externalExecution)} agency=${stringValue(output.agencySubmission)} legal=${legalAdvice || "missing"}`,
  );

  addDimension(
    dimensions,
    "redaction",
    result.snapshot.controls.sensitiveData === evalCase.expected.sensitiveData && redactionProof,
    2,
    redactionProof ? "sensitive compliance fields have redaction proof" : "redaction proof is missing",
  );

  addDimension(
    dimensions,
    "compliance_handoff",
    handoffMatches,
    2,
    handoffMatches ? "handoff links approval, packet, document, and workflow" : "handoff ids are missing",
  );

  addDimension(
    dimensions,
    "review_surface",
    taskState === evalCase.expected.taskState &&
      approval?.state === "pending" &&
      filingDraft?.state === "review_ready" &&
      workflowMatches &&
      viewMatches,
    2,
    `task=${taskState || "missing"} approval=${approval?.state ?? "missing"} draft=${filingDraft?.state ?? "missing"} steps=${result.workflowStepIds.length}`,
  );

  addDimension(
    dimensions,
    "latest_run",
    latestRunMatches,
    1,
    latestRun ? `latest run is ${latestRun.state}/${latestRun.mode}` : "latest run is missing",
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
