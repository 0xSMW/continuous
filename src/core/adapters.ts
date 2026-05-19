import { and, asc, eq } from "drizzle-orm";

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
