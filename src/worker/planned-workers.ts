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
        description: "Planned split quote-preparation command for owner-reviewable quote packets.",
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
        requiredConfig: ["jobId", "constraints"],
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
        oneRequiredConfig: ["jobId", "closeoutId"],
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
        oneRequiredConfig: ["billId", "paymentId"],
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
      {
        role: "compliance_operations",
        name: "approval.decide",
        toolAlias: "worker.command",
        description: "Decide a compliance approval without agency submission or external mutation.",
        idempotency: "none",
        sideEffects: "internal",
        externalExecution: "blocked",
        requiresTenant: true,
        requiredConfig: ["approvalId", "action"],
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
];

const runtimeWorkerRoles = new Set([
  "revenue_operations",
  "owner_chief_of_staff",
  "dispatch_operations",
  "finance_operations",
  "workforce_operations",
]);

export const runtimeWorkerContracts = workerContracts.filter((contract) =>
  runtimeWorkerRoles.has(contract.role),
);

export const plannedWorkerContracts = workerContracts.filter(
  (contract) => !runtimeWorkerRoles.has(contract.role),
);

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
      })),
  );
}

export function workerContractForRole(role: string) {
  return workerContracts.find((contract) => contract.role === role);
}

export function plannedWorkerContractForRole(role: string) {
  return plannedWorkerContracts.find((contract) => contract.role === role);
}
