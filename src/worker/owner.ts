import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { PlatformUnavailableError } from "../core/errors";
import { loadOperatorContext } from "../core/operators";
import { completeCoreWorkerRun, startCoreWorkerRun } from "../core/worker-runs";
import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  decisions,
  documents,
  evidence,
  evidencePackets,
  events,
  objects,
  objectVersions,
  tasks,
  tenants,
  uiContracts,
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

export const ownerWorkerRole = "owner_chief_of_staff";

const ownerSource = "continuous.worker";
const coreWorkerRunSource = "continuous.core.worker_runs";
const dailyBriefWorkflowKey = "daily_owner_brief";
const ownerRunUnits = 4000;
const defaultBriefScopes = ["tasks", "approvals", "cash", "capacity", "obligations", "workers"];
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OwnerWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

export type OwnerWorkerSnapshot = {
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
    openDecisions: number;
    generatedViews: number;
    externalExecution: "disabled";
  };
  activeTasks: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    outcome: JsonObject;
    cost: JsonObject;
  }>;
  recentBriefs: Array<{
    id: string;
    name: string;
    state: string;
    generatedAt: string | null;
    sourceCounts: JsonObject;
  }>;
  recentEvents: Array<{
    id: string;
    type: string;
    actorRef: string;
    occurredAt: string;
    data: JsonObject;
  }>;
  latestRun: {
    id: string;
    workerRunId: string;
    eventId: string | null;
    idempotencyKey: string;
    occurredAt: string;
    state: string;
    mode: string;
  } | null;
};

export type OwnerBriefRunResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  eventId: string | null;
  objectId: string | null;
  objectVersionId: string | null;
  evidenceId: string | null;
  documentId: string | null;
  packetId: string | null;
  approvalRequestId: string | null;
  auditEventId: string | null;
  reservationId: string | null;
  usageEventId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  decisionIds: string[];
  viewIds: string[];
  output: JsonObject;
  snapshot: OwnerWorkerSnapshot;
};

export type OwnerWorkerContinuationResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  originalWorkerRunId: string | null;
  eventId: string | null;
  approvalRequestId: string | null;
  auditEventId: string | null;
  evidenceId: string | null;
  objectId: string | null;
  documentId: string | null;
  packetId: string | null;
  workflowRunId: string | null;
  workflowStepId: string | null;
  taskId: string | null;
  output: JsonObject;
  snapshot: OwnerWorkerSnapshot;
};

export type OwnerDecisionQueueResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  eventId: string | null;
  evidenceId: string | null;
  auditEventId: string | null;
  decisionIds: string[];
  viewIds: string[];
  output: JsonObject;
  snapshot: OwnerWorkerSnapshot;
};

export type OwnerAnomalyTriageResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  eventId: string | null;
  evidenceId: string | null;
  auditEventId: string | null;
  metricObjectIds: string[];
  taskId: string | null;
  viewIds: string[];
  output: JsonObject;
  snapshot: OwnerWorkerSnapshot;
};

type OwnerWorkerRow = {
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

type OwnerContext = {
  worker: OwnerWorkerRow;
  operator: Awaited<ReturnType<typeof loadOperatorContext>>;
  budgetAccount: {
    id: string;
    name: string;
  };
};

type WindowRange = {
  from: Date;
  to: Date;
};

type OwnerReadModel = {
  window: {
    from: string;
    to: string;
  };
  tasks: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    dueAt: string | null;
  }>;
  approvals: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    risk: string;
  }>;
  obligations: Array<{
    id: string;
    name: string;
    state: string;
    type: string;
  }>;
  decisions: Array<{
    id: string;
    kind: string;
    state: string;
    decision: string;
  }>;
  workers: Array<{
    id: string;
    name: string;
    role: string;
    state: string;
    autonomyLevel: number;
  }>;
  recentEvents: Array<{
    id: string;
    type: string;
    source: string;
    occurredAt: string;
  }>;
  recentEvidence: Array<{
    id: string;
    kind: string;
    name: string;
  }>;
  budget: {
    usedUnits: number;
    heldUnits: number;
    events: number;
  };
  counts: JsonObject;
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function uuidValue(value: unknown) {
  const valueString = stringValue(value);

  return valueString && uuidPattern.test(valueString) ? valueString : undefined;
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

function booleanValue(value: unknown) {
  return value === true;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter(Boolean);
}

function hashJson(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseDate(value: unknown, field: string) {
  const text = stringValue(value);

  if (!text) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      `${field} is required.`,
      400,
    );
  }

  const date = new Date(text);

  if (Number.isNaN(date.valueOf())) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      `${field} must be an ISO timestamp.`,
      400,
    );
  }

  return date;
}

function parseWindow(config: JsonObject): WindowRange {
  const window = objectValue(config.window);
  const from = parseDate(window.from, "config.window.from");
  const to = parseDate(window.to, "config.window.to");

  if (from >= to) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.window.from must be before config.window.to.",
      400,
    );
  }

  return { from, to };
}

function parseBriefScopes(config: JsonObject) {
  const scopes = stringList(config.scopes);

  if (scopes.length === 0) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.scopes must include at least one owner brief section.",
      400,
    );
  }

  const allowed = new Set(defaultBriefScopes);
  const unknown = scopes.filter((scope) => !allowed.has(scope));

  if (unknown.length > 0) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      `config.scopes includes unsupported scopes: ${unknown.join(", ")}.`,
      400,
    );
  }

  return scopes;
}

function assertNoExternalExecution(config: JsonObject) {
  if (booleanValue(config.externalSend) || booleanValue(config.externalExecution)) {
    throw new PlatformUnavailableError(
      "worker_external_execution_blocked",
      "Owner Chief-of-Staff Worker cannot execute external actions.",
      403,
    );
  }
}

function emptySnapshot(): OwnerWorkerSnapshot {
  return {
    worker: null,
    budget: { accountId: null, name: null, usedUnits: 0, heldUnits: 0, events: 0 },
    controls: {
      pendingApprovals: 0,
      openDecisions: 0,
      generatedViews: 0,
      externalExecution: "disabled",
    },
    activeTasks: [],
    recentBriefs: [],
    recentEvents: [],
    latestRun: null,
  };
}

function workerConditions(selector: OwnerWorkerSelector) {
  const conditions = [
    eq(workers.role, selector.role ?? ownerWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: OwnerWorkerSelector): T | null {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Owner Chief-of-Staff Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadOwnerWorker(db: Database, selector: OwnerWorkerSelector): Promise<OwnerWorkerRow | null> {
  const rows = await db
    .select({
      id: workers.id,
      tenantId: workers.tenantId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      name: workers.name,
      role: workers.role,
      state: workers.state,
      mission: workers.mission,
      autonomyLevel: workers.autonomyLevel,
      scope: workers.scope,
      policy: workers.policy,
      kpis: workers.kpis,
      managerName: users.name,
    })
    .from(workers)
    .innerJoin(tenants, eq(workers.tenantId, tenants.id))
    .leftJoin(users, eq(workers.managerUserId, users.id))
    .where(workerConditions(selector))
    .orderBy(workers.createdAt)
    .limit(selector.workerId ? 1 : 2);

  return assertSingleWorker(rows, selector);
}

async function loadOwnerContext(input: {
  db: Database;
  selector: OwnerWorkerSelector;
  operatorEmail: string;
}): Promise<OwnerContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadOwnerWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Owner Chief-of-Staff Worker matches this selector.",
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

  const [budgetAccount] = await input.db
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
    .limit(1);

  if (!budgetAccount) {
    throw new PlatformUnavailableError(
      "worker_budget_missing",
      "Owner Chief-of-Staff Worker has no active budget account.",
      409,
    );
  }

  return { worker, operator, budgetAccount };
}

async function buildReadModel(db: Database, tenantId: string, window: WindowRange): Promise<OwnerReadModel> {
  const [
    taskRows,
    approvalRows,
    obligationRows,
    decisionRows,
    workerRows,
    eventRows,
    evidenceRows,
    usageRows,
    reservationRows,
  ] = await Promise.all([
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        state: tasks.state,
        priority: tasks.priority,
        dueAt: tasks.dueAt,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          sql`${tasks.state} <> 'done'`,
          sql`${tasks.state} <> 'canceled'`,
        ),
      )
      .orderBy(
        sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
        desc(tasks.updatedAt),
      )
      .limit(12),
    db
      .select({
        id: approvalRequests.id,
        title: approvalRequests.title,
        state: approvalRequests.state,
        priority: approvalRequests.priority,
        risk: approvalRequests.risk,
      })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.state, "pending")))
      .orderBy(
        sql`case ${approvalRequests.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
        desc(approvalRequests.createdAt),
      )
      .limit(12),
    db
      .select({
        id: objects.id,
        name: objects.name,
        state: objects.state,
        type: objects.type,
      })
      .from(objects)
      .where(
        and(
          eq(objects.tenantId, tenantId),
          sql`${objects.type} in ('obligation', 'filing_requirement', 'license', 'agency_notice')`,
          sql`${objects.state} <> 'closed'`,
        ),
      )
      .orderBy(desc(objects.updatedAt))
      .limit(12),
    db
      .select({
        id: decisions.id,
        kind: decisions.kind,
        state: decisions.state,
        decision: decisions.decision,
      })
      .from(decisions)
      .where(and(eq(decisions.tenantId, tenantId), sql`${decisions.state} in ('proposed', 'deferred')`))
      .orderBy(desc(decisions.createdAt))
      .limit(12),
    db
      .select({
        id: workers.id,
        name: workers.name,
        role: workers.role,
        state: workers.state,
        autonomyLevel: workers.autonomyLevel,
      })
      .from(workers)
      .where(and(eq(workers.tenantId, tenantId), sql`${workers.state} in ('training', 'active', 'paused')`))
      .orderBy(workers.createdAt)
      .limit(12),
    db
      .select({
        id: events.id,
        type: events.type,
        source: events.source,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          sql`${events.occurredAt} >= ${window.from}`,
          sql`${events.occurredAt} < ${window.to}`,
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(12),
    db
      .select({
        id: evidence.id,
        kind: evidence.kind,
        name: evidence.name,
      })
      .from(evidence)
      .where(and(eq(evidence.tenantId, tenantId), sql`${evidence.createdAt} >= ${window.from}`))
      .orderBy(desc(evidence.createdAt))
      .limit(12),
    db
      .select({
        units: sql<number>`coalesce(sum(${usageEvents.units}), 0)`,
        events: count(),
      })
      .from(usageEvents)
      .where(eq(usageEvents.tenantId, tenantId)),
    db
      .select({
        units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)`,
      })
      .from(budgetReservations)
      .where(and(eq(budgetReservations.tenantId, tenantId), eq(budgetReservations.state, "held"))),
  ]);

  const highPriorityTasks = taskRows.filter(
    (task) => task.priority === "urgent" || task.priority === "high",
  ).length;
  const activeWorkers = workerRows.filter((worker) => worker.state === "active").length;
  const pausedWorkers = workerRows.filter((worker) => worker.state === "paused").length;
  const pendingDecisions = decisionRows.filter((decision) => decision.state === "proposed").length;

  return {
    window: {
      from: window.from.toISOString(),
      to: window.to.toISOString(),
    },
    tasks: taskRows.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      priority: task.priority,
      dueAt: task.dueAt?.toISOString() ?? null,
    })),
    approvals: approvalRows,
    obligations: obligationRows,
    decisions: decisionRows,
    workers: workerRows,
    recentEvents: eventRows.map((event) => ({
      id: event.id,
      type: event.type,
      source: event.source,
      occurredAt: event.occurredAt.toISOString(),
    })),
    recentEvidence: evidenceRows,
    budget: {
      usedUnits: numberValue(usageRows[0]?.units),
      heldUnits: numberValue(reservationRows[0]?.units),
      events: usageRows[0]?.events ?? 0,
    },
    counts: {
      tasks: taskRows.length,
      highPriorityTasks,
      approvals: approvalRows.length,
      obligations: obligationRows.length,
      decisions: decisionRows.length,
      pendingDecisions,
      workers: workerRows.length,
      activeWorkers,
      pausedWorkers,
      events: eventRows.length,
      evidence: evidenceRows.length,
    },
  };
}

function section(
  key: string,
  title: string,
  summary: string,
  sourceRefs: JsonObject,
  state: string = "review_ready",
): JsonObject {
  return { key, title, summary, sourceRefs, state };
}

function buildBrief(readModel: OwnerReadModel, scopes: string[]) {
  const counts = objectValue(readModel.counts);
  const riskFlags = [
    ...(numberValue(counts.highPriorityTasks) > 0 ? ["high_priority_tasks"] : []),
    ...(numberValue(counts.approvals) > 0 ? ["pending_approvals"] : []),
    ...(numberValue(counts.obligations) > 0 ? ["open_obligations"] : []),
    ...(readModel.budget.heldUnits > 0 ? ["budget_reserved"] : []),
    ...(numberValue(counts.events) === 0 ? ["source_partial"] : []),
  ];

  const sectionByScope: Record<string, JsonObject> = {
    tasks: section(
      "tasks",
      "Tasks",
      `${counts.tasks ?? 0} open tasks; ${counts.highPriorityTasks ?? 0} high-priority tasks need attention.`,
      { taskIds: readModel.tasks.map((task) => task.id) },
      readModel.tasks.length > 0 ? "review_ready" : "empty",
    ),
    approvals: section(
      "approvals",
      "Approvals",
      `${counts.approvals ?? 0} approval requests are pending owner decision.`,
      { approvalIds: readModel.approvals.map((approval) => approval.id) },
      readModel.approvals.length > 0 ? "review_ready" : "empty",
    ),
    cash: section(
      "cash",
      "Cash And Budget",
      `${readModel.budget.usedUnits} budget units used; ${readModel.budget.heldUnits} units currently reserved.`,
      { budgetEvents: readModel.budget.events },
      readModel.budget.heldUnits > 0 ? "watch" : "review_ready",
    ),
    capacity: section(
      "capacity",
      "Capacity",
      `${counts.activeWorkers ?? 0} active workers and ${counts.pausedWorkers ?? 0} paused workers are visible.`,
      { workerIds: readModel.workers.map((worker) => worker.id) },
    ),
    obligations: section(
      "obligations",
      "Obligations",
      `${counts.obligations ?? 0} open obligations, filings, licenses, or notices need tracking.`,
      { objectIds: readModel.obligations.map((item) => item.id) },
      readModel.obligations.length > 0 ? "review_ready" : "empty",
    ),
    workers: section(
      "workers",
      "Workers",
      `${counts.workers ?? 0} human, AI, or service workers are part of the operating graph.`,
      { workerIds: readModel.workers.map((worker) => worker.id) },
    ),
  };

  return {
    window: readModel.window,
    generatedAt: new Date().toISOString(),
    sections: scopes.map((scope) => sectionByScope[scope]).filter(Boolean),
    sourceCounts: readModel.counts,
    riskFlags,
    budgetBurn: readModel.budget,
    sourceRefs: {
      taskIds: readModel.tasks.map((task) => task.id),
      approvalIds: readModel.approvals.map((approval) => approval.id),
      obligationObjectIds: readModel.obligations.map((item) => item.id),
      decisionIds: readModel.decisions.map((decision) => decision.id),
      workerIds: readModel.workers.map((worker) => worker.id),
      eventIds: readModel.recentEvents.map((event) => event.id),
      evidenceIds: readModel.recentEvidence.map((item) => item.id),
    },
    redaction: {
      bankAccountNumbers: "redacted",
      payrollDetails: "redacted",
      taxIdentifiers: "redacted",
      workerDocuments: "redacted",
      paymentTokens: "redacted",
      privateMessageBodies: "redacted",
    },
    externalExecution: "blocked",
    externalSend: false,
  };
}

function outputData(data: JsonObject) {
  const output = objectValue(data.output);

  if (Object.keys(output).length > 0) {
    return output;
  }

  return objectValue(objectValue(data.pendingCompletion).output);
}

function dataString(data: JsonObject, key: string) {
  const output = outputData(data);
  const completion = objectValue(data.completion);
  const completionBudget = objectValue(completion.budget);

  return (
    stringValue(output[key]) ??
    stringValue(data[key]) ??
    stringValue(completion[key]) ??
    stringValue(completionBudget[key]) ??
    null
  );
}

function dataStringList(data: JsonObject, key: string) {
  const output = outputData(data);
  const list = stringList(output[key]);

  return list.length > 0 ? list : stringList(data[key]);
}

function replayedBriefResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: OwnerWorkerSnapshot,
): OwnerBriefRunResult {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    eventId: dataString(data, "eventId") ?? run.eventId,
    objectId: dataString(data, "objectId"),
    objectVersionId: dataString(data, "objectVersionId"),
    evidenceId: dataString(data, "evidenceId"),
    documentId: dataString(data, "documentId"),
    packetId: dataString(data, "packetId"),
    approvalRequestId: dataString(data, "approvalRequestId"),
    auditEventId: dataString(data, "auditEventId"),
    reservationId: dataString(data, "reservationId"),
    usageEventId: dataString(data, "usageEventId"),
    workflowRunId: dataString(data, "workflowRunId"),
    workflowStepIds: dataStringList(data, "workflowStepIds"),
    decisionIds: dataStringList(data, "decisionIds"),
    viewIds: dataStringList(data, "viewIds"),
    output,
    snapshot,
  };
}

function replayedContinuationResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: OwnerWorkerSnapshot,
): OwnerWorkerContinuationResult {
  const data = objectValue(run.data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    originalWorkerRunId: stringValue(data.originalWorkerRunId) ?? null,
    eventId: run.eventId ?? stringValue(data.eventId) ?? null,
    approvalRequestId: stringValue(data.approvalRequestId) ?? null,
    auditEventId: stringValue(data.auditEventId) ?? null,
    evidenceId: stringValue(data.evidenceId) ?? null,
    objectId: stringValue(data.objectId) ?? null,
    documentId: stringValue(data.documentId) ?? null,
    packetId: stringValue(data.packetId) ?? null,
    workflowRunId: stringValue(data.workflowRunId) ?? null,
    workflowStepId: stringValue(data.workflowStepId) ?? null,
    taskId: run.taskId ?? stringValue(data.taskId) ?? null,
    output: objectValue(data.output),
    snapshot,
  };
}

function replayedDecisionQueueResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: OwnerWorkerSnapshot,
): OwnerDecisionQueueResult {
  const data = objectValue(run.data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    eventId: run.eventId,
    evidenceId: stringValue(data.evidenceId) ?? null,
    auditEventId: stringValue(data.auditEventId) ?? null,
    decisionIds: stringList(data.decisionIds),
    viewIds: stringList(data.viewIds),
    output: objectValue(data.output),
    snapshot,
  };
}

function replayedAnomalyResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: OwnerWorkerSnapshot,
): OwnerAnomalyTriageResult {
  const data = objectValue(run.data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    eventId: run.eventId,
    evidenceId: stringValue(data.evidenceId) ?? null,
    auditEventId: stringValue(data.auditEventId) ?? null,
    metricObjectIds: stringList(data.metricObjectIds),
    taskId: stringValue(data.taskId) ?? null,
    viewIds: stringList(data.viewIds),
    output: objectValue(data.output),
    snapshot,
  };
}

async function existingRun(db: Database, context: OwnerContext, idempotencyKey: string) {
  const [run] = await db
    .select()
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.tenantId, context.worker.tenantId),
        eq(workerRuns.workerId, context.worker.id),
        eq(workerRuns.source, ownerSource),
        eq(workerRuns.idempotencyKey, idempotencyKey),
      ),
    )
    .limit(1);

  return run ?? null;
}

export async function getOwnerWorkerSnapshot(
  db: Database = defaultDb,
  selector: OwnerWorkerSelector = {},
): Promise<OwnerWorkerSnapshot> {
  const worker = await loadOwnerWorker(db, selector);

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
    pendingApprovals,
    openDecisions,
    viewCount,
    activeTaskRows,
    briefRows,
    recentEventRows,
    latestRunRows,
  ] = await Promise.all([
    budgetAccount
      ? db
          .select({
            units: sql<number>`coalesce(sum(${usageEvents.units}), 0)`,
            events: count(),
          })
          .from(usageEvents)
          .where(eq(usageEvents.accountId, budgetAccount.id))
      : Promise.resolve([{ units: 0, events: 0 }]),
    budgetAccount
      ? db
          .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.accountId, budgetAccount.id),
              eq(budgetReservations.state, "held"),
            ),
          )
      : Promise.resolve([{ units: 0 }]),
    db
      .select({ value: count() })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, worker.tenantId), eq(approvalRequests.state, "pending"))),
    db
      .select({ value: count() })
      .from(decisions)
      .where(and(eq(decisions.tenantId, worker.tenantId), eq(decisions.state, "proposed"))),
    db
      .select({ value: count() })
      .from(uiContracts)
      .where(
        and(
          eq(uiContracts.tenantId, worker.tenantId),
          sql`${uiContracts.key} in ('owner.brief.review', 'owner.decision.queue', 'owner.anomaly.review')`,
          eq(uiContracts.active, true),
        ),
      ),
    db
      .select({
        id: tasks.id,
        title: tasks.title,
        state: tasks.state,
        priority: tasks.priority,
        outcome: tasks.outcome,
        cost: tasks.cost,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, worker.tenantId),
          eq(tasks.ownerType, "worker"),
          eq(tasks.ownerId, worker.id),
          sql`${tasks.state} <> 'done'`,
          sql`${tasks.state} <> 'canceled'`,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
      .limit(5),
    db
      .select({
        id: objects.id,
        name: objects.name,
        state: objects.state,
        data: objects.data,
      })
      .from(objects)
      .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.type, "owner_brief")))
      .orderBy(desc(objects.updatedAt))
      .limit(5),
    db
      .select({
        id: events.id,
        type: events.type,
        actorRef: events.actorRef,
        occurredAt: events.occurredAt,
        data: events.data,
      })
      .from(events)
      .where(and(eq(events.tenantId, worker.tenantId), eq(events.actorId, worker.id)))
      .orderBy(desc(events.occurredAt))
      .limit(8),
    db
      .select({
        id: workerRuns.id,
        eventId: workerRuns.eventId,
        idempotencyKey: workerRuns.idempotencyKey,
        state: workerRuns.state,
        mode: workerRuns.mode,
        startedAt: workerRuns.startedAt,
      })
      .from(workerRuns)
      .where(and(eq(workerRuns.tenantId, worker.tenantId), eq(workerRuns.workerId, worker.id)))
      .orderBy(desc(workerRuns.startedAt))
      .limit(1),
  ]);

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
      usedUnits: numberValue(usage[0]?.units),
      heldUnits: numberValue(reservations[0]?.units),
      events: usage[0]?.events ?? 0,
    },
    controls: {
      pendingApprovals: pendingApprovals[0]?.value ?? 0,
      openDecisions: openDecisions[0]?.value ?? 0,
      generatedViews: viewCount[0]?.value ?? 0,
      externalExecution: "disabled",
    },
    activeTasks: activeTaskRows.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      priority: task.priority,
      outcome: task.outcome,
      cost: task.cost,
    })),
    recentBriefs: briefRows.map((brief) => {
      const data = objectValue(brief.data);

      return {
        id: brief.id,
        name: brief.name,
        state: brief.state,
        generatedAt: stringValue(data.generatedAt) ?? null,
        sourceCounts: objectValue(data.sourceCounts),
      };
    }),
    recentEvents: recentEventRows.map((event) => ({
      id: event.id,
      type: event.type,
      actorRef: event.actorRef,
      occurredAt: event.occurredAt.toISOString(),
      data: event.data,
    })),
    latestRun: latestRunRows[0]
      ? {
          id: latestRunRows[0].id,
          workerRunId: latestRunRows[0].id,
          eventId: latestRunRows[0].eventId,
          idempotencyKey: latestRunRows[0].idempotencyKey,
          occurredAt: latestRunRows[0].startedAt.toISOString(),
          state: latestRunRows[0].state,
          mode: latestRunRows[0].mode,
        }
      : null,
  };
}

export async function getOwnerWorkerSnapshotSafe(selector: OwnerWorkerSelector = {}): Promise<
  | { ok: true; snapshot: OwnerWorkerSnapshot; error: null }
  | { ok: false; snapshot: OwnerWorkerSnapshot; error: string }
> {
  try {
    return { ok: true, snapshot: await getOwnerWorkerSnapshot(defaultDb, selector), error: null };
  } catch (error) {
    return {
      ok: false,
      snapshot: emptySnapshot(),
      error: error instanceof Error ? error.message : "Unknown Owner Chief-of-Staff Worker error",
    };
  }
}

export async function listOwnerBriefs(input: {
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  state?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const context = await loadOwnerContext({
    db,
    selector: { role: ownerWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const conditions = [eq(objects.tenantId, context.worker.tenantId), eq(objects.type, "owner_brief")];
  const state = stringValue(input.state);

  if (state) {
    conditions.push(eq(objects.state, state));
  }

  const rows = await db
    .select({
      id: objects.id,
      name: objects.name,
      state: objects.state,
      data: objects.data,
      updatedAt: objects.updatedAt,
    })
    .from(objects)
    .where(and(...conditions))
    .orderBy(desc(objects.updatedAt))
    .limit(25);

  return {
    worker: {
      id: context.worker.id,
      role: context.worker.role,
      tenantSlug: context.worker.tenantSlug,
    },
    briefs: rows.map((row) => ({
      id: row.id,
      name: row.name,
      state: row.state,
      updatedAt: row.updatedAt.toISOString(),
      data: row.data,
    })),
  };
}

export async function listOwnerDecisions(input: {
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  state?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const context = await loadOwnerContext({
    db,
    selector: { role: ownerWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const conditions = [eq(decisions.tenantId, context.worker.tenantId), eq(decisions.kind, "owner_decision")];
  const state = stringValue(input.state);

  if (state) {
    conditions.push(eq(decisions.state, state));
  }

  const rows = await db
    .select({
      id: decisions.id,
      state: decisions.state,
      decision: decisions.decision,
      rationale: decisions.rationale,
      data: decisions.data,
      createdAt: decisions.createdAt,
    })
    .from(decisions)
    .where(and(...conditions))
    .orderBy(desc(decisions.createdAt))
    .limit(25);

  return {
    worker: {
      id: context.worker.id,
      role: context.worker.role,
      tenantSlug: context.worker.tenantSlug,
    },
    decisions: rows.map((row) => ({
      id: row.id,
      state: row.state,
      decision: row.decision,
      rationale: row.rationale,
      data: row.data,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function generateOwnerBrief(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config: JsonObject;
  db?: Database;
}): Promise<OwnerBriefRunResult> {
  const db = input.db ?? defaultDb;
  const window = parseWindow(input.config);
  const scopes = parseBriefScopes(input.config);
  assertNoExternalExecution(input.config);

  const context = await loadOwnerContext({
    db,
    selector: { role: ownerWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const legacyRun = await existingRun(db, context, input.idempotencyKey);

  if (legacyRun) {
    return replayedBriefResult(legacyRun, await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }));
  }

  const readModel = await buildReadModel(db, context.worker.tenantId, window);
  const brief = buildBrief(readModel, scopes);
  const requestHash = hashJson({
    schemaVersion: "worker.owner_chief_of_staff.brief_generate.request.v1",
    idempotencyKey: input.idempotencyKey,
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    operatorUserId: context.operator.userId,
    config: input.config,
    window: readModel.window,
    scopes,
  });
  const inputHash = hashJson({
    schemaVersion: "worker.owner_chief_of_staff.brief_generate.input.v1",
    requestHash,
  });
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: ownerWorkerRole,
    },
    command: "brief.generate",
    mode: "read_only",
    capabilityKey: "owner_brief.generate",
    budgetAccountId: context.budgetAccount.id,
    units: ownerRunUnits,
    input: {
      requestHash,
      inputHash,
      config: input.config,
      window: readModel.window,
      scopes,
    },
    policy: {
      externalExecution: "blocked",
      externalSend: "blocked",
      sensitiveReveal: "approval_required",
    },
    evidence: {
      command: "brief.generate",
      required: ["task_rollup", "kpi_snapshot", "owner_brief_source_snapshot"],
      externalExecution: "blocked",
      externalSend: false,
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = stringValue(coreBudget.reservationId);
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${coreWorkerRunSource}:brief.generate:${input.idempotencyKey}`}))`,
    );

    const [run] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new PlatformUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Owner worker run.",
        409,
      );
    }

    const runData = objectValue(run.data);
    const existingInput = objectValue(runData.input);
    const existingRequest = objectValue(existingInput.request);
    const existingRequestHash = stringValue(existingRequest.requestHash) ?? stringValue(existingInput.requestHash);
    const existingInputHash = stringValue(existingRequest.inputHash) ?? stringValue(existingInput.inputHash);

    if (
      stringValue(existingInput.command) !== "brief.generate" ||
      run.mode !== "read_only" ||
      (existingRequestHash && existingRequestHash !== requestHash) ||
      (!existingRequestHash && existingInputHash && existingInputHash !== inputHash)
    ) {
      throw new PlatformUnavailableError(
        "worker_idempotency_conflict",
        "This idempotency key was already used with different owner worker input.",
        409,
      );
    }

    const existingOutput = outputData(runData);

    if (
      stringValue(existingOutput.command) === "brief.generate" ||
      (run.state !== "running" && stringValue(runData.command) === "brief.generate")
    ) {
      return {
        created: false as const,
        run,
      };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, dailyBriefWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "owner_workflow_missing",
        "Daily owner brief workflow definition is not seeded.",
        409,
      );
    }

    const externalId = `owner-brief:${input.idempotencyKey}`;
    const [existingBriefObject] = await tx
      .select()
      .from(objects)
      .where(
        and(
          eq(objects.tenantId, context.worker.tenantId),
          eq(objects.source, ownerSource),
          eq(objects.externalId, externalId),
        ),
      )
      .limit(1);
    const objectData = {
      ...brief,
      workerId: context.worker.id,
      idempotencyKey: input.idempotencyKey,
    };
    const [briefObject] = existingBriefObject
      ? await tx
          .update(objects)
          .set({
            name: "Daily owner brief",
            state: "review_ready",
            data: objectData,
            updatedAt: now,
          })
          .where(eq(objects.id, existingBriefObject.id))
          .returning()
      : await tx
          .insert(objects)
          .values({
            tenantId: context.worker.tenantId,
            type: "owner_brief",
            name: "Daily owner brief",
            state: "review_ready",
            source: ownerSource,
            externalId,
            data: objectData,
            createdByWorkerId: context.worker.id,
            effectiveAt: window.to,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    const [nextVersion] = await tx
      .select({
        value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
      })
      .from(objectVersions)
      .where(eq(objectVersions.objectId, briefObject.id));
    const [version] = await tx
      .insert(objectVersions)
      .values({
        tenantId: context.worker.tenantId,
        objectId: briefObject.id,
        version: Number(nextVersion?.value ?? 1),
        data: objectData,
        changedByType: "worker",
        changedById: context.worker.id,
        reason: "Owner brief generated from tenant-scoped Core source refs.",
        createdAt: now,
      })
      .returning({ id: objectVersions.id });
    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: briefObject.id,
        workerId: context.worker.id,
        state: "review_ready",
        idempotencyKey: input.idempotencyKey,
        data: {
          command: "brief.generate",
          scopes,
          window: readModel.window,
          riskFlags: brief.riskFlags,
        },
        blockers: {
          open: brief.riskFlags,
        },
        metrics: readModel.counts,
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });
    const stepValues = [
      ["source_review", "draft", "source_review"],
      ["synthesis", "source_review", "synthesis"],
      ["review_ready", "synthesis", "review_ready"],
    ].map(([name, fromState, toState], index) => ({
      tenantId: context.worker.tenantId,
      definitionId: definition.id,
      workflowRunId: workflowRun.id,
      objectId: briefObject.id,
      workerId: context.worker.id,
      kind: "transition",
      name,
      state: "done" as const,
      priority: brief.riskFlags.length > 0 ? ("high" as const) : ("normal" as const),
      risk: brief.riskFlags.length > 0 ? ("medium" as const) : ("low" as const),
      fromState,
      toState,
      idempotencyKey: `${input.idempotencyKey}:workflow_step:${index + 1}`,
      input: { window: readModel.window, scopes },
      output: { sourceCounts: readModel.counts, riskFlags: brief.riskFlags },
      startedAt: now,
      completedAt: now,
      createdAt: now,
      updatedAt: now,
    }));
    const workflowStepRows = await tx
      .insert(workflowSteps)
      .values(stepValues)
      .returning({ id: workflowSteps.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.owner_chief_of_staff.brief.generated",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: briefObject.id,
        idempotencyKey: `${input.idempotencyKey}:brief_generated`,
        data: {
          workerRunId: run.id,
          objectId: briefObject.id,
          workflowRunId: workflowRun.id,
          workflowStepIds: workflowStepRows.map((step) => step.id),
          sourceCounts: readModel.counts,
          riskFlags: brief.riskFlags,
          externalExecution: "blocked",
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });
    const [sourceSnapshot] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "snapshot",
        name: "Owner brief source snapshot",
        objectId: briefObject.id,
        eventId: event.id,
        actorType: "worker",
        actorId: context.worker.id,
        hash: hashJson(readModel),
        data: {
          readModel,
          sourceRefs: brief.sourceRefs,
          externalExecution: "blocked",
          externalSend: false,
        },
        redaction: objectValue(brief.redaction),
        createdAt: now,
      })
      .returning({ id: evidence.id });
    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: briefObject.id,
        workflowRunId: workflowRun.id,
        kind: "owner_brief",
        name: "Daily owner brief",
        state: "review_ready",
        sensitivity: "medium",
        hash: hashJson(brief),
        data: brief,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        objectId: briefObject.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        kind: "owner_brief_packet",
        name: "Owner brief evidence packet",
        state: "review_ready",
        sensitivity: "medium",
        evidenceIds: { ids: [sourceSnapshot.id] },
        documentIds: { ids: [document.id] },
        data: {
          ...brief,
          budgetReservationId: coreReservationId ?? null,
          budgetUsageEventId: null,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
        },
        hash: hashJson({ brief, sourceSnapshotId: sourceSnapshot.id }),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });
    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        workerRunId: run.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        objectId: briefObject.id,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.operator.userId,
        kind: "owner_brief_approval",
        state: "pending",
        priority: brief.riskFlags.length > 0 ? "high" : "normal",
        risk: brief.riskFlags.length > 0 ? "medium" : "low",
        title: "Review daily owner brief",
        summary:
          brief.riskFlags.length > 0
            ? `Owner Chief-of-Staff prepared a brief with risk flags: ${brief.riskFlags.join(", ")}.`
            : "Owner Chief-of-Staff prepared a review-ready daily brief.",
        requestedAction: {
          action: "publish_owner_brief",
          objectId: briefObject.id,
          documentId: document.id,
          packetId: packet.id,
          riskFlags: brief.riskFlags,
          externalExecution: "blocked",
          externalSend: false,
        },
        evidence: {
          eventId: event.id,
          objectId: briefObject.id,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
          documentId: document.id,
          packetId: packet.id,
          workflowRunId: workflowRun.id,
        },
        policy: {
          approvalRequiredFor: ["publish_owner_brief", "route_owner_task", "sensitive_reveal"],
          externalExecution: "blocked",
          sensitiveDataReveal: "blocked",
        },
        data: {
          workerRunId: run.id,
          workflowRunId: workflowRun.id,
          objectId: briefObject.id,
          documentId: document.id,
          packetId: packet.id,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
          sourceCounts: readModel.counts,
          riskFlags: brief.riskFlags,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });
    const [approvalAudit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "owner_brief.approval_requested",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "approval_request",
        targetId: approval.id,
        workerRunId: run.id,
        approvalRequestId: approval.id,
        eventId: event.id,
        objectId: briefObject.id,
        risk: brief.riskFlags.length > 0 ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:owner_brief_approval_requested`,
        data: {
          reviewerUserId: context.operator.userId,
          documentId: document.id,
          packetId: packet.id,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });
    const [approvalEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "approval",
        name: "Owner brief approval requested",
        objectId: briefObject.id,
        eventId: event.id,
        actorType: "worker",
        actorId: context.worker.id,
        hash: hashJson({ approvalRequestId: approval.id, packetId: packet.id, action: "publish_owner_brief" }),
        data: {
          approvalRequestId: approval.id,
          auditEventId: approvalAudit.id,
          objectId: briefObject.id,
          documentId: document.id,
          packetId: packet.id,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          externalSend: false,
        },
        redaction: objectValue(brief.redaction),
        createdAt: now,
      })
      .returning({ id: evidence.id });

    await tx
      .update(approvalRequests)
      .set({
        evidence: {
          eventId: event.id,
          objectId: briefObject.id,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
          requestEvidenceId: approvalEvidence.id,
          auditEventId: approvalAudit.id,
          documentId: document.id,
          packetId: packet.id,
          workflowRunId: workflowRun.id,
        },
        updatedAt: now,
      })
      .where(eq(approvalRequests.id, approval.id));
    const decisionValues = [
      {
        decision: brief.riskFlags.length > 0 ? "owner_review_required" : "brief_ready_for_review",
        rationale:
          brief.riskFlags.length > 0
            ? `Risk flags require owner attention: ${brief.riskFlags.join(", ")}.`
            : "Brief contains no high-risk flags and is ready for owner review.",
        data: {
          objectId: briefObject.id,
          packetId: packet.id,
          riskFlags: brief.riskFlags,
          recommendation: "review_owner_brief",
          externalExecution: "blocked",
        },
      },
    ];
    const decisionRows = await tx
      .insert(decisions)
      .values(
        decisionValues.map((decision) => ({
          tenantId: context.worker.tenantId,
          eventId: event.id,
          workflowRunId: workflowRun.id,
          actorType: "worker" as const,
          actorId: context.worker.id,
          kind: "owner_decision",
          state: "proposed",
          decision: decision.decision,
          rationale: decision.rationale,
          data: decision.data,
          createdAt: now,
        })),
      )
      .returning({ id: decisions.id });

    const publishView = async (key: string, name: string, purpose: string, data: JsonObject) => {
      const values = {
        key,
        version: "1.0.0",
        name,
        purpose,
        surface: "web",
        objectType: key === "owner.decision.queue" ? "decision" : "owner_brief",
        contract: {
          sections: ["summary", "evidence", "actions"],
          emptyStates: ["no_sources", "source_partial", "stale"],
        },
        actions: {
          decisionSurface: "/approval",
          decisionCommand: "approval.decide",
          valid: ["approved", "revision_requested", "rejected"],
          postDecisionSurface: "/worker",
          postDecisionCommand: "continue",
          externalExecution: "blocked",
        },
        data,
        mask: brief.redaction,
        active: true,
        updatedAt: now,
      };
      const [existingView] = await tx
        .select()
        .from(uiContracts)
        .where(
          and(
            eq(uiContracts.tenantId, context.worker.tenantId),
            eq(uiContracts.key, key),
            eq(uiContracts.version, "1.0.0"),
          ),
        )
        .limit(1);
      const [view] = existingView
        ? await tx.update(uiContracts).set(values).where(eq(uiContracts.id, existingView.id)).returning()
        : await tx
            .insert(uiContracts)
            .values({
              tenantId: context.worker.tenantId,
              ...values,
              createdAt: now,
            })
            .returning();

      return view.id;
    };
    const viewIds = [
      await publishView("owner.brief.review", "Owner brief review", "Review owner brief sources and risk flags.", {
        approvalRequestId: approval.id,
        objectId: briefObject.id,
        packetId: packet.id,
        documentId: document.id,
      }),
      await publishView("owner.decision.queue", "Owner decision queue", "Review proposed owner decisions.", {
        decisionIds: decisionRows.map((decision) => decision.id),
        sourceObjectId: briefObject.id,
      }),
      await publishView("owner.anomaly.review", "Owner anomaly review", "Review anomaly and source-health signals.", {
        sourceObjectId: briefObject.id,
        riskFlags: brief.riskFlags,
      }),
    ];
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "owner_brief.generated",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "owner_brief",
        targetId: briefObject.id,
        workerRunId: run.id,
        eventId: event.id,
        objectId: briefObject.id,
        risk: brief.riskFlags.length > 0 ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:owner_brief_generated`,
        data: {
          packetId: packet.id,
          documentId: document.id,
          evidenceId: sourceSnapshot.id,
          approvalRequestId: approval.id,
          approvalEvidenceId: approvalEvidence.id,
          approvalAuditEventId: approvalAudit.id,
          decisionIds: decisionRows.map((decision) => decision.id),
          viewIds,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });

    const output = {
      ...brief,
      command: "brief.generate",
      objectId: briefObject.id,
      objectVersionId: version.id,
      evidenceId: sourceSnapshot.id,
      documentId: document.id,
      packetId: packet.id,
      approvalRequestId: approval.id,
      auditEventId: audit.id,
      reservationId: coreReservationId ?? null,
      usageEventId: null,
      workflowRunId: workflowRun.id,
      workflowStepIds: workflowStepRows.map((step) => step.id),
      decisionIds: decisionRows.map((decision) => decision.id),
      viewIds,
    };

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        data: {
          ...runData,
          businessEventId: event.id,
          eventId: event.id,
          command: "brief.generate",
          output,
          objectId: briefObject.id,
          objectVersionId: version.id,
          evidenceId: sourceSnapshot.id,
          documentId: document.id,
          packetId: packet.id,
          approvalRequestId: approval.id,
          approvalEvidenceId: approvalEvidence.id,
          approvalAuditEventId: approvalAudit.id,
          auditEventId: audit.id,
          reservationId: coreReservationId ?? null,
          usageEventId: null,
          workflowRunId: workflowRun.id,
          workflowStepIds: workflowStepRows.map((step) => step.id),
          decisionIds: decisionRows.map((decision) => decision.id),
          viewIds,
          pendingCompletion: {
            output,
          },
          externalExecution: "blocked",
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, run.id));

    return {
      created: true as const,
      runId: run.id,
      eventId: event.id,
      objectId: briefObject.id,
      objectVersionId: version.id,
      evidenceId: sourceSnapshot.id,
      documentId: document.id,
      packetId: packet.id,
      approvalRequestId: approval.id,
      auditEventId: audit.id,
      reservationId: coreReservationId ?? null,
      usageEventId: null,
      workflowRunId: workflowRun.id,
      workflowStepIds: workflowStepRows.map((step) => step.id),
      decisionIds: decisionRows.map((decision) => decision.id),
      viewIds,
      output,
    };
  });

  if (!result.created) {
    return replayedBriefResult(result.run, await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }));
  }

  const completion = await completeCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: ownerWorkerRole,
    },
    workerRunId: result.runId,
    state: "done",
    reason: "Owner Chief-of-Staff generated a tenant-scoped brief with external execution blocked.",
    output: result.output,
    costUsd: 0,
    evidence: {
      command: "brief.generate",
      eventId: result.eventId,
      auditEventId: result.auditEventId,
      evidenceId: result.evidenceId,
      documentId: result.documentId,
      packetId: result.packetId,
      approvalRequestId: result.approvalRequestId,
      externalExecution: "blocked",
      externalSend: false,
    },
    db,
  });
  const completionBudget = objectValue(completion.budget);
  const settledReservationId = stringValue(completionBudget.reservationId) ?? result.reservationId;
  const settledUsageEventId = stringValue(completionBudget.usageEventId) ?? result.usageEventId;
  const settledOutput = {
    ...result.output,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
  } satisfies JsonObject;
  const [completedRun] = await db
    .select({ data: workerRuns.data })
    .from(workerRuns)
    .where(eq(workerRuns.id, result.runId))
    .limit(1);

  await db
    .update(workerRuns)
    .set({
      data: {
        ...objectValue(completedRun?.data),
        output: settledOutput,
        reservationId: settledReservationId,
        usageEventId: settledUsageEventId,
      },
      updatedAt: new Date(),
    })
    .where(eq(workerRuns.id, result.runId));
  const snapshot = await getOwnerWorkerSnapshot(db, {
    role: ownerWorkerRole,
    tenantSlug: context.worker.tenantSlug,
    workerId: context.worker.id,
  });

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.runId,
    eventId: result.eventId,
    objectId: result.objectId,
    objectVersionId: result.objectVersionId,
    evidenceId: result.evidenceId,
    documentId: result.documentId,
    packetId: result.packetId,
    approvalRequestId: result.approvalRequestId,
    auditEventId: result.auditEventId,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    decisionIds: result.decisionIds,
    viewIds: result.viewIds,
    output: settledOutput,
    snapshot,
  };
}

export async function continueOwnerWorker(input: {
  approvalId: string;
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  db?: Database;
}): Promise<OwnerWorkerContinuationResult> {
  const db = input.db ?? defaultDb;
  const approvalId = uuidValue(input.approvalId);

  if (!approvalId) {
    throw new PlatformUnavailableError(
      "invalid_worker_continuation_config",
      "config.approvalId must be a valid approval id.",
      400,
    );
  }

  const context = await loadOwnerContext({
    db,
    selector: { role: ownerWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${ownerSource}:continue:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.workerId, context.worker.id),
          eq(workerRuns.source, ownerSource),
          eq(workerRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      const existingData = objectValue(existingRun.data);

      if (existingRun.mode !== "continuation" || stringValue(existingData.approvalRequestId) !== approvalId) {
        throw new PlatformUnavailableError(
          "worker_continuation_idempotency_conflict",
          "Idempotency key already belongs to a different owner worker operation.",
          409,
        );
      }

      return {
        replayed: true as const,
        run: existingRun,
      };
    }

    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, context.worker.tenantId), eq(approvalRequests.id, approvalId)))
      .limit(1);

    if (!approval) {
      throw new PlatformUnavailableError(
        "worker_continuation_approval_not_found",
        "No owner worker approval request matches this id.",
        404,
      );
    }

    if (approval.kind !== "owner_brief_approval") {
      throw new PlatformUnavailableError(
        "worker_continuation_unsupported_approval",
        "Owner Chief-of-Staff continuation currently supports owner_brief_approval only.",
        400,
      );
    }

    if (!["approved", "revision_requested", "rejected"].includes(approval.state)) {
      throw new PlatformUnavailableError(
        "worker_continuation_unsupported_state",
        "Owner Chief-of-Staff continuation supports approved, revision_requested, and rejected approvals.",
        409,
      );
    }

    if (!approval.workerRunId || !approval.workflowRunId || !approval.objectId) {
      throw new PlatformUnavailableError(
        "worker_continuation_missing_links",
        "Owner brief continuation requires linked worker, workflow, and object records.",
        409,
      );
    }

    const [originalRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, approval.workerRunId),
        ),
      )
      .limit(1);

    if (!originalRun) {
      throw new PlatformUnavailableError(
        "worker_continuation_run_not_found",
        "The approval's original owner worker run is not available.",
        404,
      );
    }

    if (originalRun.workerId !== context.worker.id) {
      throw new PlatformUnavailableError(
        "worker_continuation_worker_mismatch",
        "The selected owner worker does not own this approval continuation.",
        403,
      );
    }

    const [workflow] = await tx
      .select({
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowRuns.definitionId, workflowDefinitions.id))
      .where(
        and(
          eq(workflowRuns.tenantId, context.worker.tenantId),
          eq(workflowRuns.id, approval.workflowRunId),
        ),
      )
      .limit(1);

    if (!workflow || workflow.definition.key !== dailyBriefWorkflowKey) {
      throw new PlatformUnavailableError(
        "worker_continuation_workflow_not_found",
        "The approval's owner brief workflow run is not available.",
        404,
      );
    }

    const approvalDecision = objectValue(approval.decision);
    const approvalEvidence = objectValue(approval.evidence);
    const approvalData = objectValue(approval.data);
    const requestedAction = objectValue(approval.requestedAction);
    const documentId = uuidValue(requestedAction.documentId ?? approvalEvidence.documentId ?? approvalData.documentId);
    const packetId = uuidValue(requestedAction.packetId ?? approvalEvidence.packetId ?? approvalData.packetId);
    const action = approval.state as "approved" | "revision_requested" | "rejected";
    const status =
      action === "approved"
        ? "owner_brief_published"
        : action === "revision_requested"
          ? "owner_brief_revision_requested"
          : "owner_brief_rejected";
    const objectState = action === "approved" ? "published" : action === "revision_requested" ? "draft" : "stale";
    const documentState =
      action === "approved" ? "published" : action === "revision_requested" ? "revision_requested" : "stale";
    const workflowState = action === "approved" ? "published" : workflow.run.state;
    const blockers: JsonObject =
      action === "approved"
        ? { open: [] }
        : {
            open: [action],
            approvalRequestId: approval.id,
          };

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        budgetAccountId: context.budgetAccount.id,
        source: ownerSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "continuation",
        data: {
          input: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workflowRunId: workflow.run.id,
            action,
            note: stringValue(approvalDecision.note) ?? "",
            operator: {
              userId: context.operator.userId,
              email: context.operator.email,
            },
          },
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.owner_chief_of_staff.brief.continued",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: approval.objectId,
        idempotencyKey: `${input.idempotencyKey}:owner_brief_continued`,
        data: {
          status,
          action,
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          objectId: approval.objectId,
          documentId: documentId ?? null,
          packetId: packetId ?? null,
          externalExecution: "blocked",
          externalSend: false,
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    const [taskRow] =
      action === "revision_requested"
        ? await tx
            .insert(tasks)
            .values({
              tenantId: context.worker.tenantId,
              title: "Revise owner brief",
              state: "active",
              priority: approval.priority,
              ownerType: "worker",
              ownerId: context.worker.id,
              ownerRef: `worker:${context.worker.id}`,
              triggerEventId: event.id,
              evidence: {
                required: ["owner_brief_revision_note", "source_refs"],
              },
              outcome: {
                status,
                approvalRequestId: approval.id,
                originalWorkerRunId: originalRun.id,
                workflowRunId: workflow.run.id,
                externalExecution: "blocked",
              },
              createdAt: now,
              updatedAt: now,
            })
            .returning({ id: tasks.id })
        : [null];

    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "approval",
        name: "Owner brief continuation",
        objectId: approval.objectId,
        taskId: taskRow?.id,
        eventId: event.id,
        actorType: "worker",
        actorId: context.worker.id,
        hash: hashJson({
          approvalRequestId: approval.id,
          action,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
        }),
        data: {
          status,
          action,
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          objectId: approval.objectId,
          documentId: documentId ?? null,
          packetId: packetId ?? null,
          taskId: taskRow?.id ?? null,
          approvalDecision,
          externalExecution: "blocked",
          externalSend: false,
        },
        redaction: {
          sensitiveFields: "redacted_by_default",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });
    const [workflowStep] = await tx
      .insert(workflowSteps)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: workflow.definition.id,
        workflowRunId: workflow.run.id,
        eventId: event.id,
        approvalRequestId: approval.id,
        taskId: taskRow?.id,
        objectId: approval.objectId,
        workerId: context.worker.id,
        kind: "approval_continuation",
        name: `${workflow.definition.key}:continue:${action}`,
        state: "done",
        priority: approval.priority,
        risk: approval.risk,
        fromState: workflow.run.state,
        toState: workflowState,
        attempt: 1,
        maxAttempts: 1,
        leaseOwner: `worker:${context.worker.id}`,
        leasedUntil: now,
        idempotencyKey: `${input.idempotencyKey}:workflow_step`,
        input: {
          approvalRequestId: approval.id,
          action,
          originalWorkerRunId: originalRun.id,
        },
        output: {
          status,
          evidenceId: proof.id,
          taskId: taskRow?.id ?? null,
          externalExecution: "blocked",
        },
        startedAt: now,
        completedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowSteps.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "owner_brief.continued",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "owner_brief",
        targetId: approval.objectId,
        taskId: taskRow?.id,
        workerRunId: workerRun.id,
        approvalRequestId: approval.id,
        eventId: event.id,
        objectId: approval.objectId,
        risk: approval.risk,
        idempotencyKey: `${input.idempotencyKey}:owner_brief_continued`,
        data: {
          status,
          action,
          originalWorkerRunId: originalRun.id,
          evidenceId: proof.id,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          taskId: taskRow?.id ?? null,
          documentId: documentId ?? null,
          packetId: packetId ?? null,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });

    const [briefObjectRef] = await tx
      .select({ data: objects.data })
      .from(objects)
      .where(and(eq(objects.tenantId, context.worker.tenantId), eq(objects.id, approval.objectId)))
      .limit(1);

    await tx
      .update(objects)
      .set({
        state: objectState,
        data: {
          ...objectValue(briefObjectRef?.data),
          lastContinuation: {
            status,
            action,
            approvalRequestId: approval.id,
            workerRunId: workerRun.id,
            evidenceId: proof.id,
            auditEventId: audit.id,
          },
        },
        updatedAt: now,
      })
      .where(eq(objects.id, approval.objectId));

    if (documentId) {
      const [documentRef] = await tx
        .select({ data: documents.data })
        .from(documents)
        .where(and(eq(documents.tenantId, context.worker.tenantId), eq(documents.id, documentId)))
        .limit(1);

      await tx
        .update(documents)
        .set({
          state: documentState,
          data: {
            ...objectValue(documentRef?.data),
            lastContinuation: {
              status,
              action,
              approvalRequestId: approval.id,
              workerRunId: workerRun.id,
              evidenceId: proof.id,
            },
          },
          updatedAt: now,
        })
        .where(and(eq(documents.tenantId, context.worker.tenantId), eq(documents.id, documentId)));
    }

    if (packetId) {
      const [packetRef] = await tx
        .select({ data: evidencePackets.data })
        .from(evidencePackets)
        .where(and(eq(evidencePackets.tenantId, context.worker.tenantId), eq(evidencePackets.id, packetId)))
        .limit(1);

      await tx
        .update(evidencePackets)
        .set({
          state: documentState,
          data: {
            ...objectValue(packetRef?.data),
            lastContinuation: {
              status,
              action,
              approvalRequestId: approval.id,
              workerRunId: workerRun.id,
              evidenceId: proof.id,
            },
          },
          updatedAt: now,
        })
        .where(and(eq(evidencePackets.tenantId, context.worker.tenantId), eq(evidencePackets.id, packetId)));
    }

    await tx
      .update(workflowRuns)
      .set({
        state: workflowState,
        blockers,
        data: {
          ...workflow.run.data,
          lastOwnerContinuation: {
            status,
            action,
            approvalRequestId: approval.id,
            workerRunId: workerRun.id,
            evidenceId: proof.id,
            auditEventId: audit.id,
            workflowStepId: workflowStep.id,
            taskId: taskRow?.id ?? null,
          },
        },
        updatedAt: now,
        completedAt: action === "approved" ? now : workflow.run.completedAt,
      })
      .where(eq(workflowRuns.id, workflow.run.id));

    if (action === "approved") {
      await tx
        .update(decisions)
        .set({
          state: "approved",
        })
        .where(and(eq(decisions.tenantId, context.worker.tenantId), eq(decisions.workflowRunId, workflow.run.id)));
    }

    const output = {
      status,
      action,
      approvalRequestId: approval.id,
      originalWorkerRunId: originalRun.id,
      objectId: approval.objectId,
      documentId: documentId ?? null,
      packetId: packetId ?? null,
      eventId: event.id,
      evidenceId: proof.id,
      auditEventId: audit.id,
      workflowRunId: workflow.run.id,
      workflowStepId: workflowStep.id,
      taskId: taskRow?.id ?? null,
      externalExecution: "blocked",
      externalSend: false,
    };

    await tx
      .update(workerRuns)
      .set({
        state: "done",
        eventId: event.id,
        taskId: taskRow?.id,
        data: {
          command: "continue",
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          eventId: event.id,
          evidenceId: proof.id,
          auditEventId: audit.id,
          objectId: approval.objectId,
          documentId: documentId ?? null,
          packetId: packetId ?? null,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          taskId: taskRow?.id ?? null,
          output,
          externalExecution: "blocked",
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, workerRun.id));

    const originalRunData = objectValue(originalRun.data);
    await tx
      .update(workerRuns)
      .set({
        data: {
          ...originalRunData,
          output: {
            ...objectValue(originalRunData.output),
            lastOwnerContinuation: output,
            externalExecution: "blocked",
            externalSend: false,
          },
          lastOwnerContinuation: output,
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, originalRun.id));

    return {
      replayed: false as const,
      workerRunId: workerRun.id,
      originalWorkerRunId: originalRun.id,
      eventId: event.id,
      approvalRequestId: approval.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      objectId: approval.objectId,
      documentId: documentId ?? null,
      packetId: packetId ?? null,
      workflowRunId: workflow.run.id,
      workflowStepId: workflowStep.id,
      taskId: taskRow?.id ?? null,
      output,
    };
  });

  const snapshot = await getOwnerWorkerSnapshot(db, {
    role: ownerWorkerRole,
    tenantSlug: context.worker.tenantSlug,
    workerId: context.worker.id,
  });

  if (result.replayed) {
    return replayedContinuationResult(result.run, snapshot);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    originalWorkerRunId: result.originalWorkerRunId,
    eventId: result.eventId,
    approvalRequestId: result.approvalRequestId,
    auditEventId: result.auditEventId,
    evidenceId: result.evidenceId,
    objectId: result.objectId,
    documentId: result.documentId,
    packetId: result.packetId,
    workflowRunId: result.workflowRunId,
    workflowStepId: result.workflowStepId,
    taskId: result.taskId,
    output: result.output,
    snapshot,
  };
}

export async function prepareOwnerDecisionQueue(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config: JsonObject;
  db?: Database;
}): Promise<OwnerDecisionQueueResult> {
  const db = input.db ?? defaultDb;
  const window = parseWindow(input.config);
  assertNoExternalExecution(input.config);
  const context = await loadOwnerContext({
    db,
    selector: { role: ownerWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const existing = await existingRun(db, context, input.idempotencyKey);

  if (existing) {
    return replayedDecisionQueueResult(existing, await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }));
  }

  const readModel = await buildReadModel(db, context.worker.tenantId, window);
  const now = new Date();
  const proposals = [
    ...(readModel.approvals.length > 0
      ? [
          {
            decision: "review_pending_approvals",
            rationale: `${readModel.approvals.length} approval requests need owner decision.`,
            priority: "high",
            sourceIds: readModel.approvals.map((approval) => approval.id),
          },
        ]
      : []),
    ...(readModel.tasks.some((task) => task.priority === "urgent" || task.priority === "high")
      ? [
          {
            decision: "clear_high_priority_tasks",
            rationale: "High-priority open tasks should be reviewed before lower-risk work.",
            priority: "high",
            sourceIds: readModel.tasks
              .filter((task) => task.priority === "urgent" || task.priority === "high")
              .map((task) => task.id),
          },
        ]
      : []),
    ...(readModel.obligations.length > 0
      ? [
          {
            decision: "review_open_obligations",
            rationale: `${readModel.obligations.length} compliance or operating obligations remain open.`,
            priority: "normal",
            sourceIds: readModel.obligations.map((item) => item.id),
          },
        ]
      : []),
  ];
  const effectiveProposals =
    proposals.length > 0
      ? proposals
      : [
          {
            decision: "no_owner_decision_needed",
            rationale: "No urgent owner decisions were found in the selected window.",
            priority: "low",
            sourceIds: [],
          },
        ];

  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        budgetAccountId: context.budgetAccount.id,
        source: ownerSource,
        idempotencyKey: input.idempotencyKey,
        state: "done",
        mode: "read_only",
        data: {
          command: "decision_queue.prepare",
          externalExecution: "blocked",
        },
        startedAt: now,
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.owner_chief_of_staff.decision_queue.prepared",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        idempotencyKey: `${input.idempotencyKey}:decision_queue_prepared`,
        data: {
          workerRunId: run.id,
          proposalCount: effectiveProposals.length,
          window: readModel.window,
          externalExecution: "blocked",
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });
    const decisionRows = await tx
      .insert(decisions)
      .values(
        effectiveProposals.map((proposal) => ({
          tenantId: context.worker.tenantId,
          eventId: event.id,
          actorType: "worker" as const,
          actorId: context.worker.id,
          kind: "owner_decision",
          state: proposal.decision === "no_owner_decision_needed" ? "deferred" : "proposed",
          decision: proposal.decision,
          rationale: proposal.rationale,
          data: {
            priority: proposal.priority,
            sourceIds: proposal.sourceIds,
            externalExecution: "blocked",
          },
          createdAt: now,
        })),
      )
      .returning({ id: decisions.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Owner decision queue trace",
        eventId: event.id,
        actorType: "worker",
        actorId: context.worker.id,
        hash: hashJson({ readModel, proposals: effectiveProposals }),
        data: {
          readModel,
          proposals: effectiveProposals,
          decisionIds: decisionRows.map((decision) => decision.id),
          externalExecution: "blocked",
        },
        redaction: {
          sensitiveFields: "redacted_by_default",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });
    const [view] = await tx
      .insert(uiContracts)
      .values({
        tenantId: context.worker.tenantId,
        key: "owner.decision.queue",
        version: "1.0.0",
        name: "Owner decision queue",
        purpose: "Review proposed owner decisions.",
        surface: "web",
        objectType: "decision",
        contract: {
          sections: ["priority", "rationale", "source_refs"],
          emptyStates: ["empty", "blocked_by_missing_evidence"],
        },
        actions: {
          valid: ["approve", "reject", "defer", "assign"],
          externalExecution: "blocked",
        },
        data: {
          decisionIds: decisionRows.map((decision) => decision.id),
          evidenceId: proof.id,
        },
        mask: {
          sensitive: "redacted_by_default",
        },
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [uiContracts.tenantId, uiContracts.key, uiContracts.version],
        set: {
          data: {
            decisionIds: decisionRows.map((decision) => decision.id),
            evidenceId: proof.id,
          },
          updatedAt: now,
          active: true,
        },
      })
      .returning({ id: uiContracts.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "owner_decision_queue.prepared",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "decision_queue",
        workerRunId: run.id,
        eventId: event.id,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:decision_queue_prepared`,
        data: {
          decisionIds: decisionRows.map((decision) => decision.id),
          evidenceId: proof.id,
          viewId: view.id,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });
    const output = {
      window: readModel.window,
      proposalCount: effectiveProposals.length,
      proposals: effectiveProposals,
      decisionIds: decisionRows.map((decision) => decision.id),
      evidenceId: proof.id,
      viewIds: [view.id],
      externalExecution: "blocked",
      externalSend: false,
    };

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        data: {
          command: "decision_queue.prepare",
          output,
          evidenceId: proof.id,
          auditEventId: audit.id,
          decisionIds: decisionRows.map((decision) => decision.id),
          viewIds: [view.id],
          externalExecution: "blocked",
        },
      })
      .where(eq(workerRuns.id, run.id));

    return {
      runId: run.id,
      eventId: event.id,
      evidenceId: proof.id,
      auditEventId: audit.id,
      decisionIds: decisionRows.map((decision) => decision.id),
      viewIds: [view.id],
      output,
    };
  });

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.runId,
    eventId: result.eventId,
    evidenceId: result.evidenceId,
    auditEventId: result.auditEventId,
    decisionIds: result.decisionIds,
    viewIds: result.viewIds,
    output: result.output,
    snapshot: await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

function metricValue(key: string, readModel: OwnerReadModel) {
  const counts = objectValue(readModel.counts);

  if (key === "pending_approvals") {
    return { value: numberValue(counts.approvals), target: 0 };
  }

  if (key === "high_priority_tasks") {
    return { value: numberValue(counts.highPriorityTasks), target: 0 };
  }

  if (key === "open_obligations") {
    return { value: numberValue(counts.obligations), target: 0 };
  }

  if (key === "budget_held_units") {
    return { value: readModel.budget.heldUnits, target: 0 };
  }

  return { value: 0, target: 0 };
}

export async function triageOwnerAnomalies(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config: JsonObject;
  db?: Database;
}): Promise<OwnerAnomalyTriageResult> {
  const db = input.db ?? defaultDb;
  const window = parseWindow(input.config);
  const metricKeys = stringList(input.config.metricKeys);

  if (metricKeys.length === 0) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.metricKeys must include at least one metric key.",
      400,
    );
  }

  assertNoExternalExecution(input.config);
  const context = await loadOwnerContext({
    db,
    selector: { role: ownerWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const existing = await existingRun(db, context, input.idempotencyKey);

  if (existing) {
    return replayedAnomalyResult(existing, await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }));
  }

  const readModel = await buildReadModel(db, context.worker.tenantId, window);
  const metrics = metricKeys.map((key) => {
    const value = metricValue(key, readModel);
    const variance = value.value - value.target;

    return {
      key,
      value: value.value,
      target: value.target,
      variance,
      state: variance > 0 ? "anomaly" : "normal",
    };
  });
  const anomalyMetrics = metrics.filter((metric) => metric.state === "anomaly");
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    const [run] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        budgetAccountId: context.budgetAccount.id,
        source: ownerSource,
        idempotencyKey: input.idempotencyKey,
        state: "done",
        mode: "read_only",
        data: {
          command: "anomaly.triage",
          externalExecution: "blocked",
        },
        startedAt: now,
        endedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.owner_chief_of_staff.anomaly.triaged",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        idempotencyKey: `${input.idempotencyKey}:anomaly_triaged`,
        data: {
          workerRunId: run.id,
          metricKeys,
          anomalyCount: anomalyMetrics.length,
          externalExecution: "blocked",
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });
    const metricRows = [];

    for (const metric of metrics) {
      const externalId = `owner-metric:${input.idempotencyKey}:${metric.key}`;
      const [metricObject] = await tx
        .insert(objects)
        .values({
          tenantId: context.worker.tenantId,
          type: "metric",
          name: metric.key,
          state: metric.state,
          source: ownerSource,
          externalId,
          data: {
            ...metric,
            period: readModel.window,
            sourceRefs: {
              eventIds: readModel.recentEvents.map((item) => item.id),
            },
            externalExecution: "blocked",
          },
          createdByWorkerId: context.worker.id,
          effectiveAt: window.to,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: objects.id });
      const [version] = await tx
        .insert(objectVersions)
        .values({
          tenantId: context.worker.tenantId,
          objectId: metricObject.id,
          version: 1,
          data: {
            ...metric,
            period: readModel.window,
          },
          changedByType: "worker",
          changedById: context.worker.id,
          reason: "Owner anomaly triage metric snapshot.",
          createdAt: now,
        })
        .returning({ id: objectVersions.id });
      metricRows.push({ id: metricObject.id, versionId: version.id, ...metric });
    }

    const taskRow =
      anomalyMetrics.length > 0
        ? (
            await tx
              .insert(tasks)
              .values({
                tenantId: context.worker.tenantId,
                title: "Review owner anomaly triage",
                state: "waiting",
                priority: "high",
                ownerType: "worker",
                ownerId: context.worker.id,
                ownerRef: `worker:${context.worker.id}`,
                triggerEventId: event.id,
                evidence: {
                  required: ["owner_anomaly_trace"],
                },
                outcome: {
                  metricKeys,
                  anomalyCount: anomalyMetrics.length,
                  externalExecution: "blocked",
                },
                createdAt: now,
                updatedAt: now,
              })
              .returning({ id: tasks.id })
          )[0]
        : null;
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Owner anomaly triage trace",
        taskId: taskRow?.id,
        eventId: event.id,
        actorType: "worker",
        actorId: context.worker.id,
        hash: hashJson({ readModel, metrics }),
        data: {
          metrics,
          metricObjectIds: metricRows.map((metric) => metric.id),
          taskId: taskRow?.id ?? null,
          externalExecution: "blocked",
        },
        redaction: {
          sourceContent: "quoted_only",
          sensitiveFields: "redacted_by_default",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });
    const [view] = await tx
      .insert(uiContracts)
      .values({
        tenantId: context.worker.tenantId,
        key: "owner.anomaly.review",
        version: "1.0.0",
        name: "Owner anomaly review",
        purpose: "Review anomaly and source-health signals.",
        surface: "web",
        objectType: "metric",
        taskState: taskRow ? "waiting" : undefined,
        contract: {
          sections: ["metrics", "source_refs", "routing"],
          emptyStates: ["no_anomalies", "source_unavailable"],
        },
        actions: {
          valid: ["acknowledge", "route_to_worker", "snooze"],
          externalExecution: "blocked",
        },
        data: {
          metricObjectIds: metricRows.map((metric) => metric.id),
          evidenceId: proof.id,
          taskId: taskRow?.id ?? null,
        },
        mask: {
          sensitive: "redacted_by_default",
        },
        active: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [uiContracts.tenantId, uiContracts.key, uiContracts.version],
        set: {
          data: {
            metricObjectIds: metricRows.map((metric) => metric.id),
            evidenceId: proof.id,
            taskId: taskRow?.id ?? null,
          },
          updatedAt: now,
          active: true,
        },
      })
      .returning({ id: uiContracts.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "owner_anomaly.triaged",
        source: ownerSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "metric",
        workerRunId: run.id,
        eventId: event.id,
        taskId: taskRow?.id,
        risk: anomalyMetrics.length > 0 ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:anomaly_triaged`,
        data: {
          metricObjectIds: metricRows.map((metric) => metric.id),
          evidenceId: proof.id,
          viewId: view.id,
          taskId: taskRow?.id ?? null,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });
    const output = {
      window: readModel.window,
      metrics,
      metricObjectIds: metricRows.map((metric) => metric.id),
      taskId: taskRow?.id ?? null,
      evidenceId: proof.id,
      viewIds: [view.id],
      externalExecution: "blocked",
      externalSend: false,
    };

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        taskId: taskRow?.id,
        data: {
          command: "anomaly.triage",
          output,
          evidenceId: proof.id,
          auditEventId: audit.id,
          metricObjectIds: metricRows.map((metric) => metric.id),
          taskId: taskRow?.id ?? null,
          viewIds: [view.id],
          externalExecution: "blocked",
        },
      })
      .where(eq(workerRuns.id, run.id));

    return {
      runId: run.id,
      eventId: event.id,
      evidenceId: proof.id,
      auditEventId: audit.id,
      metricObjectIds: metricRows.map((metric) => metric.id),
      taskId: taskRow?.id ?? null,
      viewIds: [view.id],
      output,
    };
  });

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.runId,
    eventId: result.eventId,
    evidenceId: result.evidenceId,
    auditEventId: result.auditEventId,
    metricObjectIds: result.metricObjectIds,
    taskId: result.taskId,
    viewIds: result.viewIds,
    output: result.output,
    snapshot: await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}
