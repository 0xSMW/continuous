import { and, asc, eq, lte } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  auditEvents,
  evidence,
  events,
  tasks,
  tenants,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type DatabaseExecutor = Database | Transaction;
type AdapterRunRow = typeof adapterRuns.$inferSelect;
type AdapterActionRow = typeof adapterActions.$inferSelect;
type ReconciliationDecision = "matched" | "retry_scheduled" | "needs_review";

const source = "continuous.adapter_reconciliation";

export type AdapterReconciliationResult = {
  processed: number;
  runs: number;
  actions: number;
  matched: number;
  retryScheduled: number;
  needsReview: number;
  taskIds: string[];
  retryTaskIds: string[];
  reviewTaskIds: string[];
  auditEventIds: string[];
  evidenceIds: string[];
};

export type AdapterRetryExecutionResult = {
  processed: number;
  runs: number;
  actions: number;
  retryRunIds: string[];
  retryActionIds: string[];
  closedRetryTaskIds: string[];
  eventIds: string[];
  auditEventIds: string[];
  evidenceIds: string[];
};

function hasExternalMutation(...values: JsonObject[]) {
  return values.some((value) => value.externalMutation === true || value.externalSend === true);
}

function nextAttemptTime(now: Date, attempt: number) {
  return new Date(now.getTime() + Math.min(attempt, 6) * 5 * 60 * 1000);
}

function decisionFor(row: {
  mode: string;
  state: string;
  attempt: number;
  maxAttempts: number;
  request?: JsonObject;
  receipt?: JsonObject;
  data?: JsonObject;
  error: JsonObject;
}): ReconciliationDecision {
  if (row.state === "failed" && row.attempt < row.maxAttempts) {
    return "retry_scheduled";
  }

  if (
    row.mode !== "dry_run" ||
    row.state === "failed" ||
    hasExternalMutation(row.request ?? {}, row.receipt ?? {}, row.data ?? {}) ||
    Object.keys(row.error).length > 0
  ) {
    return "needs_review";
  }

  return "matched";
}

function incrementedAttempt(decision: ReconciliationDecision, attempt: number) {
  return decision === "retry_scheduled" ? attempt + 1 : attempt;
}

function pendingWhere() {
  return eq(adapterRuns.reconciliationState, "pending");
}

function pendingActionWhere() {
  return eq(adapterActions.reconciliationState, "pending");
}

function scheduledRunRetryWhere(now: Date) {
  return and(
    eq(adapterRuns.mode, "dry_run"),
    eq(adapterRuns.state, "queued"),
    eq(adapterRuns.reconciliationState, "retry_scheduled"),
    lte(adapterRuns.nextAttemptAt, now),
  );
}

function scheduledActionRetryWhere(now: Date) {
  return and(
    eq(adapterActions.mode, "dry_run"),
    eq(adapterActions.state, "queued"),
    eq(adapterActions.reconciliationState, "retry_scheduled"),
    lte(adapterActions.nextAttemptAt, now),
  );
}

async function tenantIdFor(db: Database, tenantSlug?: string) {
  if (!tenantSlug) {
    return undefined;
  }

  const [tenant] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, tenantSlug))
    .limit(1);

  if (!tenant) {
    throw new PlatformUnavailableError("tenant_not_found", "No tenant matches this slug.", 404);
  }

  return tenant.id;
}

async function recordDecision(
  db: DatabaseExecutor,
  input: {
    tenantId: string;
    targetType: "adapter_run" | "adapter_action";
    targetId: string;
    connectionId: string;
    workerRunId?: string | null;
    eventId?: string | null;
    taskId?: string | null;
    capabilityId?: string | null;
    decision: ReconciliationDecision;
    attempt: number;
    maxAttempts: number;
    operation: string;
    receipt: JsonObject;
    error: JsonObject;
    now: Date;
  },
) {
  const data = {
    decision: input.decision,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    operation: input.operation,
    connectionId: input.connectionId,
    workerRunId: input.workerRunId ?? null,
    externalExecution: "blocked",
  };
  const [audit] = await db
    .insert(auditEvents)
    .values({
      tenantId: input.tenantId,
      type: "adapter.reconciled",
      source,
      actorType: "system",
      actorRef: "system:adapter-reconciliation",
      targetType: input.targetType,
      targetId: input.targetId,
      taskId: input.taskId,
      workerRunId: input.workerRunId,
      eventId: input.eventId,
      capabilityId: input.capabilityId,
      risk: input.decision === "needs_review" ? "high" : "medium",
      idempotencyKey: `${input.targetType}:${input.targetId}:${input.decision}:${input.attempt}`,
      data,
    })
    .returning({ id: auditEvents.id });
  const [proof] = await db
    .insert(evidence)
    .values({
      tenantId: input.tenantId,
      kind: input.decision === "matched" ? "receipt" : "trace",
      name: `Adapter reconciliation ${input.decision}`,
      taskId: input.taskId,
      eventId: input.eventId,
      capabilityId: input.capabilityId,
      actorType: "system",
      hash: `${source}:${input.targetType}:${input.targetId}:${input.decision}:${input.now.toISOString()}`,
      data: {
        ...data,
        auditEventId: audit.id,
        receipt: input.receipt,
        error: input.error,
      },
    })
    .returning({ id: evidence.id });

  return { auditEventId: audit.id, evidenceId: proof.id };
}

async function createFollowupTask(
  db: DatabaseExecutor,
  input: {
    tenantId: string;
    targetType: "adapter_run" | "adapter_action";
    targetId: string;
    connectionId: string;
    workerRunId?: string | null;
    sourceEventId?: string | null;
    sourceTaskId?: string | null;
    capabilityId?: string | null;
    decision: Exclude<ReconciliationDecision, "matched">;
    attempt: number;
    maxAttempts: number;
    operation: string;
    nextAttemptAt?: Date | null;
    now: Date;
  },
) {
  const isRetry = input.decision === "retry_scheduled";
  const title = isRetry
    ? `Retry adapter ${input.targetType === "adapter_run" ? "run" : "action"} ${input.operation}`
    : `Review adapter ${input.targetType === "adapter_run" ? "run" : "action"} ${input.operation}`;
  const idempotencyKey = `${input.targetType}:${input.targetId}:${input.decision}:task:${input.attempt}`;
  const [task] = await db
    .insert(tasks)
    .values({
      tenantId: input.tenantId,
      capabilityId: input.capabilityId,
      triggerEventId: input.sourceEventId,
      title,
      state: isRetry ? "waiting" : "blocked",
      priority: isRetry ? "normal" : "high",
      ownerType: "system",
      ownerRef: "system:adapter-reconciliation",
      dueAt: input.nextAttemptAt ?? input.now,
      evidence: {
        required: isRetry ? ["adapter_retry_receipt"] : ["adapter_failure_review"],
        targetType: input.targetType,
        targetId: input.targetId,
        connectionId: input.connectionId,
        workerRunId: input.workerRunId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        sourceEventId: input.sourceEventId ?? null,
      },
      outcome: {
        decision: input.decision,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        operation: input.operation,
        externalExecution: "blocked",
        executable: false,
      },
      kpi: {
        risk: isRetry ? "adapter_retry_pending" : "adapter_review_required",
      },
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: tasks.id });
  const [event] = await db
    .insert(events)
    .values({
      tenantId: input.tenantId,
      type: isRetry ? "adapter.retry_task.created" : "adapter.review_task.created",
      source,
      actorType: "system",
      actorRef: "system:adapter-reconciliation",
      taskId: task.id,
      capabilityId: input.capabilityId,
      connectionId: input.connectionId,
      idempotencyKey: `${idempotencyKey}:event`,
      data: {
        taskId: task.id,
        targetType: input.targetType,
        targetId: input.targetId,
        workerRunId: input.workerRunId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        sourceEventId: input.sourceEventId ?? null,
        decision: input.decision,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        operation: input.operation,
        externalExecution: "blocked",
        executable: false,
      },
      occurredAt: input.now,
    })
    .returning({ id: events.id });
  const [audit] = await db
    .insert(auditEvents)
    .values({
      tenantId: input.tenantId,
      type: "task.created",
      source,
      actorType: "system",
      actorRef: "system:adapter-reconciliation",
      targetType: "task",
      targetId: task.id,
      taskId: task.id,
      workerRunId: input.workerRunId,
      eventId: event.id,
      capabilityId: input.capabilityId,
      risk: isRetry ? "medium" : "high",
      idempotencyKey: `${idempotencyKey}:task_created`,
      data: {
        targetType: input.targetType,
        targetId: input.targetId,
        connectionId: input.connectionId,
        workerRunId: input.workerRunId ?? null,
        sourceTaskId: input.sourceTaskId ?? null,
        decision: input.decision,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        externalExecution: "blocked",
        executable: false,
      },
    })
    .returning({ id: auditEvents.id });
  const [proof] = await db
    .insert(evidence)
    .values({
      tenantId: input.tenantId,
      kind: "trace",
      name: isRetry ? "Adapter retry task created" : "Adapter review task created",
      taskId: task.id,
      eventId: event.id,
      capabilityId: input.capabilityId,
      actorType: "system",
      hash: `${source}:${idempotencyKey}:${input.now.toISOString()}`,
      data: {
        taskId: task.id,
        auditEventId: audit.id,
        targetType: input.targetType,
        targetId: input.targetId,
        decision: input.decision,
        attempt: input.attempt,
        maxAttempts: input.maxAttempts,
        externalExecution: "blocked",
        executable: false,
      },
    })
    .returning({ id: evidence.id });

  return {
    taskId: task.id,
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: proof.id,
  };
}

async function closeRetryTasks(
  db: DatabaseExecutor,
  input: {
    tenantId: string;
    targetType: "adapter_run" | "adapter_action";
    targetId: string;
    eventId: string;
    auditEventId: string;
    evidenceId: string;
    now: Date;
  },
) {
  const taskRows = await db
    .select({
      id: tasks.id,
      outcome: tasks.outcome,
      evidence: tasks.evidence,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, input.tenantId),
        eq(tasks.ownerRef, "system:adapter-reconciliation"),
        eq(tasks.state, "waiting"),
      ),
    );
  const matchingTaskIds = taskRows
    .filter((task) => {
      const taskEvidence = task.evidence;
      const taskOutcome = task.outcome;

      return (
        taskEvidence.targetType === input.targetType &&
        taskEvidence.targetId === input.targetId &&
        taskOutcome.decision === "retry_scheduled"
      );
    })
    .map((task) => task.id);

  if (!matchingTaskIds.length) {
    return [];
  }

  for (const task of taskRows.filter((row) => matchingTaskIds.includes(row.id))) {
    await db
      .update(tasks)
      .set({
        state: "done",
        outcome: {
          ...task.outcome,
          status: "adapter_retry_executed",
          retryEventId: input.eventId,
          retryAuditEventId: input.auditEventId,
          retryEvidenceId: input.evidenceId,
          externalExecution: "blocked",
          executable: false,
        },
        updatedAt: input.now,
      })
      .where(eq(tasks.id, task.id));
  }

  return matchingTaskIds;
}

async function recordRetryExecution(
  db: DatabaseExecutor,
  input: {
    tenantId: string;
    targetType: "adapter_run" | "adapter_action";
    targetId: string;
    connectionId: string;
    workerRunId?: string | null;
    eventId?: string | null;
    taskId?: string | null;
    capabilityId?: string | null;
    attempt: number;
    maxAttempts: number;
    operation: string;
    receipt: JsonObject;
    response?: JsonObject;
    now: Date;
  },
) {
  const data = {
    targetType: input.targetType,
    targetId: input.targetId,
    connectionId: input.connectionId,
    workerRunId: input.workerRunId ?? null,
    attempt: input.attempt,
    maxAttempts: input.maxAttempts,
    operation: input.operation,
    externalExecution: "blocked",
    externalMutation: false,
    externalSend: false,
  };
  const [event] = await db
    .insert(events)
    .values({
      tenantId: input.tenantId,
      type: "adapter.retry.executed",
      source,
      actorType: "system",
      actorRef: "system:adapter-reconciliation",
      taskId: input.taskId,
      capabilityId: input.capabilityId,
      connectionId: input.connectionId,
      idempotencyKey: `${input.targetType}:${input.targetId}:retry_executed:${input.attempt}:event`,
      data: {
        ...data,
        sourceEventId: input.eventId ?? null,
        receipt: input.receipt,
        response: input.response ?? null,
      },
      occurredAt: input.now,
    })
    .returning({ id: events.id });
  const [audit] = await db
    .insert(auditEvents)
    .values({
      tenantId: input.tenantId,
      type: "adapter.retry.executed",
      source,
      actorType: "system",
      actorRef: "system:adapter-reconciliation",
      targetType: input.targetType,
      targetId: input.targetId,
      taskId: input.taskId,
      workerRunId: input.workerRunId,
      eventId: event.id,
      capabilityId: input.capabilityId,
      risk: "medium",
      idempotencyKey: `${input.targetType}:${input.targetId}:retry_executed:${input.attempt}`,
      data: {
        ...data,
        receipt: input.receipt,
        response: input.response ?? null,
      },
    })
    .returning({ id: auditEvents.id });
  const [proof] = await db
    .insert(evidence)
    .values({
      tenantId: input.tenantId,
      kind: "receipt",
      name: "Adapter retry executed",
      taskId: input.taskId,
      eventId: event.id,
      capabilityId: input.capabilityId,
      actorType: "system",
      hash: `${source}:${input.targetType}:${input.targetId}:retry_executed:${input.attempt}:${input.now.toISOString()}`,
      data: {
        ...data,
        eventId: event.id,
        auditEventId: audit.id,
        receipt: input.receipt,
        response: input.response ?? null,
      },
    })
    .returning({ id: evidence.id });
  const closedRetryTaskIds = await closeRetryTasks(db, {
    tenantId: input.tenantId,
    targetType: input.targetType,
    targetId: input.targetId,
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: proof.id,
    now: input.now,
  });

  return {
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: proof.id,
    closedRetryTaskIds,
  };
}

async function reconcileAction(db: DatabaseExecutor, row: AdapterActionRow, now: Date) {
  const decision = decisionFor({
    mode: row.mode,
    state: row.state,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    request: row.request,
    receipt: row.receipt,
    error: row.error,
  });
  const attempt = incrementedAttempt(decision, row.attempt);
  const nextAttemptAt = decision === "retry_scheduled" ? nextAttemptTime(now, row.attempt) : null;
  const receipt = {
    ...row.receipt,
    reconciliationState: decision,
    externalMutation: row.receipt.externalMutation ?? false,
    reconciledAt: now.toISOString(),
  };
  const error =
    decision === "retry_scheduled"
      ? { ...row.error, retryScheduledAt: now.toISOString() }
      : row.error;
  const state =
    decision === "matched" ? "done" : decision === "retry_scheduled" ? "queued" : row.state;

  const updated = await db
    .update(adapterActions)
    .set({
      state,
      attempt,
      reconciliationState: decision,
      nextAttemptAt,
      receipt,
      error,
      updatedAt: now,
    })
    .where(and(eq(adapterActions.id, row.id), eq(adapterActions.reconciliationState, "pending")))
    .returning({ id: adapterActions.id });
  if (!updated.length) {
    return null;
  }
  const followup =
    decision === "matched"
      ? null
      : await createFollowupTask(db, {
          tenantId: row.tenantId,
          targetType: "adapter_action",
          targetId: row.id,
          connectionId: row.connectionId,
          sourceEventId: row.eventId,
          sourceTaskId: row.taskId,
          capabilityId: row.capabilityId,
          decision,
          attempt,
          maxAttempts: row.maxAttempts,
          operation: row.operation,
          nextAttemptAt,
          now,
        });

  const evidenceResult = await recordDecision(db, {
    tenantId: row.tenantId,
    targetType: "adapter_action",
    targetId: row.id,
    connectionId: row.connectionId,
    eventId: row.eventId,
    taskId: followup?.taskId ?? row.taskId,
    capabilityId: row.capabilityId,
    decision,
    attempt,
    maxAttempts: row.maxAttempts,
    operation: row.operation,
    receipt,
    error,
    now,
  });

  return { decision, followup, ...evidenceResult };
}

async function reconcileRun(db: DatabaseExecutor, row: AdapterRunRow, now: Date) {
  const decision = decisionFor({
    mode: row.mode,
    state: row.state,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    receipt: row.receipt,
    data: row.data,
    error: row.error,
  });
  const attempt = incrementedAttempt(decision, row.attempt);
  const nextAttemptAt = decision === "retry_scheduled" ? nextAttemptTime(now, row.attempt) : null;
  const receipt = {
    ...row.receipt,
    reconciliationState: decision,
    externalMutation: row.receipt.externalMutation ?? row.data.externalMutation ?? false,
    reconciledAt: now.toISOString(),
  };
  const error =
    decision === "retry_scheduled"
      ? { ...row.error, retryScheduledAt: now.toISOString() }
      : row.error;
  const state =
    decision === "matched" ? "done" : decision === "retry_scheduled" ? "queued" : row.state;

  const updated = await db
    .update(adapterRuns)
    .set({
      state,
      attempt,
      reconciliationState: decision,
      nextAttemptAt,
      receipt,
      error,
      endedAt: decision === "matched" ? now : row.endedAt,
    })
    .where(and(eq(adapterRuns.id, row.id), eq(adapterRuns.reconciliationState, "pending")))
    .returning({ id: adapterRuns.id });
  if (!updated.length) {
    return null;
  }
  const followup =
    decision === "matched"
      ? null
      : await createFollowupTask(db, {
          tenantId: row.tenantId,
          targetType: "adapter_run",
          targetId: row.id,
          connectionId: row.connectionId,
          workerRunId: row.workerRunId,
          sourceEventId: row.eventId,
          decision,
          attempt,
          maxAttempts: row.maxAttempts,
          operation: row.operation,
          nextAttemptAt,
          now,
        });

  const evidenceResult = await recordDecision(db, {
    tenantId: row.tenantId,
    targetType: "adapter_run",
    targetId: row.id,
    connectionId: row.connectionId,
    workerRunId: row.workerRunId,
    eventId: row.eventId,
    taskId: followup?.taskId,
    decision,
    attempt,
    maxAttempts: row.maxAttempts,
    operation: row.operation,
    receipt,
    error,
    now,
  });

  return { decision, followup, ...evidenceResult };
}

async function executeActionRetry(db: DatabaseExecutor, row: AdapterActionRow, now: Date) {
  const response = {
    ...row.response,
    status: "retry_executed",
    retryExecutedAt: now.toISOString(),
    attempt: row.attempt,
    externalExecution: "blocked",
    externalSend: false,
  };
  const receipt = {
    ...row.receipt,
    retryExecutedAt: now.toISOString(),
    retryAttempt: row.attempt,
    externalMutation: false,
    externalSend: false,
    reconciliationState: "pending",
  };
  const updated = await db
    .update(adapterActions)
    .set({
      state: "done",
      reconciliationState: "pending",
      nextAttemptAt: null,
      response,
      receipt,
      error: {},
      updatedAt: now,
    })
    .where(
      and(
        eq(adapterActions.id, row.id),
        eq(adapterActions.state, "queued"),
        eq(adapterActions.reconciliationState, "retry_scheduled"),
      ),
    )
    .returning({ id: adapterActions.id });

  if (!updated.length) {
    return null;
  }

  const proof = await recordRetryExecution(db, {
    tenantId: row.tenantId,
    targetType: "adapter_action",
    targetId: row.id,
    connectionId: row.connectionId,
    eventId: row.eventId,
    taskId: row.taskId,
    capabilityId: row.capabilityId,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    operation: row.operation,
    receipt,
    response,
    now,
  });

  return proof;
}

async function executeRunRetry(db: DatabaseExecutor, row: AdapterRunRow, now: Date) {
  const receipt = {
    ...row.receipt,
    retryExecutedAt: now.toISOString(),
    retryAttempt: row.attempt,
    externalMutation: false,
    externalSend: false,
    reconciliationState: "pending",
  };
  const data = {
    ...row.data,
    retryExecutedAt: now.toISOString(),
    externalExecution: "blocked",
    externalMutation: false,
    externalSend: false,
  };
  const updated = await db
    .update(adapterRuns)
    .set({
      state: "done",
      reconciliationState: "pending",
      nextAttemptAt: null,
      receipt,
      error: {},
      data,
      endedAt: now,
    })
    .where(
      and(
        eq(adapterRuns.id, row.id),
        eq(adapterRuns.state, "queued"),
        eq(adapterRuns.reconciliationState, "retry_scheduled"),
      ),
    )
    .returning({ id: adapterRuns.id });

  if (!updated.length) {
    return null;
  }

  const proof = await recordRetryExecution(db, {
    tenantId: row.tenantId,
    targetType: "adapter_run",
    targetId: row.id,
    connectionId: row.connectionId,
    workerRunId: row.workerRunId,
    eventId: row.eventId,
    attempt: row.attempt,
    maxAttempts: row.maxAttempts,
    operation: row.operation,
    receipt,
    now,
  });

  return proof;
}

export async function reconcileAdapterLedger(input: {
  tenantSlug?: string;
  limit?: number;
  now?: Date;
  db?: Database;
} = {}): Promise<AdapterReconciliationResult> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const tenantId = await tenantIdFor(db, input.tenantSlug);
  const result: AdapterReconciliationResult = {
    processed: 0,
    runs: 0,
    actions: 0,
    matched: 0,
    retryScheduled: 0,
    needsReview: 0,
    taskIds: [],
    retryTaskIds: [],
    reviewTaskIds: [],
    auditEventIds: [],
    evidenceIds: [],
  };

  const actionConditions = [pendingActionWhere()];
  const runConditions = [pendingWhere()];

  if (tenantId) {
    actionConditions.push(eq(adapterActions.tenantId, tenantId));
    runConditions.push(eq(adapterRuns.tenantId, tenantId));
  }

  await db.transaction(async (tx) => {
    const actionRows = await tx
      .select()
      .from(adapterActions)
      .where(and(...actionConditions))
      .orderBy(asc(adapterActions.createdAt))
      .limit(limit);
    const runRows = await tx
      .select()
      .from(adapterRuns)
      .where(and(...runConditions))
      .orderBy(asc(adapterRuns.createdAt))
      .limit(limit);

    for (const row of actionRows) {
      const decision = await reconcileAction(tx, row, now);
      if (!decision) {
        continue;
      }
      result.processed += 1;
      result.actions += 1;
      result.auditEventIds.push(decision.auditEventId);
      result.evidenceIds.push(decision.evidenceId);
      if (decision.followup) {
        result.taskIds.push(decision.followup.taskId);
        result.auditEventIds.push(decision.followup.auditEventId);
        result.evidenceIds.push(decision.followup.evidenceId);
      }

      if (decision.decision === "matched") {
        result.matched += 1;
      } else if (decision.decision === "retry_scheduled") {
        result.retryScheduled += 1;
        if (decision.followup) {
          result.retryTaskIds.push(decision.followup.taskId);
        }
      } else {
        result.needsReview += 1;
        if (decision.followup) {
          result.reviewTaskIds.push(decision.followup.taskId);
        }
      }
    }

    for (const row of runRows) {
      const decision = await reconcileRun(tx, row, now);
      if (!decision) {
        continue;
      }
      result.processed += 1;
      result.runs += 1;
      result.auditEventIds.push(decision.auditEventId);
      result.evidenceIds.push(decision.evidenceId);
      if (decision.followup) {
        result.taskIds.push(decision.followup.taskId);
        result.auditEventIds.push(decision.followup.auditEventId);
        result.evidenceIds.push(decision.followup.evidenceId);
      }

      if (decision.decision === "matched") {
        result.matched += 1;
      } else if (decision.decision === "retry_scheduled") {
        result.retryScheduled += 1;
        if (decision.followup) {
          result.retryTaskIds.push(decision.followup.taskId);
        }
      } else {
        result.needsReview += 1;
        if (decision.followup) {
          result.reviewTaskIds.push(decision.followup.taskId);
        }
      }
    }
  });

  return result;
}

export async function executeAdapterRetries(input: {
  tenantSlug?: string;
  limit?: number;
  now?: Date;
  db?: Database;
} = {}): Promise<AdapterRetryExecutionResult> {
  const db = input.db ?? defaultDb;
  const now = input.now ?? new Date();
  const limit = Math.max(1, Math.min(input.limit ?? 25, 100));
  const tenantId = await tenantIdFor(db, input.tenantSlug);
  const result: AdapterRetryExecutionResult = {
    processed: 0,
    runs: 0,
    actions: 0,
    retryRunIds: [],
    retryActionIds: [],
    closedRetryTaskIds: [],
    eventIds: [],
    auditEventIds: [],
    evidenceIds: [],
  };
  const actionConditions = [scheduledActionRetryWhere(now)];
  const runConditions = [scheduledRunRetryWhere(now)];

  if (tenantId) {
    actionConditions.push(eq(adapterActions.tenantId, tenantId));
    runConditions.push(eq(adapterRuns.tenantId, tenantId));
  }

  await db.transaction(async (tx) => {
    const actionRows = await tx
      .select()
      .from(adapterActions)
      .where(and(...actionConditions))
      .orderBy(asc(adapterActions.nextAttemptAt), asc(adapterActions.createdAt))
      .limit(limit);
    const runRows = await tx
      .select()
      .from(adapterRuns)
      .where(and(...runConditions))
      .orderBy(asc(adapterRuns.nextAttemptAt), asc(adapterRuns.createdAt))
      .limit(limit);

    for (const row of actionRows) {
      const executed = await executeActionRetry(tx, row, now);

      if (!executed) {
        continue;
      }

      result.processed += 1;
      result.actions += 1;
      result.retryActionIds.push(row.id);
      result.eventIds.push(executed.eventId);
      result.auditEventIds.push(executed.auditEventId);
      result.evidenceIds.push(executed.evidenceId);
      result.closedRetryTaskIds.push(...executed.closedRetryTaskIds);
    }

    for (const row of runRows) {
      const executed = await executeRunRetry(tx, row, now);

      if (!executed) {
        continue;
      }

      result.processed += 1;
      result.runs += 1;
      result.retryRunIds.push(row.id);
      result.eventIds.push(executed.eventId);
      result.auditEventIds.push(executed.auditEventId);
      result.evidenceIds.push(executed.evidenceId);
      result.closedRetryTaskIds.push(...executed.closedRetryTaskIds);
    }
  });

  return {
    ...result,
    closedRetryTaskIds: Array.from(new Set(result.closedRetryTaskIds)),
  };
}
