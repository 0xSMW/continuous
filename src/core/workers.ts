import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  events,
  evidence,
  objects,
  objectVersions,
  users,
  workers,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { assertCoreIdempotencyReplay, coreIdempotencyFingerprint } from "./idempotency";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type WorkerKind = "agent" | "synthetic" | "human" | "robot" | "service";
type WorkerState = "draft" | "training" | "active" | "paused" | "retired";

const source = "continuous.core.workers";
const objectSource = "continuous.core.workers";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const workerKinds = new Set<WorkerKind>(["agent", "synthetic", "human", "robot", "service"]);
const workerStates = new Set<WorkerState>(["draft", "training", "active", "paused", "retired"]);
const workerTransitions: Record<WorkerState, WorkerState[]> = {
  draft: ["training", "retired"],
  training: ["active", "retired"],
  active: ["paused", "retired"],
  paused: ["active", "retired"],
  retired: [],
};

export function canTransitionCoreWorkerState(fromState: string, toState: string) {
  if (!workerStates.has(fromState as WorkerState) || !workerStates.has(toState as WorkerState)) {
    return false;
  }

  return workerTransitions[fromState as WorkerState].includes(toState as WorkerState);
}

export type CoreWorkerUpsertInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  kind?: string;
  state?: string;
  name?: string;
  role?: string;
  mission?: string;
  managerUserId?: unknown;
  scope?: unknown;
  memory?: unknown;
  policy?: unknown;
  kpis?: unknown;
  autonomyLevel?: unknown;
  lifecycle?: unknown;
  evidence?: unknown;
  db?: Database;
};

export type CoreWorkerTransitionInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  state?: string;
  toState?: string;
  reason?: string;
  lifecycle?: unknown;
  evidence?: unknown;
  db?: Database;
};

export type CoreWorkerResult = {
  recorded: boolean;
  created: boolean;
  updated: boolean;
  transitioned: boolean;
  workerId: string;
  objectId: string | null;
  objectVersionId: string | null;
  eventId: string | null;
  evidenceId: string | null;
  auditEventId: string;
  worker: {
    id: string;
    kind: WorkerKind;
    state: WorkerState;
    name: string;
    role: string;
    mission: string;
    managerUserId: string | null;
    autonomyLevel: number;
    retiredAt: string | null;
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
    throw new PlatformUnavailableError("worker_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return value;
}

function parseKind(value: string | undefined, existing?: WorkerKind): WorkerKind {
  if (!value) {
    return existing ?? "synthetic";
  }

  if (workerKinds.has(value as WorkerKind)) {
    return value as WorkerKind;
  }

  throw new PlatformUnavailableError(
    "worker_kind_invalid",
    "config.kind must be agent, synthetic, human, robot, or service.",
    400,
  );
}

function parseState(value: string | undefined, existing?: WorkerState): WorkerState {
  if (!value) {
    return existing ?? "draft";
  }

  if (workerStates.has(value as WorkerState)) {
    return value as WorkerState;
  }

  throw new PlatformUnavailableError(
    "worker_state_invalid",
    "config.state must be draft, training, active, paused, or retired.",
    400,
  );
}

function parseInitialState(value: string | undefined) {
  const state = parseState(value);

  if (state !== "draft" && state !== "training") {
    throw new PlatformUnavailableError(
      "worker_initial_state_invalid",
      "New workers must start in draft or training. Use worker.transition to activate, pause, or retire them.",
      400,
    );
  }

  return state;
}

function parseManagerUserId(value: unknown) {
  if (value === null) {
    return null;
  }

  return optionalUuid(cleanString(value), "config.managerUserId");
}

function parseJsonObject(value: unknown, field: string): JsonObject | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }

  throw new PlatformUnavailableError(
    "worker_payload_invalid",
    `${field} must be an object when provided.`,
    400,
  );
}

function parseAutonomyLevel(value: unknown, existing?: number) {
  if (value === undefined) {
    return existing ?? 1;
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 7) {
    throw new PlatformUnavailableError(
      "worker_autonomy_level_invalid",
      "config.autonomyLevel must be an integer from 0 through 7.",
      400,
    );
  }

  return value;
}

function requiredString(value: string | undefined, field: string) {
  if (!value) {
    throw new PlatformUnavailableError("worker_identity_required", `${field} is required.`, 400);
  }

  return value;
}

function workerView(row: typeof workers.$inferSelect) {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    name: row.name,
    role: row.role,
    mission: row.mission,
    managerUserId: row.managerUserId,
    autonomyLevel: row.autonomyLevel,
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

function riskForState(state: WorkerState) {
  if (state === "active" || state === "retired") {
    return "high" as const;
  }

  if (state === "paused") {
    return "medium" as const;
  }

  return "low" as const;
}

function workerObjectData(row: typeof workers.$inferSelect): JsonObject {
  return {
    workerId: row.id,
    kind: row.kind,
    state: row.state,
    role: row.role,
    mission: row.mission,
    managerUserId: row.managerUserId,
    scope: row.scope,
    memory: row.memory,
    policy: row.policy,
    kpis: row.kpis,
    autonomyLevel: row.autonomyLevel,
    retiredAt: row.retiredAt?.toISOString() ?? null,
  };
}

async function nextObjectVersion(tx: Transaction, objectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('object_version'), hashtext(${objectId}))`);

  const [version] = await tx
    .select({
      value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
    })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId));

  return Number(version?.value ?? 1);
}

async function writeWorkerObject(input: {
  tx: Transaction;
  tenantId: string;
  operatorUserId: string;
  worker: typeof workers.$inferSelect;
  reason: string;
  now: Date;
}) {
  const externalId = `worker:${input.worker.id}`;
  const data = workerObjectData(input.worker);
  const [existingObject] = await input.tx
    .select()
    .from(objects)
    .where(
      and(
        eq(objects.tenantId, input.tenantId),
        eq(objects.source, objectSource),
        eq(objects.externalId, externalId),
      ),
    )
    .limit(1);
  const [object] = existingObject
    ? await input.tx
        .update(objects)
        .set({
          type: "worker",
          name: input.worker.name,
          state: input.worker.state,
          data,
          updatedAt: input.now,
        })
        .where(eq(objects.id, existingObject.id))
        .returning()
    : await input.tx
        .insert(objects)
        .values({
          tenantId: input.tenantId,
          type: "worker",
          name: input.worker.name,
          state: input.worker.state,
          source: objectSource,
          externalId,
          data,
          createdByUserId: input.operatorUserId,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning();
  const versionNumber = await nextObjectVersion(input.tx, object.id);
  const [objectVersion] = await input.tx
    .insert(objectVersions)
    .values({
      tenantId: input.tenantId,
      objectId: object.id,
      version: versionNumber,
      data,
      changedByType: "user",
      changedById: input.operatorUserId,
      reason: input.reason,
    })
    .returning({ id: objectVersions.id, version: objectVersions.version });

  return {
    objectId: object.id,
    objectVersionId: objectVersion.id,
    objectVersion: objectVersion.version,
  };
}

async function latestWorkerObject(input: {
  tx: Transaction;
  tenantId: string;
  workerId: string;
}) {
  const [object] = await input.tx
    .select({ id: objects.id })
    .from(objects)
    .where(
      and(
        eq(objects.tenantId, input.tenantId),
        eq(objects.source, objectSource),
        eq(objects.externalId, `worker:${input.workerId}`),
      ),
    )
    .limit(1);

  if (!object) {
    return {
      objectId: null,
      objectVersionId: null,
    };
  }

  const [version] = await input.tx
    .select({ id: objectVersions.id })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, object.id))
    .orderBy(sql`${objectVersions.version} desc`)
    .limit(1);

  return {
    objectId: object.id,
    objectVersionId: version?.id ?? null,
  };
}

async function validateManager(input: {
  tx: Transaction;
  tenantId: string;
  managerUserId: string | null;
}) {
  if (!input.managerUserId) {
    return;
  }

  const [manager] = await input.tx
    .select({ id: users.id })
    .from(users)
    .where(
      and(
        eq(users.tenantId, input.tenantId),
        eq(users.id, input.managerUserId),
        eq(users.state, "active"),
      ),
    )
    .limit(1);

  if (!manager) {
    throw new PlatformUnavailableError(
      "worker_manager_not_found",
      "config.managerUserId does not match an active user in this tenant.",
      404,
    );
  }
}

export async function upsertCoreWorker(input: CoreWorkerUpsertInput): Promise<CoreWorkerResult> {
  const db = input.db ?? defaultDb;
  const workerId = optionalUuid(cleanString(input.workerId), "config.workerId");
  const requestedKind = cleanString(input.kind);
  const requestedState = cleanString(input.state);
  parseKind(requestedKind);
  if (requestedState) {
    parseState(requestedState);
  }
  if (input.autonomyLevel !== undefined) {
    parseAutonomyLevel(input.autonomyLevel);
  }
  const requestedManagerUserId = parseManagerUserId(input.managerUserId);
  const scope = parseJsonObject(input.scope, "config.scope");
  const memory = parseJsonObject(input.memory, "config.memory");
  const policy = parseJsonObject(input.policy, "config.policy");
  const kpis = parseJsonObject(input.kpis, "config.kpis");
  const lifecycle = parseJsonObject(input.lifecycle, "config.lifecycle") ?? {};
  const evidencePacket = parseJsonObject(input.evidence, "config.evidence") ?? {};
  const name = cleanString(input.name);
  const role = cleanString(input.role);
  const mission = cleanString(input.mission);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("worker.upsert", {
    workerId: workerId ?? null,
    kind: requestedKind ?? null,
    state: requestedState ?? null,
    name: name ?? null,
    role: role ?? null,
    mission: mission ?? null,
    managerUserId: requestedManagerUserId ?? null,
    scope: scope ?? null,
    memory: memory ?? null,
    policy: policy ?? null,
    kpis: kpis ?? null,
    autonomyLevel: typeof input.autonomyLevel === "number" ? input.autonomyLevel : null,
    lifecycle,
    evidence: evidencePacket,
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
        worker: workers,
      })
      .from(auditEvents)
      .innerJoin(workers, eq(auditEvents.targetId, workers.id))
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:worker_upserted`),
          eq(auditEvents.targetType, "worker"),
        ),
      )
      .limit(1);

    if (existingAudit) {
      assertCoreIdempotencyReplay({
        command: "worker.upsert",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const workerObject = await latestWorkerObject({
        tx,
        tenantId: operator.tenantId,
        workerId: existingAudit.worker.id,
      });
      const [existingEvidence] = existingAudit.eventId
        ? await tx
            .select({ id: evidence.id })
            .from(evidence)
            .where(
              and(
                eq(evidence.tenantId, operator.tenantId),
                eq(evidence.eventId, existingAudit.eventId),
              ),
            )
            .limit(1)
        : [];

      return {
        recorded: false,
        created: false,
        updated: false,
        transitioned: false,
        workerId: existingAudit.worker.id,
        objectId: workerObject.objectId,
        objectVersionId: workerObject.objectVersionId,
        eventId: existingAudit.eventId,
        evidenceId: existingEvidence?.id ?? null,
        auditEventId: existingAudit.auditEventId,
        worker: workerView(existingAudit.worker),
      };
    }

    const [existingWorker] = workerId
      ? await tx
          .select()
          .from(workers)
          .where(and(eq(workers.tenantId, operator.tenantId), eq(workers.id, workerId)))
          .limit(1)
      : [];
    const kind = parseKind(requestedKind, existingWorker?.kind);
    const state = existingWorker ? existingWorker.state : parseInitialState(requestedState);

    if (existingWorker && requestedState && requestedState !== existingWorker.state) {
      throw new PlatformUnavailableError(
        "worker_state_transition_required",
        "Use worker.transition to change an existing worker state.",
        409,
      );
    }

    if (!existingWorker) {
      requiredString(name, "config.name");
      requiredString(role, "config.role");
      requiredString(mission, "config.mission");
    }

    const autonomyLevel = parseAutonomyLevel(input.autonomyLevel, existingWorker?.autonomyLevel);
    const managerUserId =
      requestedManagerUserId === undefined
        ? (existingWorker?.managerUserId ?? null)
        : requestedManagerUserId;
    await validateManager({ tx, tenantId: operator.tenantId, managerUserId });

    const now = new Date();
    const before = existingWorker ? workerView(existingWorker) : null;
    const workerValues = {
      tenantId: operator.tenantId,
      managerUserId,
      kind,
      state,
      name: name ?? existingWorker?.name ?? "",
      role: role ?? existingWorker?.role ?? "",
      mission: mission ?? existingWorker?.mission ?? "",
      scope: scope ?? existingWorker?.scope ?? {},
      memory: memory ?? existingWorker?.memory ?? {},
      policy: policy ?? existingWorker?.policy ?? {},
      kpis: kpis ?? existingWorker?.kpis ?? {},
      autonomyLevel,
      retiredAt: state === "retired" ? (existingWorker?.retiredAt ?? now) : null,
      updatedAt: now,
    };
    const [worker] = existingWorker
      ? await tx
          .update(workers)
          .set(workerValues)
          .where(eq(workers.id, existingWorker.id))
          .returning()
      : workerId
        ? await tx
            .insert(workers)
            .values({
              ...workerValues,
              id: workerId,
              createdAt: now,
            })
            .returning()
        : await tx
            .insert(workers)
            .values({
              ...workerValues,
              createdAt: now,
            })
            .returning();
    const workerObject = await writeWorkerObject({
      tx,
      tenantId: operator.tenantId,
      operatorUserId: operator.userId,
      worker,
      reason: existingWorker ? "Core worker updated" : "Core worker created",
      now,
    });
    const after = workerView(worker);
    const eventType = existingWorker ? "worker.updated" : "worker.created";
    const record = {
      worker: after,
      before,
      objectId: workerObject.objectId,
      objectVersionId: workerObject.objectVersionId,
      objectVersion: workerObject.objectVersion,
      lifecycle,
      evidence: evidencePacket,
      idempotency,
      externalExecution: "blocked",
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: eventType,
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: workerObject.objectId,
        idempotencyKey: `${input.idempotencyKey}:worker_upserted`,
        data: record,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [trace] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `${worker.name} worker packet`,
        objectId: workerObject.objectId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        data: record,
        redaction: {
          secretValues: "not_accepted",
        },
      })
      .returning({ id: evidence.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: eventType,
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "worker",
        targetId: worker.id,
        eventId: event.id,
        objectId: workerObject.objectId,
        risk: riskForState(worker.state),
        idempotencyKey: `${input.idempotencyKey}:worker_upserted`,
        data: {
          ...record,
          evidenceId: trace.id,
        },
      })
      .returning({ id: auditEvents.id });
    await tx
      .update(evidence)
      .set({
        data: {
          ...record,
          auditEventId: audit.id,
        },
      })
      .where(eq(evidence.id, trace.id));

    return {
      recorded: true,
      created: !existingWorker,
      updated: Boolean(existingWorker),
      transitioned: false,
      workerId: worker.id,
      objectId: workerObject.objectId,
      objectVersionId: workerObject.objectVersionId,
      eventId: event.id,
      evidenceId: trace.id,
      auditEventId: audit.id,
      worker: after,
    };
  });
}

export async function transitionCoreWorker(
  input: CoreWorkerTransitionInput,
): Promise<CoreWorkerResult> {
  const db = input.db ?? defaultDb;
  const workerId = optionalUuid(cleanString(input.workerId), "config.workerId");
  const toState = parseState(cleanString(input.toState) ?? cleanString(input.state));
  const reason = requiredString(cleanString(input.reason), "config.reason");
  const lifecycle = parseJsonObject(input.lifecycle, "config.lifecycle") ?? {};
  const evidencePacket = parseJsonObject(input.evidence, "config.evidence") ?? {};

  if (!workerId) {
    throw new PlatformUnavailableError("worker_reference_invalid", "config.workerId must be a UUID.", 400);
  }

  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const idempotency = coreIdempotencyFingerprint("worker.transition", {
    workerId,
    toState,
    reason,
    lifecycle,
    evidence: evidencePacket,
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
        worker: workers,
      })
      .from(auditEvents)
      .innerJoin(workers, eq(auditEvents.targetId, workers.id))
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, source),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:worker_transitioned`),
          eq(auditEvents.targetType, "worker"),
        ),
      )
      .limit(1);

    if (existingAudit) {
      assertCoreIdempotencyReplay({
        command: "worker.transition",
        fingerprint: idempotency,
        storedData: existingAudit.data,
      });

      const workerObject = await latestWorkerObject({
        tx,
        tenantId: operator.tenantId,
        workerId: existingAudit.worker.id,
      });
      const [existingEvidence] = existingAudit.eventId
        ? await tx
            .select({ id: evidence.id })
            .from(evidence)
            .where(
              and(
                eq(evidence.tenantId, operator.tenantId),
                eq(evidence.eventId, existingAudit.eventId),
              ),
            )
            .limit(1)
        : [];

      return {
        recorded: false,
        created: false,
        updated: false,
        transitioned: false,
        workerId: existingAudit.worker.id,
        objectId: workerObject.objectId,
        objectVersionId: workerObject.objectVersionId,
        eventId: existingAudit.eventId,
        evidenceId: existingEvidence?.id ?? null,
        auditEventId: existingAudit.auditEventId,
        worker: workerView(existingAudit.worker),
      };
    }

    const [existingWorker] = await tx
      .select()
      .from(workers)
      .where(and(eq(workers.tenantId, operator.tenantId), eq(workers.id, workerId)))
      .limit(1);

    if (!existingWorker) {
      throw new PlatformUnavailableError(
        "worker_not_found",
        "config.workerId does not match a worker in this tenant.",
        404,
      );
    }

    if (!canTransitionCoreWorkerState(existingWorker.state, toState)) {
      throw new PlatformUnavailableError(
        "worker_transition_invalid",
        `Worker state cannot transition from ${existingWorker.state} to ${toState}.`,
        409,
      );
    }

    const now = new Date();
    const [worker] = await tx
      .update(workers)
      .set({
        state: toState,
        retiredAt: toState === "retired" ? (existingWorker.retiredAt ?? now) : null,
        updatedAt: now,
      })
      .where(eq(workers.id, existingWorker.id))
      .returning();
    const workerObject = await writeWorkerObject({
      tx,
      tenantId: operator.tenantId,
      operatorUserId: operator.userId,
      worker,
      reason: `Core worker transition: ${reason}`,
      now,
    });
    const before = workerView(existingWorker);
    const after = workerView(worker);
    const record = {
      worker: after,
      before,
      fromState: existingWorker.state,
      toState,
      reason,
      objectId: workerObject.objectId,
      objectVersionId: workerObject.objectVersionId,
      objectVersion: workerObject.objectVersion,
      lifecycle,
      evidence: evidencePacket,
      idempotency,
      externalExecution: "blocked",
    };
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "worker.transitioned",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: workerObject.objectId,
        idempotencyKey: `${input.idempotencyKey}:worker_transitioned`,
        data: record,
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [trace] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `${worker.name} worker transition`,
        objectId: workerObject.objectId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        data: record,
        redaction: {
          secretValues: "not_accepted",
        },
      })
      .returning({ id: evidence.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "worker.transitioned",
        source,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "worker",
        targetId: worker.id,
        eventId: event.id,
        objectId: workerObject.objectId,
        risk: riskForState(worker.state),
        idempotencyKey: `${input.idempotencyKey}:worker_transitioned`,
        data: {
          ...record,
          evidenceId: trace.id,
        },
      })
      .returning({ id: auditEvents.id });
    await tx
      .update(evidence)
      .set({
        data: {
          ...record,
          auditEventId: audit.id,
        },
      })
      .where(eq(evidence.id, trace.id));

    return {
      recorded: true,
      created: false,
      updated: true,
      transitioned: true,
      workerId: worker.id,
      objectId: workerObject.objectId,
      objectVersionId: workerObject.objectVersionId,
      eventId: event.id,
      evidenceId: trace.id,
      auditEventId: audit.id,
      worker: after,
    };
  });
}
