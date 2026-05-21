import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { PlatformUnavailableError } from "../core/errors";
import { loadOperatorContext } from "../core/operators";
import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  capabilities,
  capabilityGrants,
  documents,
  evidence,
  evidencePackets,
  events,
  filingDrafts,
  filingRequirements,
  generatedViews,
  objectLinks,
  objects,
  objectVersions,
  obligations,
  rulePacks,
  tasks,
  tenants,
  usageEvents,
  users,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";

type Database = typeof defaultDb;

export const complianceWorkerRole = "compliance_operations";

const complianceSource = "continuous.worker";
const filingPrepareCapabilityKey = "filing.prepare";
const filingDraftWorkflowKey = "filing_draft";
const filingPrepareUnits = 3000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ComplianceWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type ComplianceContext = {
  worker: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    name: string;
    role: string;
    state: string;
    mission: string;
    autonomyLevel: number;
    scope: JsonObject;
    policy: JsonObject;
    kpis: JsonObject;
    managerName: string | null;
  };
  operator: {
    id: string;
    email: string;
    name: string;
    actorRef: string;
  };
  reviewerUserId: string | null;
  capabilityId: string;
  budgetAccountId: string;
};

export type ComplianceFilingPrepareResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  filingObjectId: string | null;
  filingDraftId: string | null;
  filingRequirementId: string | null;
  obligationId: string | null;
  rulePackId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  complianceViewId: string | null;
  externalExecution: "blocked";
  output: JsonObject;
  snapshot: ComplianceWorkerSnapshot;
};

export type ComplianceWorkerSnapshot = {
  worker: {
    id: string;
    name: string;
    role: string;
    state: string;
    mission: string;
    autonomyLevel: number;
    scope: JsonObject;
    policy: JsonObject;
    kpis: JsonObject;
    managerName: string | null;
    tenantName: string;
  } | null;
  budget: {
    accountId: string | null;
    name: string | null;
    usedUnits: number;
    heldUnits: number;
    events: number;
  };
  controls: {
    pendingApprovals: number;
    generatedViews: number;
    externalExecution: "blocked";
    agencySubmission: "blocked";
    sensitiveData: "redacted";
  };
  obligations: Array<{
    id: string;
    name: string;
    kind: string;
    state: string;
    dueAt: string | null;
    data: JsonObject;
  }>;
  filingDrafts: Array<{
    id: string;
    requirementId: string;
    obligationId: string | null;
    state: string;
    periodStart: string | null;
    periodEnd: string | null;
    data: JsonObject;
  }>;
  approvals: Array<{
    id: string;
    state: string;
    kind: string;
    title: string;
    priority: string;
  }>;
  latestRun: {
    id: string;
    workerRunId: string;
    eventId: string | null;
    idempotencyKey: string;
    state: string;
    mode: string;
    output: JsonObject;
  } | null;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uuidValue(value: unknown) {
  const text = optionalString(value);

  return text && uuidPattern.test(text) ? text : undefined;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
}

function hashObject(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function outputData(data: JsonObject) {
  return objectValue(data.output);
}

function workerWhere(selector: ComplianceWorkerSelector) {
  const conditions = [
    eq(workers.role, complianceWorkerRole),
    sql`${workers.state} in ('training', 'active')`,
  ];

  if (selector.workerId) {
    conditions.push(eq(workers.id, selector.workerId));
  }

  if (selector.tenantSlug) {
    conditions.push(eq(tenants.slug, selector.tenantSlug));
  }

  return and(...conditions);
}

function assertSingleWorker<T>(rows: T[], selector: ComplianceWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Compliance Operations Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadComplianceWorker(db: Database, selector: ComplianceWorkerSelector) {
  const rows = await db
    .select({
      id: workers.id,
      tenantId: workers.tenantId,
      name: workers.name,
      role: workers.role,
      state: workers.state,
      mission: workers.mission,
      autonomyLevel: workers.autonomyLevel,
      scope: workers.scope,
      policy: workers.policy,
      kpis: workers.kpis,
      managerUserId: workers.managerUserId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      managerName: users.name,
    })
    .from(workers)
    .innerJoin(tenants, eq(workers.tenantId, tenants.id))
    .leftJoin(users, eq(workers.managerUserId, users.id))
    .where(workerWhere(selector))
    .orderBy(workers.createdAt)
    .limit(selector.workerId ? 1 : 2);

  return assertSingleWorker(rows, selector);
}

async function loadComplianceContext(input: {
  db: Database;
  selector: ComplianceWorkerSelector;
  operatorEmail: string;
  capabilityKey: string;
  capabilityLabel: string;
}): Promise<ComplianceContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadComplianceWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Compliance Operations Worker matches this selector.",
      404,
    );
  }

  if (worker.tenantId !== operator.tenantId) {
    throw new PlatformUnavailableError(
      "operator_tenant_mismatch",
      "Operator is not a member of the selected worker tenant.",
      403,
    );
  }

  const [capability] = await input.db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, input.capabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      `Compliance Operations Worker requires the ${input.capabilityLabel} capability.`,
      409,
    );
  }

  const [grant] = await input.db
    .select({ id: capabilityGrants.id })
    .from(capabilityGrants)
    .where(
      and(
        eq(capabilityGrants.tenantId, worker.tenantId),
        eq(capabilityGrants.capabilityId, capability.id),
        eq(capabilityGrants.actorType, "worker"),
        eq(capabilityGrants.actorId, worker.id),
        eq(capabilityGrants.active, true),
      ),
    )
    .limit(1);

  if (!grant) {
    throw new PlatformUnavailableError(
      "worker_capability_not_granted",
      `Compliance Operations Worker does not have an active ${input.capabilityLabel} grant.`,
      403,
    );
  }

  const [budgetAccount] = await input.db
    .select({ id: budgetAccounts.id })
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.tenantId, worker.tenantId),
        eq(budgetAccounts.target, "worker"),
        eq(budgetAccounts.targetId, worker.id),
        eq(budgetAccounts.active, true),
      ),
    )
    .orderBy(budgetAccounts.createdAt)
    .limit(1);

  if (!budgetAccount) {
    throw new PlatformUnavailableError(
      "worker_budget_missing",
      "Compliance Operations Worker requires an active worker budget account.",
      409,
    );
  }

  return {
    worker,
    operator: {
      id: operator.userId,
      email: operator.email,
      name: operator.name,
      actorRef: operator.actorRef,
    },
    reviewerUserId: worker.managerUserId,
    capabilityId: capability.id,
    budgetAccountId: budgetAccount.id,
  };
}

function parsePeriod(value: unknown) {
  const period = objectValue(value);
  const label = optionalString(period.label) ?? optionalString(period.name) ?? optionalString(period.period);
  const from = optionalString(period.from) ?? optionalString(period.start) ?? optionalString(period.periodStart);
  const to = optionalString(period.to) ?? optionalString(period.end) ?? optionalString(period.periodEnd);

  if (!from || !to) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.period.from and config.period.to are required for filing.prepare.",
      400,
    );
  }

  const start = new Date(from);
  const end = new Date(to);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.period.from and config.period.to must be valid ISO dates.",
      400,
    );
  }

  if (start >= end) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.period.from must be before config.period.to.",
      400,
    );
  }

  return {
    label: label ?? `${start.toISOString()}..${end.toISOString()}`,
    start,
    end,
    json: {
      label: label ?? null,
      from: start.toISOString(),
      to: end.toISOString(),
    },
  };
}

async function nextObjectVersion(db: Pick<Database, "select">, objectId: string) {
  const [latest] = await db
    .select({ version: objectVersions.version })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId))
    .orderBy(desc(objectVersions.version))
    .limit(1);

  return (latest?.version ?? 0) + 1;
}

async function writeGeneratedView(input: {
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0];
  tenantId: string;
  capabilityId: string;
  taskState: "approval_required" | "blocked";
  data: JsonObject;
  now: Date;
}) {
  const [existing] = await input.tx
    .select({ id: generatedViews.id })
    .from(generatedViews)
    .where(
      and(
        eq(generatedViews.tenantId, input.tenantId),
        eq(generatedViews.key, "compliance.filing.review"),
        eq(generatedViews.version, "1.0.0"),
      ),
    )
    .limit(1);

  const values = {
    tenantId: input.tenantId,
    capabilityId: input.capabilityId,
    key: "compliance.filing.review",
    version: "1.0.0",
    name: "Compliance filing review",
    purpose: "Review rule source, filing draft validation, blockers, and approval actions.",
    surface: "web",
    objectType: "filing_draft",
    taskState: input.taskState,
    contract: {
      version: "1.0.0",
      role: complianceWorkerRole,
      sections: ["RuleSource", "Requirement", "DraftValidation", "EvidenceTimeline", "ActionBar"],
    },
    actions: {
      primary: input.taskState === "blocked" ? "resolve_blockers" : "approve_filing_draft",
      secondary: ["request_revision", "export_packet"],
    },
    data: input.data,
    mask: {
      taxIdentifiers: true,
      bankFields: true,
      rawAgencyCredentials: "never",
    },
    active: true,
    updatedAt: input.now,
  } satisfies typeof generatedViews.$inferInsert;

  const [view] = existing
    ? await input.tx
        .update(generatedViews)
        .set(values)
        .where(eq(generatedViews.id, existing.id))
        .returning({ id: generatedViews.id })
    : await input.tx
        .insert(generatedViews)
        .values({ ...values, createdAt: input.now })
        .returning({ id: generatedViews.id });

  return view.id;
}

async function getRequirement(db: Database, tenantId: string, requirementId: string) {
  const [requirement] = await db
    .select({
      id: filingRequirements.id,
      tenantId: filingRequirements.tenantId,
      legalEntityId: filingRequirements.legalEntityId,
      rulePackId: filingRequirements.rulePackId,
      form: filingRequirements.form,
      cadence: filingRequirements.cadence,
      agency: filingRequirements.agency,
      state: filingRequirements.state,
      data: filingRequirements.data,
    })
    .from(filingRequirements)
    .where(
      and(
        eq(filingRequirements.tenantId, tenantId),
        eq(filingRequirements.id, requirementId),
        eq(filingRequirements.state, "active"),
      ),
    )
    .limit(1);

  if (!requirement) {
    throw new PlatformUnavailableError(
      "worker_filing_requirement_not_found",
      "config.filingRequirementId does not match an active filing requirement in this tenant.",
      404,
    );
  }

  return requirement;
}

async function getRulePack(db: Database, rulePackId: string | null) {
  if (!rulePackId) {
    return null;
  }

  const [rulePack] = await db
    .select()
    .from(rulePacks)
    .where(eq(rulePacks.id, rulePackId))
    .limit(1);

  return rulePack ?? null;
}

async function getObligation(input: {
  db: Database;
  tenantId: string;
  requirementRulePackId: string | null;
  requestedObligationId?: string;
}) {
  if (input.requestedObligationId) {
    const [obligation] = await input.db
      .select()
      .from(obligations)
      .where(
        and(
          eq(obligations.tenantId, input.tenantId),
          eq(obligations.id, input.requestedObligationId),
        ),
      )
      .limit(1);

    if (!obligation) {
      throw new PlatformUnavailableError(
        "worker_obligation_not_found",
        "config.obligationId does not match an obligation in this tenant.",
        404,
      );
    }

    return obligation;
  }

  const conditions = [
    eq(obligations.tenantId, input.tenantId),
    eq(obligations.state, "open"),
  ];

  if (input.requirementRulePackId) {
    conditions.push(eq(obligations.rulePackId, input.requirementRulePackId));
  }

  const [obligation] = await input.db
    .select()
    .from(obligations)
    .where(and(...conditions))
    .orderBy(obligations.dueAt)
    .limit(1);

  return obligation ?? null;
}

function sourceRefsFrom(config: JsonObject, rulePack: Awaited<ReturnType<typeof getRulePack>>) {
  return {
    ...objectValue(rulePack?.sourceRefs),
    ...objectValue(config.sourceRefs),
  };
}

function blockerList(input: {
  rulePack: Awaited<ReturnType<typeof getRulePack>>;
  obligation: Awaited<ReturnType<typeof getObligation>>;
  sourceRefs: JsonObject;
  validation?: JsonObject;
}) {
  const validation = input.validation ?? {};
  const blockers = [
    input.rulePack ? "" : "rule_pack_missing",
    Object.keys(input.sourceRefs).length > 0 ? "" : "rule_source_refs_missing",
    input.obligation ? "" : "open_obligation_missing",
    ...stringList(validation.blockers),
  ].filter(Boolean);

  return Array.from(new Set(blockers));
}

export async function prepareComplianceFiling(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<ComplianceFilingPrepareResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const filingRequirementId = uuidValue(config.filingRequirementId);

  if (!filingRequirementId) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.filingRequirementId must be a valid filing requirement id.",
      400,
    );
  }

  const period = parsePeriod(config.period);
  const context = await loadComplianceContext({
    db,
    selector: { role: complianceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: filingPrepareCapabilityKey,
    capabilityLabel: "filing.prepare",
  });
  const requirement = await getRequirement(db, context.worker.tenantId, filingRequirementId);
  const rulePack = await getRulePack(db, requirement.rulePackId);
  const obligation = await getObligation({
    db,
    tenantId: context.worker.tenantId,
    requirementRulePackId: requirement.rulePackId,
    requestedObligationId: uuidValue(config.obligationId),
  });
  const sourceRefs = sourceRefsFrom(config, rulePack);
  const validation = {
    state: "review_required",
    submission: "blocked",
    checks: {
      sourceRefs: Object.keys(sourceRefs).length > 0,
      requirementActive: true,
      rulePackActive: rulePack?.active === true,
      obligationOpen: obligation?.state === "open",
    },
    ...objectValue(config.validation),
  };
  const blockers = blockerList({ rulePack, obligation, sourceRefs, validation });
  const reviewState = blockers.length > 0 ? "blocked" : "approval_required";
  const inputHash = hashObject({
    schemaVersion: "compliance.filing.prepare.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    requirementId: requirement.id,
    obligationId: obligation?.id ?? null,
    rulePackId: rulePack?.id ?? null,
    period: period.json,
    blockers,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${complianceSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, complianceSource),
          eq(workerRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      const existingInput = objectValue(objectValue(existingRun.data).input);
      const existingHash = optionalString(existingInput.inputHash);

      if (existingHash && existingHash !== inputHash) {
        throw new PlatformUnavailableError(
          "worker_idempotency_conflict",
          "A Compliance filing packet already exists for this idempotency key with different input.",
          409,
        );
      }

      return { status: "replay" as const, replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, filingDraftWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Compliance Operations Worker requires the filing_draft workflow definition.",
        409,
      );
    }

    const filingData = {
      command: "filing.prepare",
      filingRequirementId: requirement.id,
      obligationId: obligation?.id ?? null,
      rulePackId: rulePack?.id ?? null,
      form: requirement.form,
      agency: requirement.agency,
      cadence: requirement.cadence,
      legalEntityId: requirement.legalEntityId,
      period: period.json,
      sourceRefs,
      ruleSnapshot: rulePack
        ? {
            id: rulePack.id,
            key: rulePack.key,
            version: rulePack.version,
            jurisdiction: rulePack.jurisdiction,
            rules: rulePack.rules,
            sourceRefs: rulePack.sourceRefs,
          }
        : null,
      validation,
      blockers,
      policy: {
        externalExecution: "blocked",
        agencySubmission: "blocked",
        legalAdvice: "blocked",
        humanApproval: "required",
        sensitiveData: "redacted",
        ...objectValue(config.policy),
      },
      redaction: {
        taxIdentifiers: "redacted",
        bankFields: "redacted",
        rawAgencyCredentials: "never",
      },
      externalExecution: "blocked",
      submission: "blocked",
      preparedAt: now.toISOString(),
    } satisfies JsonObject;

    const [filingObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "filing_draft",
        name: `${requirement.agency} ${requirement.form} filing draft ${period.label}`,
        state: reviewState,
        source: complianceSource,
        externalId: `compliance-filing:${input.idempotencyKey}`,
        data: filingData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id, name: objects.name });

    const objectVersion = await nextObjectVersion(tx, filingObject.id);
    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: filingObject.id,
      version: objectVersion,
      data: filingData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "compliance filing draft prepared",
      createdAt: now,
    });

    const [filingDraft] = await tx
      .insert(filingDrafts)
      .values({
        tenantId: context.worker.tenantId,
        requirementId: requirement.id,
        obligationId: obligation?.id,
        state: "review_ready",
        periodStart: period.start,
        periodEnd: period.end,
        data: {
          ...filingData,
          objectId: filingObject.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: filingDrafts.id });

    if (obligation?.objectId) {
      await tx
        .insert(objectLinks)
        .values({
          tenantId: context.worker.tenantId,
          fromId: obligation.objectId,
          toId: filingObject.id,
          type: "satisfied_by_draft",
          data: { source: complianceSource, command: "filing.prepare" },
          effectiveAt: now,
        })
        .onConflictDoNothing();
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: filingObject.id,
        capabilityId: context.capabilityId,
        title: `Review ${requirement.agency} ${requirement.form} filing draft`,
        state: reviewState === "blocked" ? "blocked" : "approval_required",
        priority: blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          command: "filing.prepare",
          filingRequirementId: requirement.id,
          filingDraftId: filingDraft.id,
          sourceRefs,
          blockers,
        },
        outcome: {
          externalExecution: "blocked",
          agencySubmission: "blocked",
        },
        dueAt: obligation?.dueAt ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const [run] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source: complianceSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: {
            command: "filing.prepare",
            inputHash,
            config,
          },
        },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: filingObject.id,
        workerId: context.worker.id,
        state: reviewState === "blocked" ? "blocked" : "approval_pending",
        idempotencyKey: input.idempotencyKey,
        data: {
          ...filingData,
          filingDraftId: filingDraft.id,
          workerRunId: run.id,
        },
        blockers: { items: blockers },
        metrics: {
          blockerCount: blockers.length,
          sourceRefCount: Object.keys(sourceRefs).length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.compliance_operations.filing_prepare.completed",
        source: complianceSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: filingObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:filing_prepare_completed`,
        data: {
          ...filingData,
          filingDraftId: filingDraft.id,
          workerRunId: run.id,
          workflowRunId: workflowRun.id,
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        objectId: filingObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "trace",
        name: "Compliance filing preparation trace",
        actorType: "worker",
        actorId: context.worker.id,
        hash: `${complianceSource}:filing:${filingObject.id}:${input.idempotencyKey}`,
        data: {
          inputHash,
          filingRequirementId: requirement.id,
          filingDraftId: filingDraft.id,
          obligationId: obligation?.id ?? null,
          rulePackId: rulePack?.id ?? null,
          sourceRefs,
          validation,
          blockers,
          externalExecution: "blocked",
          agencySubmission: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: filingObject.id,
        workflowRunId: workflowRun.id,
        kind: "filing_draft_packet",
        name: `${requirement.agency} ${requirement.form} compliance packet`,
        state: reviewState === "blocked" ? "blocked" : "review_ready",
        sensitivity: "high",
        hash: `${complianceSource}:filing:${filingObject.id}:${input.idempotencyKey}:document`,
        data: {
          ...filingData,
          filingDraftId: filingDraft.id,
          evidenceIds: [traceEvidence.id],
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        objectId: filingObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "compliance_packet",
        name: `${requirement.agency} ${requirement.form} compliance packet`,
        state: reviewState === "blocked" ? "blocked" : "prepared",
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id] },
        documentIds: { ids: [document.id] },
        data: {
          ...filingData,
          filingDraftId: filingDraft.id,
          documentId: document.id,
        },
        hash: `${complianceSource}:filing:${filingObject.id}:${input.idempotencyKey}:packet`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });

    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task.id,
        workerRunId: run.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        objectId: filingObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "compliance_filing_approval",
        state: "pending",
        priority: blockers.length > 0 ? "high" : "normal",
        risk: "high",
        title: `Review ${requirement.agency} ${requirement.form} filing draft`,
        summary:
          "Review source rule refs, validation state, and filing packet before any agency submission. External submission remains blocked.",
        requestedAction: {
          action: blockers.length > 0 ? "resolve_blockers" : "approve_filing_draft",
          externalExecution: "blocked",
          agencySubmission: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds: [traceEvidence.id],
          blockers,
        },
        policy: filingData.policy as JsonObject,
        data: {
          ...filingData,
          filingDraftId: filingDraft.id,
          packetId: packet.id,
          documentId: document.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });

    const workflowStepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: filingObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "filing_draft_prepare",
          name: "Prepare filing draft",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: "high",
          fromState: "source_data_review",
          toState: reviewState === "blocked" ? "blocked" : "review_ready",
          idempotencyKey: `${input.idempotencyKey}:filing_draft_prepare`,
          input: { command: "filing.prepare", config },
          output: {
            filingDraftId: filingDraft.id,
            packetId: packet.id,
            documentId: document.id,
            evidenceId: traceEvidence.id,
            blockers,
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          taskId: task.id,
          objectId: filingObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Request filing draft review",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: "high",
          fromState: reviewState === "blocked" ? "blocked" : "review_ready",
          toState: reviewState === "blocked" ? "blocked" : "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:approval_request`,
          input: { packetId: packet.id },
          output: { approvalRequestId: approval.id, agencySubmission: "blocked" },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);

    const complianceViewId = await writeGeneratedView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      taskState: reviewState,
      data: {
        latest: {
          objectId: filingObject.id,
          filingDraftId: filingDraft.id,
          filingRequirementId: requirement.id,
          obligationId: obligation?.id ?? null,
          rulePackId: rulePack?.id ?? null,
          approvalRequestId: approval.id,
          packetId: packet.id,
          documentId: document.id,
          blockers,
          validation,
          sourceRefs,
        },
      },
      now,
    });

    await tx.insert(usageEvents).values({
      tenantId: context.worker.tenantId,
      accountId: context.budgetAccountId,
      taskId: task.id,
      capabilityId: context.capabilityId,
      actorType: "worker",
      actorId: context.worker.id,
      units: filingPrepareUnits,
      data: {
        command: "filing.prepare",
        mode: "simulation",
      },
      createdAt: now,
    });

    const output = {
      command: "filing.prepare",
      workerRunId: run.id,
      taskId: task.id,
      eventId: event.id,
      filingObjectId: filingObject.id,
      filingDraftId: filingDraft.id,
      filingRequirementId: requirement.id,
      obligationId: obligation?.id ?? null,
      rulePackId: rulePack?.id ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      complianceViewId,
      period: period.json,
      blockers,
      validation,
      policy: filingData.policy as JsonObject,
      redaction: filingData.redaction as JsonObject,
      legalAdvice: "blocked",
      taskState: reviewState === "blocked" ? "blocked" : "approval_required",
      handoff: {
        name: "compliance.obligation_to_owner_review",
        filingDraftId: filingDraft.id,
        approvalRequestId: approval.id,
        packetId: packet.id,
        documentId: document.id,
        workflowRunId: workflowRun.id,
        externalExecution: "blocked",
        agencySubmission: "blocked",
      },
      externalExecution: "blocked",
      agencySubmission: "blocked",
      sourceRefs,
    } satisfies JsonObject;

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        state: "done",
        endedAt: now,
        updatedAt: now,
        data: {
          input: {
            command: "filing.prepare",
            inputHash,
            config,
          },
          output,
        },
      })
      .where(eq(workerRuns.id, run.id));

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "worker.compliance_operations.filing_prepare.completed",
      source: complianceSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: run.id,
      eventId: event.id,
      objectId: filingObject.id,
      risk: "high",
      idempotencyKey: `${input.idempotencyKey}:filing_prepare_completed`,
      data: output,
      createdAt: now,
    });

    return {
      created: true,
      workerRunId: run.id,
      taskId: task.id,
      eventId: event.id,
      filingObjectId: filingObject.id,
      filingDraftId: filingDraft.id,
      filingRequirementId: requirement.id,
      obligationId: obligation?.id ?? null,
      rulePackId: rulePack?.id ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      complianceViewId,
      output,
    };
  });

  if (result.status === "replay") {
    const replay = result.replay;
    const output = outputData(objectValue(replay.data));
    const snapshot = await getComplianceWorkerSnapshot({
      tenantSlug: input.tenantSlug,
      workerId: input.workerId,
      db,
    });

    return {
      created: false,
      idempotencyKey: input.idempotencyKey,
      workerRunId: replay.id,
      taskId: replay.taskId,
      eventId: replay.eventId,
      filingObjectId: nullishString(output.filingObjectId),
      filingDraftId: nullishString(output.filingDraftId),
      filingRequirementId: nullishString(output.filingRequirementId),
      obligationId: nullishString(output.obligationId),
      rulePackId: nullishString(output.rulePackId),
      approvalRequestId: nullishString(output.approvalRequestId),
      evidenceId: nullishString(output.evidenceId),
      packetId: nullishString(output.packetId),
      documentId: nullishString(output.documentId),
      workflowRunId: nullishString(output.workflowRunId),
      workflowStepIds: stringList(output.workflowStepIds),
      complianceViewId: nullishString(output.complianceViewId),
      externalExecution: "blocked",
      output,
      snapshot,
    };
  }

  const snapshot = await getComplianceWorkerSnapshot({
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    db,
  });

  return {
    ...result,
    idempotencyKey: input.idempotencyKey,
    externalExecution: "blocked",
    snapshot,
  };
}

function nullishString(value: unknown) {
  return optionalString(value) ?? null;
}

export async function getComplianceWorkerSnapshot(input: ComplianceWorkerSelector & { db?: Database } = {}) {
  const db = input.db ?? defaultDb;
  const worker = await loadComplianceWorker(db, input);

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Compliance Operations Worker matches this selector.",
      404,
    );
  }

  const [
    budgetAccount,
    used,
    held,
    pendingApprovals,
    generatedViewCount,
    obligationRows,
    draftRows,
    approvalRows,
    latestRun,
  ] = await Promise.all([
    db
      .select({ id: budgetAccounts.id, name: budgetAccounts.name })
      .from(budgetAccounts)
      .where(
        and(
          eq(budgetAccounts.tenantId, worker.tenantId),
          eq(budgetAccounts.target, "worker"),
          eq(budgetAccounts.targetId, worker.id),
          eq(budgetAccounts.active, true),
        ),
      )
      .orderBy(budgetAccounts.createdAt)
      .limit(1),
    db
      .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)`, events: count() })
      .from(usageEvents)
      .where(and(eq(usageEvents.tenantId, worker.tenantId), eq(usageEvents.actorType, "worker"), eq(usageEvents.actorId, worker.id))),
    db
      .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
      .from(budgetReservations)
      .where(and(eq(budgetReservations.tenantId, worker.tenantId), eq(budgetReservations.state, "held"))),
    db
      .select({ value: count() })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, worker.tenantId),
          eq(approvalRequests.requesterType, "worker"),
          eq(approvalRequests.requesterId, worker.id),
          eq(approvalRequests.state, "pending"),
        ),
      ),
    db
      .select({ value: count() })
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'compliance.%'`)),
    db
      .select({
        id: obligations.id,
        name: obligations.name,
        kind: obligations.kind,
        state: obligations.state,
        dueAt: obligations.dueAt,
        data: obligations.data,
      })
      .from(obligations)
      .where(eq(obligations.tenantId, worker.tenantId))
      .orderBy(obligations.dueAt)
      .limit(10),
    db
      .select({
        id: filingDrafts.id,
        requirementId: filingDrafts.requirementId,
        obligationId: filingDrafts.obligationId,
        state: filingDrafts.state,
        periodStart: filingDrafts.periodStart,
        periodEnd: filingDrafts.periodEnd,
        data: filingDrafts.data,
      })
      .from(filingDrafts)
      .where(eq(filingDrafts.tenantId, worker.tenantId))
      .orderBy(desc(filingDrafts.updatedAt))
      .limit(10),
    db
      .select({
        id: approvalRequests.id,
        state: approvalRequests.state,
        kind: approvalRequests.kind,
        title: approvalRequests.title,
        priority: approvalRequests.priority,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, worker.tenantId),
          eq(approvalRequests.requesterType, "worker"),
          eq(approvalRequests.requesterId, worker.id),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(10),
    db
      .select()
      .from(workerRuns)
      .where(and(eq(workerRuns.tenantId, worker.tenantId), eq(workerRuns.workerId, worker.id)))
      .orderBy(desc(workerRuns.createdAt))
      .limit(1),
  ]);

  const [account] = budgetAccount;
  const [usedRow] = used;
  const [heldRow] = held;
  const [approvalRow] = pendingApprovals;
  const [viewRow] = generatedViewCount;
  const [run] = latestRun;

  return {
    worker: {
      id: worker.id,
      name: worker.name,
      role: worker.role,
      state: worker.state,
      mission: worker.mission,
      autonomyLevel: worker.autonomyLevel,
      scope: worker.scope,
      policy: worker.policy,
      kpis: worker.kpis,
      managerName: worker.managerName,
      tenantName: worker.tenantName,
    },
    budget: {
      accountId: account?.id ?? null,
      name: account?.name ?? null,
      usedUnits: numberValue(usedRow?.units),
      heldUnits: numberValue(heldRow?.units),
      events: numberValue(usedRow?.events),
    },
    controls: {
      pendingApprovals: Number(approvalRow?.value ?? 0),
      generatedViews: Number(viewRow?.value ?? 0),
      externalExecution: "blocked",
      agencySubmission: "blocked",
      sensitiveData: "redacted",
    },
    obligations: obligationRows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind,
      state: row.state,
      dueAt: row.dueAt?.toISOString() ?? null,
      data: row.data,
    })),
    filingDrafts: draftRows.map((row) => ({
      id: row.id,
      requirementId: row.requirementId,
      obligationId: row.obligationId,
      state: row.state,
      periodStart: row.periodStart?.toISOString() ?? null,
      periodEnd: row.periodEnd?.toISOString() ?? null,
      data: row.data,
    })),
    approvals: approvalRows,
    latestRun: run
      ? {
          id: run.id,
          workerRunId: run.id,
          eventId: run.eventId,
          idempotencyKey: run.idempotencyKey,
          state: run.state,
          mode: run.mode,
          output: outputData(objectValue(run.data)),
        }
      : null,
  } satisfies ComplianceWorkerSnapshot;
}

function emptySnapshot(): ComplianceWorkerSnapshot {
  return {
    worker: null,
    budget: {
      accountId: null,
      name: null,
      usedUnits: 0,
      heldUnits: 0,
      events: 0,
    },
    controls: {
      pendingApprovals: 0,
      generatedViews: 0,
      externalExecution: "blocked",
      agencySubmission: "blocked",
      sensitiveData: "redacted",
    },
    obligations: [],
    filingDrafts: [],
    approvals: [],
    latestRun: null,
  };
}

export async function getComplianceWorkerSnapshotSafe(
  selector: ComplianceWorkerSelector = {},
): Promise<
  | { ok: true; snapshot: ComplianceWorkerSnapshot; error: null }
  | { ok: false; snapshot: ComplianceWorkerSnapshot; error: string }
> {
  try {
    return {
      ok: true,
      snapshot: await getComplianceWorkerSnapshot(selector),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      snapshot: emptySnapshot(),
      error: error instanceof Error ? error.message : "Compliance worker snapshot unavailable.",
    };
  }
}

export async function listComplianceObligations(input: {
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const context = await loadComplianceContext({
    db,
    selector: { role: complianceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: filingPrepareCapabilityKey,
    capabilityLabel: "filing.prepare",
  });
  const config = input.config ?? {};
  const state = optionalString(config.state);
  const limit = Math.min(Math.max(numberValue(config.limit) || 25, 1), 100);
  const conditions = [eq(obligations.tenantId, context.worker.tenantId)];

  if (state) {
    conditions.push(eq(obligations.state, state));
  }

  const rows = await db
    .select({
      id: obligations.id,
      objectId: obligations.objectId,
      rulePackId: obligations.rulePackId,
      kind: obligations.kind,
      state: obligations.state,
      name: obligations.name,
      dueAt: obligations.dueAt,
      data: obligations.data,
    })
    .from(obligations)
    .where(and(...conditions))
    .orderBy(obligations.dueAt)
    .limit(limit);

  return {
    worker: {
      id: context.worker.id,
      role: context.worker.role,
      tenantSlug: context.worker.tenantSlug,
    },
    obligations: rows.map((row) => ({
      ...row,
      dueAt: row.dueAt?.toISOString() ?? null,
    })),
    filters: { state: state ?? null, limit },
  };
}

export async function getCompliancePacket(input: {
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const context = await loadComplianceContext({
    db,
    selector: { role: complianceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: filingPrepareCapabilityKey,
    capabilityLabel: "filing.prepare",
  });
  const config = input.config ?? {};
  const packetId = uuidValue(config.packetId);
  const filingDraftId = uuidValue(config.filingDraftId);
  const conditions = [
    eq(evidencePackets.tenantId, context.worker.tenantId),
    eq(evidencePackets.kind, "compliance_packet"),
  ];

  if (packetId) {
    conditions.push(eq(evidencePackets.id, packetId));
  }

  if (filingDraftId) {
    conditions.push(sql`${evidencePackets.data}->>'filingDraftId' = ${filingDraftId}`);
  }

  const [packet] = await db
    .select()
    .from(evidencePackets)
    .where(and(...conditions))
    .orderBy(desc(evidencePackets.updatedAt))
    .limit(1);

  if (!packet) {
    return {
      worker: {
        id: context.worker.id,
        role: context.worker.role,
        tenantSlug: context.worker.tenantSlug,
      },
      packet: null,
      document: null,
      approval: null,
    };
  }

  const [document] = packet.documentId
    ? await db.select().from(documents).where(eq(documents.id, packet.documentId)).limit(1)
    : [];
  const [approval] = packet.objectId
    ? await db
        .select()
        .from(approvalRequests)
        .where(
          and(
            eq(approvalRequests.tenantId, context.worker.tenantId),
            eq(approvalRequests.objectId, packet.objectId),
            eq(approvalRequests.kind, "compliance_filing_approval"),
          ),
        )
        .orderBy(desc(approvalRequests.createdAt))
        .limit(1)
    : [];

  return {
    worker: {
      id: context.worker.id,
      role: context.worker.role,
      tenantSlug: context.worker.tenantSlug,
    },
    packet,
    document: document ?? null,
    approval: approval ?? null,
  };
}
