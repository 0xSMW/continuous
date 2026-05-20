import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  capabilities,
  events,
  evidence,
  objects,
  tasks,
  users,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type TaskPriority = "low" | "normal" | "high" | "urgent";
type TaskState = "draft" | "active" | "waiting" | "approval_required" | "blocked";
type TransitionTaskState = Exclude<TaskState, "draft"> | "done" | "canceled";
type OwnerType = "user" | "worker" | "system";

const source = "continuous.core.tasks";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const taskPriorities = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);
const taskStates = new Set<TaskState>(["draft", "active", "waiting", "approval_required", "blocked"]);
const transitionTaskStates = new Set<TransitionTaskState>([
  "active",
  "waiting",
  "approval_required",
  "blocked",
  "done",
  "canceled",
]);
const ownerTypes = new Set<OwnerType>(["user", "worker", "system"]);

export type CoreTaskCreateInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  title: string;
  objectId?: string;
  capabilityId?: string;
  triggerEventId?: string;
  state?: string;
  priority?: string;
  owner?: JsonObject;
  ownerRef?: string;
  reviewerUserId?: string;
  dueAt?: string;
  evidence?: JsonObject;
  outcome?: JsonObject;
  cost?: JsonObject;
  kpi?: JsonObject;
  db?: Database;
};

export type CoreTaskCreateResult = {
  created: boolean;
  taskId: string;
  eventId: string | null;
  auditEventId: string;
  task: {
    id: string;
    title: string;
    state: string;
    priority: string;
    ownerRef: string;
    dueAt: string | null;
  };
};

export type CoreTaskTransitionInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  taskId: string;
  toState?: string;
  state?: string;
  reason?: string;
  evidence?: JsonObject;
  outcome?: JsonObject;
  cost?: JsonObject;
  kpi?: JsonObject;
  db?: Database;
};

export type CoreTaskTransitionResult = {
  transitioned: boolean;
  taskId: string;
  eventId: string | null;
  auditEventId: string;
  evidenceId: string | null;
  task: {
    id: string;
    title: string;
    state: string;
    priority: string;
    ownerRef: string;
    dueAt: string | null;
  };
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError(
      "task_reference_invalid",
      `${field} must be a UUID.`,
      400,
    );
  }

  return value;
}

function parsePriority(value: string | undefined): TaskPriority {
  if (!value) {
    return "normal";
  }

  if (taskPriorities.has(value as TaskPriority)) {
    return value as TaskPriority;
  }

  throw new PlatformUnavailableError(
    "task_priority_invalid",
    "Task priority must be low, normal, high, or urgent.",
    400,
  );
}

function parseState(value: string | undefined): TaskState {
  if (!value) {
    return "active";
  }

  if (taskStates.has(value as TaskState)) {
    return value as TaskState;
  }

  throw new PlatformUnavailableError(
    "task_state_invalid",
    "Task state must be draft, active, waiting, approval_required, or blocked on create.",
    400,
  );
}

function parseTransitionState(value: string | undefined): TransitionTaskState {
  if (!value) {
    throw new PlatformUnavailableError("task_state_required", "config.state is required.", 400);
  }

  if (transitionTaskStates.has(value as TransitionTaskState)) {
    return value as TransitionTaskState;
  }

  throw new PlatformUnavailableError(
    "task_state_invalid",
    "config.toState must be active, waiting, approval_required, blocked, done, or canceled.",
    400,
  );
}

function parseDueAt(value: string | undefined) {
  if (!value) {
    return null;
  }

  const dueAt = new Date(value);

  if (Number.isNaN(dueAt.getTime())) {
    throw new PlatformUnavailableError("task_due_at_invalid", "config.dueAt must be an ISO date.", 400);
  }

  return dueAt;
}

function parseOwner(input: {
  owner?: JsonObject;
  ownerRef?: string;
  operatorUserId: string;
  operatorActorRef: string;
}) {
  const owner = input.owner ?? {};
  const requestedType = cleanString(owner.type);
  const ownerType = requestedType && ownerTypes.has(requestedType as OwnerType)
    ? (requestedType as OwnerType)
    : "user";
  const ownerId =
    optionalUuid(cleanString(owner.id), "config.owner.id") ??
    (ownerType === "user" ? input.operatorUserId : undefined);
  const ownerRef =
    cleanString(input.ownerRef) ??
    cleanString(owner.ref) ??
    (ownerType === "user" ? input.operatorActorRef : ownerType);

  if (requestedType && !ownerTypes.has(requestedType as OwnerType)) {
    throw new PlatformUnavailableError(
      "task_owner_type_invalid",
      "config.owner.type must be user, worker, or system.",
      400,
    );
  }

  return {
    ownerType,
    ownerId: ownerType === "system" ? undefined : ownerId,
    ownerRef,
  };
}

function riskForPriority(priority: TaskPriority) {
  if (priority === "urgent") {
    return "high";
  }

  if (priority === "high") {
    return "medium";
  }

  return "low";
}

function taskView(row: typeof tasks.$inferSelect) {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    priority: row.priority,
    ownerRef: row.ownerRef,
    dueAt: row.dueAt?.toISOString() ?? null,
  };
}

function mergeJson(base: JsonObject, update: JsonObject | undefined): JsonObject {
  return update ? { ...base, ...update } : base;
}

export async function createCoreTask(input: CoreTaskCreateInput): Promise<CoreTaskCreateResult> {
  const db = input.db ?? defaultDb;
  const title = cleanString(input.title);

  if (!title) {
    throw new PlatformUnavailableError("task_title_required", "config.title is required.", 400);
  }

  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const priority = parsePriority(input.priority);
  const state = parseState(input.state);
  const dueAt = parseDueAt(input.dueAt);
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const triggerEventId = optionalUuid(input.triggerEventId, "config.triggerEventId");
  const reviewerUserId = optionalUuid(input.reviewerUserId, "config.reviewerUserId");
  const owner = parseOwner({
    owner: input.owner,
    ownerRef: input.ownerRef,
    operatorUserId: operator.userId,
    operatorActorRef: operator.actorRef,
  });
  const idempotency = coreIdempotencyFingerprint("task.create", {
    title,
    objectId: objectId ?? null,
    capabilityId: capabilityId ?? null,
    triggerEventId: triggerEventId ?? null,
    state,
    priority,
    owner: {
      type: owner.ownerType,
      id: owner.ownerId ?? null,
      ref: owner.ownerRef,
    },
    reviewerUserId: reviewerUserId ?? null,
    dueAt: dueAt?.toISOString() ?? null,
    evidence: input.evidence ?? {},
    outcome: input.outcome ?? {},
    cost: input.cost ?? {},
    kpi: input.kpi ?? {},
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        eventId: auditEvents.eventId,
        data: auditEvents.data,
        task: tasks,
      })
      .from(auditEvents)
      .innerJoin(tasks, eq(auditEvents.targetId, tasks.id))
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:task_created`),
          eq(auditEvents.targetType, "task"),
        ),
      )
      .limit(1);

    if (existingAudit) {
      assertCoreIdempotencyReplay({
        command: "task.create",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      return {
        created: false,
        taskId: existingAudit.task.id,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
        task: taskView(existingAudit.task),
      };
    }

    if (objectId) {
      const [object] = await tx
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, objectId)))
        .limit(1);

      if (!object) {
        throw new PlatformUnavailableError(
          "task_object_not_found",
          "config.objectId does not match an object in this tenant.",
          404,
        );
      }
    }

    if (capabilityId) {
      const [capability] = await tx
        .select({ id: capabilities.id })
        .from(capabilities)
        .where(and(eq(capabilities.id, capabilityId), eq(capabilities.active, true)))
        .limit(1);

      if (!capability) {
        throw new PlatformUnavailableError(
          "task_capability_not_found",
          "config.capabilityId does not match an active capability.",
          404,
        );
      }
    }

    if (reviewerUserId) {
      const [reviewer] = await tx
        .select({ id: users.id })
        .from(users)
        .where(
          and(
            eq(users.tenantId, operator.tenantId),
            eq(users.id, reviewerUserId),
            eq(users.state, "active"),
          ),
        )
        .limit(1);

      if (!reviewer) {
        throw new PlatformUnavailableError(
          "task_reviewer_not_found",
          "config.reviewerUserId does not match an active user in this tenant.",
          404,
        );
      }
    }

    const now = new Date();
    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: operator.tenantId,
        objectId,
        capabilityId,
        triggerEventId,
        title,
        state,
        priority,
        ownerType: owner.ownerType,
        ownerId: owner.ownerId,
        ownerRef: owner.ownerRef,
        reviewerUserId,
        dueAt,
        evidence: input.evidence ?? {},
        outcome: input.outcome ?? {},
        cost: input.cost ?? {},
        kpi: input.kpi ?? {},
        createdAt: now,
        updatedAt: now,
      })
      .returning();

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "task.created",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: task.objectId,
        taskId: task.id,
        capabilityId: task.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:task_created`,
        data: {
          taskId: task.id,
          title: task.title,
          state: task.state,
          priority: task.priority,
          ownerRef: task.ownerRef,
          reviewerUserId: task.reviewerUserId ?? null,
          dueAt: task.dueAt?.toISOString() ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "task.created",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "task",
        targetId: task.id,
        taskId: task.id,
        eventId: event.id,
        objectId: task.objectId,
        capabilityId: task.capabilityId,
        risk: riskForPriority(priority),
        idempotencyKey: `${input.idempotencyKey}:task_created`,
        data: {
          title: task.title,
          state: task.state,
          priority: task.priority,
          owner: {
            type: owner.ownerType,
            id: owner.ownerId ?? null,
            ref: owner.ownerRef,
          },
          triggerEventId: task.triggerEventId ?? null,
          idempotency,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      taskId: task.id,
      eventId: event.id,
      auditEventId: audit.id,
      task: taskView(task),
    };
  });
}

export async function transitionCoreTask(
  input: CoreTaskTransitionInput,
): Promise<CoreTaskTransitionResult> {
  const db = input.db ?? defaultDb;
  const taskId = optionalUuid(cleanString(input.taskId), "config.taskId");

  if (!taskId) {
    throw new PlatformUnavailableError("task_reference_invalid", "config.taskId must be a UUID.", 400);
  }

  const nextState = parseTransitionState(cleanString(input.toState) ?? cleanString(input.state));
  const reason = cleanString(input.reason);

  if (!reason) {
    throw new PlatformUnavailableError("task_reason_required", "config.reason is required.", 400);
  }

  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("task.transition", {
    taskId,
    toState: nextState,
    reason,
    evidence: input.evidence ?? {},
    outcome: input.outcome ?? {},
    cost: input.cost ?? {},
    kpi: input.kpi ?? {},
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        eventId: auditEvents.eventId,
        data: auditEvents.data,
        task: tasks,
      })
      .from(auditEvents)
      .innerJoin(tasks, eq(auditEvents.targetId, tasks.id))
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:task_transitioned`),
          eq(auditEvents.targetType, "task"),
        ),
      )
      .limit(1);

    if (existingAudit) {
      assertCoreIdempotencyReplay({
        command: "task.transition",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const [transitionEvidence] = await tx
        .select({ id: evidence.id })
        .from(evidence)
        .where(
          and(
            eq(evidence.tenantId, operator.tenantId),
            sql`${evidence.data}->>'auditEventId' = ${existingAudit.auditEventId}`,
          ),
        )
        .limit(1);

      return {
        transitioned: false,
        taskId: existingAudit.task.id,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
        evidenceId: transitionEvidence?.id ?? null,
        task: taskView(existingAudit.task),
      };
    }

    const [task] = await tx
      .select()
      .from(tasks)
      .where(and(eq(tasks.tenantId, operator.tenantId), eq(tasks.id, taskId)))
      .limit(1);

    if (!task) {
      throw new PlatformUnavailableError(
        "task_not_found",
        "config.taskId does not match a task in this tenant.",
        404,
      );
    }

    if ((task.state === "done" || task.state === "canceled") && task.state !== nextState) {
      throw new PlatformUnavailableError(
        "task_terminal",
        "Done or canceled tasks cannot transition to another state.",
        409,
      );
    }

    const now = new Date();
    const [updatedTask] = await tx
      .update(tasks)
      .set({
        state: nextState,
        evidence: mergeJson(task.evidence, input.evidence),
        outcome: mergeJson(task.outcome, input.outcome),
        cost: mergeJson(task.cost, input.cost),
        kpi: mergeJson(task.kpi, input.kpi),
        updatedAt: now,
        doneAt: nextState === "done" ? (task.doneAt ?? now) : task.doneAt,
        canceledAt: nextState === "canceled" ? (task.canceledAt ?? now) : task.canceledAt,
      })
      .where(eq(tasks.id, task.id))
      .returning();
    const transition = {
      taskId: task.id,
      fromState: task.state,
      toState: nextState,
      reason,
      idempotency,
      externalExecution: "blocked",
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "task.transitioned",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: task.objectId,
        taskId: task.id,
        capabilityId: task.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:task_transitioned`,
        data: transition,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "task.transitioned",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "task",
        targetId: task.id,
        taskId: task.id,
        eventId: event.id,
        objectId: task.objectId,
        capabilityId: task.capabilityId,
        risk: riskForPriority(task.priority),
        idempotencyKey: `${input.idempotencyKey}:task_transitioned`,
        data: transition,
      })
      .returning({ id: auditEvents.id });
    const [transitionEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Task transition ${task.state} to ${nextState}`,
        objectId: task.objectId,
        taskId: task.id,
        eventId: event.id,
        capabilityId: task.capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${source}:${task.id}:${task.state}:${nextState}:${now.toISOString()}`,
        data: {
          ...transition,
          auditEventId: audit.id,
        },
      })
      .returning({ id: evidence.id });

    return {
      transitioned: true,
      taskId: updatedTask.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: transitionEvidence.id,
      task: taskView(updatedTask),
    };
  });
}
