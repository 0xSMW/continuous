import { createHash } from "node:crypto";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

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
  decisions,
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
const customerUpdateCapabilityKey = "response.draft";
const closeoutCapabilityKey = "document_packet.prepare";
const exceptionRouteCapabilityKey = "exception.route";
const workflowKey = "promise_to_delivery";
const scheduleProposalUnits = 6000;
const customerUpdateDraftUnits = 2500;
const closeoutPrepareUnits = 4500;
const exceptionRouteUnits = 1800;
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
  connectionId: string | null;
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

export type DispatchCustomerUpdateDraftResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  customerUpdateObjectId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  draftEvidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  dispatchCustomerUpdateViewId: string | null;
  output: JsonObject;
  snapshot: DispatchWorkerSnapshot;
};

export type DispatchCloseoutPrepareResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  closeoutObjectId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  qaEvidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  dispatchCloseoutViewId: string | null;
  output: JsonObject;
  snapshot: DispatchWorkerSnapshot;
};

export type DispatchExceptionRouteResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  decisionId: string | null;
  evidenceId: string | null;
  decisionEvidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
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

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
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
  capabilityKey: string;
  capabilityLabel: string;
  connectionKind?: string;
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
    .where(and(eq(capabilities.key, input.capabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      `Dispatch Operations Worker requires the ${input.capabilityLabel} capability.`,
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
      `Dispatch Operations Worker is not actively granted ${input.capabilityLabel}.`,
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

  const [connection] = input.connectionKind
    ? await input.db
        .select({ id: connections.id })
        .from(connections)
        .innerJoin(adapters, eq(connections.adapterId, adapters.id))
        .where(
          and(
            eq(connections.tenantId, worker.tenantId),
            eq(connections.state, "active"),
            eq(adapters.kind, input.connectionKind),
          ),
        )
        .orderBy(connections.createdAt)
        .limit(1)
    : [null];

  if (input.connectionKind && !connection) {
    throw new PlatformUnavailableError(
      "worker_connection_missing",
      `Dispatch Operations Worker has no active ${input.connectionKind} connection.`,
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
    connectionId: connection?.id ?? null,
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

async function loadCustomerUpdateRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const jobRef =
    optionalString(config.jobId) ??
    optionalString(sourceRefs.jobObjectId) ??
    optionalString(sourceRefs.jobId);

  if (!jobRef) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.jobId is required for customer_update.draft.",
      400,
    );
  }

  const updateKind = stringValue(config.updateKind);

  if (!updateKind) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.updateKind is required for customer_update.draft.",
      400,
    );
  }

  const jobObject = await resolveJobObject(db, tenantId, jobRef);

  if (!jobObject) {
    throw new PlatformUnavailableError(
      "dispatch_job_not_found",
      "Dispatch customer update draft requires a tenant-scoped job object.",
      404,
    );
  }

  const jobRow = await loadJobState(db, tenantId, jobObject.id);
  const state = jobRow?.state ?? jobObject.state;

  if (state === "closed" || state === "canceled") {
    throw new PlatformUnavailableError(
      "dispatch_job_not_updateable",
      `Dispatch customer update draft requires an open job. Current state is ${state}.`,
      409,
    );
  }

  const jobData = {
    ...objectValue(jobObject.data),
    ...objectValue(jobRow?.data),
  } satisfies JsonObject;
  const requestedCustomerObjectId = optionalString(sourceRefs.customerObjectId);
  const customerObjectId =
    requestedCustomerObjectId ??
    optionalString(jobData.customerObjectId) ??
    optionalString(jobData.customerId);
  const customerObject = customerObjectId ? await getObjectById(db, tenantId, customerObjectId) : null;

  if (requestedCustomerObjectId && customerObject?.type !== "customer") {
    throw new PlatformUnavailableError(
      "dispatch_customer_not_found",
      "Dispatch customer update draft requires a tenant-scoped customer object when config.sourceRefs.customerObjectId is provided.",
      404,
    );
  }

  const requestedQuoteObjectId = optionalString(sourceRefs.quoteObjectId);
  const quoteObjectId =
    requestedQuoteObjectId ??
    optionalString(jobData.quoteObjectId) ??
    optionalString(jobData.quoteId);
  const quoteObject = quoteObjectId ? await getObjectById(db, tenantId, quoteObjectId) : null;

  if (requestedQuoteObjectId && quoteObject?.type !== "quote") {
    throw new PlatformUnavailableError(
      "dispatch_quote_not_found",
      "Dispatch customer update draft requires a tenant-scoped quote object when config.sourceRefs.quoteObjectId is provided.",
      404,
    );
  }

  const requestedAppointmentObjectId = optionalString(sourceRefs.appointmentObjectId);
  const appointmentObject = requestedAppointmentObjectId
    ? await getObjectById(db, tenantId, requestedAppointmentObjectId)
    : null;

  if (requestedAppointmentObjectId && appointmentObject?.type !== "appointment") {
    throw new PlatformUnavailableError(
      "dispatch_appointment_not_found",
      "Dispatch customer update draft requires a tenant-scoped appointment object when config.sourceRefs.appointmentObjectId is provided.",
      404,
    );
  }

  return {
    sourceRefs,
    updateKind,
    jobObject,
    jobRow,
    jobData,
    customerObject,
    quoteObject,
    appointmentObject,
  };
}

function draftCustomerUpdateMessage(input: {
  jobName: string;
  serviceArea: string;
  updateKind: string;
  context: JsonObject;
}) {
  const customerSummary = stringValue(input.context.customerFacingSummary);
  const serviceArea = input.serviceArea || "your service request";
  const subjectKind = input.updateKind.replace(/[._-]+/g, " ");
  const defaultBody =
    input.updateKind === "schedule_proposed"
      ? `We have prepared a proposed service window for ${serviceArea}. A dispatcher is reviewing the details before anything is sent or placed on an external calendar.`
      : `We have prepared a ${subjectKind} update for ${serviceArea}. A dispatcher is reviewing the details before any customer message is sent.`;

  return {
    subject: `Update on ${input.jobName}`,
    body: customerSummary || defaultBody,
  };
}

async function replayedCustomerUpdateDraft(
  db: Database,
  context: DispatchContext,
  run: typeof workerRuns.$inferSelect,
): Promise<DispatchCustomerUpdateDraftResult> {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    taskId: run.taskId,
    eventId: run.eventId ?? optionalString(data.eventId) ?? null,
    customerUpdateObjectId: optionalString(output.customerUpdateObjectId) ?? null,
    approvalRequestId: optionalString(data.approvalRequestId) ?? optionalString(output.approvalRequestId) ?? null,
    evidenceId: optionalString(data.evidenceId) ?? optionalString(output.evidenceId) ?? null,
    draftEvidenceId: optionalString(data.draftEvidenceId) ?? optionalString(output.draftEvidenceId) ?? null,
    packetId: optionalString(data.packetId) ?? optionalString(output.packetId) ?? null,
    documentId: optionalString(data.documentId) ?? optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(data.workflowRunId) ?? optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(data),
    dispatchCustomerUpdateViewId:
      optionalString(data.dispatchCustomerUpdateViewId) ??
      optionalString(output.dispatchCustomerUpdateViewId) ??
      null,
    output,
    snapshot: await getDispatchWorkerSnapshot(db, {
      role: dispatchWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

async function loadEvidenceRefs(db: Database, tenantId: string, ids: string[], label: string) {
  const uniqueIds = Array.from(new Set(ids.filter((id) => id.length > 0)));

  if (uniqueIds.length === 0) {
    return [];
  }

  const invalid = uniqueIds.find((id) => !uuidPattern.test(id));

  if (invalid) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      `${label} must contain tenant-scoped evidence UUIDs.`,
      400,
    );
  }

  const rows = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), inArray(evidence.id, uniqueIds)));
  const found = new Set(rows.map((row) => row.id));
  const missing = uniqueIds.filter((id) => !found.has(id));

  if (missing.length > 0) {
    throw new PlatformUnavailableError(
      "dispatch_evidence_not_found",
      `${label} contains evidence that does not exist for this tenant.`,
      404,
    );
  }

  return rows;
}

async function loadCloseoutRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const workOrderRef =
    optionalString(config.workOrderId) ??
    optionalString(sourceRefs.workOrderObjectId) ??
    optionalString(sourceRefs.workOrderId);

  if (!workOrderRef) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.workOrderId is required for closeout.prepare.",
      400,
    );
  }

  const workOrderObject = await getObjectById(db, tenantId, workOrderRef);

  if (workOrderObject?.type !== "work_order") {
    throw new PlatformUnavailableError(
      "dispatch_work_order_not_found",
      "Dispatch closeout prepare requires a tenant-scoped work_order object.",
      404,
    );
  }

  if (workOrderObject.state === "closed" || workOrderObject.state === "canceled") {
    throw new PlatformUnavailableError(
      "dispatch_work_order_not_closeable",
      `Dispatch closeout prepare requires an open work order. Current state is ${workOrderObject.state}.`,
      409,
    );
  }

  const workOrderData = objectValue(workOrderObject.data);
  const requestedJobObjectId =
    optionalString(sourceRefs.jobObjectId) ??
    optionalString(sourceRefs.jobId) ??
    optionalString(workOrderData.jobObjectId) ??
    optionalString(workOrderData.jobId);
  const jobObject = requestedJobObjectId ? await getObjectById(db, tenantId, requestedJobObjectId) : null;

  if (jobObject?.type !== "job") {
    throw new PlatformUnavailableError(
      "dispatch_job_not_found",
      "Dispatch closeout prepare requires a tenant-scoped job object through config.sourceRefs.jobObjectId or work order data.",
      404,
    );
  }

  const requestedCustomerObjectId =
    optionalString(sourceRefs.customerObjectId) ??
    optionalString(workOrderData.customerObjectId) ??
    optionalString(workOrderData.customerId);
  const customerObject = requestedCustomerObjectId ? await getObjectById(db, tenantId, requestedCustomerObjectId) : null;

  if (requestedCustomerObjectId && customerObject?.type !== "customer") {
    throw new PlatformUnavailableError(
      "dispatch_customer_not_found",
      "Dispatch closeout prepare requires a tenant-scoped customer object when config.sourceRefs.customerObjectId is provided.",
      404,
    );
  }

  const requestedAppointmentObjectId =
    optionalString(sourceRefs.appointmentObjectId) ?? optionalString(workOrderData.appointmentObjectId);
  const appointmentObject = requestedAppointmentObjectId
    ? await getObjectById(db, tenantId, requestedAppointmentObjectId)
    : null;

  if (requestedAppointmentObjectId && appointmentObject?.type !== "appointment") {
    throw new PlatformUnavailableError(
      "dispatch_appointment_not_found",
      "Dispatch closeout prepare requires a tenant-scoped appointment object when config.sourceRefs.appointmentObjectId is provided.",
      404,
    );
  }

  const requestedCustomerUpdateObjectId =
    optionalString(sourceRefs.customerUpdateObjectId) ?? optionalString(workOrderData.customerUpdateObjectId);
  const customerUpdateObject = requestedCustomerUpdateObjectId
    ? await getObjectById(db, tenantId, requestedCustomerUpdateObjectId)
    : null;

  if (requestedCustomerUpdateObjectId && customerUpdateObject?.type !== "customer_update") {
    throw new PlatformUnavailableError(
      "dispatch_customer_update_not_found",
      "Dispatch closeout prepare requires a tenant-scoped customer_update object when config.sourceRefs.customerUpdateObjectId is provided.",
      404,
    );
  }

  const photoEvidenceIds = Array.from(
    new Set([...stringList(config.photoEvidenceIds), ...stringList(sourceRefs.photoEvidenceIds)]),
  );
  const sourceEvidenceIds = Array.from(
    new Set([
      ...photoEvidenceIds,
      ...stringList(config.evidenceIds),
      ...stringList(sourceRefs.evidenceIds),
      ...stringList(config.completionEvidenceIds),
      ...stringList(sourceRefs.completionEvidenceIds),
    ]),
  );
  const sourceEvidence = await loadEvidenceRefs(db, tenantId, sourceEvidenceIds, "config.sourceRefs.evidenceIds");

  return {
    sourceRefs,
    workOrderObject,
    workOrderData,
    jobObject,
    customerObject,
    appointmentObject,
    customerUpdateObject,
    photoEvidenceIds,
    sourceEvidenceIds: sourceEvidence.map((row) => row.id),
  };
}

function normalizeExceptionSeverity(value: unknown) {
  const severity = stringValue(value, "medium").toLowerCase();

  if (severity === "critical") {
    return { severity: "critical", priority: "urgent" as const, risk: "critical" as const };
  }

  if (severity === "high") {
    return { severity: "high", priority: "high" as const, risk: "high" as const };
  }

  if (severity === "low") {
    return { severity: "low", priority: "low" as const, risk: "low" as const };
  }

  return { severity: "medium", priority: "normal" as const, risk: "medium" as const };
}

async function loadExceptionRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const jobRef =
    optionalString(config.jobId) ??
    optionalString(sourceRefs.jobObjectId) ??
    optionalString(sourceRefs.jobId);

  if (!jobRef) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.jobId is required for exception.route.",
      400,
    );
  }

  const reason = stringValue(config.reason);

  if (!reason) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.reason is required for exception.route.",
      400,
    );
  }

  const severityInput = stringValue(config.severity);

  if (!severityInput) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.severity is required for exception.route.",
      400,
    );
  }

  const jobObject = await resolveJobObject(db, tenantId, jobRef);

  if (!jobObject) {
    throw new PlatformUnavailableError(
      "dispatch_job_not_found",
      "Dispatch exception route requires a tenant-scoped job object.",
      404,
    );
  }

  const jobRow = await loadJobState(db, tenantId, jobObject.id);
  const jobData = {
    ...objectValue(jobObject.data),
    ...objectValue(jobRow?.data),
  } satisfies JsonObject;
  const customerObjectId =
    optionalString(sourceRefs.customerObjectId) ??
    optionalString(jobData.customerObjectId) ??
    optionalString(jobData.customerId);
  const customerObject = customerObjectId ? await getObjectById(db, tenantId, customerObjectId) : null;

  if (customerObjectId && customerObject?.type !== "customer") {
    throw new PlatformUnavailableError(
      "dispatch_customer_not_found",
      "Dispatch exception route requires a tenant-scoped customer object when config.sourceRefs.customerObjectId is provided.",
      404,
    );
  }

  const workOrderObjectId = optionalString(sourceRefs.workOrderObjectId) ?? optionalString(sourceRefs.workOrderId);
  const workOrderObject = workOrderObjectId ? await getObjectById(db, tenantId, workOrderObjectId) : null;

  if (workOrderObjectId && workOrderObject?.type !== "work_order") {
    throw new PlatformUnavailableError(
      "dispatch_work_order_not_found",
      "Dispatch exception route requires a tenant-scoped work_order object when config.sourceRefs.workOrderObjectId is provided.",
      404,
    );
  }

  const appointmentObjectId = optionalString(sourceRefs.appointmentObjectId);
  const appointmentObject = appointmentObjectId ? await getObjectById(db, tenantId, appointmentObjectId) : null;

  if (appointmentObjectId && appointmentObject?.type !== "appointment") {
    throw new PlatformUnavailableError(
      "dispatch_appointment_not_found",
      "Dispatch exception route requires a tenant-scoped appointment object when config.sourceRefs.appointmentObjectId is provided.",
      404,
    );
  }

  const closeoutObjectId = optionalString(sourceRefs.closeoutObjectId);
  const closeoutObject = closeoutObjectId ? await getObjectById(db, tenantId, closeoutObjectId) : null;

  if (closeoutObjectId && closeoutObject?.type !== "closeout") {
    throw new PlatformUnavailableError(
      "dispatch_closeout_not_found",
      "Dispatch exception route requires a tenant-scoped closeout object when config.sourceRefs.closeoutObjectId is provided.",
      404,
    );
  }

  const sourceEvidenceIds = Array.from(
    new Set([
      ...stringList(config.evidenceIds),
      ...stringList(sourceRefs.evidenceIds),
      ...stringList(config.sourceEvidenceIds),
      ...stringList(sourceRefs.sourceEvidenceIds),
    ]),
  );
  const sourceEvidence = await loadEvidenceRefs(db, tenantId, sourceEvidenceIds, "config.sourceRefs.evidenceIds");

  return {
    sourceRefs,
    reason,
    severity: normalizeExceptionSeverity(config.severity),
    routeKind: stringValue(config.kind, stringValue(sourceRefs.kind, "dispatch_exception")),
    notes: stringValue(config.notes, stringValue(config.note)),
    jobObject,
    jobRow,
    customerObject,
    workOrderObject,
    appointmentObject,
    closeoutObject,
    sourceEvidenceIds: sourceEvidence.map((row) => row.id),
  };
}

function normalizeCloseoutQuality(config: JsonObject, photoEvidenceIds: string[]) {
  const qaInput = objectValue(config.qaChecklist ?? config.qualityChecklist);
  const completionNotes = stringValue(
    config.completionNotes,
    stringValue(qaInput.completionNotes, "Work is ready for closeout review."),
  );
  const scopeCompleted = booleanValue(qaInput.scopeCompleted, booleanValue(config.scopeCompleted, true));
  const photosAttached = booleanValue(
    qaInput.photosAttached,
    booleanValue(config.photosAttached, photoEvidenceIds.length > 0),
  );
  const customerSignoff = booleanValue(
    qaInput.customerSignoff,
    booleanValue(config.customerSignoff, false),
  );
  const safetyReviewed = booleanValue(qaInput.safetyReviewed, booleanValue(config.safetyReviewed, true));
  const blockers = Array.from(
    new Set([
      ...stringList(config.blockers),
      ...stringList(qaInput.blockers),
      ...(scopeCompleted ? [] : ["qa_incomplete"]),
      ...(photosAttached ? [] : ["missing_photos"]),
      ...(customerSignoff ? [] : ["customer_signoff_missing"]),
      ...(safetyReviewed ? [] : ["safety_review_incomplete"]),
    ]),
  );
  const invoiceReady = blockers.length === 0 && booleanValue(config.invoiceReady, true);

  return {
    completionNotes,
    blockers,
    invoiceReady,
    qaChecklist: {
      scopeCompleted,
      photosAttached,
      customerSignoff,
      safetyReviewed,
      invoiceReady,
      blockers,
    } satisfies JsonObject,
  };
}

async function replayedCloseoutPrepare(
  db: Database,
  context: DispatchContext,
  run: typeof workerRuns.$inferSelect,
): Promise<DispatchCloseoutPrepareResult> {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    taskId: run.taskId,
    eventId: run.eventId ?? optionalString(data.eventId) ?? null,
    closeoutObjectId: optionalString(output.closeoutObjectId) ?? null,
    approvalRequestId: optionalString(data.approvalRequestId) ?? optionalString(output.approvalRequestId) ?? null,
    evidenceId: optionalString(data.evidenceId) ?? optionalString(output.evidenceId) ?? null,
    qaEvidenceId: optionalString(data.qaEvidenceId) ?? optionalString(output.qaEvidenceId) ?? null,
    packetId: optionalString(data.packetId) ?? optionalString(output.packetId) ?? null,
    documentId: optionalString(data.documentId) ?? optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(data.workflowRunId) ?? optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(data),
    dispatchCloseoutViewId:
      optionalString(data.dispatchCloseoutViewId) ?? optionalString(output.dispatchCloseoutViewId) ?? null,
    output,
    snapshot: await getDispatchWorkerSnapshot(db, {
      role: dispatchWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

async function replayedExceptionRoute(
  db: Database,
  context: DispatchContext,
  run: typeof workerRuns.$inferSelect,
): Promise<DispatchExceptionRouteResult> {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    taskId: run.taskId,
    eventId: run.eventId ?? optionalString(data.eventId) ?? null,
    decisionId: optionalString(data.decisionId) ?? optionalString(output.decisionId) ?? null,
    evidenceId: optionalString(data.evidenceId) ?? optionalString(output.evidenceId) ?? null,
    decisionEvidenceId:
      optionalString(data.decisionEvidenceId) ?? optionalString(output.decisionEvidenceId) ?? null,
    packetId: optionalString(data.packetId) ?? optionalString(output.packetId) ?? null,
    documentId: optionalString(data.documentId) ?? optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(data.workflowRunId) ?? optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(data),
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
    capabilityKey: scheduleCapabilityKey,
    capabilityLabel: "schedule.propose",
    connectionKind: "calendar",
  });
  const config = input.config ?? {};
  const constraints = objectValue(config.constraints);
  const handoff = await loadSourceRefs(db, context.worker.tenantId, config);
  const connectionId = context.connectionId;

  if (!connectionId) {
    throw new PlatformUnavailableError(
      "worker_connection_missing",
      "Dispatch schedule proposal requires an active dry-run calendar connection.",
      409,
    );
  }

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
        connectionId: connectionId,
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
        connectionId: connectionId,
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
        connectionId: connectionId,
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
        connectionId: connectionId,
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
        actorId: connectionId,
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

export async function draftDispatchCustomerUpdate(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<DispatchCustomerUpdateDraftResult> {
  const db = input.db ?? defaultDb;
  const context = await loadDispatchContext({
    db,
    selector: { role: dispatchWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: customerUpdateCapabilityKey,
    capabilityLabel: "response.draft",
  });
  const config = input.config ?? {};
  const handoff = await loadCustomerUpdateRefs(db, context.worker.tenantId, config);
  const messageContext = objectValue(config.messageContext);
  const channel = stringValue(config.channel, "email");
  const serviceArea = stringValue(handoff.jobData.serviceArea, stringValue(handoff.jobData.service_area));
  const draftMessage = draftCustomerUpdateMessage({
    jobName: handoff.jobObject.name,
    serviceArea,
    updateKind: handoff.updateKind,
    context: messageContext,
  });
  const inputHash = hashObject({
    schemaVersion: "dispatch.customer_update.draft.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    jobObjectId: handoff.jobObject.id,
    customerObjectId: handoff.customerObject?.id ?? null,
    quoteObjectId: handoff.quoteObject?.id ?? null,
    appointmentObjectId: handoff.appointmentObject?.id ?? null,
    updateKind: handoff.updateKind,
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
          "A Dispatch customer update draft already exists for this idempotency key with different input.",
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
        title: `Review customer update draft for ${handoff.jobObject.name}`,
        state: "approval_required",
        priority: "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          required: ["job_snapshot", "drafted_customer_update", "dispatch_customer_update_packet"],
        },
        outcome: { status: "customer_update_approval_needed" },
        cost: { units: customerUpdateDraftUnits },
        kpi: { customer_updates_drafted: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const runInput = {
      command: "customer_update.draft",
      inputHash,
      config,
      jobObjectId: handoff.jobObject.id,
      customerObjectId: handoff.customerObject?.id ?? null,
      quoteObjectId: handoff.quoteObject?.id ?? null,
      appointmentObjectId: handoff.appointmentObject?.id ?? null,
      updateKind: handoff.updateKind,
    } satisfies JsonObject;

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source: dispatchSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: runInput,
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const customerUpdateData = {
      jobObjectId: handoff.jobObject.id,
      jobRowId: handoff.jobRow?.id ?? null,
      customerObjectId: handoff.customerObject?.id ?? null,
      quoteObjectId: handoff.quoteObject?.id ?? null,
      appointmentObjectId: handoff.appointmentObject?.id ?? null,
      updateKind: handoff.updateKind,
      channel,
      draft: draftMessage,
      sourceRefs: handoff.sourceRefs,
      messageContext,
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
      redaction: {
        customerContact: "redacted_by_default",
        siteAddress: "redacted_by_default",
      },
    } satisfies JsonObject;

    const [customerUpdate] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "customer_update",
        name: `Customer update draft for ${handoff.jobObject.name}`,
        state: "approval_required",
        source: dispatchSource,
        externalId: `dispatch-customer-update:${input.idempotencyKey}`,
        data: customerUpdateData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: customerUpdate.id,
      version: 1,
      data: customerUpdateData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "dispatch customer update draft",
      createdAt: now,
    });

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: customerUpdate.id,
          toId: handoff.jobObject.id,
          type: "updates_job",
          data: { source: dispatchSource },
          effectiveAt: now,
        },
        ...(handoff.customerObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: customerUpdate.id,
                toId: handoff.customerObject.id,
                type: "for_customer",
                data: { source: dispatchSource },
                effectiveAt: now,
              },
            ]
          : []),
        ...(handoff.appointmentObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: customerUpdate.id,
                toId: handoff.appointmentObject.id,
                type: "about_appointment",
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
          customerUpdateObjectId: customerUpdate.id,
          jobObjectId: handoff.jobObject.id,
          sourceRefs: handoff.sourceRefs,
          inputHash,
          externalExecution: "blocked",
        },
        blockers: { open: ["customer_update_approval_required", "external_send_blocked"] },
        metrics: { budgetUnits: customerUpdateDraftUnits, customerUpdatesDrafted: 1 },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task.id,
        units: customerUpdateDraftUnits,
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
        promptHash: traceHash(input.idempotencyKey, "dispatch-customer-update"),
        request: {
          mode: "deterministic",
          objective: "Draft a customer update from tenant-scoped job evidence without sending it.",
          jobObjectId: handoff.jobObject.id,
          updateKind: handoff.updateKind,
          channel,
          inputHash,
        },
        result: {
          customerUpdateObjectId: customerUpdate.id,
          draft: draftMessage,
          requiresApproval: true,
          externalSend: false,
        },
        safety: {
          externalExecution: "blocked",
          externalMutation: false,
          customerSend: "blocked",
        },
        promptTokens: 260,
        completionTokens: 120,
        units: customerUpdateDraftUnits,
        costUsd: "0.000000",
        latencyMs: 90,
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
        units: customerUpdateDraftUnits,
        costUsd: "0.000000",
        data: {
          mode: "deterministic",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          customerUpdateObjectId: customerUpdate.id,
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "dispatch_worker.customer_update_draft.completed",
        source: dispatchSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: customerUpdate.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          jobObjectId: handoff.jobObject.id,
          customerUpdateObjectId: customerUpdate.id,
          updateKind: handoff.updateKind,
          channel,
          externalExecution: "blocked",
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

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Dispatch customer update trace",
        objectId: customerUpdate.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          inputHash,
          jobObjectId: handoff.jobObject.id,
          customerObjectId: handoff.customerObject?.id ?? null,
          quoteObjectId: handoff.quoteObject?.id ?? null,
          appointmentObjectId: handoff.appointmentObject?.id ?? null,
          updateKind: handoff.updateKind,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [draftEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "draft",
        name: "Customer update draft",
        objectId: customerUpdate.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "customer_update_draft"),
        data: {
          customerUpdateObjectId: customerUpdate.id,
          jobObjectId: handoff.jobObject.id,
          channel,
          draft: draftMessage,
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
        objectId: customerUpdate.id,
        workflowRunId: workflowRun.id,
        kind: "dispatch_customer_update_draft",
        name: `Customer update draft for ${handoff.jobObject.name}`,
        state: "review_ready",
        sensitivity: "medium",
        hash: traceHash(input.idempotencyKey, "document"),
        data: {
          jobObjectId: handoff.jobObject.id,
          customerUpdateObjectId: customerUpdate.id,
          updateKind: handoff.updateKind,
          draft: draftMessage,
          externalExecution: "blocked",
          externalSend: false,
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
        objectId: customerUpdate.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "dispatch_customer_update_packet",
        name: "Dispatch customer update evidence packet",
        state: "review_ready",
        sensitivity: "medium",
        evidenceIds: { ids: [traceEvidence.id, draftEvidence.id] },
        documentIds: { ids: [document.id] },
        data: {
          jobObjectId: handoff.jobObject.id,
          customerUpdateObjectId: customerUpdate.id,
          updateKind: handoff.updateKind,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
        },
        hash: traceHash(input.idempotencyKey, "dispatch_customer_update_packet"),
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
        objectId: customerUpdate.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "dispatch_customer_update_approval",
        state: "pending",
        priority: "normal",
        risk: "medium",
        title: `Approve customer update for ${handoff.jobObject.name}`,
        summary:
          "Dispatch Operations Worker drafted a customer update; external customer sends remain blocked.",
        requestedAction: {
          action: "approve_customer_update",
          customerUpdateObjectId: customerUpdate.id,
          jobObjectId: handoff.jobObject.id,
          updateKind: handoff.updateKind,
          channel,
          externalSend: false,
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
        },
        policy: {
          customerSend: "blocked",
          externalExecution: "blocked",
        },
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          customerUpdateObjectId: customerUpdate.id,
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
          name: "Dispatch job context accepted",
          state: "done",
          toState: "ready_to_update_customer",
          idempotencyKey: `${input.idempotencyKey}:job_context`,
          input: { sourceRefs: handoff.sourceRefs },
          output: { jobObjectId: handoff.jobObject.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: customerUpdate.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "Customer update draft prepared",
          state: "done",
          fromState: "ready_to_update_customer",
          toState: "customer_update_drafted",
          idempotencyKey: `${input.idempotencyKey}:customer_update_drafted`,
          input: { updateKind: handoff.updateKind, channel },
          output: { customerUpdateObjectId: customerUpdate.id, draftEvidenceId: draftEvidence.id },
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
          objectId: customerUpdate.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Customer update approval requested",
          state: "done",
          fromState: "customer_update_drafted",
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
    const viewKey = "dispatch.customer_update.review";
    const viewVersion = "1.0.0";
    const viewValues = {
      capabilityId: context.capabilityId,
      key: viewKey,
      version: viewVersion,
      name: "Dispatch customer update review",
      purpose: "Let an operator review a customer update draft while external sends remain blocked.",
      surface: "web",
      objectType: "customer_update",
      taskState: "approval_required" as const,
      contract: {
        sections: ["JobSummary", "DraftMessage", "EvidenceTimeline", "ActionBar"],
        externalExecution: "blocked",
      } as JsonObject,
      actions: {
        decisionSurface: "/approval",
        decisionCommand: "approval.decide",
        postDecisionSurface: "/worker",
        postDecisionCommand: "continue",
        valid: ["approved", "revision_requested", "rejected"],
        externalExecution: "blocked",
      } as JsonObject,
      data: {
        latest: {
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          taskId: task.id,
          jobObjectId: handoff.jobObject.id,
          customerObjectId: handoff.customerObject?.id ?? null,
          customerUpdateObjectId: customerUpdate.id,
          updateKind: handoff.updateKind,
          channel,
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
        },
      } as JsonObject,
      mask: {
        customer_contact: "redacted_by_default",
        site_address: "redacted_by_default",
        externalExecution: "blocked",
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
      objectId: customerUpdate.id,
      taskId: task.id,
      capabilityId: context.capabilityId,
      idempotencyKey: `${input.idempotencyKey}:dispatch_customer_update_view`,
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
      type: "dispatch_worker.customer_update_draft.completed",
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
      objectId: customerUpdate.id,
      capabilityId: context.capabilityId,
      risk: "medium",
      idempotencyKey: `${input.idempotencyKey}:audit`,
      data: {
        operatorEmail: context.operator.email,
        inputHash,
        externalExecution: "blocked",
        externalMutation: false,
        externalSend: false,
      },
      createdAt: now,
    });

    const output = {
      jobObjectId: handoff.jobObject.id,
      customerObjectId: handoff.customerObject?.id ?? null,
      quoteObjectId: handoff.quoteObject?.id ?? null,
      appointmentObjectId: handoff.appointmentObject?.id ?? null,
      customerUpdateObjectId: customerUpdate.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      draftEvidenceId: draftEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      dispatchCustomerUpdateViewId: view.id,
      updateKind: handoff.updateKind,
      channel,
      draft: draftMessage,
      sourceRefs: handoff.sourceRefs,
      externalExecution: "blocked",
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
          customerUpdateObjectId: customerUpdate.id,
          approvalRequestId: approval.id,
          evidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          dispatchCustomerUpdateViewId: view.id,
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
          customer_updates_drafted: numberValue(context.worker.kpis.customer_updates_drafted) + 1,
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      replay: null,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      customerUpdateObjectId: customerUpdate.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      draftEvidenceId: draftEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      dispatchCustomerUpdateViewId: view.id,
      output,
    };
  });

  if (result.replay) {
    return replayedCustomerUpdateDraft(db, context, result.replay);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    customerUpdateObjectId: result.customerUpdateObjectId,
    approvalRequestId: result.approvalRequestId,
    evidenceId: result.evidenceId,
    draftEvidenceId: result.draftEvidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    dispatchCustomerUpdateViewId: result.dispatchCustomerUpdateViewId,
    output: result.output,
    snapshot: await getDispatchWorkerSnapshot(db, {
      role: dispatchWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function prepareDispatchCloseout(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<DispatchCloseoutPrepareResult> {
  const db = input.db ?? defaultDb;
  const context = await loadDispatchContext({
    db,
    selector: { role: dispatchWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: closeoutCapabilityKey,
    capabilityLabel: "document_packet.prepare",
  });
  const config = input.config ?? {};
  const handoff = await loadCloseoutRefs(db, context.worker.tenantId, config);
  const quality = normalizeCloseoutQuality(config, handoff.photoEvidenceIds);
  const billableLines = Array.isArray(config.billableLines)
    ? config.billableLines
        .filter((line) => line && typeof line === "object" && !Array.isArray(line))
        .map((line) => objectValue(line))
    : [];
  const closeoutState = quality.blockers.length > 0 ? "rework_required" : "review_ready";
  const inputHash = hashObject({
    schemaVersion: "dispatch.closeout.prepare.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    workOrderObjectId: handoff.workOrderObject.id,
    jobObjectId: handoff.jobObject.id,
    customerObjectId: handoff.customerObject?.id ?? null,
    appointmentObjectId: handoff.appointmentObject?.id ?? null,
    customerUpdateObjectId: handoff.customerUpdateObject?.id ?? null,
    sourceEvidenceIds: handoff.sourceEvidenceIds,
    closeoutState,
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
          "A Dispatch closeout packet already exists for this idempotency key with different input.",
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
        objectId: handoff.workOrderObject.id,
        capabilityId: context.capabilityId,
        title: `Review closeout packet for ${handoff.workOrderObject.name}`,
        state: "approval_required",
        priority: quality.blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          required: ["work_order_snapshot", "qa_checklist", "dispatch_closeout_packet"],
          blockers: quality.blockers,
        },
        outcome: {
          status: quality.blockers.length > 0 ? "closeout_rework_needed" : "closeout_approval_needed",
        },
        cost: { units: closeoutPrepareUnits },
        kpi: { closeouts_prepared: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const runInput = {
      command: "closeout.prepare",
      inputHash,
      config,
      workOrderObjectId: handoff.workOrderObject.id,
      jobObjectId: handoff.jobObject.id,
      customerObjectId: handoff.customerObject?.id ?? null,
      appointmentObjectId: handoff.appointmentObject?.id ?? null,
      customerUpdateObjectId: handoff.customerUpdateObject?.id ?? null,
      sourceEvidenceIds: handoff.sourceEvidenceIds,
    } satisfies JsonObject;

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source: dispatchSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: runInput,
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const closeoutData = {
      workOrderObjectId: handoff.workOrderObject.id,
      jobObjectId: handoff.jobObject.id,
      customerObjectId: handoff.customerObject?.id ?? null,
      appointmentObjectId: handoff.appointmentObject?.id ?? null,
      customerUpdateObjectId: handoff.customerUpdateObject?.id ?? null,
      sourceRefs: handoff.sourceRefs,
      sourceEvidenceIds: handoff.sourceEvidenceIds,
      photoEvidenceIds: handoff.photoEvidenceIds,
      completionNotes: quality.completionNotes,
      qaChecklist: quality.qaChecklist,
      billableLines,
      invoiceReady: quality.invoiceReady,
      financeHandoff: {
        handoff: "dispatch.closeout_to_finance",
        status: quality.invoiceReady ? "ready_for_invoice_draft" : "blocked_for_rework",
        invoiceExecution: "blocked",
        paymentExecution: "blocked",
      },
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
    } satisfies JsonObject;

    const [closeout] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "closeout",
        name: `Closeout packet for ${handoff.workOrderObject.name}`,
        state: closeoutState,
        source: dispatchSource,
        externalId: `dispatch-closeout:${input.idempotencyKey}`,
        data: closeoutData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: closeout.id,
      version: 1,
      data: closeoutData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "dispatch closeout packet",
      createdAt: now,
    });

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: closeout.id,
          toId: handoff.workOrderObject.id,
          type: "closes_work_order",
          data: { source: dispatchSource },
          effectiveAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          fromId: closeout.id,
          toId: handoff.jobObject.id,
          type: "supports_job",
          data: { source: dispatchSource },
          effectiveAt: now,
        },
        ...(handoff.customerObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: closeout.id,
                toId: handoff.customerObject.id,
                type: "for_customer",
                data: { source: dispatchSource },
                effectiveAt: now,
              },
            ]
          : []),
        ...(handoff.appointmentObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: closeout.id,
                toId: handoff.appointmentObject.id,
                type: "about_appointment",
                data: { source: dispatchSource },
                effectiveAt: now,
              },
            ]
          : []),
        ...(handoff.customerUpdateObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: closeout.id,
                toId: handoff.customerUpdateObject.id,
                type: "includes_customer_update",
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
          closeoutObjectId: closeout.id,
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          sourceRefs: handoff.sourceRefs,
          inputHash,
          externalExecution: "blocked",
        },
        blockers: {
          open: [
            "closeout_approval_required",
            "external_invoice_handoff_blocked",
            ...quality.blockers,
          ],
        },
        metrics: {
          budgetUnits: closeoutPrepareUnits,
          closeoutsPrepared: 1,
          blockerCount: quality.blockers.length,
          billableLineCount: billableLines.length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task.id,
        units: closeoutPrepareUnits,
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
        promptHash: traceHash(input.idempotencyKey, "dispatch-closeout"),
        request: {
          mode: "deterministic",
          objective: "Prepare a closeout packet and QA checklist from tenant-scoped work order evidence.",
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          sourceEvidenceIds: handoff.sourceEvidenceIds,
          inputHash,
        },
        result: {
          closeoutObjectId: closeout.id,
          closeoutState,
          qaChecklist: quality.qaChecklist,
          blockers: quality.blockers,
          requiresApproval: true,
          externalExecution: "blocked",
        },
        safety: {
          externalExecution: "blocked",
          externalMutation: false,
          financeHandoff: "blocked",
        },
        promptTokens: 320,
        completionTokens: 140,
        units: closeoutPrepareUnits,
        costUsd: "0.000000",
        latencyMs: 100,
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
        units: closeoutPrepareUnits,
        costUsd: "0.000000",
        data: {
          mode: "deterministic",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          closeoutObjectId: closeout.id,
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "dispatch_worker.closeout_prepare.completed",
        source: dispatchSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: closeout.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          closeoutObjectId: closeout.id,
          closeoutState,
          blockers: quality.blockers,
          externalExecution: "blocked",
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

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Dispatch closeout trace",
        objectId: closeout.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          inputHash,
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          closeoutObjectId: closeout.id,
          sourceEvidenceIds: handoff.sourceEvidenceIds,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [qaEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "snapshot",
        name: "Closeout QA checklist",
        objectId: closeout.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "closeout_qa"),
        data: {
          closeoutObjectId: closeout.id,
          workOrderObjectId: handoff.workOrderObject.id,
          qaChecklist: quality.qaChecklist,
          completionNotes: quality.completionNotes,
          billableLines,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: closeout.id,
        workflowRunId: workflowRun.id,
        kind: "dispatch_closeout_packet",
        name: `Dispatch closeout packet for ${handoff.workOrderObject.name}`,
        state: closeoutState,
        sensitivity: "medium",
        hash: traceHash(input.idempotencyKey, "document"),
        data: {
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          closeoutObjectId: closeout.id,
          qaChecklist: quality.qaChecklist,
          billableLines,
          invoiceReady: quality.invoiceReady,
          sourceEvidenceIds: handoff.sourceEvidenceIds,
          financeHandoff: closeoutData.financeHandoff,
          externalExecution: "blocked",
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
        objectId: closeout.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "dispatch_closeout_packet",
        name: "Dispatch closeout evidence packet",
        state: "review_ready",
        sensitivity: "medium",
        evidenceIds: { ids: [traceEvidence.id, qaEvidence.id, ...handoff.sourceEvidenceIds] },
        documentIds: { ids: [document.id] },
        data: {
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          closeoutObjectId: closeout.id,
          customerObjectId: handoff.customerObject?.id ?? null,
          invoiceReady: quality.invoiceReady,
          blockers: quality.blockers,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
        },
        hash: traceHash(input.idempotencyKey, "dispatch_closeout_packet"),
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
        objectId: closeout.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "dispatch_closeout_approval",
        state: "pending",
        priority: quality.blockers.length > 0 ? "high" : "normal",
        risk: quality.blockers.length > 0 ? "high" : "medium",
        title: `Approve closeout for ${handoff.workOrderObject.name}`,
        summary:
          "Dispatch Operations Worker prepared a closeout packet and QA checklist; invoice preparation and external sends remain blocked.",
        requestedAction: {
          action: quality.blockers.length > 0 ? "request_rework" : "accept_closeout",
          closeoutObjectId: closeout.id,
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          invoiceReady: quality.invoiceReady,
          blockers: quality.blockers,
          financeHandoff: "dispatch.closeout_to_finance",
          externalExecution: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          qaEvidenceId: qaEvidence.id,
          sourceEvidenceIds: handoff.sourceEvidenceIds,
        },
        policy: {
          closeoutAcceptance: "approval_required",
          invoicePreparation: "blocked_until_finance_worker",
          externalExecution: "blocked",
        },
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          closeoutObjectId: closeout.id,
          financeHandoff: "dispatch.closeout_to_finance",
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
          objectId: handoff.workOrderObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "handoff",
          name: "Work order context accepted",
          state: "done",
          fromState: "in_progress",
          toState: "closeout_ready",
          idempotencyKey: `${input.idempotencyKey}:work_order_context`,
          input: { sourceRefs: handoff.sourceRefs },
          output: {
            workOrderObjectId: handoff.workOrderObject.id,
            jobObjectId: handoff.jobObject.id,
          },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: closeout.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "Closeout packet prepared",
          state: "done",
          fromState: "closeout_ready",
          toState: closeoutState,
          idempotencyKey: `${input.idempotencyKey}:closeout_prepared`,
          input: { workOrderObjectId: handoff.workOrderObject.id },
          output: { closeoutObjectId: closeout.id, documentId: document.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: closeout.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "QA checklist recorded",
          state: "done",
          fromState: closeoutState,
          toState: closeoutState,
          idempotencyKey: `${input.idempotencyKey}:qa_checklist`,
          input: { sourceEvidenceIds: handoff.sourceEvidenceIds },
          output: { qaEvidenceId: qaEvidence.id, blockers: quality.blockers },
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
          objectId: closeout.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Closeout approval requested",
          state: "done",
          fromState: closeoutState,
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
    const viewKey = "dispatch.closeout.review";
    const viewVersion = "1.0.0";
    const viewValues = {
      capabilityId: context.capabilityId,
      key: viewKey,
      version: viewVersion,
      name: "Dispatch closeout review",
      purpose: "Let an operator review a closeout packet, QA checklist, and Finance handoff readiness.",
      surface: "web",
      objectType: "closeout",
      taskState: "approval_required" as const,
      contract: {
        sections: ["WorkOrderSummary", "QAChecklist", "EvidenceTimeline", "FinanceHandoff", "ActionBar"],
        externalExecution: "blocked",
      } as JsonObject,
      actions: {
        decisionSurface: "/approval",
        decisionCommand: "approval.decide",
        postDecisionSurface: "/worker",
        postDecisionCommand: "continue",
        valid: ["approved", "revision_requested", "rejected"],
        closeoutActions: ["accept_closeout", "request_rework", "prepare_invoice"],
        externalExecution: "blocked",
      } as JsonObject,
      data: {
        latest: {
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          taskId: task.id,
          workOrderObjectId: handoff.workOrderObject.id,
          jobObjectId: handoff.jobObject.id,
          customerObjectId: handoff.customerObject?.id ?? null,
          closeoutObjectId: closeout.id,
          closeoutState,
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          qaEvidenceId: qaEvidence.id,
          sourceEvidenceIds: handoff.sourceEvidenceIds,
          invoiceReady: quality.invoiceReady,
          blockers: quality.blockers,
          financeHandoff: "dispatch.closeout_to_finance",
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
        },
      } as JsonObject,
      mask: {
        customer_contact: "redacted_by_default",
        site_notes: "redacted_by_default",
        externalExecution: "blocked",
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
      objectId: closeout.id,
      taskId: task.id,
      capabilityId: context.capabilityId,
      idempotencyKey: `${input.idempotencyKey}:dispatch_closeout_view`,
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
      type: "dispatch_worker.closeout_prepare.completed",
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
      objectId: closeout.id,
      capabilityId: context.capabilityId,
      risk: quality.blockers.length > 0 ? "high" : "medium",
      idempotencyKey: `${input.idempotencyKey}:audit`,
      data: {
        operatorEmail: context.operator.email,
        inputHash,
        closeoutState,
        externalExecution: "blocked",
        externalMutation: false,
        externalSend: false,
      },
      createdAt: now,
    });

    const output = {
      workOrderObjectId: handoff.workOrderObject.id,
      jobObjectId: handoff.jobObject.id,
      customerObjectId: handoff.customerObject?.id ?? null,
      appointmentObjectId: handoff.appointmentObject?.id ?? null,
      customerUpdateObjectId: handoff.customerUpdateObject?.id ?? null,
      closeoutObjectId: closeout.id,
      closeoutState,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      qaEvidenceId: qaEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      dispatchCloseoutViewId: view.id,
      qaChecklist: quality.qaChecklist,
      billableLines,
      invoiceReady: quality.invoiceReady,
      blockers: quality.blockers,
      sourceRefs: handoff.sourceRefs,
      sourceEvidenceIds: handoff.sourceEvidenceIds,
      financeHandoff: {
        name: "dispatch.closeout_to_finance",
        status: quality.invoiceReady ? "ready_for_invoice_draft" : "blocked_for_rework",
        externalExecution: "blocked",
      },
      externalExecution: "blocked",
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
          closeoutObjectId: closeout.id,
          approvalRequestId: approval.id,
          evidenceId: traceEvidence.id,
          qaEvidenceId: qaEvidence.id,
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          dispatchCloseoutViewId: view.id,
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
          closeouts_prepared: numberValue(context.worker.kpis.closeouts_prepared) + 1,
          approval_requests_created: numberValue(context.worker.kpis.approval_requests_created) + 1,
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      replay: null,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      closeoutObjectId: closeout.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      qaEvidenceId: qaEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      dispatchCloseoutViewId: view.id,
      output,
    };
  });

  if (result.replay) {
    return replayedCloseoutPrepare(db, context, result.replay);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    closeoutObjectId: result.closeoutObjectId,
    approvalRequestId: result.approvalRequestId,
    evidenceId: result.evidenceId,
    qaEvidenceId: result.qaEvidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    dispatchCloseoutViewId: result.dispatchCloseoutViewId,
    output: result.output,
    snapshot: await getDispatchWorkerSnapshot(db, {
      role: dispatchWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function routeDispatchException(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<DispatchExceptionRouteResult> {
  const db = input.db ?? defaultDb;
  const context = await loadDispatchContext({
    db,
    selector: { role: dispatchWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: exceptionRouteCapabilityKey,
    capabilityLabel: "exception.route",
  });
  const config = input.config ?? {};
  const route = await loadExceptionRefs(db, context.worker.tenantId, config);
  const inputHash = hashObject({
    schemaVersion: "dispatch.exception.route.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    jobObjectId: route.jobObject.id,
    customerObjectId: route.customerObject?.id ?? null,
    workOrderObjectId: route.workOrderObject?.id ?? null,
    appointmentObjectId: route.appointmentObject?.id ?? null,
    closeoutObjectId: route.closeoutObject?.id ?? null,
    sourceEvidenceIds: route.sourceEvidenceIds,
    reason: route.reason,
    severity: route.severity.severity,
  });
  const now = new Date();
  const normalizedReason = route.reason.replace(/\s+/g, "_").toLowerCase();
  const title = `Route ${route.severity.severity} dispatch exception for ${route.jobObject.name}`;

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
          "A Dispatch exception route already exists for this idempotency key with different input.",
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
        objectId: route.jobObject.id,
        capabilityId: context.capabilityId,
        title,
        state: "blocked",
        priority: route.severity.priority,
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          required: ["exception_context", "route_decision", "dispatch_exception_packet"],
          reason: route.reason,
          severity: route.severity.severity,
          sourceEvidenceIds: route.sourceEvidenceIds,
        },
        outcome: {
          status: "dispatch_exception_routed",
          routeKind: route.routeKind,
          reason: route.reason,
          severity: route.severity.severity,
        },
        cost: { units: exceptionRouteUnits },
        kpi: { exceptions_routed: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const runInput = {
      command: "exception.route",
      inputHash,
      config,
      jobObjectId: route.jobObject.id,
      customerObjectId: route.customerObject?.id ?? null,
      workOrderObjectId: route.workOrderObject?.id ?? null,
      appointmentObjectId: route.appointmentObject?.id ?? null,
      closeoutObjectId: route.closeoutObject?.id ?? null,
      sourceEvidenceIds: route.sourceEvidenceIds,
      reason: route.reason,
      severity: route.severity.severity,
    } satisfies JsonObject;

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source: dispatchSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: runInput,
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: route.jobObject.id,
        workerId: context.worker.id,
        state: "blocked",
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          taskId: task.id,
          jobObjectId: route.jobObject.id,
          sourceRefs: route.sourceRefs,
          reason: route.reason,
          severity: route.severity.severity,
          inputHash,
          externalExecution: "blocked",
        },
        blockers: { open: [`dispatch_exception:${normalizedReason}`] },
        metrics: {
          budgetUnits: exceptionRouteUnits,
          exceptionsRouted: 1,
          severity: route.severity.severity,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task.id,
        units: exceptionRouteUnits,
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
        promptHash: traceHash(input.idempotencyKey, "dispatch-exception"),
        request: {
          mode: "deterministic",
          objective: "Route a dispatch exception into tenant-scoped review work without external execution.",
          jobObjectId: route.jobObject.id,
          reason: route.reason,
          severity: route.severity.severity,
          inputHash,
        },
        result: {
          taskId: task.id,
          routeKind: route.routeKind,
          reason: route.reason,
          severity: route.severity.severity,
          externalExecution: "blocked",
        },
        safety: {
          externalExecution: "blocked",
          externalMutation: false,
          customerSend: "blocked",
        },
        promptTokens: 180,
        completionTokens: 80,
        units: exceptionRouteUnits,
        costUsd: "0.000000",
        latencyMs: 70,
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
        units: exceptionRouteUnits,
        costUsd: "0.000000",
        data: {
          mode: "deterministic",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          routeKind: route.routeKind,
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "dispatch_worker.exception_route.completed",
        source: dispatchSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: route.jobObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          jobObjectId: route.jobObject.id,
          customerObjectId: route.customerObject?.id ?? null,
          workOrderObjectId: route.workOrderObject?.id ?? null,
          appointmentObjectId: route.appointmentObject?.id ?? null,
          closeoutObjectId: route.closeoutObject?.id ?? null,
          reason: route.reason,
          severity: route.severity.severity,
          routeKind: route.routeKind,
          externalExecution: "blocked",
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

    const [decision] = await tx
      .insert(decisions)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task.id,
        eventId: event.id,
        workflowRunId: workflowRun.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        kind: "dispatch_exception_route",
        state: "proposed",
        decision: "route_to_dispatch_review",
        rationale:
          route.notes ||
          `Route ${route.severity.severity} dispatch exception for operator review before external execution.`,
        data: {
          workerRunId: workerRun.id,
          jobObjectId: route.jobObject.id,
          reason: route.reason,
          severity: route.severity.severity,
          routeKind: route.routeKind,
          sourceRefs: route.sourceRefs,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: decisions.id });

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Dispatch exception route trace",
        objectId: route.jobObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          inputHash,
          jobObjectId: route.jobObject.id,
          reason: route.reason,
          severity: route.severity.severity,
          routeKind: route.routeKind,
          sourceEvidenceIds: route.sourceEvidenceIds,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [decisionEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "note",
        name: "Dispatch exception route decision",
        objectId: route.jobObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "exception_route_decision"),
        data: {
          decisionId: decision.id,
          taskId: task.id,
          jobObjectId: route.jobObject.id,
          reason: route.reason,
          severity: route.severity.severity,
          routeKind: route.routeKind,
          recommendedAction: "operator_review",
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: route.jobObject.id,
        workflowRunId: workflowRun.id,
        kind: "dispatch_exception_packet",
        name: `Dispatch exception packet for ${route.jobObject.name}`,
        state: "review_ready",
        sensitivity: route.severity.risk,
        hash: traceHash(input.idempotencyKey, "document"),
        data: {
          jobObjectId: route.jobObject.id,
          taskId: task.id,
          decisionId: decision.id,
          reason: route.reason,
          severity: route.severity.severity,
          routeKind: route.routeKind,
          sourceEvidenceIds: route.sourceEvidenceIds,
          externalExecution: "blocked",
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
        objectId: route.jobObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "dispatch_exception_packet",
        name: "Dispatch exception evidence packet",
        state: "review_ready",
        sensitivity: route.severity.risk,
        evidenceIds: { ids: [traceEvidence.id, decisionEvidence.id, ...route.sourceEvidenceIds] },
        documentIds: { ids: [document.id] },
        data: {
          jobObjectId: route.jobObject.id,
          taskId: task.id,
          decisionId: decision.id,
          reason: route.reason,
          severity: route.severity.severity,
          routeKind: route.routeKind,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
        },
        hash: traceHash(input.idempotencyKey, "dispatch_exception_packet"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });

    const stepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: route.jobObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "Dispatch exception detected",
          state: "done",
          toState: "blocked",
          idempotencyKey: `${input.idempotencyKey}:exception_detected`,
          input: { sourceRefs: route.sourceRefs },
          output: { taskId: task.id, reason: route.reason, severity: route.severity.severity },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: route.jobObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "decision",
          name: "Exception route decision recorded",
          state: "done",
          fromState: "blocked",
          toState: "blocked",
          idempotencyKey: `${input.idempotencyKey}:route_decision`,
          input: { taskId: task.id },
          output: { decisionId: decision.id, packetId: packet.id, documentId: document.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });

    const workflowStepIds = stepRows.map((step) => step.id);

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "dispatch_worker.exception_route.completed",
      source: dispatchSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: workerRun.id,
      taskId: task.id,
      workerRunId: workerRun.id,
      eventId: event.id,
      objectId: route.jobObject.id,
      capabilityId: context.capabilityId,
      risk: route.severity.risk,
      idempotencyKey: `${input.idempotencyKey}:audit`,
      data: {
        operatorEmail: context.operator.email,
        inputHash,
        decisionId: decision.id,
        packetId: packet.id,
        reason: route.reason,
        severity: route.severity.severity,
        externalExecution: "blocked",
        externalMutation: false,
        externalSend: false,
      },
      createdAt: now,
    });

    const output = {
      jobObjectId: route.jobObject.id,
      customerObjectId: route.customerObject?.id ?? null,
      workOrderObjectId: route.workOrderObject?.id ?? null,
      appointmentObjectId: route.appointmentObject?.id ?? null,
      closeoutObjectId: route.closeoutObject?.id ?? null,
      taskId: task.id,
      decisionId: decision.id,
      evidenceId: traceEvidence.id,
      decisionEvidenceId: decisionEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      reason: route.reason,
      severity: route.severity.severity,
      routeKind: route.routeKind,
      sourceRefs: route.sourceRefs,
      sourceEvidenceIds: route.sourceEvidenceIds,
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
      requiresOperatorReview: true,
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
          decisionId: decision.id,
          evidenceId: traceEvidence.id,
          decisionEvidenceId: decisionEvidence.id,
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
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
          exceptions_routed: numberValue(context.worker.kpis.exceptions_routed) + 1,
          conflicts_found:
            normalizedReason.includes("conflict") || normalizedReason.includes("double_book")
              ? numberValue(context.worker.kpis.conflicts_found) + 1
              : numberValue(context.worker.kpis.conflicts_found),
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      replay: null,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      decisionId: decision.id,
      evidenceId: traceEvidence.id,
      decisionEvidenceId: decisionEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      output,
    };
  });

  if (result.replay) {
    return replayedExceptionRoute(db, context, result.replay);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    decisionId: result.decisionId,
    evidenceId: result.evidenceId,
    decisionEvidenceId: result.decisionEvidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
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
