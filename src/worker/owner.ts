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

const ownerSource = "continuous.owner_worker";
const dailyBriefWorkflowKey = "daily_owner_brief";
const ownerRunUnits = 4000;
const defaultBriefScopes = ["tasks", "approvals", "cash", "capacity", "obligations", "workers"];

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
      "owner_worker_not_found",
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

function replayedBriefResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: OwnerWorkerSnapshot,
): OwnerBriefRunResult {
  const data = objectValue(run.data);
  const output = objectValue(data.output);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    eventId: run.eventId,
    objectId: stringValue(data.objectId) ?? null,
    objectVersionId: stringValue(data.objectVersionId) ?? null,
    evidenceId: stringValue(data.evidenceId) ?? null,
    documentId: stringValue(data.documentId) ?? null,
    packetId: stringValue(data.packetId) ?? null,
    auditEventId: stringValue(data.auditEventId) ?? null,
    reservationId: stringValue(data.reservationId) ?? null,
    usageEventId: stringValue(data.usageEventId) ?? null,
    workflowRunId: stringValue(data.workflowRunId) ?? null,
    workflowStepIds: stringList(data.workflowStepIds),
    decisionIds: stringList(data.decisionIds),
    viewIds: stringList(data.viewIds),
    output,
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
  const existing = await existingRun(db, context, input.idempotencyKey);

  if (existing) {
    return replayedBriefResult(existing, await getOwnerWorkerSnapshot(db, {
      role: ownerWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }));
  }

  const readModel = await buildReadModel(db, context.worker.tenantId, window);
  const brief = buildBrief(readModel, scopes);
  const now = new Date();

  const result = await db.transaction(async (tx) => {
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
    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccount.id,
        units: ownerRunUnits,
        state: "used",
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: budgetReservations.id });
    const [usage] = await tx
      .insert(usageEvents)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccount.id,
        reservationId: reservation.id,
        actorType: "worker",
        actorId: context.worker.id,
        units: ownerRunUnits,
        costUsd: "0.000000",
        data: {
          command: "brief.generate",
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });
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
          command: "brief.generate",
          output: brief,
          objectId: briefObject.id,
          objectVersionId: version.id,
          reservationId: reservation.id,
          usageEventId: usage.id,
          workflowRunId: workflowRun.id,
          workflowStepIds: workflowStepRows.map((step) => step.id),
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
        type: "owner_worker.brief.generated",
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
          budgetUsageEventId: usage.id,
          sourceSnapshotEvidenceId: sourceSnapshot.id,
        },
        hash: hashJson({ brief, sourceSnapshotId: sourceSnapshot.id }),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });
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
          valid: ["approve_brief", "route_task", "request_revision"],
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
          decisionIds: decisionRows.map((decision) => decision.id),
          viewIds,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });

    const output = {
      ...brief,
      objectId: briefObject.id,
      objectVersionId: version.id,
      evidenceId: sourceSnapshot.id,
      documentId: document.id,
      packetId: packet.id,
      auditEventId: audit.id,
      reservationId: reservation.id,
      usageEventId: usage.id,
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
          command: "brief.generate",
          output,
          objectId: briefObject.id,
          objectVersionId: version.id,
          evidenceId: sourceSnapshot.id,
          documentId: document.id,
          packetId: packet.id,
          auditEventId: audit.id,
          reservationId: reservation.id,
          usageEventId: usage.id,
          workflowRunId: workflowRun.id,
          workflowStepIds: workflowStepRows.map((step) => step.id),
          decisionIds: decisionRows.map((decision) => decision.id),
          viewIds,
          externalExecution: "blocked",
        },
      })
      .where(eq(workerRuns.id, run.id));

    return {
      runId: run.id,
      eventId: event.id,
      objectId: briefObject.id,
      objectVersionId: version.id,
      evidenceId: sourceSnapshot.id,
      documentId: document.id,
      packetId: packet.id,
      auditEventId: audit.id,
      reservationId: reservation.id,
      usageEventId: usage.id,
      workflowRunId: workflowRun.id,
      workflowStepIds: workflowStepRows.map((step) => step.id),
      decisionIds: decisionRows.map((decision) => decision.id),
      viewIds,
      output,
    };
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
    auditEventId: result.auditEventId,
    reservationId: result.reservationId,
    usageEventId: result.usageEventId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
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
        type: "owner_worker.decision_queue.prepared",
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
        type: "owner_worker.anomaly.triaged",
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
