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
  customers,
  customerSignals,
  documents,
  evidence,
  evidencePackets,
  events,
  generatedViews,
  objectLinks,
  objects,
  objectVersions,
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
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const customerExperienceWorkerRole = "customer_experience_operations";

const customerExperienceSource = "continuous.worker";
const recoveryDraftCapabilityKey = "recovery.draft";
const customerRecoveryWorkflowKey = "customer_recovery";
const recoveryDraftUnits = 2600;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CustomerExperienceWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type CustomerExperienceContext = {
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
    managerUserId: string | null;
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

type ResolvedSignal = {
  id: string;
  objectId: string;
  customerId: string | null;
  customerObjectId: string | null;
  customerName: string | null;
  customerData: JsonObject | null;
  type: string;
  state: string;
  source: string;
  externalId: string | null;
  data: JsonObject;
  occurredAt: Date | null;
};

export type CustomerExperienceWorkerSnapshot = {
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
    customerSend: "blocked";
    sensitiveData: "redacted";
  };
  signals: Array<{
    id: string;
    objectId: string;
    customerObjectId: string | null;
    customerName: string | null;
    type: string;
    state: string;
    source: string;
    externalId: string | null;
    severity: string | null;
    sentiment: string | null;
    occurredAt: string | null;
    data: JsonObject;
  }>;
  recoveryDrafts: Array<{
    id: string;
    name: string;
    state: string;
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

export type CustomerExperienceSignalsView = {
  worker: CustomerExperienceWorkerSnapshot["worker"];
  controls: CustomerExperienceWorkerSnapshot["controls"];
  filters: JsonObject;
  signals: CustomerExperienceWorkerSnapshot["signals"];
  recoveryDrafts: CustomerExperienceWorkerSnapshot["recoveryDrafts"];
  approvals: CustomerExperienceWorkerSnapshot["approvals"];
};

export type CustomerExperienceRecoveryDraftResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  recoveryObjectId: string | null;
  customerSignalId: string | null;
  signalObjectId: string | null;
  customerObjectId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  signalsViewId: string | null;
  externalExecution: "blocked";
  externalSend: false;
  output: JsonObject;
  snapshot: CustomerExperienceWorkerSnapshot;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function uuidValue(value: unknown) {
  const text = optionalString(value);

  return text && uuidPattern.test(text) ? text : undefined;
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

function severityFrom(data: JsonObject) {
  return (
    optionalString(data.severity) ??
    optionalString(data.priority) ??
    optionalString(objectValue(data.sentiment).severity) ??
    null
  );
}

function sentimentFrom(data: JsonObject) {
  return (
    optionalString(data.sentiment) ??
    optionalString(objectValue(data.analysis).sentiment) ??
    optionalString(objectValue(data.emotion).sentiment) ??
    null
  );
}

function riskForSignal(type: string, severity: string | null) {
  if (severity === "critical" || severity === "high") {
    return "high" as const;
  }

  return type === "complaint" || type === "review" ? ("medium" as const) : ("low" as const);
}

function blockerList(input: {
  signal: ResolvedSignal;
  sourceRefs: JsonObject;
  policy: JsonObject;
  requestedCustomerObjectId?: string;
}) {
  const blockers = [
    input.signal.customerObjectId ?? input.requestedCustomerObjectId ? "" : "customer_ref_missing",
    input.signal.source ? "" : "signal_source_missing",
    severityFrom(input.signal.data) ? "" : "signal_severity_missing",
    uuidValue(input.sourceRefs.evidencePacketId) ? "" : "evidence_packet_missing",
    input.policy.allowExternalSend === true ? "external_send_requested" : "",
    ...stringList(input.policy.blockers),
  ].filter(Boolean);

  return Array.from(new Set(blockers));
}

function recoveryDraftBody(input: {
  signal: ResolvedSignal;
  blockers: string[];
  policy: JsonObject;
}) {
  const requestedOutcome = optionalString(input.signal.data.requestedOutcome);
  const category = optionalString(input.signal.data.category) ?? input.signal.type.replaceAll("_", " ");
  const customerName = input.signal.customerName ?? "the customer";
  const hasBlockers = input.blockers.length > 0;

  return [
    `Acknowledge ${customerName}'s ${category} signal.`,
    requestedOutcome ? `Reference the requested outcome: ${requestedOutcome}.` : "Ask for any missing facts before promising a remedy.",
    hasBlockers
      ? `Hold for owner review because: ${input.blockers.join(", ")}.`
      : "Offer a factual recovery path and keep the response blocked until owner approval.",
  ].join(" ");
}

function workerWhere(selector: CustomerExperienceWorkerSelector) {
  const conditions = [
    eq(workers.role, customerExperienceWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: CustomerExperienceWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Customer Experience Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadCustomerExperienceWorker(db: Database, selector: CustomerExperienceWorkerSelector) {
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

async function loadCustomerExperienceContext(input: {
  db: Database;
  selector: CustomerExperienceWorkerSelector;
  operatorEmail: string;
}): Promise<CustomerExperienceContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadCustomerExperienceWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Customer Experience Worker matches this selector.",
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
    .where(and(eq(capabilities.key, recoveryDraftCapabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      "Customer Experience Worker requires the recovery.draft capability.",
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
      "Customer Experience Worker does not have an active recovery.draft grant.",
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
      "Customer Experience Worker requires an active worker budget account.",
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

async function nextObjectVersion(db: Pick<Database, "select">, objectId: string) {
  const [latest] = await db
    .select({ version: objectVersions.version })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId))
    .orderBy(desc(objectVersions.version))
    .limit(1);

  return (latest?.version ?? 0) + 1;
}

async function resolveCustomerSignal(input: {
  db: Database;
  tenantId: string;
  sourceRefs: JsonObject;
}): Promise<ResolvedSignal> {
  const requestedSignalId =
    uuidValue(input.sourceRefs.customerSignalId) ?? uuidValue(input.sourceRefs.signalId);
  const requestedSignalObjectId =
    uuidValue(input.sourceRefs.customerSignalObjectId) ?? uuidValue(input.sourceRefs.signalObjectId);

  if (!requestedSignalId && !requestedSignalObjectId) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.sourceRefs.customerSignalObjectId or config.sourceRefs.customerSignalId is required for recovery.draft.",
      400,
    );
  }

  const conditions = [eq(customerSignals.tenantId, input.tenantId)];

  if (requestedSignalId) {
    conditions.push(eq(customerSignals.id, requestedSignalId));
  } else if (requestedSignalObjectId) {
    conditions.push(eq(customerSignals.objectId, requestedSignalObjectId));
  }

  const [signal] = await input.db
    .select({
      id: customerSignals.id,
      objectId: customerSignals.objectId,
      customerId: customerSignals.customerId,
      type: customerSignals.type,
      state: customerSignals.state,
      source: customerSignals.source,
      externalId: customerSignals.externalId,
      data: customerSignals.data,
      occurredAt: customerSignals.occurredAt,
      customerObjectId: customers.objectId,
      customerData: customers.data,
    })
    .from(customerSignals)
    .leftJoin(customers, eq(customerSignals.customerId, customers.id))
    .where(and(...conditions))
    .limit(1);

  if (!signal) {
    throw new PlatformUnavailableError(
      "worker_customer_signal_not_found",
      "config.sourceRefs does not match a customer signal in this tenant.",
      404,
    );
  }

  return {
    ...signal,
    customerName:
      optionalString(signal.customerData?.name) ??
      optionalString(signal.customerData?.displayName) ??
      null,
  };
}

async function assertCustomerObject(input: {
  db: Database;
  tenantId: string;
  customerObjectId?: string;
  signal: ResolvedSignal;
}) {
  const requested = input.customerObjectId;
  const resolved = input.signal.customerObjectId;

  if (!requested) {
    return resolved;
  }

  const [object] = await input.db
    .select({ id: objects.id, type: objects.type })
    .from(objects)
    .where(and(eq(objects.tenantId, input.tenantId), eq(objects.id, requested)))
    .limit(1);

  if (!object || object.type !== "customer") {
    throw new PlatformUnavailableError(
      "worker_customer_not_found",
      "config.sourceRefs.customerObjectId does not match a customer object in this tenant.",
      404,
    );
  }

  if (resolved && requested !== resolved) {
    throw new PlatformUnavailableError(
      "worker_customer_signal_mismatch",
      "config.sourceRefs.customerObjectId does not match the selected customer signal.",
      409,
    );
  }

  return requested;
}

async function writeGeneratedSignalsView(input: {
  tx: Transaction;
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
        eq(generatedViews.key, "customer.signals"),
        eq(generatedViews.version, "1.0.0"),
      ),
    )
    .limit(1);

  const values = {
    tenantId: input.tenantId,
    capabilityId: input.capabilityId,
    key: "customer.signals",
    version: "1.0.0",
    name: "Customer signals",
    purpose: "Review customer signals, recovery drafts, approval actions, and no-send proof.",
    surface: "web",
    objectType: "satisfaction_signal",
    taskState: input.taskState,
    contract: {
      version: "1.0.0",
      role: customerExperienceWorkerRole,
      sections: ["Signal", "Customer", "RecoveryDraft", "Evidence", "ApprovalActions"],
    },
    actions: {
      primary: input.taskState === "blocked" ? "request_facts" : "approve_recovery_draft",
      secondary: ["route_escalation", "request_revision", "reject_send"],
    },
    data: input.data,
    mask: {
      contactDetails: true,
      privateComplaintFacts: true,
      paymentData: true,
      employeeNotes: true,
      rawMessages: "source_handles_only",
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

export async function prepareCustomerRecoveryDraft(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<CustomerExperienceRecoveryDraftResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const sourceRefs = objectValue(config.sourceRefs);
  const policy = objectValue(config.policy);

  if (policy.allowExternalSend === true || config.externalSend === true) {
    throw new PlatformUnavailableError(
      "worker_external_send_blocked",
      "Customer Experience recovery.draft cannot request external send. Keep send policy blocked under config.policy.",
      400,
    );
  }

  const context = await loadCustomerExperienceContext({
    db,
    selector: { role: customerExperienceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const signal = await resolveCustomerSignal({
    db,
    tenantId: context.worker.tenantId,
    sourceRefs,
  });
  const customerObjectId = await assertCustomerObject({
    db,
    tenantId: context.worker.tenantId,
    customerObjectId: uuidValue(sourceRefs.customerObjectId),
    signal,
  });
  const blockers = blockerList({
    signal,
    sourceRefs,
    policy,
    requestedCustomerObjectId: customerObjectId ?? undefined,
  });
  const taskState = blockers.length > 0 ? "blocked" : "approval_required";
  const severity = severityFrom(signal.data);
  const sentiment = sentimentFrom(signal.data);
  const draftBody = recoveryDraftBody({ signal, blockers, policy });
  const draftHash = hashObject({ draftBody, signalId: signal.id, customerObjectId });
  const safePolicy = {
    ...policy,
    requiresOwnerApproval: true,
    allowExternalSend: false,
    externalExecution: "blocked",
    customerSend: "blocked",
    refund: "blocked",
    concession: "approval_required",
  } satisfies JsonObject;
  const inputHash = hashObject({
    schemaVersion: "customer_experience.recovery.draft.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    signalId: signal.id,
    customerObjectId: customerObjectId ?? null,
    blockers,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${customerExperienceSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, customerExperienceSource),
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
          "A Customer Experience recovery draft already exists for this idempotency key with different input.",
          409,
        );
      }

      const output = outputData(existingRun.data);

      return {
        status: "replay" as const,
        output: {
          ...output,
          created: false,
        } as JsonObject,
      };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, customerRecoveryWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Customer Experience Worker requires the customer_recovery workflow definition.",
        409,
      );
    }

    const recoveryData = {
      command: "recovery.draft",
      customerSignalId: signal.id,
      signalObjectId: signal.objectId,
      customerObjectId: customerObjectId ?? null,
      signal: {
        type: signal.type,
        state: signal.state,
        source: signal.source,
        externalId: signal.externalId,
        severity,
        sentiment,
        occurredAt: signal.occurredAt?.toISOString() ?? null,
      },
      sourceRefs,
      blockers,
      draft: {
        body: draftBody,
        bodyHash: draftHash,
        channel: optionalString(policy.channel) ?? "email",
        tone: optionalString(policy.tone) ?? "calm",
        externalSend: false,
      },
      policy: safePolicy,
      redaction: {
        rawMessages: "source_handles_only",
        contactDetails: "redacted",
        paymentData: "redacted",
        employeeNotes: "redacted",
      },
      externalExecution: "blocked",
      externalSend: false,
      preparedAt: now.toISOString(),
    } satisfies JsonObject;

    const [recoveryObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "recovery_draft",
        name: `Recovery draft for ${signal.type.replaceAll("_", " ")}`,
        state: taskState,
        source: customerExperienceSource,
        externalId: `customer-recovery:${input.idempotencyKey}`,
        data: recoveryData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id, name: objects.name });

    const objectVersion = await nextObjectVersion(tx, recoveryObject.id);
    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: recoveryObject.id,
      version: objectVersion,
      data: recoveryData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "customer recovery draft prepared",
      createdAt: now,
    });

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: recoveryObject.id,
          toId: signal.objectId,
          type: "drafted_from_signal",
          data: { source: customerExperienceSource, command: "recovery.draft" },
          effectiveAt: now,
        },
        ...(customerObjectId
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: recoveryObject.id,
                toId: customerObjectId,
                type: "about_customer",
                data: { source: customerExperienceSource, command: "recovery.draft" },
                effectiveAt: now,
              },
            ]
          : []),
      ])
      .onConflictDoNothing();

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: recoveryObject.id,
        capabilityId: context.capabilityId,
        title: `Review customer recovery draft`,
        state: taskState,
        priority: blockers.length > 0 ? "high" : riskForSignal(signal.type, severity) === "high" ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          command: "recovery.draft",
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          sourceRefs,
          blockers,
        },
        outcome: {
          externalExecution: "blocked",
          customerSend: "blocked",
        },
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
        source: customerExperienceSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: {
            command: "recovery.draft",
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
        objectId: recoveryObject.id,
        workerId: context.worker.id,
        state: taskState === "blocked" ? "blocked" : "approval_pending",
        idempotencyKey: input.idempotencyKey,
        data: {
          ...recoveryData,
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
        type: "worker.customer_experience_operations.recovery_draft.completed",
        source: customerExperienceSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: recoveryObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:recovery_draft_completed`,
        data: {
          ...recoveryData,
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
        objectId: recoveryObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "trace",
        name: "Customer recovery draft trace",
        actorType: "worker",
        actorId: context.worker.id,
        hash: `${customerExperienceSource}:recovery:${recoveryObject.id}:${input.idempotencyKey}`,
        data: {
          inputHash,
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          sourceRefs,
          blockers,
          draftHash,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: recoveryObject.id,
        workflowRunId: workflowRun.id,
        kind: "customer_recovery_packet",
        name: "Customer recovery packet",
        state: taskState === "blocked" ? "blocked" : "review_ready",
        sensitivity: "high",
        hash: `${customerExperienceSource}:recovery:${recoveryObject.id}:${input.idempotencyKey}:document`,
        data: {
          ...recoveryData,
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
        objectId: recoveryObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "customer_experience_packet",
        name: "Customer experience packet",
        state: taskState === "blocked" ? "blocked" : "prepared",
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id] },
        documentIds: { ids: [document.id] },
        data: {
          ...recoveryData,
          documentId: document.id,
        },
        hash: `${customerExperienceSource}:recovery:${recoveryObject.id}:${input.idempotencyKey}:packet`,
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
        objectId: recoveryObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "customer_recovery_approval",
        state: "pending",
        priority: blockers.length > 0 ? "high" : "normal",
        risk: riskForSignal(signal.type, severity),
        title: "Review customer recovery draft",
        summary:
          "Review source refs, complaint facts, recovery draft, and no-send proof before any customer response.",
        requestedAction: {
          action: blockers.length > 0 ? "resolve_blockers" : "approve_recovery_draft",
          externalExecution: "blocked",
          customerSend: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds: [traceEvidence.id],
          blockers,
        },
        policy: safePolicy,
        data: {
          ...recoveryData,
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
          objectId: recoveryObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "customer_signal_review",
          name: "Review customer signal",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForSignal(signal.type, severity),
          fromState: "signal_open",
          toState: "facts_review",
          idempotencyKey: `${input.idempotencyKey}:customer_signal_review`,
          input: { command: "recovery.draft", sourceRefs },
          output: {
            customerSignalId: signal.id,
            signalObjectId: signal.objectId,
            customerObjectId: customerObjectId ?? null,
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
          taskId: task.id,
          objectId: recoveryObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "recovery_draft_prepare",
          name: "Prepare recovery draft",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForSignal(signal.type, severity),
          fromState: "facts_review",
          toState: taskState === "blocked" ? "blocked" : "draft_prepared",
          idempotencyKey: `${input.idempotencyKey}:recovery_draft_prepare`,
          input: { signalId: signal.id, policy },
          output: {
            recoveryObjectId: recoveryObject.id,
            draftHash,
            externalExecution: "blocked",
            externalSend: false,
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
          objectId: recoveryObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Request recovery review",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForSignal(signal.type, severity),
          fromState: taskState === "blocked" ? "blocked" : "draft_prepared",
          toState: taskState === "blocked" ? "blocked" : "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:approval_request`,
          input: { packetId: packet.id },
          output: {
            approvalRequestId: approval.id,
            customerSend: "blocked",
            externalExecution: "blocked",
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);

    const signalsViewId = await writeGeneratedSignalsView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      taskState,
      data: {
        latest: {
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          recoveryObjectId: recoveryObject.id,
          approvalRequestId: approval.id,
          packetId: packet.id,
          documentId: document.id,
          evidenceId: traceEvidence.id,
          blockers,
          externalExecution: "blocked",
          externalSend: false,
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
      units: recoveryDraftUnits,
      data: {
        command: "recovery.draft",
        mode: "simulation",
      },
      createdAt: now,
    });

    const output = {
      command: "recovery.draft",
      workerRunId: run.id,
      taskId: task.id,
      eventId: event.id,
      recoveryObjectId: recoveryObject.id,
      customerSignalId: signal.id,
      signalObjectId: signal.objectId,
      customerObjectId: customerObjectId ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      signalsViewId,
      blockers,
      draft: recoveryData.draft as JsonObject,
      policy: safePolicy,
      redaction: recoveryData.redaction as JsonObject,
      generatedView: "customer.signals",
      taskState,
      handoff: {
        name: "customer.signal_to_experience",
        customerSignalId: signal.id,
        signalObjectId: signal.objectId,
        customerObjectId: customerObjectId ?? null,
        approvalRequestId: approval.id,
        packetId: packet.id,
        documentId: document.id,
        workflowRunId: workflowRun.id,
        externalExecution: "blocked",
        customerSend: "blocked",
      },
      externalExecution: "blocked",
      externalSend: false,
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
            command: "recovery.draft",
            inputHash,
            config,
          },
          output,
        },
      })
      .where(eq(workerRuns.id, run.id));

    await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "customer_experience.recovery_draft.prepared",
        source: customerExperienceSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "recovery_draft",
        targetId: recoveryObject.id,
        taskId: task.id,
        eventId: event.id,
        objectId: recoveryObject.id,
        workerRunId: run.id,
        approvalRequestId: approval.id,
        capabilityId: context.capabilityId,
        risk: riskForSignal(signal.type, severity),
        idempotencyKey: `${input.idempotencyKey}:recovery_draft_prepared`,
        data: {
          inputHash,
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          packetId: packet.id,
          signalsViewId,
          blockers,
          externalExecution: "blocked",
          externalSend: false,
        },
      });

    return {
      status: "created" as const,
      output,
    };
  });

  const output = result.output;
  const snapshot = await getCustomerExperienceWorkerSnapshot({
    tenantSlug: context.worker.tenantSlug,
    workerId: context.worker.id,
    db,
  });

  return {
    created: result.status === "created",
    idempotencyKey: input.idempotencyKey,
    workerRunId: stringValue(output.workerRunId),
    taskId: optionalString(output.taskId) ?? null,
    eventId: optionalString(output.eventId) ?? null,
    recoveryObjectId: optionalString(output.recoveryObjectId) ?? null,
    customerSignalId: optionalString(output.customerSignalId) ?? null,
    signalObjectId: optionalString(output.signalObjectId) ?? null,
    customerObjectId: optionalString(output.customerObjectId) ?? null,
    approvalRequestId: optionalString(output.approvalRequestId) ?? null,
    evidenceId: optionalString(output.evidenceId) ?? null,
    packetId: optionalString(output.packetId) ?? null,
    documentId: optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(output.workflowRunId) ?? null,
    workflowStepIds: stringList(output.workflowStepIds),
    signalsViewId: optionalString(output.signalsViewId) ?? null,
    externalExecution: "blocked",
    externalSend: false,
    output,
    snapshot,
  };
}

async function getCustomerExperienceWorkerSnapshot(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}): Promise<CustomerExperienceWorkerSnapshot> {
  const db = input.db ?? defaultDb;
  const worker = await loadCustomerExperienceWorker(db, {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    role: input.role,
  });

  if (!worker) {
    return emptyCustomerExperienceWorkerSnapshot();
  }

  const [
    budgetAccount,
    heldUnits,
    usageCount,
    pendingApprovalCount,
    viewCount,
    signalRows,
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
      .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
      .from(budgetReservations)
      .where(and(eq(budgetReservations.tenantId, worker.tenantId), eq(budgetReservations.state, "held"))),
    db
      .select({ value: count(usageEvents.id), units: sql<number>`coalesce(sum(${usageEvents.units}), 0)` })
      .from(usageEvents)
      .where(and(eq(usageEvents.tenantId, worker.tenantId), eq(usageEvents.actorId, worker.id))),
    db
      .select({ value: count(approvalRequests.id) })
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
      .select({ value: count(generatedViews.id) })
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'customer.%'`)),
    db
      .select({
        id: customerSignals.id,
        objectId: customerSignals.objectId,
        customerObjectId: customers.objectId,
        customerData: customers.data,
        type: customerSignals.type,
        state: customerSignals.state,
        source: customerSignals.source,
        externalId: customerSignals.externalId,
        data: customerSignals.data,
        occurredAt: customerSignals.occurredAt,
      })
      .from(customerSignals)
      .leftJoin(customers, eq(customerSignals.customerId, customers.id))
      .where(eq(customerSignals.tenantId, worker.tenantId))
      .orderBy(desc(customerSignals.createdAt))
      .limit(25),
    db
      .select({
        id: objects.id,
        name: objects.name,
        state: objects.state,
        data: objects.data,
      })
      .from(objects)
      .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.type, "recovery_draft")))
      .orderBy(desc(objects.createdAt))
      .limit(25),
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
      .limit(25),
    db
      .select({
        id: workerRuns.id,
        eventId: workerRuns.eventId,
        idempotencyKey: workerRuns.idempotencyKey,
        state: workerRuns.state,
        mode: workerRuns.mode,
        data: workerRuns.data,
      })
      .from(workerRuns)
      .where(and(eq(workerRuns.tenantId, worker.tenantId), eq(workerRuns.workerId, worker.id)))
      .orderBy(desc(workerRuns.createdAt))
      .limit(1),
  ]);
  const [account] = budgetAccount;
  const [held] = heldUnits;
  const [usage] = usageCount;
  const [approvalCount] = pendingApprovalCount;
  const [viewRow] = viewCount;
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
      usedUnits: Number(usage?.units ?? 0),
      heldUnits: Number(held?.units ?? 0),
      events: Number(usage?.value ?? 0),
    },
    controls: {
      pendingApprovals: Number(approvalCount?.value ?? 0),
      generatedViews: Number(viewRow?.value ?? 0),
      externalExecution: "blocked",
      customerSend: "blocked",
      sensitiveData: "redacted",
    },
    signals: signalRows.map((signal) => ({
      id: signal.id,
      objectId: signal.objectId,
      customerObjectId: signal.customerObjectId,
      customerName:
        optionalString(signal.customerData?.name) ??
        optionalString(signal.customerData?.displayName) ??
        null,
      type: signal.type,
      state: signal.state,
      source: signal.source,
      externalId: signal.externalId,
      severity: severityFrom(signal.data),
      sentiment: sentimentFrom(signal.data),
      occurredAt: signal.occurredAt?.toISOString() ?? null,
      data: signal.data,
    })),
    recoveryDrafts: draftRows.map((draft) => ({
      id: draft.id,
      name: draft.name,
      state: draft.state,
      data: draft.data,
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
          output: outputData(run.data),
        }
      : null,
  };
}

function emptyCustomerExperienceWorkerSnapshot(): CustomerExperienceWorkerSnapshot {
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
      customerSend: "blocked",
      sensitiveData: "redacted",
    },
    signals: [],
    recoveryDrafts: [],
    approvals: [],
    latestRun: null,
  };
}

export async function getCustomerExperienceWorkerSnapshotSafe(
  input: CustomerExperienceWorkerSelector,
): Promise<{ ok: true; snapshot: CustomerExperienceWorkerSnapshot; error: null } | { ok: false; snapshot: CustomerExperienceWorkerSnapshot; error: string }> {
  try {
    return {
      ok: true,
      snapshot: await getCustomerExperienceWorkerSnapshot(input),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      snapshot: emptyCustomerExperienceWorkerSnapshot(),
      error: error instanceof Error ? error.message : "Failed to load Customer Experience Worker snapshot.",
    };
  }
}

export async function listCustomerExperienceSignals(input: {
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<CustomerExperienceSignalsView> {
  const db = input.db ?? defaultDb;
  await loadCustomerExperienceContext({
    db,
    selector: { role: customerExperienceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const config = input.config ?? {};
  const state = optionalString(config.state);
  const severity = optionalString(config.severity);
  const snapshot = await getCustomerExperienceWorkerSnapshot({
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    db,
  });
  const signals = snapshot.signals.filter(
    (signal) => (!state || signal.state === state) && (!severity || signal.severity === severity),
  );

  return {
    worker: snapshot.worker,
    controls: snapshot.controls,
    filters: {
      state: state ?? null,
      severity: severity ?? null,
    },
    signals,
    recoveryDrafts: snapshot.recoveryDrafts,
    approvals: snapshot.approvals,
  };
}
