import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  adapters,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  documents,
  evidence,
  evidencePackets,
  events,
  generatedViews,
  inferences,
  jobs,
  objects,
  objectLinks,
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
import { PlatformUnavailableError } from "../core/errors";

type Database = typeof defaultDb;

export const dispatchWorkerRole = "dispatch_operations";

const dispatchSource = "continuous.dispatch_worker";
const scheduleCapabilityKey = "schedule.propose";
const workflowKey = "promise_to_delivery";
const scheduleProposalUnits = 6000;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type DispatchWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type DispatchContext = {
  worker: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    tenantTimezone: string;
    name: string;
    kpis: JsonObject;
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
  connectionId: string;
};

export type DispatchScheduleProposalResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  appointmentObjectId: string | null;
  approvalRequestId: string | null;
  adapterRunId: string | null;
  adapterActionId: string | null;
  adapterReceiptEvidenceId: string | null;
  evidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  dispatchScheduleViewId: string | null;
  output: JsonObject;
  snapshot: DispatchWorkerSnapshot;
};

export type DispatchWorkerSnapshot = {
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
    grantedCapabilities: number;
    approvalTasks: number;
    generatedViews: number;
    externalExecution: "dry_run";
  };
  scheduleBoard: Array<{
    id: string;
    name: string;
    state: string;
    data: JsonObject;
  }>;
  exceptions: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    evidence: JsonObject;
  }>;
  latestRun: {
    id: string;
    eventId: string | null;
    idempotencyKey: string;
    state: string;
    mode: string;
    output: JsonObject;
  } | null;
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function optionalString(value: unknown) {
  const valueString = stringValue(value);
  return valueString || undefined;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
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

function traceHash(...parts: string[]) {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function outputData(data: JsonObject) {
  return objectValue(data.output);
}

function getWorkflowStepIds(data: JsonObject) {
  return stringList(data.workflowStepIds);
}

function emptySnapshot(): DispatchWorkerSnapshot {
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
      grantedCapabilities: 0,
      approvalTasks: 0,
      generatedViews: 0,
      externalExecution: "dry_run",
    },
    scheduleBoard: [],
    exceptions: [],
    latestRun: null,
  };
}

function workerWhere(selector: DispatchWorkerSelector) {
  const conditions = [
    eq(workers.role, selector.role ?? dispatchWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: DispatchWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Dispatch Operations Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadDispatchContext(input: {
  db: Database;
  selector: DispatchWorkerSelector;
  operatorEmail: string;
}): Promise<DispatchContext> {
  const workerRows = await input.db
    .select({
      id: workers.id,
      tenantId: workers.tenantId,
      name: workers.name,
      kpis: workers.kpis,
      managerUserId: workers.managerUserId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      tenantTimezone: tenants.timezone,
    })
    .from(workers)
    .innerJoin(tenants, eq(workers.tenantId, tenants.id))
    .where(workerWhere(input.selector))
    .orderBy(workers.createdAt)
    .limit(input.selector.workerId ? 1 : 2);

  const worker = assertSingleWorker(workerRows, input.selector);

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Dispatch Operations Worker matches this selector.",
      404,
    );
  }

  const [operator] = await input.db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .where(
      and(
        eq(users.tenantId, worker.tenantId),
        eq(users.email, input.operatorEmail),
        eq(users.state, "active"),
      ),
    )
    .limit(1);

  if (!operator) {
    throw new PlatformUnavailableError(
      "worker_operator_missing",
      "Dispatch Operations Worker requires an active operator user for the configured email.",
      409,
    );
  }

  const [capability] = await input.db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, scheduleCapabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      "Dispatch Operations Worker requires the schedule.propose capability.",
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
      "worker_capability_missing",
      "Dispatch Operations Worker is not actively granted schedule.propose.",
      409,
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
      "Dispatch Operations Worker has no active budget account.",
      409,
    );
  }

  const [connection] = await input.db
    .select({ id: connections.id })
    .from(connections)
    .innerJoin(adapters, eq(connections.adapterId, adapters.id))
    .where(
      and(
        eq(connections.tenantId, worker.tenantId),
        eq(connections.state, "active"),
        eq(adapters.kind, "calendar"),
      ),
    )
    .orderBy(connections.createdAt)
    .limit(1);

  if (!connection) {
    throw new PlatformUnavailableError(
      "worker_connection_missing",
      "Dispatch Operations Worker has no active dry-run calendar connection.",
      409,
    );
  }

  return {
    worker: {
      id: worker.id,
      tenantId: worker.tenantId,
      tenantSlug: worker.tenantSlug,
      tenantName: worker.tenantName,
      tenantTimezone: worker.tenantTimezone,
      name: worker.name,
      kpis: worker.kpis,
    },
    operator: {
      id: operator.id,
      email: operator.email,
      name: operator.name,
      actorRef: `user:${operator.id}`,
    },
    reviewerUserId: worker.managerUserId,
    capabilityId: capability.id,
    budgetAccountId: budgetAccount.id,
    connectionId: connection.id,
  };
}

async function getObjectById(db: Database, tenantId: string, id: string) {
  if (!uuidPattern.test(id)) {
    return null;
  }

  const [object] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, id)))
    .limit(1);

  return object ?? null;
}

async function resolveJobObject(db: Database, tenantId: string, jobRef: string) {
  const directObject = await getObjectById(db, tenantId, jobRef);

  if (directObject?.type === "job") {
    return directObject;
  }

  if (uuidPattern.test(jobRef)) {
    const [job] = await db
      .select({ objectId: jobs.objectId })
      .from(jobs)
      .where(and(eq(jobs.tenantId, tenantId), eq(jobs.id, jobRef)))
      .limit(1);

    if (job) {
      return getObjectById(db, tenantId, job.objectId);
    }
  }

  return null;
}

async function loadJobState(db: Database, tenantId: string, jobObjectId: string) {
  const [job] = await db
    .select({ id: jobs.id, state: jobs.state, data: jobs.data })
    .from(jobs)
    .where(and(eq(jobs.tenantId, tenantId), eq(jobs.objectId, jobObjectId)))
    .limit(1);

  return job ?? null;
}

async function loadSourceRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const jobRef =
    optionalString(config.jobId) ??
    optionalString(sourceRefs.jobObjectId) ??
    optionalString(sourceRefs.jobId);

  if (!jobRef) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.jobId or config.sourceRefs.jobObjectId is required for schedule.propose.",
      400,
    );
  }

  const jobObject = await resolveJobObject(db, tenantId, jobRef);

  if (!jobObject) {
    throw new PlatformUnavailableError(
      "dispatch_job_not_found",
      "Dispatch schedule proposal requires a tenant-scoped job object.",
      404,
    );
  }

  const jobRow = await loadJobState(db, tenantId, jobObject.id);
  const state = jobRow?.state ?? jobObject.state;
  const blockedStates = new Set(["scheduled", "in_progress", "closed", "canceled"]);

  if (blockedStates.has(state)) {
    throw new PlatformUnavailableError(
      "dispatch_job_not_schedulable",
      `Dispatch schedule proposal requires an unscheduled job. Current state is ${state}.`,
      409,
    );
  }

  const quoteObjectId = optionalString(sourceRefs.quoteObjectId) ?? optionalString(sourceRefs.quoteId);
  const quoteObject = quoteObjectId ? await getObjectById(db, tenantId, quoteObjectId) : null;

  if (quoteObjectId && quoteObject?.type !== "quote") {
    throw new PlatformUnavailableError(
      "dispatch_quote_not_found",
      "Dispatch schedule proposal requires a tenant-scoped quote object when config.sourceRefs.quoteObjectId is provided.",
      404,
    );
  }

  if (quoteObject) {
    const quoteData = objectValue(quoteObject.data);
    const totalCents = numberValue(quoteData.totalCents, numberValue(quoteData.total_cents));
    const currency = stringValue(quoteData.currency);

    if (totalCents <= 0 || !currency || quoteData.policy === undefined) {
      throw new PlatformUnavailableError(
        "dispatch_quote_handoff_incomplete",
        "Dispatch schedule proposal requires quote total, currency, and policy before accepting a revenue handoff.",
        409,
      );
    }
  }

  const approvalRequestId = optionalString(sourceRefs.approvalRequestId);
  const approval = approvalRequestId
    ? (
        await db
          .select()
          .from(approvalRequests)
          .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, approvalRequestId)))
          .limit(1)
      )[0] ?? null
    : null;

  if (approvalRequestId && !approval) {
    throw new PlatformUnavailableError(
      "dispatch_approval_not_found",
      "Dispatch schedule proposal requires a tenant-scoped approval request when config.sourceRefs.approvalRequestId is provided.",
      404,
    );
  }

  if (approval && approval.state !== "approved") {
    throw new PlatformUnavailableError(
      "dispatch_quote_approval_required",
      "Dispatch schedule proposal requires an approved quote handoff before schedule proposal.",
      409,
    );
  }

  const adapterReceiptEvidenceId = optionalString(sourceRefs.adapterReceiptEvidenceId);
  const adapterReceipt = adapterReceiptEvidenceId
    ? (
        await db
          .select()
          .from(evidence)
          .where(and(eq(evidence.tenantId, tenantId), eq(evidence.id, adapterReceiptEvidenceId)))
          .limit(1)
      )[0] ?? null
    : null;

  if (adapterReceiptEvidenceId && !adapterReceipt) {
    throw new PlatformUnavailableError(
      "dispatch_receipt_not_found",
      "Dispatch schedule proposal requires tenant-scoped receipt evidence when config.sourceRefs.adapterReceiptEvidenceId is provided.",
      404,
    );
  }

  const adapterReceiptData = objectValue(adapterReceipt?.data);

  if (
    adapterReceipt &&
    (adapterReceipt.kind !== "receipt" ||
      adapterReceiptData.externalMutation === true ||
      adapterReceiptData.externalSend === true)
  ) {
    throw new PlatformUnavailableError(
      "dispatch_handoff_receipt_invalid",
      "Dispatch schedule proposal requires receipt evidence proving no external mutation or send.",
      409,
    );
  }

  return {
    sourceRefs,
    jobObject,
    jobRow,
    quoteObject,
    approval,
    adapterReceipt,
  };
}

function proposedWindow(constraints: JsonObject, timezone: string) {
  const serviceWindow = stringValue(constraints.serviceWindow, new Date().toISOString().slice(0, 10));
  const durationMinutes = Math.max(15, Math.min(8 * 60, Math.trunc(numberValue(constraints.durationMinutes, 120))));
  const start =
    /^\d{4}-\d{2}-\d{2}$/.test(serviceWindow)
      ? new Date(`${serviceWindow}T14:00:00.000Z`)
      : new Date(serviceWindow);
  const startAt = Number.isNaN(start.getTime()) ? new Date() : start;
  const endAt = new Date(startAt.getTime() + durationMinutes * 60 * 1000);

  return {
    startAt: startAt.toISOString(),
    endAt: endAt.toISOString(),
    durationMinutes,
    timezone,
  };
}

async function replayedScheduleProposal(
  db: Database,
  context: DispatchContext,
  run: typeof workerRuns.$inferSelect,
): Promise<DispatchScheduleProposalResult> {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    taskId: run.taskId,
    eventId: run.eventId ?? optionalString(data.eventId) ?? null,
    appointmentObjectId: optionalString(output.appointmentObjectId) ?? null,
    approvalRequestId: optionalString(data.approvalRequestId) ?? optionalString(output.approvalRequestId) ?? null,
    adapterRunId: optionalString(data.adapterRunId) ?? optionalString(output.adapterRunId) ?? null,
    adapterActionId: optionalString(data.adapterActionId) ?? optionalString(output.adapterActionId) ?? null,
    adapterReceiptEvidenceId:
      optionalString(data.adapterReceiptEvidenceId) ?? optionalString(output.adapterReceiptEvidenceId) ?? null,
    evidenceId: optionalString(data.evidenceId) ?? optionalString(output.evidenceId) ?? null,
    packetId: optionalString(data.packetId) ?? optionalString(output.packetId) ?? null,
    documentId: optionalString(data.documentId) ?? optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(data.workflowRunId) ?? optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(data),
    dispatchScheduleViewId:
      optionalString(data.dispatchScheduleViewId) ?? optionalString(output.dispatchScheduleViewId) ?? null,
    output,
    snapshot: await getDispatchWorkerSnapshot(db, {
      role: dispatchWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function proposeDispatchSchedule(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<DispatchScheduleProposalResult> {
  const db = input.db ?? defaultDb;
  const context = await loadDispatchContext({
    db,
    selector: { role: dispatchWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const config = input.config ?? {};
  const constraints = objectValue(config.constraints);
  const handoff = await loadSourceRefs(db, context.worker.tenantId, config);
  const scheduleWindow = proposedWindow(constraints, context.worker.tenantTimezone);
  const inputHash = hashObject({
    schemaVersion: "dispatch.schedule.propose.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    jobObjectId: handoff.jobObject.id,
    quoteObjectId: handoff.quoteObject?.id ?? null,
    approvalRequestId: handoff.approval?.id ?? null,
    adapterReceiptEvidenceId: handoff.adapterReceipt?.id ?? null,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${dispatchSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, dispatchSource),
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
          "A Dispatch schedule proposal already exists for this idempotency key with different input.",
          409,
        );
      }

      return { replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, workflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Dispatch Operations Worker requires the promise_to_delivery workflow definition.",
        409,
      );
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: handoff.jobObject.id,
        capabilityId: context.capabilityId,
        title: `Review schedule proposal for ${handoff.jobObject.name}`,
        state: "approval_required",
        priority: "high",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          required: ["job_snapshot", "availability_trace", "calendar_dry_run_receipt", "dispatch_packet"],
        },
        outcome: { status: "schedule_approval_needed" },
        cost: { units: scheduleProposalUnits },
        kpi: { schedules_proposed: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const runInput = {
      command: "schedule.propose",
      inputHash,
      config,
      constraints,
      sourceRefs: handoff.sourceRefs,
      jobObjectId: handoff.jobObject.id,
      quoteObjectId: handoff.quoteObject?.id ?? null,
      approvalRequestId: handoff.approval?.id ?? null,
      adapterReceiptEvidenceId: handoff.adapterReceipt?.id ?? null,
    } satisfies JsonObject;

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        connectionId: context.connectionId,
        budgetAccountId: context.budgetAccountId,
        source: dispatchSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "dry_run",
        data: {
          input: runInput,
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const appointmentData = {
      jobObjectId: handoff.jobObject.id,
      jobRowId: handoff.jobRow?.id ?? null,
      quoteObjectId: handoff.quoteObject?.id ?? null,
      approvalRequestId: handoff.approval?.id ?? null,
      requestedByOperatorId: context.operator.id,
      constraints,
      proposedWindow: scheduleWindow,
      crewSkills: stringList(constraints.crewSkills),
      conflicts: [],
      sourceRefs: handoff.sourceRefs,
      externalExecution: "dry_run",
      externalMutation: false,
      externalSend: false,
    } satisfies JsonObject;

    const [appointment] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "appointment",
        name: `Proposed appointment for ${handoff.jobObject.name}`,
        state: "approval_required",
        source: dispatchSource,
        externalId: `dispatch-schedule:${input.idempotencyKey}`,
        data: appointmentData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        effectiveAt: new Date(scheduleWindow.startAt),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: appointment.id,
      version: 1,
      data: appointmentData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "dispatch schedule proposal",
      createdAt: now,
    });

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: appointment.id,
          toId: handoff.jobObject.id,
          type: "schedules_job",
          data: { source: dispatchSource },
          effectiveAt: now,
        },
        ...(handoff.quoteObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: appointment.id,
                toId: handoff.quoteObject.id,
                type: "prepared_from_quote",
                data: { source: dispatchSource },
                effectiveAt: now,
              },
            ]
          : []),
      ])
      .onConflictDoNothing();

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: handoff.jobObject.id,
        workerId: context.worker.id,
        state: "approval_pending",
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          appointmentObjectId: appointment.id,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          sourceRefs: handoff.sourceRefs,
          inputHash,
          externalExecution: "dry_run",
        },
        blockers: { open: ["schedule_approval_required", "external_calendar_write_blocked"] },
        metrics: { budgetUnits: scheduleProposalUnits, conflicts: 0 },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [adapterRun] = await tx
      .insert(adapterRuns)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        workerRunId: workerRun.id,
        mode: "dry_run",
        operation: "calendar_schedule_proposal",
        idempotencyKey: `${input.idempotencyKey}:adapter_run`,
        state: "done",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "matched",
        cursor: input.idempotencyKey,
        readCount: 1,
        writeCount: 0,
        receipt: {
          mode: "dry_run",
          externalMutation: false,
          externalSend: false,
          reconciliationState: "matched",
        },
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          appointmentObjectId: appointment.id,
          proposedWindow: scheduleWindow,
          externalMutation: false,
        },
        startedAt: now,
        endedAt: now,
      })
      .returning({ id: adapterRuns.id });

    const [adapterAction] = await tx
      .insert(adapterActions)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        adapterRunId: adapterRun.id,
        capabilityId: context.capabilityId,
        taskId: task.id,
        idempotencyKey: input.idempotencyKey,
        state: "done",
        mode: "dry_run",
        operation: "calendar_schedule_proposal",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "matched",
        request: {
          action: "propose_calendar_hold",
          appointmentObjectId: appointment.id,
          jobObjectId: handoff.jobObject.id,
          proposedWindow: scheduleWindow,
          externalMutation: false,
        },
        response: {
          status: "prepared",
          nextStep: "manager_approval",
          reconciliation: "matched",
        },
        receipt: {
          mode: "dry_run",
          adapterRunId: adapterRun.id,
          workerRunId: workerRun.id,
          externalMutation: false,
          externalSend: false,
          rollbackRequired: false,
          reconciliationState: "matched",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: adapterActions.id });

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task.id,
        units: scheduleProposalUnits,
        state: "used",
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: budgetReservations.id });

    const [inference] = await tx
      .insert(inferences)
      .values({
        tenantId: context.worker.tenantId,
        budgetAccountId: context.budgetAccountId,
        taskId: task.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        promptHash: traceHash(input.idempotencyKey, "dispatch-schedule"),
        request: {
          mode: "deterministic",
          objective: "Propose a schedulable appointment window from approved revenue handoff evidence.",
          jobObjectId: handoff.jobObject.id,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          constraints,
          inputHash,
        },
        result: {
          appointmentObjectId: appointment.id,
          proposedWindow: scheduleWindow,
          conflicts: [],
          requiresApproval: true,
          externalMutation: false,
        },
        safety: {
          externalExecution: "dry_run",
          externalMutation: false,
          customerSend: "blocked",
        },
        promptTokens: 420,
        completionTokens: 160,
        units: scheduleProposalUnits,
        costUsd: "0.000000",
        latencyMs: 120,
        createdAt: now,
      })
      .returning({ id: inferences.id });

    const [usage] = await tx
      .insert(usageEvents)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        reservationId: reservation.id,
        inferenceId: inference.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        units: scheduleProposalUnits,
        costUsd: "0.000000",
        data: {
          mode: "deterministic",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          appointmentObjectId: appointment.id,
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "dispatch_worker.schedule_propose.completed",
        source: dispatchSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: appointment.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        connectionId: context.connectionId,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          jobObjectId: handoff.jobObject.id,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          appointmentObjectId: appointment.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          proposedWindow: scheduleWindow,
          externalExecution: "dry_run",
          externalMutation: false,
          externalSend: false,
          inputHash,
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    await tx
      .update(workerRuns)
      .set({ eventId: event.id, updatedAt: now })
      .where(eq(workerRuns.id, workerRun.id));

    await tx
      .update(adapterActions)
      .set({ eventId: event.id, updatedAt: now })
      .where(eq(adapterActions.id, adapterAction.id));

    await tx
      .update(adapterRuns)
      .set({ eventId: event.id })
      .where(eq(adapterRuns.id, adapterRun.id));

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Dispatch schedule proposal trace",
        objectId: appointment.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          inputHash,
          jobObjectId: handoff.jobObject.id,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          approvalRequestId: handoff.approval?.id ?? null,
          adapterReceiptEvidenceId: handoff.adapterReceipt?.id ?? null,
          proposedWindow: scheduleWindow,
          conflicts: [],
          externalExecution: "dry_run",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [receiptEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "receipt",
        name: "Calendar dry-run receipt",
        objectId: appointment.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "adapter",
        actorId: context.connectionId,
        hash: traceHash(input.idempotencyKey, adapterRun.id, adapterAction.id),
        data: {
          mode: "dry_run",
          operation: "calendar_schedule_proposal",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          appointmentObjectId: appointment.id,
          externalMutation: false,
          externalSend: false,
          rollbackRequired: false,
          reconciliationState: "matched",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: appointment.id,
        workflowRunId: workflowRun.id,
        kind: "dispatch_schedule_packet",
        name: `Dispatch schedule packet for ${handoff.jobObject.name}`,
        state: "review_ready",
        sensitivity: "medium",
        hash: traceHash(input.idempotencyKey, "document"),
        data: {
          jobObjectId: handoff.jobObject.id,
          appointmentObjectId: appointment.id,
          proposedWindow: scheduleWindow,
          sourceRefs: handoff.sourceRefs,
          externalExecution: "dry_run",
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
        objectId: appointment.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "dispatch_packet",
        name: "Dispatch schedule evidence packet",
        state: "review_ready",
        sensitivity: "medium",
        evidenceIds: {
          ids: [
            traceEvidence.id,
            receiptEvidence.id,
            ...(handoff.adapterReceipt ? [handoff.adapterReceipt.id] : []),
          ],
        },
        documentIds: { ids: [document.id] },
        data: {
          jobObjectId: handoff.jobObject.id,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          appointmentObjectId: appointment.id,
          proposedWindow: scheduleWindow,
          workflowRunId: workflowRun.id,
          externalExecution: "dry_run",
          externalMutation: false,
        },
        hash: traceHash(input.idempotencyKey, "dispatch_packet"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });

    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        objectId: appointment.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "dispatch_schedule_approval",
        state: "pending",
        priority: "high",
        risk: "medium",
        title: `Approve schedule for ${handoff.jobObject.name}`,
        summary:
          "Dispatch Operations Worker prepared a dry-run schedule proposal; external calendar writes and customer sends remain blocked.",
        requestedAction: {
          action: "approve_schedule_proposal",
          appointmentObjectId: appointment.id,
          jobObjectId: handoff.jobObject.id,
          proposedWindow: scheduleWindow,
          adapterActionId: adapterAction.id,
          externalMutation: false,
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          sourceAdapterReceiptEvidenceId: handoff.adapterReceipt?.id ?? null,
        },
        policy: {
          externalCalendarWrite: "approval_required",
          customerSend: "blocked",
        },
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          appointmentObjectId: appointment.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });

    const stepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: handoff.jobObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "handoff",
          name: "Approved revenue handoff accepted",
          state: "done",
          toState: "ready_to_schedule",
          idempotencyKey: `${input.idempotencyKey}:handoff`,
          input: { sourceRefs: handoff.sourceRefs },
          output: { jobObjectId: handoff.jobObject.id, quoteObjectId: handoff.quoteObject?.id ?? null },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: appointment.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "Schedule proposal prepared",
          state: "done",
          fromState: "ready_to_schedule",
          toState: "schedule_proposed",
          idempotencyKey: `${input.idempotencyKey}:schedule_proposed`,
          input: { constraints },
          output: { appointmentObjectId: appointment.id, proposedWindow: scheduleWindow },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: appointment.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "adapter_dry_run",
          name: "Calendar dry-run recorded",
          state: "done",
          fromState: "schedule_proposed",
          toState: "schedule_proposed",
          idempotencyKey: `${input.idempotencyKey}:calendar_dry_run`,
          input: { adapterRunId: adapterRun.id, adapterActionId: adapterAction.id },
          output: { adapterReceiptEvidenceId: receiptEvidence.id, externalMutation: false },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          objectId: appointment.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Schedule approval requested",
          state: "done",
          fromState: "schedule_proposed",
          toState: "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:approval_requested`,
          input: { approvalRequestId: approval.id },
          output: { packetId: packet.id, documentId: document.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });

    const workflowStepIds = stepRows.map((step) => step.id);
    const viewKey = "dispatch.schedule.review";
    const viewVersion = "1.0.0";
    const viewValues = {
      capabilityId: context.capabilityId,
      key: viewKey,
      version: viewVersion,
      name: "Dispatch schedule review",
      purpose: "Let an operator review and approve a dry-run schedule proposal with linked handoff evidence.",
      surface: "web",
      objectType: "appointment",
      taskState: "approval_required" as const,
      contract: {
        sections: ["JobSummary", "QuoteHandoff", "ScheduleWindow", "CalendarDryRun", "EvidenceTimeline", "ActionBar"],
        externalExecution: "dry_run",
      } as JsonObject,
      actions: {
        decisionSurface: "/approval",
        decisionCommand: "approval.decide",
        postDecisionSurface: "/worker",
        postDecisionCommand: "continue",
        valid: ["approved", "revision_requested", "rejected"],
        externalExecution: "dry_run",
      } as JsonObject,
      data: {
        latest: {
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          taskId: task.id,
          jobObjectId: handoff.jobObject.id,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          appointmentObjectId: appointment.id,
          proposedWindow: scheduleWindow,
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          externalExecution: "dry_run",
          externalMutation: false,
          externalSend: false,
        },
      } as JsonObject,
      mask: {
        customer_contact: "redacted_by_default",
        externalExecution: "dry_run",
      } as JsonObject,
      active: true,
      updatedAt: now,
    };
    const [existingView] = await tx
      .select({ id: generatedViews.id })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, context.worker.tenantId),
          eq(generatedViews.key, viewKey),
          eq(generatedViews.version, viewVersion),
        ),
      )
      .limit(1);
    const [view] = existingView
      ? await tx
          .update(generatedViews)
          .set(viewValues)
          .where(eq(generatedViews.id, existingView.id))
          .returning({ id: generatedViews.id })
      : await tx
          .insert(generatedViews)
          .values({
            tenantId: context.worker.tenantId,
            ...viewValues,
            createdAt: now,
          })
          .returning({ id: generatedViews.id });

    await tx.insert(events).values({
      tenantId: context.worker.tenantId,
      type: existingView ? "view.updated" : "view.published",
      source: dispatchSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      objectId: appointment.id,
      taskId: task.id,
      capabilityId: context.capabilityId,
      idempotencyKey: `${input.idempotencyKey}:dispatch_schedule_view`,
      data: {
        key: viewKey,
        version: viewVersion,
        viewId: view.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
      },
      occurredAt: now,
      createdAt: now,
    });

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "dispatch_worker.schedule_propose.completed",
      source: dispatchSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: workerRun.id,
      taskId: task.id,
      workerRunId: workerRun.id,
      approvalRequestId: approval.id,
      eventId: event.id,
      objectId: appointment.id,
      capabilityId: context.capabilityId,
      risk: "medium",
      idempotencyKey: `${input.idempotencyKey}:audit`,
      data: {
        operatorEmail: context.operator.email,
        inputHash,
        externalExecution: "dry_run",
        externalMutation: false,
      },
      createdAt: now,
    });

    const output = {
      jobObjectId: handoff.jobObject.id,
      quoteObjectId: handoff.quoteObject?.id ?? null,
      appointmentObjectId: appointment.id,
      approvalRequestId: approval.id,
      adapterRunId: adapterRun.id,
      adapterActionId: adapterAction.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      dispatchScheduleViewId: view.id,
      proposedWindow: scheduleWindow,
      conflicts: [],
      sourceRefs: handoff.sourceRefs,
      externalExecution: "dry_run",
      externalMutation: false,
      externalSend: false,
      requiresApproval: true,
    } satisfies JsonObject;

    await tx
      .update(workerRuns)
      .set({
        state: "done",
        eventId: event.id,
        data: {
          input: runInput,
          output,
          eventId: event.id,
          taskId: task.id,
          appointmentObjectId: appointment.id,
          approvalRequestId: approval.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          evidenceId: traceEvidence.id,
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          dispatchScheduleViewId: view.id,
          reservationId: reservation.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, workerRun.id));

    await tx
      .update(workers)
      .set({
        kpis: {
          ...context.worker.kpis,
          schedules_proposed: numberValue(context.worker.kpis.schedules_proposed) + 1,
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      replay: null,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      appointmentObjectId: appointment.id,
      approvalRequestId: approval.id,
      adapterRunId: adapterRun.id,
      adapterActionId: adapterAction.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      dispatchScheduleViewId: view.id,
      output,
    };
  });

  if (result.replay) {
    return replayedScheduleProposal(db, context, result.replay);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    appointmentObjectId: result.appointmentObjectId,
    approvalRequestId: result.approvalRequestId,
    adapterRunId: result.adapterRunId,
    adapterActionId: result.adapterActionId,
    adapterReceiptEvidenceId: result.adapterReceiptEvidenceId,
    evidenceId: result.evidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    dispatchScheduleViewId: result.dispatchScheduleViewId,
    output: result.output,
    snapshot: await getDispatchWorkerSnapshot(db, {
      role: dispatchWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function getDispatchWorkerSnapshot(
  db: Database = defaultDb,
  selector: DispatchWorkerSelector = {},
): Promise<DispatchWorkerSnapshot> {
  const workerRows = await db
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
      managerName: users.name,
      tenantName: tenants.name,
    })
    .from(workers)
    .innerJoin(tenants, eq(workers.tenantId, tenants.id))
    .leftJoin(users, eq(workers.managerUserId, users.id))
    .where(workerWhere(selector))
    .orderBy(workers.createdAt)
    .limit(selector.workerId ? 1 : 2);

  const worker = assertSingleWorker(workerRows, selector);

  if (!worker) {
    return emptySnapshot();
  }

  const [budgetAccount] = await db
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
    .limit(1);

  const [
    usage,
    reservations,
    grants,
    approvals,
    views,
    appointmentRows,
    exceptionRows,
    latestRuns,
  ] = await Promise.all([
    budgetAccount
      ? db
          .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)`, events: count() })
          .from(usageEvents)
          .where(eq(usageEvents.accountId, budgetAccount.id))
      : Promise.resolve([{ units: 0, events: 0 }]),
    budgetAccount
      ? db
          .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
          .from(budgetReservations)
          .where(and(eq(budgetReservations.accountId, budgetAccount.id), eq(budgetReservations.state, "held")))
      : Promise.resolve([{ units: 0 }]),
    db
      .select({ value: count() })
      .from(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.tenantId, worker.tenantId),
          eq(capabilityGrants.actorType, "worker"),
          eq(capabilityGrants.actorId, worker.id),
          eq(capabilityGrants.active, true),
        ),
      ),
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
      .where(and(eq(generatedViews.tenantId, worker.tenantId), eq(generatedViews.active, true))),
    db
      .select({ id: objects.id, name: objects.name, state: objects.state, data: objects.data })
      .from(objects)
      .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.type, "appointment")))
      .orderBy(desc(objects.createdAt))
      .limit(10),
    db
      .select({ id: tasks.id, title: tasks.title, state: tasks.state, priority: tasks.priority, evidence: tasks.evidence })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, worker.tenantId),
          eq(tasks.ownerType, "worker"),
          eq(tasks.ownerId, worker.id),
          sql`${tasks.state} in ('active', 'waiting', 'approval_required', 'blocked')`,
        ),
      )
      .orderBy(desc(tasks.createdAt))
      .limit(10),
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

  const latestRun = latestRuns[0];

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
      accountId: budgetAccount?.id ?? null,
      name: budgetAccount?.name ?? null,
      usedUnits: usage[0]?.units ?? 0,
      heldUnits: reservations[0]?.units ?? 0,
      events: usage[0]?.events ?? 0,
    },
    controls: {
      grantedCapabilities: grants[0]?.value ?? 0,
      approvalTasks: approvals[0]?.value ?? 0,
      generatedViews: views[0]?.value ?? 0,
      externalExecution: "dry_run",
    },
    scheduleBoard: appointmentRows.map((appointment) => ({
      id: appointment.id,
      name: appointment.name,
      state: appointment.state,
      data: appointment.data,
    })),
    exceptions: exceptionRows.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      priority: task.priority,
      evidence: task.evidence,
    })),
    latestRun: latestRun
      ? {
          id: latestRun.id,
          eventId: latestRun.eventId,
          idempotencyKey: latestRun.idempotencyKey,
          state: latestRun.state,
          mode: latestRun.mode,
          output: outputData(latestRun.data),
        }
      : null,
  };
}

export async function getDispatchWorkerSnapshotSafe(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}) {
  try {
    return {
      ok: true as const,
      snapshot: await getDispatchWorkerSnapshot(input.db ?? defaultDb, {
        tenantSlug: input.tenantSlug,
        workerId: input.workerId,
        role: input.role,
      }),
      error: null,
    };
  } catch (error) {
    return {
      ok: false as const,
      snapshot: emptySnapshot(),
      error: error instanceof Error ? error.message : "Unknown Dispatch Operations Worker error",
    };
  }
}
