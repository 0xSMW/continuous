import { and, asc, eq, isNotNull, or, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  auditEvents,
  evidence,
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

function pendingWhere(now: Date) {
  return or(
    eq(adapterRuns.reconciliationState, "pending"),
    and(isNotNull(adapterRuns.nextAttemptAt), sql`${adapterRuns.nextAttemptAt} <= ${now}`),
  );
}

function pendingActionWhere(now: Date) {
  return or(
    eq(adapterActions.reconciliationState, "pending"),
    and(isNotNull(adapterActions.nextAttemptAt), sql`${adapterActions.nextAttemptAt} <= ${now}`),
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

  await db
    .update(adapterActions)
    .set({
      state,
      attempt,
      reconciliationState: decision,
      nextAttemptAt: decision === "retry_scheduled" ? nextAttemptTime(now, attempt) : null,
      receipt,
      error,
      updatedAt: now,
    })
    .where(eq(adapterActions.id, row.id));

  const evidenceResult = await recordDecision(db, {
    tenantId: row.tenantId,
    targetType: "adapter_action",
    targetId: row.id,
    connectionId: row.connectionId,
    eventId: row.eventId,
    taskId: row.taskId,
    capabilityId: row.capabilityId,
    decision,
    attempt,
    maxAttempts: row.maxAttempts,
    operation: row.operation,
    receipt,
    error,
    now,
  });

  return { decision, ...evidenceResult };
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

  await db
    .update(adapterRuns)
    .set({
      state,
      attempt,
      reconciliationState: decision,
      nextAttemptAt: decision === "retry_scheduled" ? nextAttemptTime(now, attempt) : null,
      receipt,
      error,
      endedAt: decision === "matched" ? now : row.endedAt,
    })
    .where(eq(adapterRuns.id, row.id));

  const evidenceResult = await recordDecision(db, {
    tenantId: row.tenantId,
    targetType: "adapter_run",
    targetId: row.id,
    connectionId: row.connectionId,
    workerRunId: row.workerRunId,
    eventId: row.eventId,
    decision,
    attempt,
    maxAttempts: row.maxAttempts,
    operation: row.operation,
    receipt,
    error,
    now,
  });

  return { decision, ...evidenceResult };
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
    auditEventIds: [],
    evidenceIds: [],
  };

  const actionConditions = [pendingActionWhere(now)];
  const runConditions = [pendingWhere(now)];

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
      result.processed += 1;
      result.actions += 1;
      result.auditEventIds.push(decision.auditEventId);
      result.evidenceIds.push(decision.evidenceId);

      if (decision.decision === "matched") {
        result.matched += 1;
      } else if (decision.decision === "retry_scheduled") {
        result.retryScheduled += 1;
      } else {
        result.needsReview += 1;
      }
    }

    for (const row of runRows) {
      const decision = await reconcileRun(tx, row, now);
      result.processed += 1;
      result.runs += 1;
      result.auditEventIds.push(decision.auditEventId);
      result.evidenceIds.push(decision.evidenceId);

      if (decision.decision === "matched") {
        result.matched += 1;
      } else if (decision.decision === "retry_scheduled") {
        result.retryScheduled += 1;
      } else {
        result.needsReview += 1;
      }
    }
  });

  return result;
}
