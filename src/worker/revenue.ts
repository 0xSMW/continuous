import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  decisions,
  evidence,
  evaluations,
  events,
  generatedViews,
  inferences,
  modelRoutes,
  objectVersions,
  tasks,
  tenants,
  usageEvents,
  users,
  workers,
  type JsonObject,
} from "../db/schema";

type Database = typeof defaultDb;

const revenueWorkerRole = "revenue_operations";
const source = "continuous.revenue_worker";
const runUnits = 12000;

export type RevenueWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

export class RevenueWorkerUnavailableError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 409,
  ) {
    super(message);
    this.name = "RevenueWorkerUnavailableError";
  }
}

export type RevenueWorkerSnapshot = {
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
    externalExecution: "disabled" | "simulated";
  };
  activeTasks: Array<{
    id: string;
    title: string;
    state: string;
    priority: string;
    outcome: JsonObject;
    cost: JsonObject;
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
    idempotencyKey: string | null;
    occurredAt: string;
  } | null;
};

export type RevenueWorkerRunResult = {
  created: boolean;
  idempotencyKey: string;
  eventId: string;
  taskId: string | null;
  evidenceId: string | null;
  reservationId: string | null;
  inferenceId: string | null;
  usageEventId: string | null;
  adapterActionId: string | null;
  snapshot: RevenueWorkerSnapshot;
};

type WorkerContext = {
  worker: {
    id: string;
    tenantId: string;
    name: string;
    kpis: JsonObject;
  };
  tenantName: string;
  task: {
    id: string;
    objectId: string | null;
    capabilityId: string | null;
  } | null;
  quoteCapabilityId: string | null;
  briefCapabilityId: string | null;
  budgetAccountId: string;
  connectionId: string;
  routeId: string | null;
};

function numberValue(value: unknown) {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string") {
    return Number(value);
  }

  return 0;
}

function nextWorkerKpis(current: JsonObject, now: Date) {
  const normalized = { ...current };
  delete normalized.quotesPrepared;
  delete normalized.ownerHoursSaved;

  return {
    ...normalized,
    lastRunAt: now.toISOString(),
    simulatedRuns: numberValue(current.simulatedRuns) + 1,
    quotes_prepared: numberValue(current.quotes_prepared) + 1,
    owner_hours_saved: 0.6,
  };
}

function traceHash(idempotencyKey: string, eventType: string) {
  return createHash("sha256").update(`${source}:${eventType}:${idempotencyKey}`).digest("hex");
}

function workerWhere(selector: RevenueWorkerSelector) {
  const conditions = [
    eq(workers.role, selector.role ?? revenueWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: RevenueWorkerSelector): T | null {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new RevenueWorkerUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Revenue Workers match this selector. Provide a workerId.",
    );
  }

  return rows[0] ?? null;
}

async function loadWorkerContext(db: Database, selector: RevenueWorkerSelector): Promise<WorkerContext> {
  const workerRows = await db
    .select({
      id: workers.id,
      tenantId: workers.tenantId,
      name: workers.name,
      kpis: workers.kpis,
      tenantName: tenants.name,
    })
    .from(workers)
    .innerJoin(tenants, eq(workers.tenantId, tenants.id))
    .where(workerWhere(selector))
    .orderBy(workers.createdAt)
    .limit(selector.workerId ? 1 : 2);

  const workerRow = assertSingleWorker(workerRows, selector);

  if (!workerRow) {
    throw new RevenueWorkerUnavailableError(
      "worker_not_found",
      "No active Revenue Worker matches this selector.",
      404,
    );
  }

  const [taskRow] = await db
    .select({
      id: tasks.id,
      objectId: tasks.objectId,
      capabilityId: tasks.capabilityId,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.tenantId, workerRow.tenantId),
        eq(tasks.ownerType, "worker"),
        eq(tasks.ownerId, workerRow.id),
        eq(tasks.state, "active"),
      ),
    )
    .orderBy(
      sql`case ${tasks.priority} when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end`,
      tasks.createdAt,
    )
    .limit(1);

  const [quoteCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.key, "quote.prepare"))
    .limit(1);

  const [briefCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(eq(capabilities.key, "owner_brief.generate"))
    .limit(1);

  const [budgetAccount] = await db
    .select({ id: budgetAccounts.id })
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.tenantId, workerRow.tenantId),
        eq(budgetAccounts.target, "worker"),
        eq(budgetAccounts.targetId, workerRow.id),
        eq(budgetAccounts.active, true),
      ),
    )
    .orderBy(budgetAccounts.createdAt)
    .limit(1);

  if (!budgetAccount) {
    throw new RevenueWorkerUnavailableError(
      "worker_budget_missing",
      "Revenue Worker has no active budget account.",
    );
  }

  const [connection] = await db
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.tenantId, workerRow.tenantId), eq(connections.state, "active")))
    .orderBy(connections.createdAt)
    .limit(1);

  if (!connection) {
    throw new RevenueWorkerUnavailableError(
      "worker_connection_missing",
      "Revenue Worker has no active adapter connection.",
    );
  }

  const [route] = await db
    .select({ id: modelRoutes.id })
    .from(modelRoutes)
    .where(and(eq(modelRoutes.tenantId, workerRow.tenantId), eq(modelRoutes.active, true)))
    .orderBy(modelRoutes.createdAt)
    .limit(1);

  return {
    worker: {
      id: workerRow.id,
      tenantId: workerRow.tenantId,
      name: workerRow.name,
      kpis: workerRow.kpis,
    },
    tenantName: workerRow.tenantName,
    task: taskRow ?? null,
    quoteCapabilityId: quoteCapability?.id ?? null,
    briefCapabilityId: briefCapability?.id ?? null,
    budgetAccountId: budgetAccount.id,
    connectionId: connection.id,
    routeId: route?.id ?? null,
  };
}

export async function getRevenueWorkerSnapshot(
  db: Database = defaultDb,
  selector: RevenueWorkerSelector = {},
): Promise<RevenueWorkerSnapshot> {
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

  const workerRow = assertSingleWorker(workerRows, selector);

  if (!workerRow) {
    return {
      worker: null,
      budget: { accountId: null, name: null, usedUnits: 0, heldUnits: 0, events: 0 },
      controls: {
        grantedCapabilities: 0,
        approvalTasks: 0,
        generatedViews: 0,
        externalExecution: "disabled",
      },
      activeTasks: [],
      recentEvents: [],
      latestRun: null,
    };
  }

  const [budgetAccount] = await db
    .select({ id: budgetAccounts.id, name: budgetAccounts.name })
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.tenantId, workerRow.tenantId),
        eq(budgetAccounts.target, "worker"),
        eq(budgetAccounts.targetId, workerRow.id),
        eq(budgetAccounts.active, true),
      ),
    )
    .limit(1);

  const [
    grantedCapabilities,
    approvalTasks,
    viewCount,
    usage,
    reservations,
    workerTasks,
    workerEvents,
    latestRun,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(capabilityGrants)
      .where(
        and(
          eq(capabilityGrants.tenantId, workerRow.tenantId),
          eq(capabilityGrants.actorType, "worker"),
          eq(capabilityGrants.actorId, workerRow.id),
          eq(capabilityGrants.active, true),
        ),
      ),
    db
      .select({ value: count() })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, workerRow.tenantId),
          eq(tasks.ownerType, "worker"),
          eq(tasks.ownerId, workerRow.id),
          eq(tasks.state, "approval_required"),
        ),
      ),
    db
      .select({ value: count() })
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, workerRow.tenantId), eq(generatedViews.active, true))),
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
          eq(tasks.tenantId, workerRow.tenantId),
          eq(tasks.ownerType, "worker"),
          eq(tasks.ownerId, workerRow.id),
          sql`${tasks.state} <> 'done'`,
          sql`${tasks.state} <> 'canceled'`,
        ),
      )
      .orderBy(desc(tasks.updatedAt))
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
      .where(and(eq(events.tenantId, workerRow.tenantId), eq(events.actorId, workerRow.id)))
      .orderBy(desc(events.occurredAt))
      .limit(6),
    db
      .select({
        id: events.id,
        idempotencyKey: events.idempotencyKey,
        occurredAt: events.occurredAt,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, workerRow.tenantId),
          eq(events.source, source),
          eq(events.type, "revenue_worker.run.completed"),
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(1),
  ]);

  return {
    worker: {
      id: workerRow.id,
      name: workerRow.name,
      role: workerRow.role,
      state: workerRow.state,
      mission: workerRow.mission,
      autonomyLevel: workerRow.autonomyLevel,
      scope: workerRow.scope,
      policy: workerRow.policy,
      kpis: workerRow.kpis,
      managerName: workerRow.managerName,
      tenantName: workerRow.tenantName,
    },
    budget: {
      accountId: budgetAccount?.id ?? null,
      name: budgetAccount?.name ?? null,
      usedUnits: numberValue(usage[0]?.units),
      heldUnits: numberValue(reservations[0]?.units),
      events: usage[0]?.events ?? 0,
    },
    controls: {
      grantedCapabilities: grantedCapabilities[0]?.value ?? 0,
      approvalTasks: approvalTasks[0]?.value ?? 0,
      generatedViews: viewCount[0]?.value ?? 0,
      externalExecution: "disabled",
    },
    activeTasks: workerTasks.map((task) => ({
      id: task.id,
      title: task.title,
      state: task.state,
      priority: task.priority,
      outcome: task.outcome,
      cost: task.cost,
    })),
    recentEvents: workerEvents.map((event) => ({
      id: event.id,
      type: event.type,
      actorRef: event.actorRef,
      occurredAt: event.occurredAt.toISOString(),
      data: event.data,
    })),
	    latestRun: latestRun[0]
	      ? {
	          id: latestRun[0].id,
	          idempotencyKey: latestRun[0].idempotencyKey,
	          occurredAt: latestRun[0].occurredAt.toISOString(),
	        }
	      : null,
	  };
	}

export async function getRevenueWorkerSnapshotSafe(selector: RevenueWorkerSelector = {}): Promise<
  | { ok: true; snapshot: RevenueWorkerSnapshot; error: null }
  | { ok: false; snapshot: RevenueWorkerSnapshot; error: string }
> {
  try {
    return { ok: true, snapshot: await getRevenueWorkerSnapshot(defaultDb, selector), error: null };
  } catch (error) {
    return {
      ok: false,
      snapshot: {
        worker: null,
        budget: { accountId: null, name: null, usedUnits: 0, heldUnits: 0, events: 0 },
        controls: {
          grantedCapabilities: 0,
          approvalTasks: 0,
          generatedViews: 0,
          externalExecution: "disabled",
        },
        activeTasks: [],
        recentEvents: [],
        latestRun: null,
      },
      error: error instanceof Error ? error.message : "Unknown Revenue Worker error",
    };
		}
}

export async function runRevenueWorker(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  db?: Database;
}): Promise<RevenueWorkerRunResult> {
  const db = input.db ?? defaultDb;
  const selector: RevenueWorkerSelector = {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  };
  const context = await loadWorkerContext(db, selector);

	  const result = await db.transaction(async (tx) => {
	    await tx.execute(
	      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
	    );

    const [existing] = await tx
      .select({
        id: events.id,
        taskId: events.taskId,
        data: events.data,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, context.worker.tenantId),
          eq(events.source, source),
          eq(events.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

	    if (existing) {
	      return {
        created: false as const,
        eventId: existing.id,
        taskId: existing.taskId ?? context.task?.id ?? null,
        evidenceId: typeof existing.data.evidenceId === "string" ? existing.data.evidenceId : null,
        reservationId: typeof existing.data.reservationId === "string" ? existing.data.reservationId : null,
        inferenceId: typeof existing.data.inferenceId === "string" ? existing.data.inferenceId : null,
        usageEventId: typeof existing.data.usageEventId === "string" ? existing.data.usageEventId : null,
        adapterActionId: typeof existing.data.adapterActionId === "string" ? existing.data.adapterActionId : null,
	      };
	    }

	    const now = new Date();
	    await tx.execute(sql`select id from budget_accounts where id = ${context.budgetAccountId} for update`);

	    const [budgetState] = await tx
	      .select({
	        policyId: budgetAccounts.policyId,
	        policyActive: budgetPolicies.active,
	        monthlyUnits: budgetPolicies.monthlyUnits,
	        perTaskUnits: budgetPolicies.perTaskUnits,
	        hardLimit: budgetPolicies.hardLimit,
	      })
	      .from(budgetAccounts)
	      .leftJoin(budgetPolicies, eq(budgetAccounts.policyId, budgetPolicies.id))
	      .where(and(eq(budgetAccounts.id, context.budgetAccountId), eq(budgetAccounts.active, true)))
	      .limit(1);

	    if (!budgetState?.policyId || !budgetState.policyActive) {
	      throw new RevenueWorkerUnavailableError(
	        "worker_budget_policy_missing",
	        "Revenue Worker budget account has no active policy.",
	      );
	    }

	    const perTaskUnits =
	      budgetState.perTaskUnits === null ? null : numberValue(budgetState.perTaskUnits);

	    if (perTaskUnits !== null && runUnits > perTaskUnits) {
	      throw new RevenueWorkerUnavailableError(
	        "worker_budget_per_task_exceeded",
	        `Revenue Worker run requires ${runUnits} units, above the per-task limit of ${perTaskUnits}.`,
	      );
	    }

	    const [allocation] = await tx
	      .select({
	        units: sql<number>`coalesce(sum(${budgetAllocations.units}), 0)`,
	        startsAt: sql<Date | null>`min(${budgetAllocations.startsAt})`,
	        endsAt: sql<Date | null>`max(${budgetAllocations.endsAt})`,
	      })
	      .from(budgetAllocations)
	      .where(
	        and(
	          eq(budgetAllocations.accountId, context.budgetAccountId),
	          sql`${budgetAllocations.startsAt} <= ${now}`,
	          sql`${budgetAllocations.endsAt} > ${now}`,
	        ),
	      );

	    const usageConditions = [eq(usageEvents.accountId, context.budgetAccountId)];

	    if (allocation?.startsAt && allocation.endsAt) {
	      usageConditions.push(sql`${usageEvents.createdAt} >= ${allocation.startsAt}`);
	      usageConditions.push(sql`${usageEvents.createdAt} < ${allocation.endsAt}`);
	    }

	    const [used] = await tx
	      .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)` })
	      .from(usageEvents)
	      .where(and(...usageConditions));

	    const [held] = await tx
	      .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
	      .from(budgetReservations)
	      .where(
	        and(
	          eq(budgetReservations.accountId, context.budgetAccountId),
	          eq(budgetReservations.state, "held"),
	          sql`(${budgetReservations.expiresAt} is null or ${budgetReservations.expiresAt} > ${now})`,
	        ),
	      );

	    const monthlyUnits = numberValue(budgetState.monthlyUnits);
	    const allocatedUnits = numberValue(allocation?.units);
	    const allowanceUnits =
	      allocatedUnits > 0 && monthlyUnits > 0
	        ? Math.min(allocatedUnits, monthlyUnits)
	        : allocatedUnits > 0
	          ? allocatedUnits
	          : monthlyUnits;
	    const hardLimit = numberValue(budgetState.hardLimit) || 100;
	    const maxUnits = Math.floor((allowanceUnits * hardLimit) / 100);
	    const committedUnits = numberValue(used?.units) + numberValue(held?.units);

	    if (maxUnits <= 0 || committedUnits + runUnits > maxUnits) {
	      throw new RevenueWorkerUnavailableError(
	        "worker_budget_exceeded",
	        `Revenue Worker run requires ${runUnits} units, with ${Math.max(maxUnits - committedUnits, 0)} units available.`,
	      );
	    }

	    const task = context.task;
	    const capabilityId = task?.capabilityId ?? context.quoteCapabilityId ?? context.briefCapabilityId;

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task?.id,
        units: runUnits,
        state: "used",
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
      })
      .returning({ id: budgetReservations.id });

    const [run] = await tx
      .insert(adapterRuns)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        state: "done",
        cursor: input.idempotencyKey,
        readCount: 1,
        writeCount: 0,
        startedAt: now,
        endedAt: now,
      })
      .returning({ id: adapterRuns.id });

    const [inference] = await tx
      .insert(inferences)
      .values({
        tenantId: context.worker.tenantId,
        routeId: context.routeId,
        budgetAccountId: context.budgetAccountId,
        taskId: task?.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        promptHash: traceHash(input.idempotencyKey, "prompt"),
        request: {
          mode: "simulation",
          objective: "Classify the active lead-to-cash task and prepare the next owner-visible action.",
        },
        result: {
          classification: "quote_ready_for_owner_approval",
          nextAction: "owner_approval",
          externalSend: false,
        },
        safety: {
          externalExecution: "blocked",
          moneyMovement: "approval_required",
          pii: "minimal",
        },
        promptTokens: 820,
        completionTokens: 260,
        units: runUnits,
        costUsd: "0.000000",
        latencyMs: 240,
      })
      .returning({ id: inferences.id });

    const [usage] = await tx
      .insert(usageEvents)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        reservationId: reservation.id,
        inferenceId: inference.id,
        taskId: task?.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        units: runUnits,
        costUsd: "0.000000",
        data: {
          route: "low_cost_fast",
          mode: "simulation",
          adapterRunId: run.id,
        },
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "revenue_worker.run.completed",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: task?.objectId,
        taskId: task?.id,
        capabilityId,
        connectionId: context.connectionId,
        idempotencyKey: input.idempotencyKey,
        data: {
          worker: context.worker.name,
          tenant: context.tenantName,
          classification: "quote_ready_for_owner_approval",
          budgetUnits: runUnits,
          externalExecution: "blocked",
          requiresApproval: true,
          taskId: task?.id ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [workerEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Revenue Worker simulation trace",
        objectId: task?.objectId,
        taskId: task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "trace"),
        data: {
          idempotencyKey: input.idempotencyKey,
          inferenceId: inference.id,
          usageEventId: usage.id,
          reservationId: reservation.id,
          decision: "prepared_quote_for_owner_approval",
          guardrails: ["no_external_send", "no_money_movement", "owner_approval_required"],
        },
      })
      .returning({ id: evidence.id });

    await tx
      .insert(decisions)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        kind: "approval_recommendation",
        state: "proposed",
        decision: "request_owner_approval",
        rationale: "External communication and money movement are blocked until owner approval.",
        data: {
          idempotencyKey: input.idempotencyKey,
          classification: "quote_ready_for_owner_approval",
          autonomyLevel: 2,
        },
      });

    const [action] = await tx
      .insert(adapterActions)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        capabilityId,
        taskId: task?.id,
        eventId: event.id,
        idempotencyKey: input.idempotencyKey,
        state: "done",
        request: {
          action: "draft_customer_response",
          externalSend: false,
        },
        response: {
          status: "prepared",
          nextStep: "owner_approval",
        },
        receipt: {
          mode: "simulation",
          externalMutation: false,
        },
      })
      .returning({ id: adapterActions.id });

    await tx.insert(evaluations).values({
      tenantId: context.worker.tenantId,
      workerId: context.worker.id,
      taskId: task?.id,
      eventId: event.id,
      kind: "simulation_quality",
      score: "0.860",
      data: {
        idempotencyKey: input.idempotencyKey,
        dimensions: {
          evidence_complete: true,
          within_budget: true,
          external_execution_blocked: true,
          owner_approval_required: true,
        },
      },
    });

    if (task?.id) {
      await tx
        .update(tasks)
        .set({
          state: "approval_required",
          outcome: {
            status: "quote_ready_for_owner_approval",
            runEventId: event.id,
            adapterActionId: action.id,
          },
          cost: {
            units: runUnits,
            reservationId: reservation.id,
            usageEventId: usage.id,
          },
          kpi: {
            quotePrepared: true,
            ownerTimeSavedMinutes: 18,
            responseTimeTarget: "under_5_minutes",
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
    }

    if (task?.objectId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('object_version'), hashtext(${task.objectId}))`,
      );

      const [version] = await tx
        .select({
          value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
        })
        .from(objectVersions)
        .where(eq(objectVersions.objectId, task.objectId));

      await tx.insert(objectVersions).values({
        tenantId: context.worker.tenantId,
        objectId: task.objectId,
        version: numberValue(version?.value),
        data: {
          state: "approval_required",
          sourceEventId: event.id,
          approvalRequired: true,
        },
        changedByType: "worker",
        changedById: context.worker.id,
        reason: "Revenue Worker prepared the next owner-approved action.",
      });
    }

    await tx
      .update(workers)
      .set({
        state: "active",
        kpis: nextWorkerKpis(context.worker.kpis, now),
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    await tx
      .update(events)
      .set({
        data: {
          worker: context.worker.name,
          tenant: context.tenantName,
          classification: "quote_ready_for_owner_approval",
          budgetUnits: runUnits,
          externalExecution: "blocked",
          requiresApproval: true,
          taskId: task?.id ?? null,
          evidenceId: workerEvidence.id,
          reservationId: reservation.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
          adapterActionId: action.id,
        },
      })
      .where(eq(events.id, event.id));

    return {
      created: true as const,
      eventId: event.id,
      taskId: task?.id ?? null,
      evidenceId: workerEvidence.id,
      reservationId: reservation.id,
      inferenceId: inference.id,
      usageEventId: usage.id,
      adapterActionId: action.id,
    };
  });

  return {
    idempotencyKey: input.idempotencyKey,
    ...result,
    snapshot: await getRevenueWorkerSnapshot(db, selector),
  };
}
