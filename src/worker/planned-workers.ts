type IdempotencyPolicy = "required" | "none";
type SideEffectLevel = "internal" | "dry_run" | "approved_only" | "external" | "none";
type ExternalExecution = "blocked" | "dry_run" | "approved_only" | "enabled";

export const workerApiRoute = "/worker" as const;
type WorkerApiRoute = typeof workerApiRoute;

export type PlannedWorkerConfigSchema = {
  type: "object" | "array" | "string" | "number" | "boolean";
  description?: string;
  required?: string[];
  oneRequired?: string[];
  properties?: Record<string, PlannedWorkerConfigSchema>;
  items?: PlannedWorkerConfigSchema;
  enum?: string[];
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
  integer?: boolean;
  additionalProperties?: boolean;
};

export type PlannedWorkerCommandMetadata = {
  role: string;
  name: string;
  toolAlias: string;
  description: string;
  idempotency: IdempotencyPolicy;
  sideEffects: SideEffectLevel;
  externalExecution: ExternalExecution;
  requiresTenant: boolean;
  requiredConfig: string[];
  oneRequiredConfig?: string[];
  configSchema?: PlannedWorkerConfigSchema;
};

export type PlannedWorkerViewMetadata = {
  role: string;
  name: string;
  toolAlias: string;
  description: string;
  idempotency: "none";
  sideEffects: "none";
  externalExecution: "blocked";
  requiresTenant: boolean;
  configSchema?: PlannedWorkerConfigSchema;
};

export type PlannedWorkerCommandRegistryEntry = Omit<PlannedWorkerCommandMetadata, "configSchema"> & {
  apiRoute: WorkerApiRoute;
  contractPath: string;
  evidencePacket: string;
  configSchema: PlannedWorkerConfigSchema;
};

export type PlannedWorkerViewRegistryEntry = PlannedWorkerViewMetadata & {
  apiRoute: WorkerApiRoute;
  contractPath: string;
  evidencePacket: string | null;
  configSchema: PlannedWorkerConfigSchema;
};

export type PlannedWorkerContractMetadata = {
  role: string;
  name: string;
  apiRoute: WorkerApiRoute;
  contractPath: string;
  firstOutcome: string;
  autonomyLevel: number;
  externalExecution: ExternalExecution;
  evidencePacket: string;
  commands: PlannedWorkerCommandMetadata[];
  views: PlannedWorkerViewMetadata[];
};

export type WorkerExpansionStatus =
  | "runtime"
  | "partial"
  | "planned_contract"
  | "candidate"
  | "packaged";
export type WorkerExpansionKind = "worker_family" | "packaged_worker";

export type WorkerExpansionCatalogEntry = {
  schemaVersion: "continuous.worker_expansion.v1";
  wave: number;
  order: number;
  key: string;
  name: string;
  status: WorkerExpansionStatus;
  kind: WorkerExpansionKind;
  apiRoute: WorkerApiRoute;
  workerRole?: string;
  packageKey?: string;
  strategyFamily: string;
  familyKind: string;
  firstCommand: string;
  firstView: string;
  coreObjects: string[];
  incomingHandoff?: string;
  acceptanceChecks: string[];
  firstBlocker: string;
  launchGate: string;
  contractPath?: string;
  evidencePacket?: string;
  externalExecution: ExternalExecution;
  autonomyLevel?: number;
  cluster?: string;
  composedFamilies?: string[];
  firstPackagedOutcome?: string;
  sourceDocs: string[];
};

function stringSchema(description?: string): PlannedWorkerConfigSchema {
  return {
    type: "string",
    ...(description ? { description } : {}),
  };
}

function stringArraySchema(description?: string): PlannedWorkerConfigSchema {
  return {
    type: "array",
    minItems: 1,
    items: stringSchema(),
    ...(description ? { description } : {}),
  };
}

function objectSchema(description?: string): PlannedWorkerConfigSchema {
  return {
    type: "object",
    additionalProperties: true,
    ...(description ? { description } : {}),
  };
}

function windowSchema(): PlannedWorkerConfigSchema {
  return {
    type: "object",
    required: ["from", "to"],
    properties: {
      from: stringSchema("Inclusive ISO timestamp."),
      to: stringSchema("Exclusive ISO timestamp."),
    },
    additionalProperties: false,
  };
}

function plannedFieldSchema(field: string): PlannedWorkerConfigSchema {
  if (field === "window") {
    return windowSchema();
  }

  if (field === "accounts" || field === "checks" || field === "objectIds") {
    return stringArraySchema();
  }

  if (field === "constraints" || field === "policy" || field === "sourceRefs" || field === "trigger") {
    return objectSchema();
  }

  if (field === "action") {
    return {
      type: "string",
      enum: ["approved", "rejected", "revision_requested"],
    };
  }

  return stringSchema();
}

function plannedConfigSchema(command: PlannedWorkerCommandMetadata): PlannedWorkerConfigSchema {
  if (command.configSchema) {
    return command.configSchema;
  }

  return {
    type: "object",
    required: command.requiredConfig,
    ...(command.oneRequiredConfig ? { oneRequired: command.oneRequiredConfig } : {}),
    properties: Object.fromEntries(
      [...command.requiredConfig, ...(command.oneRequiredConfig ?? [])].map((field) => [
        field,
        plannedFieldSchema(field),
      ]),
    ),
    additionalProperties: true,
  };
}

function plannedViewConfigSchema(view: PlannedWorkerViewMetadata): PlannedWorkerConfigSchema {
  return (
    view.configSchema ?? {
      type: "object",
      properties: {},
      additionalProperties: false,
    }
  );
}

export const workerContracts: PlannedWorkerContractMetadata[] = [
  {
    role: "revenue_operations",
    name: "Revenue Operations Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/revenue-operations-worker-v1-contract.md",
    firstOutcome: "Lead intake, classification, response draft, quote approval, and no-send continuation proof",
    autonomyLevel: 2,
    externalExecution: "blocked",
    evidencePacket: "quote_approval_packet",
    commands: [
      {
        role: "revenue_operations",
        name: "lead.read",
        toolAlias: "worker.command",
        description: "Read inbound lead source records into persisted Core intake selectors.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["source"],
        oneRequiredConfig: ["record", "records", "items", "leads", "reader"],
        configSchema: {
          type: "object",
          required: ["source"],
          oneRequired: ["record", "records", "items", "leads", "reader"],
          properties: {
            source: stringSchema("Source system name."),
            sourceKind: stringSchema("Optional source kind."),
            reader: objectSchema("Read-only source reader metadata."),
            record: objectSchema("Single source record."),
            records: { type: "array", minItems: 1, maxItems: 25, items: objectSchema() },
            items: { type: "array", minItems: 1, maxItems: 25, items: objectSchema() },
            leads: { type: "array", minItems: 1, maxItems: 25, items: objectSchema() },
          },
          additionalProperties: true,
        },
      },
      {
        role: "revenue_operations",
        name: "lead.classify",
        toolAlias: "worker.command",
        description: "Classify a persisted or direct lead packet without external execution.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["intake", "leadPacket", "lead"],
      },
      {
        role: "revenue_operations",
        name: "response.draft",
        toolAlias: "worker.command",
        description: "Draft an owner-reviewable customer response without sending it.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["intake", "leadPacket", "lead"],
      },
      {
        role: "revenue_operations",
        name: "run",
        toolAlias: "worker.command",
        description: "Run the Revenue Operations Worker against persisted Core intake.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["intake", "leadPacket", "lead"],
      },
      {
        role: "revenue_operations",
        name: "continue",
        toolAlias: "worker.command",
        description: "Continue a worker-owned approval outcome without executing external actions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId"],
      },
      {
        role: "revenue_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Record an operator approval decision without executing external actions.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
      {
        role: "revenue_operations",
        name: "adapters.reconcile",
        toolAlias: "worker.command",
        description: "Reconcile dry-run adapter records, retry tasks, and review tasks.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        configSchema: {
          type: "object",
          properties: {
            limit: { type: "number", integer: true, minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
      {
        role: "revenue_operations",
        name: "adapters.retry",
        toolAlias: "worker.command",
        description: "Drain due dry-run adapter retry rows without live external mutation.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        configSchema: {
          type: "object",
          properties: {
            limit: { type: "number", integer: true, minimum: 1, maximum: 100 },
          },
          additionalProperties: false,
        },
      },
      {
        role: "revenue_operations",
        name: "quote.prepare",
        toolAlias: "worker.command",
        description: "Prepare owner-reviewable quote packets without sending them.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["intake", "leadPacket", "lead"],
      },
      {
        role: "revenue_operations",
        name: "payment_link.prepare",
        toolAlias: "worker.command",
        description: "Planned payment-link preparation packet with human approval and no money movement.",
        idempotency: "required",
        sideEffects: "approved_only",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["invoiceId", "sourceRefs"],
      },
    ],
    views: [
      {
        role: "revenue_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read the Revenue Operations Worker runtime snapshot.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "revenue_operations",
        name: "approvals",
        toolAlias: "worker.view",
        description: "Read Revenue approval queue items and continuation hints.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "revenue_operations",
        name: "readiness",
        toolAlias: "worker.view",
        description: "Read Revenue dry-run proof checks, latest launch refs, and live credential gates.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "revenue_operations",
        name: "quote_review",
        toolAlias: "worker.view",
        description: "Planned quote approval packet detail view for generated review surfaces.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "owner_chief_of_staff",
    name: "Owner Chief-of-Staff Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/owner-chief-of-staff-worker-v1-contract.md",
    firstOutcome: "Daily owner brief and decision queue with evidence links",
    autonomyLevel: 1,
    externalExecution: "blocked",
    evidencePacket: "owner_brief_packet",
    commands: [
      {
        role: "owner_chief_of_staff",
        name: "brief.generate",
        toolAlias: "worker.command",
        description: "Generate a read-only owner brief over tasks, approvals, cash, capacity, obligations, and worker health.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["window", "scopes"],
      },
      {
        role: "owner_chief_of_staff",
        name: "decision_queue.prepare",
        toolAlias: "worker.command",
        description: "Prepare owner decisions with source evidence, priority, options, rationale, and approval gates.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["window"],
      },
      {
        role: "owner_chief_of_staff",
        name: "anomaly.triage",
        toolAlias: "worker.command",
        description: "Triage cross-system metric anomalies into review-ready evidence and route proposals.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["window", "metricKeys"],
      },
      {
        role: "owner_chief_of_staff",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Record an owner approval decision without executing external actions.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
    ],
    views: [
      {
        role: "owner_chief_of_staff",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read the owner chief-of-staff worker runtime snapshot.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "owner_chief_of_staff",
        name: "briefs",
        toolAlias: "worker.view",
        description: "List generated owner briefs by state and time window.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "owner_chief_of_staff",
        name: "decisions",
        toolAlias: "worker.view",
        description: "List owner decision proposals and approval state.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "dispatch_operations",
    name: "Dispatch Operations Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/dispatch-operations-worker-v1-contract.md",
    firstOutcome: "Job schedule proposal, customer update packet, and closeout packet",
    autonomyLevel: 2,
    externalExecution: "dry_run",
    evidencePacket: "dispatch_packet",
    commands: [
      {
        role: "dispatch_operations",
        name: "schedule.propose",
        toolAlias: "worker.command",
        description: "Prepare a schedule proposal, conflict scan, appointment draft, and approval request.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        requiredConfig: ["constraints"],
        oneRequiredConfig: ["jobId", "sourceRefs"],
      },
      {
        role: "dispatch_operations",
        name: "customer_update.draft",
        toolAlias: "worker.command",
        description: "Draft a customer update from job evidence without sending externally.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["jobId", "updateKind"],
      },
      {
        role: "dispatch_operations",
        name: "closeout.prepare",
        toolAlias: "worker.command",
        description: "Prepare a closeout packet with QA checklist, proof, blockers, and invoice handoff.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["workOrderId"],
      },
      {
        role: "dispatch_operations",
        name: "exception.route",
        toolAlias: "worker.command",
        description: "Route schedule, material, safety, or closeout exceptions into Core tasks and evidence.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["jobId", "reason", "severity"],
      },
      {
        role: "dispatch_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Record an operator decision on a dispatch approval without executing external actions.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
    ],
    views: [
      {
        role: "dispatch_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read the dispatch worker runtime snapshot.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "dispatch_operations",
        name: "board",
        toolAlias: "worker.view",
        description: "Read the dispatch board, conflicts, approvals, and schedule readiness.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "dispatch_operations",
        name: "exceptions",
        toolAlias: "worker.view",
        description: "Read dispatch exceptions with blocker and evidence links.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "finance_operations",
    name: "Finance Operations Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/finance-operations-worker-v1-contract.md",
    firstOutcome: "Cash packet with invoice draft, AR queue, and forecast evidence",
    autonomyLevel: 2,
    externalExecution: "dry_run",
    evidencePacket: "cash_packet",
    commands: [
      {
        role: "finance_operations",
        name: "invoice.prepare",
        toolAlias: "worker.command",
        description: "Prepare an invoice draft from job or closeout evidence with approval and adapter dry-run receipt.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["jobId", "closeoutId", "sourceRefs"],
      },
      {
        role: "finance_operations",
        name: "ar_followup.draft",
        toolAlias: "worker.command",
        description: "Draft an AR follow-up and payment-link preparation packet without sending externally.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["invoiceId", "tonePolicy"],
      },
      {
        role: "finance_operations",
        name: "expense_code.propose",
        toolAlias: "worker.command",
        description: "Propose expense coding from receipt evidence with policy flags and review state.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["receiptId", "expenseId"],
      },
      {
        role: "finance_operations",
        name: "cash_forecast.generate",
        toolAlias: "worker.command",
        description: "Generate a cash forecast from balances, invoices, bills, receipts, and confidence evidence.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["window", "accounts"],
      },
      {
        role: "finance_operations",
        name: "payment_draft.prepare",
        toolAlias: "worker.command",
        description: "Prepare a payment instruction draft with dual-control evidence and no money movement.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["billId", "paymentId", "sourceRefs"],
      },
      {
        role: "finance_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Decide a finance approval request without executing external actions.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
    ],
    views: [
      {
        role: "finance_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read invoices, AR, expenses, cash forecast, payment drafts, and finance approvals.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "finance_operations",
        name: "approvals",
        toolAlias: "worker.view",
        description: "Read finance approval queue items and packet refs.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "workforce_operations",
    name: "Workforce Operations Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/workforce-operations-worker-v1-contract.md",
    firstOutcome: "New-hire or contractor packet with payroll blockers",
    autonomyLevel: 2,
    externalExecution: "blocked",
    evidencePacket: "workforce_packet",
    commands: [
      {
        role: "workforce_operations",
        name: "hire.packet.prepare",
        toolAlias: "worker.command",
        description: "Prepare a new-hire packet with document checklist, approvals, and payroll blockers.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["personId", "positionId", "workLocationId"],
      },
      {
        role: "workforce_operations",
        name: "contractor.packet.prepare",
        toolAlias: "worker.command",
        description: "Prepare a contractor engagement and classification review packet.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["personId", "engagementId"],
      },
      {
        role: "workforce_operations",
        name: "credential.review",
        toolAlias: "worker.command",
        description: "Review credentials, expirations, evidence, renewal blockers, and owner tasks.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["personId", "credentialId"],
      },
      {
        role: "workforce_operations",
        name: "schedule_readiness.prepare",
        toolAlias: "worker.command",
        description: "Prepare schedule readiness evidence and exception tasks for workforce capacity.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["personId", "period"],
      },
      {
        role: "workforce_operations",
        name: "payroll_input.prepare",
        toolAlias: "worker.command",
        description: "Prepare payroll input readiness with blockers; payroll submission stays blocked.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        requiredConfig: ["employmentId", "period"],
      },
      {
        role: "workforce_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Decide a workforce approval request without executing external actions.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
    ],
    views: [
      {
        role: "workforce_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read workforce cases, blockers, credentials, approvals, and readiness state.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "workforce_operations",
        name: "readiness",
        toolAlias: "worker.view",
        description: "Read payroll, schedule, credential, and document blocker boards.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "compliance_operations",
    name: "Compliance Operations Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/compliance-operations-worker-v1-contract.md",
    firstOutcome: "Compliance packet with obligation, rule source, draft, and approval path",
    autonomyLevel: 2,
    externalExecution: "blocked",
    evidencePacket: "compliance_packet",
    commands: [
      {
        role: "compliance_operations",
        name: "obligation.scan",
        toolAlias: "worker.command",
        description: "Scan source refs and rule packs into obligation proposals with evidence.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["scope", "jurisdiction"],
      },
      {
        role: "compliance_operations",
        name: "notice.response.prepare",
        toolAlias: "worker.command",
        description: "Prepare a notice response draft, source packet, validation trace, and approval request.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["noticeId"],
      },
      {
        role: "compliance_operations",
        name: "license.renewal.prepare",
        toolAlias: "worker.command",
        description: "Prepare a license or permit renewal packet with due-date and blocker evidence.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["licenseId"],
      },
      {
        role: "compliance_operations",
        name: "filing.prepare",
        toolAlias: "worker.command",
        description: "Prepare a filing draft from source facts, rule refs, validation results, and approval gates.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["filingRequirementId", "period"],
      },
      {
        role: "compliance_operations",
        name: "evidence_binder.export",
        toolAlias: "worker.command",
        description: "Prepare a redacted compliance evidence binder for review and export.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["objectIds", "purpose"],
      },
    ],
    views: [
      {
        role: "compliance_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read the compliance worker runtime snapshot.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "compliance_operations",
        name: "obligations",
        toolAlias: "worker.view",
        description: "Read obligations, filings, notices, licenses, blockers, and due dates.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "compliance_operations",
        name: "packet",
        toolAlias: "worker.view",
        description: "Read compliance packet details, rule refs, approvals, redactions, and receipts.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "systems_operations",
    name: "Systems Operations Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/systems-operations-worker-v1-contract.md",
    firstOutcome: "Connector health and sync repair packet with rollback plan",
    autonomyLevel: 2,
    externalExecution: "dry_run",
    evidencePacket: "systems_packet",
    commands: [
      {
        role: "systems_operations",
        name: "connector.health.scan",
        toolAlias: "worker.command",
        description: "Scan connector health, scopes, sync lag, schema drift, and error rates.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["checks"],
      },
      {
        role: "systems_operations",
        name: "sync.repair.plan",
        toolAlias: "worker.command",
        description: "Prepare a sync repair plan, dry-run action, reconciliation evidence, and rollback packet.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        requiredConfig: ["connectionId", "issueId"],
      },
      {
        role: "systems_operations",
        name: "data_quality.remediate",
        toolAlias: "worker.command",
        description: "Prepare a data-quality remediation proposal and object diff without applying live changes.",
        idempotency: "required",
        sideEffects: "dry_run",
        externalExecution: "dry_run",
        requiresTenant: true,
        requiredConfig: ["issueId", "policy"],
      },
      {
        role: "systems_operations",
        name: "permission.review",
        toolAlias: "worker.command",
        description: "Review connection or capability grant scopes and prepare least-privilege decisions.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: [],
        oneRequiredConfig: ["connectionId", "grantId"],
      },
      {
        role: "systems_operations",
        name: "automation.plan",
        toolAlias: "worker.command",
        description: "Prepare a workflow automation plan and simulation packet without enabling automation.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["workflowKey", "trigger"],
      },
      {
        role: "systems_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Decide a systems worker approval without executing external actions.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
    ],
    views: [
      {
        role: "systems_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read the Systems Operations Worker runtime snapshot.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "systems_operations",
        name: "health",
        toolAlias: "worker.view",
        description: "Read connector health, sync jobs, data-quality issues, and permission reviews.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
      {
        role: "systems_operations",
        name: "repairs",
        toolAlias: "worker.view",
        description: "Read sync repair plans, dry-run receipts, rollback plans, and approval state.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
      },
    ],
  },
  {
    role: "offer_pricing_operations",
    name: "Offer and Pricing Worker",
    apiRoute: workerApiRoute,
    contractPath: "docs/offer-pricing-worker-v1-contract.md",
    firstOutcome:
      "Pricing review packet with margin verdict, discount approval request, quote-line policy refs, and generated price policy view",
    autonomyLevel: 2,
    externalExecution: "blocked",
    evidencePacket: "pricing_review_packet",
    commands: [
      {
        role: "offer_pricing_operations",
        name: "margin.review.prepare",
        toolAlias: "worker.command",
        description: "Prepare quote-line margin, discount, and price-policy review packets without external publish.",
        idempotency: "required",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["sourceRefs", "policy"],
        configSchema: {
          type: "object",
          required: ["sourceRefs", "policy"],
          properties: {
            sourceRefs: {
              type: "object",
              required: ["quoteObjectId", "evidencePacketId"],
              properties: {
                quoteObjectId: stringSchema("Revenue quote object id."),
                leadObjectId: stringSchema("Revenue lead object id."),
                customerObjectId: stringSchema("Revenue customer object id."),
                evidencePacketId: stringSchema("Revenue quote evidence packet id."),
                approvalRequestId: stringSchema("Optional Revenue quote approval id."),
                workflowRunId: stringSchema("Optional Revenue workflow run id."),
              },
              additionalProperties: false,
            },
            policy: {
              type: "object",
              required: ["marginRuleId", "discountPolicyId"],
              properties: {
                marginRuleId: stringSchema("Margin rule object id."),
                discountPolicyId: stringSchema("Discount policy object id."),
                requireOwnerApproval: { type: "boolean" },
              },
              additionalProperties: false,
            },
            requestedChange: objectSchema("Optional change-order or price-change context."),
          },
          additionalProperties: false,
        },
      },
      {
        role: "offer_pricing_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Record pricing approval decisions without external execution.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
      },
    ],
    views: [
      {
        role: "offer_pricing_operations",
        name: "snapshot",
        toolAlias: "worker.view",
        description: "Read the Offer and Pricing Worker runtime snapshot.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: false,
      },
      {
        role: "offer_pricing_operations",
        name: "price_policy",
        toolAlias: "worker.view",
        description: "Read price book, margin rule, discount policy, and quote-line review state.",
        idempotency: "none",
        sideEffects: "none",
        externalExecution: "blocked",
        requiresTenant: true,
        configSchema: {
          type: "object",
          properties: {
            quoteObjectId: stringSchema("Optional quote object id filter."),
            priceBookId: stringSchema("Optional price book id filter."),
          },
          additionalProperties: false,
        },
      },
    ],
  },
];

const runtimeWorkerRoles = new Set([
  "revenue_operations",
  "owner_chief_of_staff",
  "dispatch_operations",
  "finance_operations",
  "workforce_operations",
  "compliance_operations",
  "systems_operations",
  "offer_pricing_operations",
]);

export const runtimeWorkerContracts = workerContracts.filter((contract) =>
  runtimeWorkerRoles.has(contract.role),
);

export const plannedWorkerContracts = workerContracts.filter(
  (contract) => !runtimeWorkerRoles.has(contract.role),
);

export const workerExpansionCatalog: WorkerExpansionCatalogEntry[] = [
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 1,
    order: 1,
    key: "revenue_operations",
    name: "Revenue Operations Worker",
    status: "runtime",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "revenue_operations",
    strategyFamily: "Sales and Revenue Capture",
    familyKind: "operating_family",
    firstCommand: "lead.read",
    firstView: "snapshot",
    coreObjects: ["Lead", "Customer", "Offer", "Quote", "Booking", "Job", "Invoice", "Payment", "Review"],
    acceptanceChecks: [
      "Lead intake source evidence is persisted",
      "Quote and response drafts stay blocked until approval",
      "Controlled external send records receipt and rollback proof through config.execution",
    ],
    firstBlocker: "Production inbox, CRM, and scoped sender credentials are not yet provisioned.",
    launchGate: "Stable lead-to-cash simulation plus approved controlled-send receipt recording through config.execution.",
    contractPath: "docs/revenue-operations-worker-v1-contract.md",
    evidencePacket: "quote_approval_packet",
    externalExecution: "blocked",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/revenue-operations-worker-v1-contract.md",
      "docs/worker-readiness.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 2,
    order: 2,
    key: "owner_chief_of_staff",
    name: "Owner Chief-of-Staff Worker",
    status: "runtime",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "owner_chief_of_staff",
    strategyFamily: "Owner / General Management",
    familyKind: "operating_family",
    firstCommand: "brief.generate",
    firstView: "snapshot",
    coreObjects: ["Task", "Decision", "KPI", "Anomaly", "Approval", "WorkerRun"],
    incomingHandoff: "revenue.lead_to_owner_review",
    acceptanceChecks: [
      "Brief facts carry source refs",
      "Decision queues are tenant-scoped",
      "Generated views are read-only until approval",
    ],
    firstBlocker: "Broader factuality evals and stale-source handling are still needed.",
    launchGate: "Read-only cross-system summary with evidence links and no external mutation.",
    contractPath: "docs/owner-chief-of-staff-worker-v1-contract.md",
    evidencePacket: "owner_brief_packet",
    externalExecution: "blocked",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/owner-chief-of-staff-worker-v1-contract.md",
      "docs/worker-readiness.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 3,
    order: 3,
    key: "dispatch_operations",
    name: "Dispatch/Ops Worker",
    status: "partial",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "dispatch_operations",
    strategyFamily: "Operations / Service Delivery",
    familyKind: "operating_family",
    firstCommand: "schedule.propose",
    firstView: "snapshot",
    coreObjects: ["Job", "WorkOrder", "Appointment", "Crew", "Asset", "Material", "Closeout"],
    incomingHandoff: "revenue.quote_to_dispatch",
    acceptanceChecks: [
      "Schedule proposals cite approved Revenue handoff refs",
      "Customer updates are drafted without external sends",
      "Closeout packets produce finance handoff refs",
    ],
    firstBlocker: "Live calendar and job-system credential gates need approval receipts and rollback proof.",
    launchGate: "Runtime schedule, customer update, closeout, and exception packets with live credential gates blocked.",
    contractPath: "docs/dispatch-operations-worker-v1-contract.md",
    evidencePacket: "dispatch_packet",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/dispatch-operations-worker-v1-contract.md",
      "docs/worker-readiness.md",
      "docs/worker-handoffs.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 4,
    order: 4,
    key: "finance_operations",
    name: "Finance Worker",
    status: "partial",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "finance_operations",
    strategyFamily: "Finance and Admin",
    familyKind: "operating_family",
    firstCommand: "invoice.prepare",
    firstView: "snapshot",
    coreObjects: ["Invoice", "Bill", "Payment", "Expense", "Receipt", "CashForecast", "ReconciliationItem"],
    incomingHandoff: "dispatch.closeout_to_finance",
    acceptanceChecks: [
      "Invoice drafts are tied to closeout evidence",
      "Payment drafts stay blocked without dual control",
      "Cash packets carry accounting dry-run receipts",
    ],
    firstBlocker: "Live accounting and payment readiness need scoped credentials and dual-control execution gates.",
    launchGate: "Accounting and payment adapters in draft mode, cash evidence packet, dual-control proof, no money movement.",
    contractPath: "docs/finance-operations-worker-v1-contract.md",
    evidencePacket: "cash_packet",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/finance-operations-worker-v1-contract.md",
      "docs/worker-readiness.md",
      "docs/worker-handoffs.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 5,
    order: 5,
    key: "workforce_operations",
    name: "Workforce Worker",
    status: "partial",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "workforce_operations",
    strategyFamily: "Workforce and HR",
    familyKind: "operating_family",
    firstCommand: "hire.packet.prepare",
    firstView: "snapshot",
    coreObjects: [
      "Person",
      "Employment",
      "ContractorEngagement",
      "Position",
      "CompensationAgreement",
      "Credential",
      "Document",
    ],
    incomingHandoff: "finance.invoice_to_owner_review",
    acceptanceChecks: [
      "Restricted documents are redacted in evidence packets",
      "Payroll-input readiness lists blockers before submission",
      "Contractor, credential, and schedule readiness remain follow-up commands until handlers exist",
    ],
    firstBlocker: "Contractor packet, credential review, schedule readiness, and live HR/payroll credential gates remain follow-ups.",
    launchGate: "New-hire and payroll-input packets with restricted document proof, approvals, readiness views, and payroll blockers.",
    contractPath: "docs/workforce-operations-worker-v1-contract.md",
    evidencePacket: "workforce_packet",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/workforce-operations-worker-v1-contract.md",
      "docs/worker-readiness.md",
      "docs/worker-handoffs.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 6,
    order: 6,
    key: "compliance_operations",
    name: "Compliance Worker",
    status: "runtime",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "compliance_operations",
    strategyFamily: "Risk, Legal, Compliance, and Quality",
    familyKind: "operating_family",
    firstCommand: "filing.prepare",
    firstView: "snapshot",
    coreObjects: [
      "RulePack",
      "Obligation",
      "FilingRequirement",
      "FilingDraft",
      "Notice",
      "License",
      "Permit",
      "EvidenceBinder",
    ],
    incomingHandoff: "workforce.payroll_to_compliance",
    acceptanceChecks: [
      "Rule claims cite source refs",
      "Submission stays blocked until human approval",
      "Evidence binder is exportable",
    ],
    firstBlocker: "Live agency credentials, source validation breadth, receipt capture, and submission rollback proof remain blocked.",
    launchGate: "Rule-pack coverage, due-date obligations, source refs, human submission approval, and receipt/rejection capture.",
    contractPath: "docs/compliance-operations-worker-v1-contract.md",
    evidencePacket: "compliance_packet",
    externalExecution: "blocked",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/compliance-operations-worker-v1-contract.md",
      "docs/worker-readiness.md",
      "docs/worker-handoffs.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 7,
    order: 7,
    key: "systems_operations",
    name: "Systems Worker",
    status: "partial",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "systems_operations",
    strategyFamily: "Data, Systems, and Automation",
    familyKind: "operating_family",
    firstCommand: "connector.health.scan",
    firstView: "snapshot",
    coreObjects: ["Adapter", "Connection", "SyncJob", "Webhook", "PermissionGrant", "DataQualityIssue"],
    incomingHandoff: "systems.sync_issue_to_worker",
    acceptanceChecks: [
      "Connector checks are tenant scoped",
      "Repair actions produce rollback plans",
      "Permission and automation mutations stay blocked",
    ],
    firstBlocker: "Scoped live connector credentials need approval receipts and rollback evidence.",
    launchGate: "Tenant-scoped adapter grants, rollback plans, and sync reconciliation tests.",
    contractPath: "docs/systems-operations-worker-v1-contract.md",
    evidencePacket: "systems_packet",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/systems-operations-worker-v1-contract.md",
      "docs/worker-readiness.md",
      "docs/worker-handoffs.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 8,
    order: 8,
    key: "offer_pricing_operations",
    name: "Offer and Pricing Worker",
    status: "runtime",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "offer_pricing_operations",
    strategyFamily: "Offer, Product, and Pricing",
    familyKind: "operating_family",
    firstCommand: "margin.review.prepare",
    firstView: "price_policy",
    coreObjects: ["Offer", "PriceBook", "QuoteLine", "MarginRule", "DiscountPolicy"],
    incomingHandoff: "revenue.quote_to_pricing",
    acceptanceChecks: [
      "Quote lines have source evidence",
      "Margin policy exists",
      "External send remains blocked",
    ],
    firstBlocker: "Pricing and margin policy fixture plus discount approval packet.",
    launchGate: "Quote/margin policy fixture, approval for discounts, and price-change evidence packet.",
    contractPath: "docs/offer-pricing-worker-v1-contract.md",
    evidencePacket: "pricing_review_packet",
    externalExecution: "blocked",
    autonomyLevel: 2,
    sourceDocs: [
      "docs/worker-expansion.md",
      "docs/offer-pricing-worker-v1-contract.md",
      "docs/worker-readiness.md",
      "docs/worker-handoffs.md",
    ],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 9,
    order: 9,
    key: "customer_experience_operations",
    name: "Customer Experience Worker",
    status: "candidate",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "customer_experience_operations",
    strategyFamily: "Customer / Client / Patient Experience",
    familyKind: "operating_family",
    firstCommand: "recovery.draft",
    firstView: "signals",
    coreObjects: ["Customer", "Conversation", "Promise", "SatisfactionSignal", "Complaint", "Review"],
    incomingHandoff: "customer.signal_to_experience",
    acceptanceChecks: [
      "Signal type, source, and severity are present",
      "Customer ref is tenant-scoped",
      "Outbound recovery is blocked",
    ],
    firstBlocker: "Approved send gate and complaint evidence packet.",
    launchGate: "Approved outbound message gate, escalation routing, and complaint evidence packet.",
    externalExecution: "blocked",
    autonomyLevel: 2,
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md", "docs/worker-handoffs.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 10,
    order: 10,
    key: "asset_supply_operations",
    name: "Asset and Supply Worker",
    status: "candidate",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "asset_supply_operations",
    strategyFamily: "Supply Chain, Assets, and Facilities",
    familyKind: "operating_family",
    firstCommand: "reorder.plan",
    firstView: "stockouts",
    coreObjects: ["Vendor", "InventoryItem", "PurchaseOrder", "Asset", "Facility", "MaintenanceEvent"],
    incomingHandoff: "dispatch.asset_need_to_supply",
    acceptanceChecks: [
      "Need is tied to job or work order",
      "Purchase action is unapproved",
      "Cash impact is visible",
    ],
    firstBlocker: "Dry-run purchase or maintenance receipt and rollback plan.",
    launchGate: "Dry-run reorder or maintenance plan, approval for purchase and asset actions, and rollback plan.",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md", "docs/worker-handoffs.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 11,
    order: 11,
    key: "growth_operations",
    name: "Growth Worker",
    status: "candidate",
    kind: "worker_family",
    apiRoute: workerApiRoute,
    workerRole: "growth_operations",
    strategyFamily: "Growth and Brand",
    familyKind: "operating_family",
    firstCommand: "campaign.draft",
    firstView: "campaigns",
    coreObjects: ["Campaign", "Channel", "Audience", "ContentDraft", "AttributionEvent", "BudgetReservation"],
    incomingHandoff: "growth.campaign_to_owner_review",
    acceptanceChecks: [
      "Claims have source refs",
      "Budget is reserved",
      "Audience and channel are explicit",
    ],
    firstBlocker: "External publish approval and ROI ledger fixture.",
    launchGate: "No external publish without approval, source-backed claims, budget and ROI ledger.",
    externalExecution: "blocked",
    autonomyLevel: 2,
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md", "docs/worker-handoffs.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 12,
    order: 12,
    key: "vertical_packages",
    name: "Vertical Packaged Worker Catalog",
    status: "packaged",
    kind: "packaged_worker",
    apiRoute: workerApiRoute,
    packageKey: "vertical_packages",
    strategyFamily: "Packaged SMB operating bundles",
    familyKind: "packaged_bundle",
    firstCommand: "package.flow.prepare",
    firstView: "package_readiness",
    coreObjects: ["Connection", "PermissionGrant", "WorkflowRun", "EvidencePacket", "GeneratedView"],
    incomingHandoff: "systems.connection_to_packaged_worker",
    acceptanceChecks: [
      "Required connector freshness is proven",
      "Least-privilege grants are present",
      "Rollback evidence passes",
    ],
    firstBlocker: "Package-specific handoff fixture and launch smoke.",
    launchGate: "Required connector freshness, least-privilege grant, and rollback evidence pass.",
    externalExecution: "blocked",
    autonomyLevel: 2,
    cluster: "All ICP clusters",
    composedFamilies: ["Revenue", "Dispatch/Ops", "Finance", "Systems"],
    firstPackagedOutcome: "Connection-ready package flow with evidence-backed readiness gates.",
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md", "docs/worker-handoffs.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 12,
    order: 12.1,
    key: "package_quote_to_cash_field",
    name: "Quote-to-Cash Field Worker",
    status: "packaged",
    kind: "packaged_worker",
    apiRoute: workerApiRoute,
    packageKey: "quote_to_cash_field",
    strategyFamily: "Local field-service SMBs",
    familyKind: "packaged_bundle",
    firstCommand: "package.flow.prepare",
    firstView: "package_readiness",
    coreObjects: ["Lead", "Quote", "Appointment", "Closeout", "Invoice", "Review"],
    incomingHandoff: "systems.connection_to_packaged_worker",
    acceptanceChecks: [
      "Revenue-to-dispatch-to-finance handoff is complete",
      "Customer-send approval is present",
      "Adapter receipts are recorded",
    ],
    firstBlocker: "Field-service package fixture and connector-readiness smoke.",
    launchGate: "Revenue-to-dispatch-to-finance handoff, customer-send approval, and adapter receipts.",
    externalExecution: "blocked",
    autonomyLevel: 2,
    cluster: "Local field-service SMBs",
    composedFamilies: ["Revenue", "Dispatch/Ops", "Finance", "Customer Experience"],
    firstPackagedOutcome: "Lead response, quote, schedule proposal, closeout, invoice draft, and review request.",
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 12,
    order: 12.2,
    key: "package_knowledge_delivery",
    name: "Knowledge Delivery Worker",
    status: "packaged",
    kind: "packaged_worker",
    apiRoute: workerApiRoute,
    packageKey: "knowledge_delivery",
    strategyFamily: "Expert-service SMBs",
    familyKind: "packaged_bundle",
    firstCommand: "package.flow.prepare",
    firstView: "package_readiness",
    coreObjects: ["Lead", "Proposal", "DeliverablePacket", "Invoice", "ClientUpdate", "EvidenceBinder"],
    incomingHandoff: "systems.connection_to_packaged_worker",
    acceptanceChecks: [
      "Proposal and deliverable packet schema exists",
      "Billing handoff is complete",
      "Knowledge claims carry source evidence",
    ],
    firstBlocker: "Proposal, deliverable, and billing packet fixture.",
    launchGate: "Proposal/deliverable packet schema, billing handoff, and source-backed knowledge claims.",
    externalExecution: "blocked",
    autonomyLevel: 2,
    cluster: "Expert-service SMBs",
    composedFamilies: ["Revenue", "Offer/Pricing", "Customer Experience", "Finance", "Compliance"],
    firstPackagedOutcome: "Intake, proposal, deliverable packet, retainer or billing draft, and client update.",
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 12,
    order: 12.3,
    key: "package_inventory_replenishment",
    name: "Inventory and Replenishment Worker",
    status: "packaged",
    kind: "packaged_worker",
    apiRoute: workerApiRoute,
    packageKey: "inventory_replenishment",
    strategyFamily: "Physical goods SMBs",
    familyKind: "packaged_bundle",
    firstCommand: "package.flow.prepare",
    firstView: "package_readiness",
    coreObjects: ["InventoryItem", "Vendor", "PurchaseOrder", "CashForecast", "Connection", "Receipt"],
    incomingHandoff: "systems.connection_to_packaged_worker",
    acceptanceChecks: [
      "Inventory and source sync proof exists",
      "Purchase approval is required",
      "Vendor and accounting dry-run receipts are recorded",
    ],
    firstBlocker: "Inventory source sync fixture and purchase approval packet.",
    launchGate: "Inventory/source sync proof, purchase approval, and vendor/accounting dry-run receipt.",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    cluster: "Physical goods SMBs",
    composedFamilies: ["Asset/Supply", "Finance", "Systems"],
    firstPackagedOutcome: "Stockout detection, reorder draft, vendor packet, and cash impact.",
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 12,
    order: 12.4,
    key: "package_compliance_qa",
    name: "Compliance QA Worker",
    status: "packaged",
    kind: "packaged_worker",
    apiRoute: workerApiRoute,
    packageKey: "compliance_qa",
    strategyFamily: "Regulated care/trust SMBs",
    familyKind: "packaged_bundle",
    firstCommand: "package.flow.prepare",
    firstView: "package_readiness",
    coreObjects: ["RulePack", "EvidenceBinder", "Deadline", "Exception", "GeneratedView"],
    incomingHandoff: "systems.connection_to_packaged_worker",
    acceptanceChecks: [
      "Rule-source traceability exists",
      "Exception queue is generated",
      "Audit packet can be exported",
    ],
    firstBlocker: "Rule-source traceability fixture and exportable audit packet.",
    launchGate: "Rule-source traceability, exception queue, and exportable audit packet.",
    externalExecution: "blocked",
    autonomyLevel: 2,
    cluster: "Regulated care/trust SMBs",
    composedFamilies: ["Compliance", "Systems", "Owner"],
    firstPackagedOutcome: "Documentation quality review, deadline blocker, and evidence binder.",
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md"],
  },
  {
    schemaVersion: "continuous.worker_expansion.v1",
    wave: 12,
    order: 12.5,
    key: "package_maintenance",
    name: "Maintenance Worker",
    status: "packaged",
    kind: "packaged_worker",
    apiRoute: workerApiRoute,
    packageKey: "maintenance",
    strategyFamily: "Asset-heavy SMBs",
    familyKind: "packaged_bundle",
    firstCommand: "package.flow.prepare",
    firstView: "package_readiness",
    coreObjects: ["Asset", "MaintenanceEvent", "Incident", "Vendor", "PartsDraft", "ComplianceRef"],
    incomingHandoff: "systems.connection_to_packaged_worker",
    acceptanceChecks: [
      "Asset history is present",
      "Safety and compliance source refs are present",
      "Purchase approval gate is active",
    ],
    firstBlocker: "Asset history fixture and purchase approval gate.",
    launchGate: "Asset history, safety/compliance source refs, and purchase approval gate.",
    externalExecution: "dry_run",
    autonomyLevel: 2,
    cluster: "Asset-heavy SMBs",
    composedFamilies: ["Asset/Supply", "Compliance", "Operations", "Finance"],
    firstPackagedOutcome: "Preventive maintenance schedule, incident packet, and vendor or parts draft.",
    sourceDocs: ["docs/worker-expansion.md", "docs/worker-roadmap.md"],
  },
];

export function plannedWorkerRoles() {
  return plannedWorkerContracts.map((contract) => contract.role);
}

export function plannedWorkerCommands(): PlannedWorkerCommandRegistryEntry[] {
  return plannedWorkerContracts.flatMap((contract) =>
    contract.commands.map((command) => {
      return {
        ...command,
        apiRoute: contract.apiRoute,
        contractPath: contract.contractPath,
        evidencePacket: contract.evidencePacket,
        configSchema: plannedConfigSchema(command),
      };
    }),
  );
}

export function plannedWorkerViews(): PlannedWorkerViewRegistryEntry[] {
  return plannedWorkerContracts.flatMap((contract) =>
    contract.views.map((view) => ({
      ...view,
      apiRoute: contract.apiRoute,
      contractPath: contract.contractPath,
      evidencePacket: view.name === "snapshot" ? null : contract.evidencePacket,
      configSchema: plannedViewConfigSchema(view),
    })),
  );
}

type RegisteredWorkerItem = {
  role: string;
  name: string;
};

function registeredKeys(items: RegisteredWorkerItem[]) {
  return new Set(items.map((item) => `${item.role}:${item.name}`));
}

export function workerFollowUpCommands(
  registeredCommands: RegisteredWorkerItem[] = [],
): PlannedWorkerCommandRegistryEntry[] {
  const registered = registeredKeys(registeredCommands);

  return workerContracts.flatMap((contract) =>
    contract.commands
      .filter((command) => !registered.has(`${command.role}:${command.name}`))
      .map((command) => ({
        ...command,
        apiRoute: contract.apiRoute,
        contractPath: contract.contractPath,
        evidencePacket: contract.evidencePacket,
        configSchema: plannedConfigSchema(command),
      })),
  );
}

export function workerFollowUpViews(
  registeredViews: RegisteredWorkerItem[] = [],
): PlannedWorkerViewRegistryEntry[] {
  const registered = registeredKeys(registeredViews);

  return workerContracts.flatMap((contract) =>
    contract.views
      .filter((view) => !registered.has(`${view.role}:${view.name}`))
      .map((view) => ({
        ...view,
        apiRoute: contract.apiRoute,
        contractPath: contract.contractPath,
        evidencePacket: view.name === "snapshot" ? null : contract.evidencePacket,
        configSchema: plannedViewConfigSchema(view),
      })),
  );
}

export function workerContractForRole(role: string) {
  return workerContracts.find((contract) => contract.role === role);
}

export function plannedWorkerContractForRole(role: string) {
  return plannedWorkerContracts.find((contract) => contract.role === role);
}
