import { executeAdapterRetries, reconcileAdapterLedger } from "../core/adapters";
import {
  decideApproval,
  listApprovals,
  normalizeApprovalDecision,
} from "../core/approvals";
import { PlatformUnavailableError } from "../core/errors";
import type { JsonObject } from "../db/schema";
import {
  classifyRevenueLead,
  continueRevenueWorker,
  draftRevenueResponse,
  getRevenueReadinessSafe,
  getRevenueWorkerSnapshotSafe,
  prepareRevenuePaymentLink,
  prepareRevenueQuote,
  readRevenueLeads,
  RevenueWorkerUnavailableError,
  runRevenueWorker,
} from "./revenue";
import {
  continueOwnerWorker,
  generateOwnerBrief,
  getOwnerWorkerSnapshotSafe,
  listOwnerBriefs,
  listOwnerDecisions,
  ownerWorkerRole,
  prepareOwnerDecisionQueue,
  triageOwnerAnomalies,
} from "./owner";
import {
  dispatchWorkerRole,
  draftDispatchCustomerUpdate,
  getDispatchWorkerSnapshotSafe,
  prepareDispatchCloseout,
  proposeDispatchSchedule,
  routeDispatchException,
} from "./dispatch";
import {
  draftFinanceArFollowup,
  financeWorkerRole,
  generateFinanceCashForecast,
  getFinanceWorkerSnapshotSafe,
  prepareFinanceInvoice,
  prepareFinancePaymentDraft,
} from "./finance";
import {
  getWorkforceReadiness,
  getWorkforceWorkerSnapshotSafe,
  prepareWorkforceHirePacket,
  prepareWorkforcePayrollInput,
  workforceWorkerRole,
} from "./workforce";
import {
  complianceWorkerRole,
  getCompliancePacket,
  getComplianceWorkerSnapshotSafe,
  listComplianceObligations,
  prepareComplianceFiling,
} from "./compliance";
import {
  getOfferPricingPricePolicy,
  getOfferPricingWorkerSnapshotSafe,
  offerPricingWorkerRole,
  prepareOfferPricingMarginReview,
} from "./offer-pricing";
import {
  customerExperienceWorkerRole,
  getCustomerExperienceWorkerSnapshotSafe,
  listCustomerExperienceSignals,
  prepareCustomerRecoveryDraft,
} from "./customer-experience";
import {
  getGrowthWorkerSnapshotSafe,
  growthWorkerRole,
  listGrowthCampaigns,
  prepareGrowthCampaignDraft,
} from "./growth";
import {
  getSystemsRepairs,
  getSystemsWorkerSnapshotSafe,
  planSystemsAutomation,
  planSystemsSyncRepair,
  remediateSystemsDataQuality,
  reviewSystemsPermission,
  scanSystemsConnectorHealth,
  systemsWorkerRole,
} from "./systems";
import {
  isWorkerOperationIdentifier,
  isWorkerRoleIdentifier,
  workerOperationDescription,
  workerRoleDescription,
} from "./envelope";
import { plannedWorkerContractForRole, workerApiRoute } from "./planned-workers";
import { normalizeIdempotencyKey } from "./security";

export const workerApiVersion = "continuous.worker.v1";
const revenueWorkerRole = "revenue_operations";

export type WorkerTargetInput = {
  role?: string;
  id?: string;
  tenantSlug?: string;
};

export type WorkerTarget = {
  role: string;
  workerId?: string;
  tenantSlug?: string;
};

type WorkerResponseTarget = {
  role: string;
  id: string | null;
  tenantSlug: string | null;
};

type WorkerCommandContext = {
  target: WorkerTarget;
  operatorEmail: string;
  config: JsonObject;
  idempotencyKey?: string;
};

type WorkerCommandDefinition = {
  name: string;
  description: string;
  idempotency: "required" | "none";
  sideEffects: "internal" | "dry_run" | "approved_only" | "external" | "none";
  externalExecution: "blocked" | "dry_run" | "approved_only" | "enabled";
  requiresTenant?: boolean;
  configSchema?: WorkerConfigSchema;
  handle: (context: WorkerCommandContext) => Promise<unknown>;
};

type WorkerViewContext = {
  target: WorkerTarget;
  operatorEmail: string;
  config: JsonObject;
};

type WorkerViewDefinition = {
  name: string;
  description: string;
  configSchema?: WorkerConfigSchema;
  handle: (context: WorkerViewContext) => Promise<WorkerViewResult>;
};

type WorkerDefinition = {
  role: string;
  commands: Record<string, WorkerCommandDefinition>;
  views: Record<string, WorkerViewDefinition>;
};

type WorkerConfigSchema = {
  type: "object" | "array" | "string" | "number" | "boolean";
  description?: string;
  required?: string[];
  oneRequired?: string[];
  oneRequiredPaths?: string[][];
  properties?: Record<string, WorkerConfigSchema>;
  items?: WorkerConfigSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  additionalProperties?: boolean;
};

export type WorkerCommandResult = {
  worker: WorkerResponseTarget;
  command: string;
  result: unknown;
};

export type WorkerViewResult = {
  status?: number;
  data: {
    worker: WorkerResponseTarget;
    view: string;
    [key: string]: unknown;
  };
  error: string | null;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalLimit(value: unknown) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 100) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.limit must be an integer between 1 and 100.",
      400,
    );
  }

  return value;
}

function responseTarget(target: WorkerTarget, tenantSlug?: string | null): WorkerResponseTarget {
  return {
    role: target.role,
    id: target.workerId ?? null,
    tenantSlug: target.tenantSlug ?? tenantSlug ?? null,
  };
}

function unsupportedCommandMessage(definition: WorkerDefinition) {
  return `Worker command must be ${Object.keys(definition.commands).join(", ")}.`;
}

function unsupportedViewMessage(definition: WorkerDefinition) {
  return `Worker view must be ${Object.keys(definition.views).join(" or ")}.`;
}

function requireIdempotency(value: unknown) {
  const idempotency = normalizeIdempotencyKey(value);

  if (!idempotency.ok) {
    throw new PlatformUnavailableError("invalid_idempotency_key", idempotency.message, 400);
  }

  return idempotency.key;
}

function commandConfig(value: unknown): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new PlatformUnavailableError(
    "invalid_worker_command_config",
    "config must be an object when provided.",
    400,
  );
}

function viewConfig(value: unknown): JsonObject {
  if (value === undefined || value === null) {
    return {};
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new PlatformUnavailableError(
    "invalid_worker_view_config",
    "config must be an object when provided.",
    400,
  );
}

function describeFields(fields: string[]) {
  if (fields.length === 1) {
    return fields[0];
  }

  return `${fields.slice(0, -1).join(", ")} or ${fields[fields.length - 1]}`;
}

function describePathFields(paths: string[][], prefix: string) {
  return describeFields(paths.map((fieldPath) => `${prefix}.${fieldPath.join(".")}`));
}

function hasPathValue(record: Record<string, unknown>, path: string[]) {
  let current: unknown = record;

  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return false;
    }

    current = (current as Record<string, unknown>)[segment];
  }

  return current !== undefined && current !== null && current !== "";
}

function failConfig(message: string, code = "invalid_worker_command_config"): never {
  throw new PlatformUnavailableError(code, message, 400);
}

function validateConfigSchema(
  operationName: string,
  schema: WorkerConfigSchema,
  value: unknown,
  path = "config",
  errorCode = "invalid_worker_command_config",
) {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      failConfig(`${path} must be an object.`, errorCode);
    }

    const record = value as Record<string, unknown>;

    for (const field of schema.required ?? []) {
      if (record[field] === undefined || record[field] === null || record[field] === "") {
        failConfig(`${path}.${field} is required for ${operationName}.`, errorCode);
      }
    }

    if (schema.oneRequired && !schema.oneRequired.some((field) => record[field] !== undefined && record[field] !== null && record[field] !== "")) {
      failConfig(`${path}.${describeFields(schema.oneRequired)} is required for ${operationName}.`, errorCode);
    }

    if (schema.oneRequiredPaths && !schema.oneRequiredPaths.some((fieldPath) => hasPathValue(record, fieldPath))) {
      failConfig(`${describePathFields(schema.oneRequiredPaths, path)} is required for ${operationName}.`, errorCode);
    }

    if (schema.additionalProperties === false && schema.properties) {
      const allowed = new Set(Object.keys(schema.properties));
      const unexpected = Object.keys(record).filter((field) => !allowed.has(field));

      if (unexpected.length > 0) {
        failConfig(`${path} contains unsupported fields: ${unexpected.join(", ")}.`, errorCode);
      }
    }

    for (const [field, fieldSchema] of Object.entries(schema.properties ?? {})) {
      if (record[field] !== undefined && record[field] !== null) {
        validateConfigSchema(operationName, fieldSchema, record[field], `${path}.${field}`, errorCode);
      }
    }

    return;
  }

  if (schema.type === "array") {
    if (!Array.isArray(value)) {
      failConfig(`${path} must be an array.`, errorCode);
    }

    if (schema.minItems !== undefined && value.length < schema.minItems) {
      failConfig(`${path} must contain at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}.`, errorCode);
    }

    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      failConfig(`${path} must contain at most ${schema.maxItems} items.`, errorCode);
    }

    if (schema.items) {
      value.forEach((item, index) =>
        validateConfigSchema(operationName, schema.items!, item, `${path}[${index}]`, errorCode),
      );
    }

    return;
  }

  if (schema.type === "string") {
    if (typeof value !== "string" || !value.trim()) {
      failConfig(`${path} must be a non-empty string.`, errorCode);
    }

    if (schema.enum && !schema.enum.includes(value)) {
      failConfig(`${path} must be one of ${schema.enum.join(", ")}.`, errorCode);
    }

    return;
  }

  if (schema.type === "number") {
    if (typeof value !== "number" || Number.isNaN(value)) {
      failConfig(`${path} must be a number.`, errorCode);
    }

    if (schema.integer && !Number.isInteger(value)) {
      if (schema.minimum !== undefined && schema.maximum !== undefined) {
        failConfig(`${path} must be an integer between ${schema.minimum} and ${schema.maximum}.`, errorCode);
      }

      failConfig(`${path} must be an integer.`, errorCode);
    }

    if (schema.minimum !== undefined && value < schema.minimum) {
      failConfig(`${path} must be greater than or equal to ${schema.minimum}.`, errorCode);
    }

    if (schema.maximum !== undefined && value > schema.maximum) {
      failConfig(`${path} must be less than or equal to ${schema.maximum}.`, errorCode);
    }

    return;
  }

  if (typeof value !== "boolean") {
    failConfig(`${path} must be a boolean.`, errorCode);
  }
}

const jsonObjectConfig: WorkerConfigSchema = {
  type: "object",
  additionalProperties: true,
};
const emptyViewConfig: WorkerConfigSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
};
const stateFilterConfig: WorkerConfigSchema = {
  type: "object",
  properties: {
    state: { type: "string" },
  },
  additionalProperties: false,
};
const optionalLimitConfig: WorkerConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: {
      type: "number",
      integer: true,
      minimum: 1,
      maximum: 100,
    },
  },
};
const stateLimitFilterConfig: WorkerConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    state: { type: "string" },
    limit: {
      type: "number",
      integer: true,
      minimum: 1,
      maximum: 100,
    },
  },
};
const compliancePacketViewConfig: WorkerConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    packetId: { type: "string" },
    filingDraftId: { type: "string" },
  },
};
const windowConfig: WorkerConfigSchema = {
  type: "object",
  required: ["from", "to"],
  properties: {
    from: { type: "string" },
    to: { type: "string" },
  },
  additionalProperties: true,
};
const leadReadConfig: WorkerConfigSchema = {
  type: "object",
  required: ["source"],
  oneRequired: ["record", "records", "items", "leads", "reader"],
  properties: {
    source: { type: "string" },
    sourceKind: { type: "string" },
    reader: jsonObjectConfig,
    record: jsonObjectConfig,
    records: { type: "array", minItems: 1, maxItems: 25, items: jsonObjectConfig },
    items: { type: "array", minItems: 1, maxItems: 25, items: jsonObjectConfig },
    leads: { type: "array", minItems: 1, maxItems: 25, items: jsonObjectConfig },
  },
  additionalProperties: true,
};
const workerRunConfig: WorkerConfigSchema = {
  type: "object",
  oneRequired: ["intake", "leadPacket", "lead"],
  properties: {
    intake: jsonObjectConfig,
    lead: jsonObjectConfig,
    leadPacket: jsonObjectConfig,
    pricing: {
      type: "object",
      properties: {
        baseCents: { type: "number", minimum: 0 },
      },
      additionalProperties: true,
    },
    expectedAction: { type: "string" },
  },
  additionalProperties: true,
};
const revenuePaymentLinkSourceRefsConfig: WorkerConfigSchema = {
  type: "object",
  properties: {
    invoiceId: { type: "string" },
    invoiceObjectId: { type: "string" },
    paymentId: { type: "string" },
    paymentObjectId: { type: "string" },
    quoteObjectId: { type: "string" },
    approvalRequestId: { type: "string" },
    bankAccountId: { type: "string" },
    amountCents: { type: "number", integer: true, minimum: 0 },
    currency: { type: "string" },
    customerName: { type: "string" },
    dueAt: { type: "string" },
  },
  additionalProperties: true,
};
const revenuePaymentLinkPrepareConfig: WorkerConfigSchema = {
  type: "object",
  oneRequiredPaths: [
    ["invoiceId"],
    ["invoiceObjectId"],
    ["sourceRefs", "invoiceId"],
    ["sourceRefs", "invoiceObjectId"],
  ],
  properties: {
    invoiceId: { type: "string" },
    invoiceObjectId: { type: "string" },
    paymentId: { type: "string" },
    paymentObjectId: { type: "string" },
    quoteObjectId: { type: "string" },
    approvalRequestId: { type: "string" },
    bankAccountId: { type: "string" },
    amountCents: { type: "number", integer: true, minimum: 0 },
    currency: { type: "string" },
    customerName: { type: "string" },
    dueAt: { type: "string" },
    sourceRefs: revenuePaymentLinkSourceRefsConfig,
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const ownerBriefConfig: WorkerConfigSchema = {
  type: "object",
  required: ["window", "scopes"],
  properties: {
    window: windowConfig,
    scopes: {
      type: "array",
      minItems: 1,
      items: {
        type: "string",
        enum: ["tasks", "approvals", "cash", "capacity", "obligations", "workers"],
      },
    },
    includeEvidence: { type: "boolean" },
  },
  additionalProperties: true,
};
const ownerDecisionQueueConfig: WorkerConfigSchema = {
  type: "object",
  required: ["window"],
  properties: {
    window: windowConfig,
    priorityFloor: { type: "string" },
  },
  additionalProperties: true,
};
const ownerAnomalyTriageConfig: WorkerConfigSchema = {
  type: "object",
  required: ["window", "metricKeys"],
  properties: {
    window: windowConfig,
    metricKeys: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const dispatchScheduleConfig: WorkerConfigSchema = {
  type: "object",
  required: ["constraints"],
  oneRequired: ["jobId", "sourceRefs"],
  properties: {
    jobId: { type: "string" },
    sourceRefs: jsonObjectConfig,
    constraints: {
      type: "object",
      properties: {
        serviceWindow: { type: "string" },
        durationMinutes: { type: "number", integer: true, minimum: 15, maximum: 480 },
        crewSkills: {
          type: "array",
          minItems: 1,
          items: { type: "string" },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
};
const dispatchCustomerUpdateConfig: WorkerConfigSchema = {
  type: "object",
  required: ["jobId", "updateKind"],
  properties: {
    jobId: { type: "string" },
    updateKind: { type: "string" },
    channel: { type: "string" },
    sourceRefs: jsonObjectConfig,
    messageContext: jsonObjectConfig,
  },
  additionalProperties: true,
};
const dispatchCloseoutConfig: WorkerConfigSchema = {
  type: "object",
  required: ["workOrderId"],
  properties: {
    workOrderId: { type: "string" },
    sourceRefs: jsonObjectConfig,
    photoEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    completionEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    qaChecklist: jsonObjectConfig,
    completionNotes: { type: "string" },
    invoiceReady: { type: "boolean" },
    billableLines: {
      type: "array",
      items: jsonObjectConfig,
    },
  },
  additionalProperties: true,
};
const dispatchExceptionRouteConfig: WorkerConfigSchema = {
  type: "object",
  required: ["jobId", "reason", "severity"],
  properties: {
    jobId: { type: "string" },
    reason: { type: "string" },
    severity: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
    },
    kind: { type: "string" },
    notes: { type: "string" },
    note: { type: "string" },
    sourceRefs: jsonObjectConfig,
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    sourceEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const financeInvoicePrepareConfig: WorkerConfigSchema = {
  type: "object",
  oneRequired: ["jobId", "closeoutId", "sourceRefs"],
  properties: {
    jobId: { type: "string" },
    jobObjectId: { type: "string" },
    closeoutId: { type: "string" },
    closeoutObjectId: { type: "string" },
    customerObjectId: { type: "string" },
    sourceRefs: jsonObjectConfig,
    billableLines: {
      type: "array",
      items: jsonObjectConfig,
    },
    lines: {
      type: "array",
      items: jsonObjectConfig,
    },
    currency: { type: "string" },
    taxCents: { type: "number", minimum: 0 },
    dueAt: { type: "string" },
    policy: jsonObjectConfig,
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    sourceEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const financeArFollowupDraftConfig: WorkerConfigSchema = {
  type: "object",
  required: ["invoiceId", "tonePolicy"],
  properties: {
    invoiceId: { type: "string" },
    invoiceObjectId: { type: "string" },
    tonePolicy: { type: "string" },
    channel: {
      type: "string",
      enum: ["email", "sms", "phone"],
    },
    sourceRefs: jsonObjectConfig,
    messageContext: jsonObjectConfig,
    policy: jsonObjectConfig,
    draft: { type: "string" },
    dueAt: { type: "string" },
    daysPastDue: { type: "number", integer: true, minimum: 0 },
    amountCents: { type: "number", minimum: 0 },
    currency: { type: "string" },
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    sourceEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const financeCashForecastGenerateConfig: WorkerConfigSchema = {
  type: "object",
  required: ["window", "accounts"],
  properties: {
    window: {
      type: "object",
      required: ["from", "to"],
      properties: {
        from: { type: "string" },
        to: { type: "string" },
      },
      additionalProperties: true,
    },
    accounts: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    sourceRefs: jsonObjectConfig,
    startingBalanceCents: { type: "number" },
    expectedInflowCents: { type: "number", minimum: 0 },
    expectedOutflowCents: { type: "number", minimum: 0 },
    inflows: {
      type: "array",
      items: jsonObjectConfig,
    },
    outflows: {
      type: "array",
      items: jsonObjectConfig,
    },
    currency: { type: "string" },
    confidence: { type: "string" },
    accountsStale: { type: "boolean" },
    policy: jsonObjectConfig,
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    sourceEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const financePaymentDraftPrepareConfig: WorkerConfigSchema = {
  type: "object",
  oneRequired: ["billId", "paymentId", "sourceRefs"],
  properties: {
    billId: { type: "string" },
    billObjectId: { type: "string" },
    paymentId: { type: "string" },
    paymentObjectId: { type: "string" },
    paymentInstructionId: { type: "string" },
    bankAccountId: { type: "string" },
    amountCents: { type: "number", minimum: 0 },
    currency: { type: "string" },
    method: { type: "string" },
    dueAt: { type: "string" },
    payee: { type: "string" },
    sourceRefs: jsonObjectConfig,
    policy: jsonObjectConfig,
    evidenceIds: {
      type: "array",
      items: { type: "string" },
    },
    sourceEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const workforceHirePacketConfig: WorkerConfigSchema = {
  type: "object",
  required: ["personId", "positionId", "workLocationId"],
  properties: {
    personId: { type: "string" },
    positionId: { type: "string" },
    workLocationId: { type: "string" },
    employmentId: { type: "string" },
    employmentObjectId: { type: "string" },
    startDate: { type: "string" },
    sourceRefs: jsonObjectConfig,
    policy: jsonObjectConfig,
    documents: {
      type: "array",
    },
    requiredDocuments: {
      type: "array",
      items: { type: "string" },
    },
    restrictedDocuments: {
      type: "array",
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: true,
};
const workforcePayrollInputConfig: WorkerConfigSchema = {
  type: "object",
  required: ["employmentId", "period"],
  properties: {
    employmentId: { type: "string" },
    period: { type: "string" },
    payrollRunId: { type: "string" },
    hours: { type: "number", minimum: 0 },
    earnings: {
      type: "array",
      items: jsonObjectConfig,
    },
    deductions: {
      type: "array",
      items: jsonObjectConfig,
    },
    blockers: {
      type: "array",
      items: { type: "string" },
    },
    sourceRefs: jsonObjectConfig,
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const complianceFilingPrepareConfig: WorkerConfigSchema = {
  type: "object",
  required: ["filingRequirementId", "period"],
  properties: {
    filingRequirementId: { type: "string" },
    obligationId: { type: "string" },
    period: {
      type: "object",
      required: ["from", "to"],
      properties: {
        label: { type: "string" },
        from: { type: "string" },
        to: { type: "string" },
      },
      additionalProperties: true,
    },
    sourceRefs: jsonObjectConfig,
    validation: jsonObjectConfig,
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const offerPricingMarginReviewConfig: WorkerConfigSchema = {
  type: "object",
  required: ["sourceRefs", "policy"],
  properties: {
    sourceRefs: {
      type: "object",
      required: ["quoteObjectId", "evidencePacketId"],
      properties: {
        quoteObjectId: { type: "string" },
        leadObjectId: { type: "string" },
        customerObjectId: { type: "string" },
        evidencePacketId: { type: "string" },
        approvalRequestId: { type: "string" },
        workflowRunId: { type: "string" },
        priceBookId: { type: "string" },
      },
      additionalProperties: false,
    },
    policy: {
      type: "object",
      required: ["marginRuleId", "discountPolicyId"],
      properties: {
        marginRuleId: { type: "string" },
        discountPolicyId: { type: "string" },
        priceBookId: { type: "string" },
        requireOwnerApproval: { type: "boolean" },
      },
      additionalProperties: false,
    },
    requestedChange: jsonObjectConfig,
  },
  additionalProperties: false,
};
const offerPricingPricePolicyViewConfig: WorkerConfigSchema = {
  type: "object",
  properties: {
    quoteObjectId: { type: "string" },
    priceBookId: { type: "string" },
  },
  additionalProperties: false,
};
const customerExperienceSourceRefsConfig: WorkerConfigSchema = {
  type: "object",
  required: ["customerObjectId", "customerSignalObjectId", "evidencePacketId"],
  properties: {
    customerObjectId: { type: "string" },
    customerSignalObjectId: { type: "string" },
    customerSignalId: { type: "string" },
    signalObjectId: { type: "string" },
    signalId: { type: "string" },
    conversationObjectId: { type: "string" },
    promiseObjectId: { type: "string" },
    reviewObjectId: { type: "string" },
    evidencePacketId: { type: "string" },
    eventId: { type: "string" },
    sourceEvidenceIds: {
      type: "array",
      items: { type: "string" },
    },
  },
  additionalProperties: false,
};
const customerExperienceRecoveryConfig: WorkerConfigSchema = {
  type: "object",
  required: ["sourceRefs", "policy"],
  properties: {
    sourceRefs: customerExperienceSourceRefsConfig,
    policy: {
      type: "object",
      properties: {
        tone: { type: "string" },
        channel: { type: "string" },
        requiresOwnerApproval: { type: "boolean" },
        allowExternalSend: { type: "boolean" },
        blockers: {
          type: "array",
          items: { type: "string" },
        },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: false,
};
const customerExperienceSignalsViewConfig: WorkerConfigSchema = {
  type: "object",
  properties: {
    state: { type: "string" },
    severity: { type: "string" },
  },
  additionalProperties: false,
};
const growthCampaignDraftConfig: WorkerConfigSchema = {
  type: "object",
  required: ["sourceRefs", "policy"],
  properties: {
    sourceRefs: {
      type: "object",
      required: ["evidencePacketId", "budgetReservationId"],
      oneRequired: ["customerSignalObjectId", "customerSignalId"],
      properties: {
        customerSignalObjectId: { type: "string" },
        customerSignalId: { type: "string" },
        customerObjectId: { type: "string" },
        reviewObjectId: { type: "string" },
        campaignObjectId: { type: "string" },
        contentDraftObjectId: { type: "string" },
        audienceObjectId: { type: "string" },
        budgetReservationId: { type: "string" },
        evidencePacketId: { type: "string" },
      },
      additionalProperties: false,
    },
    policy: {
      type: "object",
      required: ["channel", "audience", "requiresOwnerApproval", "allowPublish"],
      properties: {
        channel: { type: "string" },
        audience: { type: "string" },
        requiresOwnerApproval: { type: "boolean" },
        allowPublish: { type: "boolean" },
        allowSend: { type: "boolean" },
        allowSpend: { type: "boolean" },
        allowTrackingMutation: { type: "boolean" },
      },
      additionalProperties: false,
    },
    claims: {
      type: "array",
      items: jsonObjectConfig,
    },
    content: jsonObjectConfig,
  },
  additionalProperties: false,
};
const growthCampaignsViewConfig: WorkerConfigSchema = {
  type: "object",
  properties: {
    state: { type: "string" },
    channel: { type: "string" },
  },
  additionalProperties: false,
};
const systemsConnectorHealthConfig: WorkerConfigSchema = {
  type: "object",
  required: ["checks"],
  properties: {
    checks: {
      type: "array",
      minItems: 1,
      items: { type: "string" },
    },
    connectionId: { type: "string" },
    adapterIds: {
      type: "array",
      items: { type: "string" },
    },
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const systemsSyncRepairPlanConfig: WorkerConfigSchema = {
  type: "object",
  required: ["connectionId", "issueId"],
  properties: {
    connectionId: { type: "string" },
    issueId: { type: "string" },
    severity: { type: "string" },
    strategy: { type: "string" },
    checks: {
      type: "array",
      items: { type: "string" },
    },
    sourceRefs: jsonObjectConfig,
    rollback: jsonObjectConfig,
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const systemsDataQualityRemediateConfig: WorkerConfigSchema = {
  type: "object",
  required: ["issueId", "policy"],
  properties: {
    issueId: { type: "string" },
    policy: jsonObjectConfig,
    sourceRefs: jsonObjectConfig,
    checks: {
      type: "array",
      items: { type: "string" },
    },
    rollback: jsonObjectConfig,
  },
  additionalProperties: true,
};
const systemsPermissionReviewConfig: WorkerConfigSchema = {
  type: "object",
  oneRequired: ["connectionId", "grantId"],
  properties: {
    connectionId: { type: "string" },
    grantId: { type: "string" },
    requestedScopes: {
      type: "array",
      items: { type: "string" },
    },
    expectedScopes: {
      type: "array",
      items: { type: "string" },
    },
    sourceRefs: jsonObjectConfig,
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const systemsAutomationPlanConfig: WorkerConfigSchema = {
  type: "object",
  required: ["workflowKey", "trigger"],
  properties: {
    workflowKey: { type: "string" },
    trigger: jsonObjectConfig,
    sourceRefs: jsonObjectConfig,
    policy: jsonObjectConfig,
  },
  additionalProperties: true,
};
const revenueDefinition: WorkerDefinition = {
  role: revenueWorkerRole,
  commands: {
    run: {
      name: "run",
      description: "Run the Revenue Operations Worker against persisted Core intake.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: workerRunConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return runRevenueWorker({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "lead.read": {
      name: "lead.read",
      description: "Read inbound lead source records into persisted Core intake selectors.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: leadReadConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        if (!context.target.tenantSlug) {
          throw new PlatformUnavailableError(
            "invalid_worker_target",
            "worker.tenantSlug is required for lead.read.",
            400,
          );
        }

        return readRevenueLeads({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "lead.classify": {
      name: "lead.classify",
      description: "Classify a persisted or direct lead packet without external execution.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: workerRunConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return classifyRevenueLead({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "response.draft": {
      name: "response.draft",
      description: "Draft an owner-reviewable customer response without sending it.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: workerRunConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return draftRevenueResponse({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "quote.prepare": {
      name: "quote.prepare",
      description: "Prepare an owner-reviewable quote packet without sending it.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: workerRunConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return prepareRevenueQuote({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "payment_link.prepare": {
      name: "payment_link.prepare",
      description:
        "Prepare an owner-reviewable payment-link packet while live provider creation and money movement stay blocked.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: revenuePaymentLinkPrepareConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return prepareRevenuePaymentLink({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    continue: {
      name: "continue",
      description:
        "Continue a worker-owned approval outcome. Optional approved execution details live under config.execution.",
      idempotency: "required",
      sideEffects: "approved_only",
      externalExecution: "approved_only",
      requiresTenant: true,
      configSchema: {
        type: "object",
        required: ["approvalId"],
        properties: {
          approvalId: { type: "string" },
          execution: {
            type: "object",
            description:
              "Optional approved controlled-send receipt config. If supplied, connectionId, managed credentialRef, recipient, receipt, and rollback are required.",
            required: ["connectionId", "credentialRef", "recipient", "receipt", "rollback"],
            properties: {
              connectionId: { type: "string" },
              credentialRef: { type: "string" },
              requiredScopes: { type: "array", items: { type: "string" } },
              channel: { type: "string" },
              recipient: { type: "string" },
              receipt: { type: "object", additionalProperties: true },
              rollback: { type: "object", additionalProperties: true },
            },
            additionalProperties: true,
          },
        },
        additionalProperties: true,
      },
      async handle(context) {
        const approvalId = optionalString(context.config.approvalId);

        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        if (!approvalId) {
          throw new PlatformUnavailableError(
            "invalid_worker_command_config",
            "config.approvalId is required for continue.",
            400,
          );
        }

        return continueRevenueWorker({
          approvalId,
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "approval.decide": {
      name: "approval.decide",
      description: "Decide a worker approval request without executing external actions.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: {
        type: "object",
        required: ["approvalId", "action"],
        properties: {
          approvalId: { type: "string" },
          action: {
            type: "string",
            enum: ["approved", "rejected", "revision_requested"],
          },
          note: { type: "string" },
        },
        additionalProperties: true,
      },
      async handle(context) {
        const approvalId = optionalString(context.config.approvalId);
        const action = normalizeApprovalDecision(context.config.action);

        if (!approvalId || !action) {
          throw new PlatformUnavailableError(
            "invalid_worker_command_config",
            "config.approvalId and config.action are required for approval.decide.",
            400,
          );
        }

        return decideApproval({
          approvalId,
          idempotencyKey: context.idempotencyKey!,
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          action,
          note: optionalString(context.config.note),
          subject: "worker",
        });
      },
    },
    "adapters.reconcile": {
      name: "adapters.reconcile",
      description: "Reconcile dry-run adapter records and capture receipts.",
      idempotency: "none",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: optionalLimitConfig,
      async handle(context) {
        if (!context.target.tenantSlug) {
          throw new PlatformUnavailableError(
            "invalid_worker_target",
            "worker.tenantSlug is required for adapter reconciliation.",
            400,
          );
        }

        return reconcileAdapterLedger({
          tenantSlug: context.target.tenantSlug,
          limit: optionalLimit(context.config.limit),
        });
      },
    },
    "adapters.retry": {
      name: "adapters.retry",
      description:
        "Execute due dry-run adapter retries, recording live-credential and rollback readiness while external execution stays blocked.",
      idempotency: "none",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: optionalLimitConfig,
      async handle(context) {
        if (!context.target.tenantSlug) {
          throw new PlatformUnavailableError(
            "invalid_worker_target",
            "worker.tenantSlug is required for adapter retry execution.",
            400,
          );
        }

        return executeAdapterRetries({
          tenantSlug: context.target.tenantSlug,
          limit: optionalLimit(context.config.limit),
        });
      },
    },
  },
  views: {
    snapshot: {
      name: "snapshot",
      description: "Read the worker runtime snapshot.",
      configSchema: emptyViewConfig,
      async handle(context) {
        const result = await getRevenueWorkerSnapshotSafe({
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          role: context.target.role,
        });

        return {
          status: result.ok ? 200 : 500,
          data: {
            worker: responseTarget(context.target),
            view: "snapshot",
            snapshot: result.snapshot,
          },
          error: result.error,
        };
      },
    },
    approvals: {
      name: "approvals",
      description: "List worker approval requests.",
      configSchema: stateFilterConfig,
      async handle(context) {
        const approvals = await listApprovals({
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          state: optionalString(context.config.state),
          subject: "worker",
        });

        return {
          data: {
            worker: responseTarget(context.target, approvals.operator.tenantSlug),
            view: "approvals",
            approvals,
          },
          error: null,
        };
      },
    },
    readiness: {
      name: "readiness",
      description: "Read Revenue dry-run proof, launch blockers, launch gates, and latest proof refs.",
      configSchema: emptyViewConfig,
      async handle(context) {
        const result = await getRevenueReadinessSafe({
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          role: context.target.role,
        });

        return {
          status: result.ok ? 200 : 500,
          data: {
            worker: responseTarget(context.target, result.readiness.worker ? context.target.tenantSlug : null),
            view: "readiness",
            readiness: result.readiness,
          },
          error: result.error,
        };
      },
    },
  },
};

const financeDefinition: WorkerDefinition = {
  role: financeWorkerRole,
  commands: {
    "invoice.prepare": {
      name: "invoice.prepare",
      description: "Prepare an invoice draft from Core job or closeout refs with accounting dry-run evidence.",
      idempotency: "required",
      sideEffects: "dry_run",
      externalExecution: "dry_run",
      requiresTenant: true,
      configSchema: financeInvoicePrepareConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return prepareFinanceInvoice({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "ar_followup.draft": {
      name: "ar_followup.draft",
      description: "Draft an AR follow-up packet without external send or payment-link creation.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: financeArFollowupDraftConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return draftFinanceArFollowup({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "cash_forecast.generate": {
      name: "cash_forecast.generate",
      description: "Generate a cash forecast review packet without external execution or money movement.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: financeCashForecastGenerateConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return generateFinanceCashForecast({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "payment_draft.prepare": {
      name: "payment_draft.prepare",
      description: "Prepare a payment instruction draft with dual-control evidence and no money movement.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: financePaymentDraftPrepareConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return prepareFinancePaymentDraft({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "approval.decide": {
      name: "approval.decide",
      description: "Decide a finance approval request without executing external sends or money movement.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: {
        type: "object",
        required: ["approvalId", "action"],
        properties: {
          approvalId: { type: "string" },
          action: {
            type: "string",
            enum: ["approved", "rejected", "revision_requested"],
          },
          note: { type: "string" },
        },
        additionalProperties: true,
      },
      async handle(context) {
        const approvalId = optionalString(context.config.approvalId);
        const action = normalizeApprovalDecision(context.config.action);

        if (!approvalId || !action) {
          throw new PlatformUnavailableError(
            "invalid_worker_command_config",
            "config.approvalId and config.action are required for approval.decide.",
            400,
          );
        }

        return decideApproval({
          approvalId,
          idempotencyKey: context.idempotencyKey!,
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          action,
          note: optionalString(context.config.note),
          subject: "worker",
        });
      },
    },
  },
  views: {
    snapshot: {
      name: "snapshot",
      description: "Read the finance worker runtime snapshot.",
      configSchema: emptyViewConfig,
      async handle(context) {
        const result = await getFinanceWorkerSnapshotSafe({
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          role: context.target.role,
        });

        return {
          status: result.ok ? 200 : 500,
          data: {
            worker: responseTarget(context.target),
            view: "snapshot",
            snapshot: result.snapshot,
          },
          error: result.error,
        };
      },
    },
    approvals: {
      name: "approvals",
      description: "List finance approval requests.",
      configSchema: stateFilterConfig,
      async handle(context) {
        const approvals = await listApprovals({
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          state: optionalString(context.config.state),
          subject: "worker",
        });

        return {
          data: {
            worker: responseTarget(context.target, approvals.operator.tenantSlug),
            view: "approvals",
            approvals,
          },
          error: null,
        };
      },
    },
  },
};

const offerPricingDefinition: WorkerDefinition = {
  role: offerPricingWorkerRole,
  commands: {
    "margin.review.prepare": {
      name: "margin.review.prepare",
      description: "Prepare quote-line margin, discount, and price-policy review packets without external publish.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: offerPricingMarginReviewConfig,
      async handle(context) {
        if (!context.idempotencyKey) {
          throw new PlatformUnavailableError(
            "invalid_idempotency_key",
            "A string idempotency key is required.",
            400,
          );
        }

        return prepareOfferPricingMarginReview({
          idempotencyKey: context.idempotencyKey,
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          operatorEmail: context.operatorEmail,
          config: context.config,
        });
      },
    },
    "approval.decide": {
      name: "approval.decide",
      description: "Record pricing approval decisions without external execution.",
      idempotency: "required",
      sideEffects: "internal",
      externalExecution: "blocked",
      requiresTenant: true,
      configSchema: {
        type: "object",
        required: ["approvalId", "action"],
        properties: {
          approvalId: { type: "string" },
          action: {
            type: "string",
            enum: ["approved", "rejected", "revision_requested"],
          },
          note: { type: "string" },
        },
        additionalProperties: true,
      },
      async handle(context) {
        const approvalId = optionalString(context.config.approvalId);
        const action = normalizeApprovalDecision(context.config.action);

        if (!approvalId || !action) {
          throw new PlatformUnavailableError(
            "invalid_worker_command_config",
            "config.approvalId and config.action are required for approval.decide.",
            400,
          );
        }

        return decideApproval({
          approvalId,
          idempotencyKey: context.idempotencyKey!,
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          action,
          note: optionalString(context.config.note),
          subject: "worker",
        });
      },
    },
  },
  views: {
    snapshot: {
      name: "snapshot",
      description: "Read the Offer and Pricing Worker runtime snapshot.",
      configSchema: emptyViewConfig,
      async handle(context) {
        const result = await getOfferPricingWorkerSnapshotSafe({
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          role: context.target.role,
        });

        return {
          status: result.ok ? 200 : 500,
          data: {
            worker: responseTarget(context.target),
            view: "snapshot",
            snapshot: result.snapshot,
          },
          error: result.error,
        };
      },
    },
    price_policy: {
      name: "price_policy",
      description: "Read price book, margin rule, discount policy, and quote-line review state.",
      configSchema: offerPricingPricePolicyViewConfig,
      async handle(context) {
        const pricePolicy = await getOfferPricingPricePolicy({
          tenantSlug: context.target.tenantSlug,
          workerId: context.target.workerId,
          config: context.config,
        });

        return {
          data: {
            worker: responseTarget(context.target, context.target.tenantSlug),
            view: "price_policy",
            pricePolicy,
          },
          error: null,
        };
      },
    },
    approvals: {
      name: "approvals",
      description: "List pricing approval requests.",
      configSchema: stateFilterConfig,
      async handle(context) {
        const approvals = await listApprovals({
          operatorEmail: context.operatorEmail,
          tenantSlug: context.target.tenantSlug,
          state: optionalString(context.config.state),
          subject: "worker",
        });

        return {
          data: {
            worker: responseTarget(context.target, approvals.operator.tenantSlug),
            view: "approvals",
            approvals,
          },
          error: null,
        };
      },
    },
  },
};

const workerDefinitions: Record<string, WorkerDefinition> = {
  [revenueDefinition.role]: revenueDefinition,
  [financeDefinition.role]: financeDefinition,
  [offerPricingDefinition.role]: offerPricingDefinition,
  [customerExperienceWorkerRole]: {
    role: customerExperienceWorkerRole,
    commands: {
      "recovery.draft": {
        name: "recovery.draft",
        description: "Prepare a source-backed customer recovery draft and complaint packet without sending externally.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: customerExperienceRecoveryConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareCustomerRecoveryDraft({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide a customer-experience approval request without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the Customer Experience Worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getCustomerExperienceWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      signals: {
        name: "signals",
        description: "Read customer signals, recovery drafts, approvals, and no-send blockers.",
        configSchema: customerExperienceSignalsViewConfig,
        async handle(context) {
          const signals = await listCustomerExperienceSignals({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });

          return {
            data: {
              worker: responseTarget(context.target),
              view: "signals",
              signals,
            },
            error: null,
          };
        },
      },
    },
  },
  [growthWorkerRole]: {
    role: growthWorkerRole,
    commands: {
      "campaign.draft": {
        name: "campaign.draft",
        description:
          "Prepare a source-backed campaign draft, budget proof, approval packet, and generated campaign view without publishing, sending, spending, or changing tracking.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: growthCampaignDraftConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareGrowthCampaignDraft({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide a growth approval request without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the Growth Worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getGrowthWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
            operatorEmail: context.operatorEmail,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      campaigns: {
        name: "campaigns",
        description: "Read campaign drafts, claim blockers, audience policy, budget refs, and no-publish proof.",
        configSchema: growthCampaignsViewConfig,
        async handle(context) {
          const campaigns = await listGrowthCampaigns({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });

          return {
            data: {
              worker: responseTarget(context.target),
              view: "campaigns",
              campaigns,
            },
            error: null,
          };
        },
      },
    },
  },
  [workforceWorkerRole]: {
    role: workforceWorkerRole,
    commands: {
      "hire.packet.prepare": {
        name: "hire.packet.prepare",
        description: "Prepare a new-hire packet with document checklist, restricted-document proof, and payroll blockers.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: workforceHirePacketConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareWorkforceHirePacket({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "payroll_input.prepare": {
        name: "payroll_input.prepare",
        description: "Prepare payroll input readiness with blockers; payroll submission and money movement stay blocked.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        configSchema: workforcePayrollInputConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareWorkforcePayrollInput({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide a workforce approval request without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the workforce worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getWorkforceWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      readiness: {
        name: "readiness",
        description: "Read workforce document, payroll, and approval blockers.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const readiness = await getWorkforceReadiness({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            data: {
              worker: responseTarget(context.target, readiness.worker ? context.target.tenantSlug : null),
              view: "readiness",
              readiness,
            },
            error: null,
          };
        },
      },
    },
  },
  [complianceWorkerRole]: {
    role: complianceWorkerRole,
    commands: {
      "filing.prepare": {
        name: "filing.prepare",
        description: "Prepare a filing draft from source facts, rule refs, validation results, and approval gates.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: complianceFilingPrepareConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareComplianceFiling({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide a compliance approval request without agency submission.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the Compliance Operations Worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getComplianceWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      obligations: {
        name: "obligations",
        description: "Read obligations, filings, blockers, and due dates.",
        configSchema: stateLimitFilterConfig,
        async handle(context) {
          const obligations = await listComplianceObligations({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });

          return {
            data: {
              worker: responseTarget(context.target),
              view: "obligations",
              obligations,
            },
            error: null,
          };
        },
      },
      packet: {
        name: "packet",
        description: "Read compliance packet details, rule refs, approvals, redactions, and receipts.",
        configSchema: compliancePacketViewConfig,
        async handle(context) {
          const packet = await getCompliancePacket({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });

          return {
            data: {
              worker: responseTarget(context.target),
              view: "packet",
              packet,
            },
            error: null,
          };
        },
      },
    },
  },
  [systemsWorkerRole]: {
    role: systemsWorkerRole,
    commands: {
      "connector.health.scan": {
        name: "connector.health.scan",
        description: "Scan connector health, scopes, sync lag, schema drift, and error rates.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: systemsConnectorHealthConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return scanSystemsConnectorHealth({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "sync.repair.plan": {
        name: "sync.repair.plan",
        description: "Prepare a sync repair plan, dry-run action, reconciliation evidence, and rollback packet.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        configSchema: systemsSyncRepairPlanConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return planSystemsSyncRepair({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "data_quality.remediate": {
        name: "data_quality.remediate",
        description: "Prepare a data-quality remediation proposal and object diff without applying live changes.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        configSchema: systemsDataQualityRemediateConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return remediateSystemsDataQuality({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "permission.review": {
        name: "permission.review",
        description: "Review connection or capability grant scopes and prepare least-privilege decisions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: systemsPermissionReviewConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return reviewSystemsPermission({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "automation.plan": {
        name: "automation.plan",
        description: "Prepare a workflow automation plan and simulation packet without enabling automation.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: systemsAutomationPlanConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return planSystemsAutomation({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide a systems approval request without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the Systems Operations Worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getSystemsWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      health: {
        name: "health",
        description: "Read connector health, sync jobs, data-quality issues, and permission reviews.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getSystemsWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "health",
              health: {
                controls: result.snapshot.controls,
                connections: result.snapshot.connections,
                permissions: result.snapshot.permissions,
              },
            },
            error: result.error,
          };
        },
      },
      repairs: {
        name: "repairs",
        description: "Read sync repair plans, dry-run receipts, rollback plans, and approval state.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const repairs = await getSystemsRepairs({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: repairs.error ? 500 : 200,
            data: {
              worker: responseTarget(context.target),
              view: "repairs",
              repairs,
            },
            error: repairs.error,
          };
        },
      },
    },
  },
  [ownerWorkerRole]: {
    role: ownerWorkerRole,
    commands: {
      "brief.generate": {
        name: "brief.generate",
        description: "Generate a read-only owner brief over tenant-scoped Core records.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: ownerBriefConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return generateOwnerBrief({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "decision_queue.prepare": {
        name: "decision_queue.prepare",
        description: "Prepare owner decision proposals from tasks, approvals, obligations, and evidence.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: ownerDecisionQueueConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareOwnerDecisionQueue({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "anomaly.triage": {
        name: "anomaly.triage",
        description: "Triage owner-facing metric anomalies into evidence and internal review work.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: ownerAnomalyTriageConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return triageOwnerAnomalies({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide an owner worker approval request without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
      continue: {
        name: "continue",
        description: "Continue an owner worker approval outcome without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId"],
          properties: {
            approvalId: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);

          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          if (!approvalId) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId is required for continue.",
              400,
            );
          }

          return continueOwnerWorker({
            approvalId,
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the owner chief-of-staff worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getOwnerWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      briefs: {
        name: "briefs",
        description: "List generated owner briefs.",
        configSchema: stateFilterConfig,
        async handle(context) {
          const briefs = await listOwnerBriefs({
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            state: optionalString(context.config.state),
          });

          return {
            data: {
              worker: responseTarget(context.target, briefs.worker.tenantSlug),
              view: "briefs",
              briefs: briefs.briefs,
            },
            error: null,
          };
        },
      },
      decisions: {
        name: "decisions",
        description: "List owner decision proposals.",
        configSchema: stateFilterConfig,
        async handle(context) {
          const ownerDecisions = await listOwnerDecisions({
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            state: optionalString(context.config.state),
          });

          return {
            data: {
              worker: responseTarget(context.target, ownerDecisions.worker.tenantSlug),
              view: "decisions",
              decisions: ownerDecisions.decisions,
            },
            error: null,
          };
        },
      },
    },
  },
  [dispatchWorkerRole]: {
    role: dispatchWorkerRole,
    commands: {
      "schedule.propose": {
        name: "schedule.propose",
        description: "Prepare a dry-run schedule proposal from Core job and handoff refs.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        configSchema: dispatchScheduleConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return proposeDispatchSchedule({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "customer_update.draft": {
        name: "customer_update.draft",
        description: "Draft a customer update from Core job evidence without external send.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: dispatchCustomerUpdateConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return draftDispatchCustomerUpdate({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "closeout.prepare": {
        name: "closeout.prepare",
        description: "Prepare a closeout packet and QA checklist without external invoice or customer send.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: dispatchCloseoutConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return prepareDispatchCloseout({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "exception.route": {
        name: "exception.route",
        description: "Route a dispatch exception into Core task, decision, and evidence records.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: dispatchExceptionRouteConfig,
        async handle(context) {
          if (!context.idempotencyKey) {
            throw new PlatformUnavailableError(
              "invalid_idempotency_key",
              "A string idempotency key is required.",
              400,
            );
          }

          return routeDispatchException({
            idempotencyKey: context.idempotencyKey,
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            operatorEmail: context.operatorEmail,
            config: context.config,
          });
        },
      },
      "approval.decide": {
        name: "approval.decide",
        description: "Decide a dispatch approval request without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          required: ["approvalId", "action"],
          properties: {
            approvalId: { type: "string" },
            action: {
              type: "string",
              enum: ["approved", "rejected", "revision_requested"],
            },
            note: { type: "string" },
          },
          additionalProperties: true,
        },
        async handle(context) {
          const approvalId = optionalString(context.config.approvalId);
          const action = normalizeApprovalDecision(context.config.action);

          if (!approvalId || !action) {
            throw new PlatformUnavailableError(
              "invalid_worker_command_config",
              "config.approvalId and config.action are required for approval.decide.",
              400,
            );
          }

          return decideApproval({
            approvalId,
            idempotencyKey: context.idempotencyKey!,
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            action,
            note: optionalString(context.config.note),
            subject: "worker",
          });
        },
      },
    },
    views: {
      snapshot: {
        name: "snapshot",
        description: "Read the dispatch worker runtime snapshot.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getDispatchWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "snapshot",
              snapshot: result.snapshot,
            },
            error: result.error,
          };
        },
      },
      board: {
        name: "board",
        description: "Read dispatch schedule proposals, approvals, and dry-run calendar state.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getDispatchWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "board",
              board: result.snapshot.scheduleBoard,
              approvals: result.snapshot.controls.approvalTasks,
            },
            error: result.error,
          };
        },
      },
      exceptions: {
        name: "exceptions",
        description: "Read dispatch exceptions and blocker tasks.",
        configSchema: emptyViewConfig,
        async handle(context) {
          const result = await getDispatchWorkerSnapshotSafe({
            tenantSlug: context.target.tenantSlug,
            workerId: context.target.workerId,
            role: context.target.role,
          });

          return {
            status: result.ok ? 200 : 500,
            data: {
              worker: responseTarget(context.target),
              view: "exceptions",
              exceptions: result.snapshot.exceptions,
            },
            error: result.error,
          };
        },
      },
      approvals: {
        name: "approvals",
        description: "List dispatch approval requests.",
        configSchema: stateFilterConfig,
        async handle(context) {
          const approvals = await listApprovals({
            operatorEmail: context.operatorEmail,
            tenantSlug: context.target.tenantSlug,
            state: optionalString(context.config.state),
            subject: "worker",
          });

          return {
            data: {
              worker: responseTarget(context.target, approvals.operator.tenantSlug),
              view: "approvals",
              approvals,
            },
            error: null,
          };
        },
      },
    },
  },
};

export function registeredWorkerCommands() {
  return Object.values(workerDefinitions).flatMap((definition) =>
    Object.values(definition.commands).map((command) => ({
      role: definition.role,
      name: command.name,
      apiRoute: workerApiRoute,
      description: command.description,
      idempotency: command.idempotency,
      sideEffects: command.sideEffects,
      externalExecution: command.externalExecution,
      requiresTenant: command.requiresTenant === true,
      configSchema: command.configSchema ?? null,
    })),
  );
}

export function registeredWorkerViews() {
  return Object.values(workerDefinitions).flatMap((definition) =>
    Object.values(definition.views).map((view) => ({
      role: definition.role,
      name: view.name,
      apiRoute: workerApiRoute,
      description: view.description,
      configSchema: view.configSchema ?? null,
    })),
  );
}

export function resolveWorkerTarget(target: WorkerTargetInput = {}): WorkerTarget {
  const role = optionalString(target.role);

  if (!role) {
    throw new PlatformUnavailableError(
      "invalid_worker_target",
      "worker.role is required.",
      400,
    );
  }

  if (!isWorkerRoleIdentifier(role)) {
    throw new PlatformUnavailableError(
      "invalid_worker_target",
      workerRoleDescription,
      400,
    );
  }

  if (!workerDefinitions[role]) {
    const plannedWorker = plannedWorkerContractForRole(role);

    if (plannedWorker) {
      throw new PlatformUnavailableError(
        "worker_role_planned",
        `Worker role ${role} is planned but not available yet. See ${plannedWorker.contractPath}.`,
        400,
      );
    }

    throw new PlatformUnavailableError(
      "worker_role_unsupported",
      `Worker role ${role} is not available yet.`,
      400,
    );
  }

  return {
    role,
    workerId: target.id,
    tenantSlug: target.tenantSlug,
  };
}

export function workerErrorStatus(error: unknown, fallbackCode: string) {
  if (error instanceof RevenueWorkerUnavailableError || error instanceof PlatformUnavailableError) {
    return {
      status: error.status,
      code: error.code,
      message: error.status >= 500 ? "Worker command failed." : error.message,
    };
  }

  return {
    status: 500,
    code: fallbackCode,
    message: fallbackCode === "worker_view_failed" ? "Worker view failed." : "Worker command failed.",
  };
}

export async function executeWorkerCommand(input: {
  command?: string;
  target?: WorkerTargetInput;
  operatorEmail: string;
  config?: unknown;
  idempotencyKey?: unknown;
}): Promise<WorkerCommandResult> {
  const target = resolveWorkerTarget(input.target);
  const definition = workerDefinitions[target.role];
  const commandName = optionalString(input.command);

  if (commandName && !isWorkerOperationIdentifier(commandName)) {
    throw new PlatformUnavailableError(
      "invalid_worker_command",
      workerOperationDescription,
      400,
    );
  }

  const command = commandName ? definition.commands[commandName] : undefined;

  if (!command) {
    throw new PlatformUnavailableError(
      "worker_command_unsupported",
      unsupportedCommandMessage(definition),
      400,
    );
  }

  if (command.requiresTenant && !target.tenantSlug) {
    throw new PlatformUnavailableError(
      "invalid_worker_target",
      `worker.tenantSlug is required for ${command.name}.`,
      400,
    );
  }

  const idempotencyKey =
    command.idempotency === "required" ? requireIdempotency(input.idempotencyKey) : undefined;
  const config = commandConfig(input.config);

  if (command.configSchema) {
    validateConfigSchema(command.name, command.configSchema, config);
  }

  const result = await command.handle({
    target,
    operatorEmail: input.operatorEmail,
    config,
    idempotencyKey,
  });

  return {
    worker: responseTarget(target),
    command: command.name,
    result,
  };
}

export async function executeWorkerView(input: {
  view: string;
  target?: WorkerTargetInput;
  operatorEmail: string;
  config?: unknown;
}): Promise<WorkerViewResult> {
  const target = resolveWorkerTarget(input.target);
  const definition = workerDefinitions[target.role];
  const viewName = optionalString(input.view);

  if (!viewName) {
    throw new PlatformUnavailableError(
      "worker_view_missing",
      "Worker view requires a non-empty view.",
      400,
    );
  }

  if (!isWorkerOperationIdentifier(viewName)) {
    throw new PlatformUnavailableError(
      "invalid_worker_view",
      workerOperationDescription,
      400,
    );
  }

  const view = definition.views[viewName];
  const config = viewConfig(input.config);

  if (!view) {
    throw new PlatformUnavailableError(
      "worker_view_unsupported",
      unsupportedViewMessage(definition),
      400,
    );
  }

  if (view.configSchema) {
    validateConfigSchema(view.name, view.configSchema, config, "config", "invalid_worker_view_config");
  }

  return view.handle({
    target,
    operatorEmail: input.operatorEmail,
    config,
  });
}
