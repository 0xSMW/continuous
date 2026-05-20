type IdempotencyPolicy = "required" | "none";
type SideEffectLevel = "internal" | "dry_run" | "approved_only" | "external" | "none";
type ExternalExecution = "blocked" | "dry_run" | "approved_only" | "enabled";

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
  contractPath: string;
  evidencePacket: string;
  configSchema: PlannedWorkerConfigSchema;
};

export type PlannedWorkerViewRegistryEntry = PlannedWorkerViewMetadata & {
  contractPath: string;
  evidencePacket: string | null;
};

export type PlannedWorkerContractMetadata = {
  role: string;
  name: string;
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

  if (field === "accounts" || field === "checks" || field === "objectIds" || field === "sourceRefs") {
    return stringArraySchema();
  }

  if (field === "constraints" || field === "policy" || field === "trigger") {
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

const allPlannedWorkerContracts: PlannedWorkerContractMetadata[] = [
  {
    role: "owner_chief_of_staff",
    name: "Owner Chief-of-Staff Worker",
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
  "owner_chief_of_staff",
  "dispatch_operations",
  "finance_operations",
]);

export const plannedWorkerContracts = allPlannedWorkerContracts.filter(
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
      contractPath: contract.contractPath,
      evidencePacket: view.name === "snapshot" ? null : contract.evidencePacket,
    })),
  );
}

export function plannedWorkerContractForRole(role: string) {
  return plannedWorkerContracts.find((contract) => contract.role === role);
}
