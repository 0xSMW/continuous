import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetReservations,
  capabilities,
  events,
  evidence,
  tasks,
  usageEvents,
  users,
  workers,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type ActorType = "user" | "worker";

const source = "continuous.core.budgets";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorTypes = new Set<ActorType>(["user", "worker"]);

export type BudgetReserveInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  budgetAccountId: string;
  units: unknown;
  taskId?: string;
  capabilityId?: string;
  expiresAt?: string;
  reason?: string;
  data?: JsonObject;
  db?: Database;
};

export type BudgetChargeInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  reservationId: string;
  units?: unknown;
  costUsd?: unknown;
  actor?: JsonObject;
  taskId?: string;
  capabilityId?: string;
  inferenceId?: string;
  reason?: string;
  data?: JsonObject;
  db?: Database;
};

export type BudgetReleaseInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  reservationId: string;
  reason?: string;
  data?: JsonObject;
  db?: Database;
};

export type BudgetReserveResult = {
  reserved: boolean;
  reservationId: string;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
  reservation: {
    id: string;
    budgetAccountId: string;
    taskId: string | null;
    units: number;
    state: string;
    expiresAt: string | null;
  };
};

export type BudgetChargeResult = {
  charged: boolean;
  reservationId: string;
  usageEventId: string;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
  usage: {
    id: string;
    budgetAccountId: string;
    reservationId: string;
    units: number;
    costUsd: string;
    actor: {
      type: ActorType;
      id: string;
      ref: string;
    };
  };
};

export type BudgetReleaseResult = {
  released: boolean;
  reservationId: string;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
  reservation: {
    id: string;
    budgetAccountId: string;
    taskId: string | null;
    units: number;
    state: string;
    expiresAt: string | null;
  };
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("budget_field_required", `${field} is required.`, 400);
  }

  return output;
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError("budget_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return value;
}

function requiredUuid(value: unknown, field: string) {
  const output = optionalUuid(requiredString(value, field), field);

  if (!output) {
    throw new PlatformUnavailableError("budget_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return output;
}

function jsonObject(value: JsonObject | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function parseUnits(value: unknown, field: string) {
  const units = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(units) || units < 1) {
    throw new PlatformUnavailableError("budget_units_invalid", `${field} must be a positive integer.`, 400);
  }

  return units;
}

function optionalDate(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("budget_date_invalid", `${field} must be an ISO date.`, 400);
  }

  return date;
}

function parseCostUsd(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "0.000000";
  }

  const cost = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(cost) || cost < 0) {
    throw new PlatformUnavailableError("budget_cost_invalid", "config.costUsd must be a non-negative number.", 400);
  }

  return cost.toFixed(6);
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : Number(value ?? 0);
}

function reservationView(row: typeof budgetReservations.$inferSelect) {
  return {
    id: row.id,
    budgetAccountId: row.accountId,
    taskId: row.taskId,
    units: row.units,
    state: row.state,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

function actorFrom(input: {
  value?: JsonObject;
  operatorUserId: string;
  operatorActorRef: string;
}) {
  const actor = jsonObject(input.value);
  const requestedType = cleanString(actor.type);

  if (!requestedType) {
    return {
      type: "user" as const,
      id: input.operatorUserId,
      ref: input.operatorActorRef,
    };
  }

  const id = requiredUuid(actor.id, "config.actor.id");

  if (!actorTypes.has(requestedType as ActorType)) {
    throw new PlatformUnavailableError(
      "budget_actor_type_invalid",
      "config.actor.type must be user or worker.",
      400,
    );
  }

  return {
    type: requestedType as ActorType,
    id,
    ref: cleanString(actor.ref) ?? `${requestedType}:${id}`,
  };
}

async function assertActor(
  tx: Pick<Database, "select">,
  tenantId: string,
  actor: { type: ActorType; id: string },
) {
  if (actor.type === "user") {
    const [user] = await tx
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, actor.id), eq(users.state, "active")))
      .limit(1);

    if (!user) {
      throw new PlatformUnavailableError(
        "budget_actor_not_found",
        "config.actor.id does not match an active user in this tenant.",
        404,
      );
    }
  }

  if (actor.type === "worker") {
    const [worker] = await tx
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.tenantId, tenantId), eq(workers.id, actor.id)))
      .limit(1);

    if (!worker) {
      throw new PlatformUnavailableError(
        "budget_actor_not_found",
        "config.actor.id does not match a worker in this tenant.",
        404,
      );
    }
  }

}

async function assertTask(tx: Pick<Database, "select">, tenantId: string, taskId?: string) {
  if (!taskId) {
    return;
  }

  const [task] = await tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.tenantId, tenantId), eq(tasks.id, taskId)))
    .limit(1);

  if (!task) {
    throw new PlatformUnavailableError(
      "budget_task_not_found",
      "config.taskId does not match a task in this tenant.",
      404,
    );
  }
}

async function assertCapability(tx: Pick<Database, "select">, capabilityId?: string) {
  if (!capabilityId) {
    return;
  }

  const [capability] = await tx
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.id, capabilityId), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "budget_capability_not_found",
      "config.capabilityId does not match an active capability.",
      404,
    );
  }
}

async function assertBudgetCapacity(input: {
  tx: Pick<Database, "select">;
  accountId: string;
  units: number;
  now: Date;
}) {
  const [budgetState] = await input.tx
    .select({
      policyId: budgetAccounts.policyId,
      policyActive: budgetPolicies.active,
      monthlyUnits: budgetPolicies.monthlyUnits,
      perTaskUnits: budgetPolicies.perTaskUnits,
      hardLimit: budgetPolicies.hardLimit,
    })
    .from(budgetAccounts)
    .leftJoin(budgetPolicies, eq(budgetAccounts.policyId, budgetPolicies.id))
    .where(and(eq(budgetAccounts.id, input.accountId), eq(budgetAccounts.active, true)))
    .limit(1);

  if (!budgetState?.policyId || !budgetState.policyActive) {
    throw new PlatformUnavailableError(
      "budget_policy_missing",
      "config.budgetAccountId has no active budget policy.",
      409,
    );
  }

  const perTaskUnits = budgetState.perTaskUnits === null ? null : numberValue(budgetState.perTaskUnits);

  if (perTaskUnits !== null && input.units > perTaskUnits) {
    throw new PlatformUnavailableError(
      "budget_per_task_exceeded",
      `Budget reserve requires ${input.units} units, above the per-task limit of ${perTaskUnits}.`,
      409,
    );
  }

  const [allocation] = await input.tx
    .select({
      units: sql<number>`coalesce(sum(${budgetAllocations.units}), 0)`,
      startsAt: sql<Date | null>`min(${budgetAllocations.startsAt})`,
      endsAt: sql<Date | null>`max(${budgetAllocations.endsAt})`,
    })
    .from(budgetAllocations)
    .where(
      and(
        eq(budgetAllocations.accountId, input.accountId),
        sql`${budgetAllocations.startsAt} <= ${input.now}`,
        sql`${budgetAllocations.endsAt} > ${input.now}`,
      ),
    );
  const usageConditions = [eq(usageEvents.accountId, input.accountId)];

  if (allocation?.startsAt && allocation.endsAt) {
    usageConditions.push(sql`${usageEvents.createdAt} >= ${allocation.startsAt}`);
    usageConditions.push(sql`${usageEvents.createdAt} < ${allocation.endsAt}`);
  }

  const [used] = await input.tx
    .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)` })
    .from(usageEvents)
    .where(and(...usageConditions));
  const [held] = await input.tx
    .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.accountId, input.accountId),
        eq(budgetReservations.state, "held"),
        sql`(${budgetReservations.expiresAt} is null or ${budgetReservations.expiresAt} > ${input.now})`,
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

  if (maxUnits <= 0 || committedUnits + input.units > maxUnits) {
    throw new PlatformUnavailableError(
      "budget_exceeded",
      `Budget reserve requires ${input.units} units, with ${Math.max(maxUnits - committedUnits, 0)} units available.`,
      409,
    );
  }
}

async function evidenceForAudit(tx: Pick<Database, "select">, tenantId: string, auditEventId: string) {
  const [item] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), sql`${evidence.data}->>'auditEventId' = ${auditEventId}`))
    .limit(1);

  return item?.id ?? null;
}

export async function reserveBudget(input: BudgetReserveInput): Promise<BudgetReserveResult> {
  const db = input.db ?? defaultDb;
  const accountId = requiredUuid(input.budgetAccountId, "config.budgetAccountId");
  const taskId = optionalUuid(cleanString(input.taskId), "config.taskId");
  const capabilityId = optionalUuid(cleanString(input.capabilityId), "config.capabilityId");
  const units = parseUnits(input.units, "config.units");
  const reason = requiredString(input.reason, "config.reason");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({ auditEventId: auditEvents.id, eventId: auditEvents.eventId, targetId: auditEvents.targetId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:budget_reserved`),
          eq(auditEvents.targetType, "budget_reservation"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [reservation] = await tx
        .select()
        .from(budgetReservations)
        .where(and(eq(budgetReservations.tenantId, operator.tenantId), eq(budgetReservations.id, existingAudit.targetId)))
        .limit(1);

      if (reservation) {
        return {
          reserved: false,
          reservationId: reservation.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
          reservation: reservationView(reservation),
        };
      }
    }

    await tx.execute(sql`select id from budget_accounts where id = ${accountId} for update`);

    const [account] = await tx
      .select({ id: budgetAccounts.id })
      .from(budgetAccounts)
      .where(and(eq(budgetAccounts.tenantId, operator.tenantId), eq(budgetAccounts.id, accountId), eq(budgetAccounts.active, true)))
      .limit(1);

    if (!account) {
      throw new PlatformUnavailableError(
        "budget_account_not_found",
        "config.budgetAccountId does not match an active budget account in this tenant.",
        404,
      );
    }

    await Promise.all([
      assertTask(tx, operator.tenantId, taskId),
      assertCapability(tx, capabilityId),
      assertBudgetCapacity({ tx, accountId, units, now: new Date() }),
    ]);

    const now = new Date();
    const expiresAt = optionalDate(cleanString(input.expiresAt), "config.expiresAt") ?? new Date(now.getTime() + 15 * 60 * 1000);

    if (expiresAt <= now) {
      throw new PlatformUnavailableError("budget_expiration_invalid", "config.expiresAt must be in the future.", 400);
    }

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: operator.tenantId,
        accountId,
        taskId,
        units,
        state: "held",
        expiresAt,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const payload = {
      reservationId: reservation.id,
      budgetAccountId: accountId,
      taskId: taskId ?? null,
      capabilityId: capabilityId ?? null,
      units,
      reason,
      expiresAt: expiresAt.toISOString(),
      externalExecution: "blocked",
      data: jsonObject(input.data),
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "budget.reserved",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        taskId,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:budget_reserved`,
        data: payload,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "budget.reserved",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "budget_reservation",
        targetId: reservation.id,
        taskId,
        eventId: event.id,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:budget_reserved`,
        data: payload,
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: "Budget reservation held",
        taskId,
        eventId: event.id,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${reservation.id}:reserved:${now.toISOString()}`,
        data: {
          ...payload,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });

    return {
      reserved: true,
      reservationId: reservation.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      reservation: reservationView(reservation),
    };
  });
}

export async function chargeBudget(input: BudgetChargeInput): Promise<BudgetChargeResult> {
  const db = input.db ?? defaultDb;
  const reservationId = requiredUuid(input.reservationId, "config.reservationId");
  const taskId = optionalUuid(cleanString(input.taskId), "config.taskId");
  const capabilityId = optionalUuid(cleanString(input.capabilityId), "config.capabilityId");
  const inferenceId = optionalUuid(cleanString(input.inferenceId), "config.inferenceId");
  const reason = requiredString(input.reason, "config.reason");
  const costUsd = parseCostUsd(input.costUsd);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = actorFrom({
    value: input.actor,
    operatorUserId: operator.userId,
    operatorActorRef: operator.actorRef,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({ auditEventId: auditEvents.id, eventId: auditEvents.eventId, targetId: auditEvents.targetId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:budget_charged`),
          eq(auditEvents.targetType, "usage_event"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [usage] = await tx
        .select()
        .from(usageEvents)
        .where(and(eq(usageEvents.tenantId, operator.tenantId), eq(usageEvents.id, existingAudit.targetId)))
        .limit(1);

      if (usage?.reservationId) {
        return {
          charged: false,
          reservationId: usage.reservationId,
          usageEventId: usage.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
          usage: {
            id: usage.id,
            budgetAccountId: usage.accountId,
            reservationId: usage.reservationId,
            units: usage.units,
            costUsd: String(usage.costUsd),
            actor,
          },
        };
      }
    }

    await tx.execute(
      sql`select id from budget_reservations where tenant_id = ${operator.tenantId} and id = ${reservationId} for update`,
    );

    const [reservation] = await tx
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.tenantId, operator.tenantId), eq(budgetReservations.id, reservationId)))
      .limit(1);

    if (!reservation) {
      throw new PlatformUnavailableError(
        "budget_reservation_not_found",
        "config.reservationId does not match a reservation in this tenant.",
        404,
      );
    }
    if (reservation.state !== "held") {
      throw new PlatformUnavailableError(
        "budget_reservation_not_held",
        "Only held reservations can be charged.",
        409,
      );
    }

    const now = new Date();

    if (reservation.expiresAt && reservation.expiresAt <= now) {
      await tx
        .update(budgetReservations)
        .set({ state: "expired", updatedAt: now })
        .where(eq(budgetReservations.id, reservation.id));
      throw new PlatformUnavailableError(
        "budget_reservation_expired",
        "Expired reservations cannot be charged.",
        409,
      );
    }

    const units = input.units === undefined || input.units === null
      ? reservation.units
      : parseUnits(input.units, "config.units");

    if (units !== reservation.units) {
      throw new PlatformUnavailableError(
        "budget_charge_units_mismatch",
        "budget.charge currently charges the full reserved amount only.",
        409,
      );
    }

    await Promise.all([
      assertActor(tx, operator.tenantId, actor),
      assertTask(tx, operator.tenantId, taskId ?? reservation.taskId ?? undefined),
      assertCapability(tx, capabilityId),
    ]);

    const [usage] = await tx
      .insert(usageEvents)
      .values({
        tenantId: operator.tenantId,
        accountId: reservation.accountId,
        reservationId: reservation.id,
        inferenceId,
        taskId: taskId ?? reservation.taskId,
        capabilityId,
        actorType: actor.type,
        actorId: actor.id,
        units,
        costUsd,
        data: {
          reason,
          externalExecution: "blocked",
          ...jsonObject(input.data),
        },
        createdAt: now,
      })
      .returning();

    await tx
      .update(budgetReservations)
      .set({ state: "used", updatedAt: now })
      .where(eq(budgetReservations.id, reservation.id));

    const payload = {
      reservationId: reservation.id,
      usageEventId: usage.id,
      budgetAccountId: reservation.accountId,
      taskId: usage.taskId,
      capabilityId: capabilityId ?? null,
      actor,
      units,
      costUsd,
      reason,
      externalExecution: "blocked",
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "budget.charged",
        source,
        actorType: actor.type,
        actorId: actor.id,
        actorRef: actor.ref,
        taskId: usage.taskId,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:budget_charged`,
        data: payload,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "budget.charged",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "usage_event",
        targetId: usage.id,
        taskId: usage.taskId,
        eventId: event.id,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:budget_charged`,
        data: payload,
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "receipt",
        name: "Budget usage charged",
        taskId: usage.taskId,
        eventId: event.id,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${usage.id}:charged:${now.toISOString()}`,
        data: {
          ...payload,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });

    return {
      charged: true,
      reservationId: reservation.id,
      usageEventId: usage.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      usage: {
        id: usage.id,
        budgetAccountId: usage.accountId,
        reservationId: reservation.id,
        units: usage.units,
        costUsd,
        actor,
      },
    };
  });
}

export async function releaseBudget(input: BudgetReleaseInput): Promise<BudgetReleaseResult> {
  const db = input.db ?? defaultDb;
  const reservationId = requiredUuid(input.reservationId, "config.reservationId");
  const reason = requiredString(input.reason, "config.reason");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({ auditEventId: auditEvents.id, eventId: auditEvents.eventId, targetId: auditEvents.targetId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:budget_released`),
          eq(auditEvents.targetType, "budget_reservation"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [reservation] = await tx
        .select()
        .from(budgetReservations)
        .where(and(eq(budgetReservations.tenantId, operator.tenantId), eq(budgetReservations.id, existingAudit.targetId)))
        .limit(1);

      if (reservation) {
        return {
          released: false,
          reservationId: reservation.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
          reservation: reservationView(reservation),
        };
      }
    }

    await tx.execute(
      sql`select id from budget_reservations where tenant_id = ${operator.tenantId} and id = ${reservationId} for update`,
    );

    const [reservation] = await tx
      .select()
      .from(budgetReservations)
      .where(and(eq(budgetReservations.tenantId, operator.tenantId), eq(budgetReservations.id, reservationId)))
      .limit(1);

    if (!reservation) {
      throw new PlatformUnavailableError(
        "budget_reservation_not_found",
        "config.reservationId does not match a reservation in this tenant.",
        404,
      );
    }
    if (reservation.state !== "held") {
      throw new PlatformUnavailableError(
        "budget_reservation_not_held",
        "Only held reservations can be released.",
        409,
      );
    }

    const now = new Date();
    const [released] = await tx
      .update(budgetReservations)
      .set({ state: "released", updatedAt: now })
      .where(eq(budgetReservations.id, reservation.id))
      .returning();
    const payload = {
      reservationId: reservation.id,
      budgetAccountId: reservation.accountId,
      taskId: reservation.taskId,
      units: reservation.units,
      reason,
      externalExecution: "blocked",
      data: jsonObject(input.data),
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "budget.released",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        taskId: reservation.taskId,
        idempotencyKey: `${input.idempotencyKey}:budget_released`,
        data: payload,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "budget.released",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "budget_reservation",
        targetId: reservation.id,
        taskId: reservation.taskId,
        eventId: event.id,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:budget_released`,
        data: payload,
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: "Budget reservation released",
        taskId: reservation.taskId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${reservation.id}:released:${now.toISOString()}`,
        data: {
          ...payload,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });

    return {
      released: true,
      reservationId: reservation.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
      reservation: reservationView(released),
    };
  });
}
