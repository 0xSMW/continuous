import { createHash } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  auditEvents,
  budgetAccounts,
  capabilities,
  events,
  evidence,
  inferences,
  modelProviders,
  modelRoutes,
  objects,
  tasks,
  usageEvents,
  users,
  workers,
  type JsonObject,
} from "../db/schema";
import { chargeBudget, reserveBudget } from "./budgets";
import { PlatformUnavailableError } from "./errors";
import {
  assertCoreIdempotencyReplay,
  coreIdempotencyFingerprint,
  type CoreIdempotencyFingerprint,
} from "./idempotency";
import { loadOperatorContext } from "./operators";

type Database = typeof defaultDb;
type ActorType = "user" | "worker";

const source = "continuous.core.ai_gateway";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const defaultRedactedKeys = new Set([
  "apiKey",
  "api_key",
  "authorization",
  "authHeader",
  "password",
  "secret",
  "token",
  "accessToken",
  "refreshToken",
]);

export type AiInferInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  routeKey?: string;
  routePurpose?: string;
  budgetAccountId: string;
  maxUnits: unknown;
  costUsd?: unknown;
  actor?: JsonObject;
  taskId?: string;
  objectId?: string;
  capabilityId?: string;
  input?: JsonObject;
  redaction?: JsonObject;
  evaluation?: JsonObject;
  db?: Database;
};

export type AiInferResult = {
  created: boolean;
  idempotencyKey: string;
  inferenceId: string;
  providerId: string | null;
  routeId: string | null;
  budgetAccountId: string | null;
  reservationId: string | null;
  usageEventId: string | null;
  eventId: string | null;
  auditEventId: string | null;
  evidenceId: string | null;
  promptHash: string | null;
  units: number;
  costUsd: string;
  request: JsonObject;
  result: JsonObject;
  safety: JsonObject;
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("ai_gateway_field_required", `${field} is required.`, 400);
  }

  return output;
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError("ai_gateway_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return value;
}

function requiredUuid(value: unknown, field: string) {
  return optionalUuid(requiredString(value, field), field)!;
}

function jsonObject(value: JsonObject | undefined): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : [];
}

function positiveInteger(value: unknown, field: string) {
  const output = typeof value === "number" ? value : Number(value);

  if (!Number.isInteger(output) || output < 1) {
    throw new PlatformUnavailableError("ai_gateway_units_invalid", `${field} must be a positive integer.`, 400);
  }

  return output;
}

function parseCostUsd(value: unknown) {
  if (value === undefined || value === null || value === "") {
    return "0.000000";
  }

  const output = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(output) || output < 0) {
    throw new PlatformUnavailableError("ai_gateway_cost_invalid", "config.costUsd must be a non-negative number.", 400);
  }

  return output.toFixed(6);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableValue(child)]),
    );
  }

  return value;
}

function hashObject(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function redactionFields(input: JsonObject | undefined) {
  const policy = jsonObject(input);
  return new Set([
    ...defaultRedactedKeys,
    ...stringList(policy.fields),
    ...stringList(policy.redactFields),
    ...stringList(policy.sensitiveKeys),
  ]);
}

function redactValue(value: unknown, fields: Set<string>): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, fields));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, child]) => [
        key,
        fields.has(key) || fields.has(key.toLowerCase()) ? "[redacted]" : redactValue(child, fields),
      ]),
    );
  }

  return value;
}

function actorFrom(input: {
  value?: JsonObject;
  operatorUserId: string;
  operatorActorRef: string;
}) {
  const actor = jsonObject(input.value);
  const type = cleanString(actor.type) as ActorType | undefined;

  if (!type) {
    return {
      type: "user" as const,
      id: input.operatorUserId,
      ref: input.operatorActorRef,
    };
  }

  if (type !== "user" && type !== "worker") {
    throw new PlatformUnavailableError(
      "ai_gateway_actor_invalid",
      "config.actor.type must be user or worker.",
      400,
    );
  }

  const id = requiredUuid(actor.id, "config.actor.id");

  return {
    type,
    id,
    ref: cleanString(actor.ref) ?? `${type}:${id}`,
  };
}

async function assertActor(db: Database, tenantId: string, actor: { type: ActorType; id: string }) {
  if (actor.type === "user") {
    const [user] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, actor.id), eq(users.state, "active")))
      .limit(1);

    if (!user) {
      throw new PlatformUnavailableError(
        "ai_gateway_actor_not_found",
        "config.actor.id does not match an active user in this tenant.",
        404,
      );
    }
  }

  if (actor.type === "worker") {
    const [worker] = await db
      .select({ id: workers.id })
      .from(workers)
      .where(and(eq(workers.tenantId, tenantId), eq(workers.id, actor.id)))
      .limit(1);

    if (!worker) {
      throw new PlatformUnavailableError(
        "ai_gateway_actor_not_found",
        "config.actor.id does not match a worker in this tenant.",
        404,
      );
    }
  }
}

async function assertReference(input: {
  db: Database;
  tenantId: string;
  table: "budgetAccount" | "task" | "object" | "capability";
  id?: string;
  field: string;
}) {
  if (!input.id) {
    return;
  }

  if (input.table === "budgetAccount") {
    const [row] = await input.db
      .select({ id: budgetAccounts.id })
      .from(budgetAccounts)
      .where(and(eq(budgetAccounts.tenantId, input.tenantId), eq(budgetAccounts.id, input.id), eq(budgetAccounts.active, true)))
      .limit(1);

    if (!row) {
      throw new PlatformUnavailableError(
        "ai_gateway_reference_not_found",
        `${input.field} does not match an active budget account in this tenant.`,
        404,
      );
    }
  }

  if (input.table === "task") {
    const [row] = await input.db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.tenantId, input.tenantId), eq(tasks.id, input.id)))
      .limit(1);

    if (!row) {
      throw new PlatformUnavailableError(
        "ai_gateway_reference_not_found",
        `${input.field} does not match a task in this tenant.`,
        404,
      );
    }
  }

  if (input.table === "object") {
    const [row] = await input.db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.tenantId, input.tenantId), eq(objects.id, input.id)))
      .limit(1);

    if (!row) {
      throw new PlatformUnavailableError(
        "ai_gateway_reference_not_found",
        `${input.field} does not match an object in this tenant.`,
        404,
      );
    }
  }

  if (input.table === "capability") {
    const [row] = await input.db
      .select({ id: capabilities.id })
      .from(capabilities)
      .where(and(eq(capabilities.id, input.id), eq(capabilities.active, true)))
      .limit(1);

    if (!row) {
      throw new PlatformUnavailableError(
        "ai_gateway_reference_not_found",
        `${input.field} does not match an active capability.`,
        404,
      );
    }
  }
}

async function routeFor(input: {
  db: Database;
  tenantId: string;
  routeKey?: string;
  routePurpose?: string;
}) {
  const routeKey = cleanString(input.routeKey);
  const routePurpose = cleanString(input.routePurpose) ?? "default";
  const rows = await input.db
    .select({
      routeId: modelRoutes.id,
      routeTenantId: modelRoutes.tenantId,
      routeKey: modelRoutes.key,
      routeName: modelRoutes.name,
      purpose: modelRoutes.purpose,
      model: modelRoutes.model,
      rules: modelRoutes.rules,
      providerId: modelProviders.id,
      providerKey: modelProviders.key,
      providerName: modelProviders.name,
      providerKind: modelProviders.kind,
      providerConfig: modelProviders.config,
    })
    .from(modelRoutes)
    .innerJoin(modelProviders, eq(modelRoutes.providerId, modelProviders.id))
    .where(and(eq(modelRoutes.active, true), eq(modelProviders.active, true)))
    .orderBy(modelRoutes.createdAt);
  const candidates = rows.filter(
    (row) =>
      (row.routeTenantId === input.tenantId || row.routeTenantId === null) &&
      (routeKey ? row.routeKey === routeKey : row.purpose === routePurpose),
  );
  const route = candidates.find((row) => row.routeTenantId === input.tenantId) ?? candidates[0];

  if (!route) {
    throw new PlatformUnavailableError(
      "ai_gateway_route_not_found",
      routeKey
        ? "config.routeKey does not match an active model route in this tenant."
        : "config.routePurpose does not match an active model route in this tenant.",
      404,
    );
  }

  return route;
}

async function replayedInference(input: {
  db: Database;
  tenantId: string;
  idempotencyKey: string;
  fingerprint: CoreIdempotencyFingerprint;
}) {
  const [audit] = await input.db
    .select({
      auditEventId: auditEvents.id,
      eventId: auditEvents.eventId,
      targetId: auditEvents.targetId,
      data: auditEvents.data,
    })
    .from(auditEvents)
    .where(
      and(
        eq(auditEvents.tenantId, input.tenantId),
        eq(auditEvents.source, source),
        eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:ai_infer`),
        eq(auditEvents.targetType, "inference"),
      ),
    )
    .limit(1);

  if (!audit?.targetId) {
    return null;
  }

  assertCoreIdempotencyReplay({
    command: "ai.infer",
    fingerprint: input.fingerprint,
    storedData: audit.data,
  });

  const [inference] = await input.db
    .select()
    .from(inferences)
    .where(and(eq(inferences.tenantId, input.tenantId), eq(inferences.id, audit.targetId)))
    .limit(1);

  if (!inference) {
    return null;
  }

  const [usage] = await input.db
    .select({ id: usageEvents.id, reservationId: usageEvents.reservationId })
    .from(usageEvents)
    .where(and(eq(usageEvents.tenantId, input.tenantId), eq(usageEvents.inferenceId, inference.id)))
    .limit(1);
  const [proof] = await input.db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, input.tenantId), sql`${evidence.data}->>'auditEventId' = ${audit.auditEventId}`))
    .limit(1);

  return {
    created: false,
    idempotencyKey: input.idempotencyKey,
    inferenceId: inference.id,
    providerId: inference.providerId,
    routeId: inference.routeId,
    budgetAccountId: inference.budgetAccountId,
    reservationId: usage?.reservationId ?? null,
    usageEventId: usage?.id ?? null,
    eventId: audit.eventId,
    auditEventId: audit.auditEventId,
    evidenceId: proof?.id ?? null,
    promptHash: inference.promptHash,
    units: inference.units,
    costUsd: String(inference.costUsd),
    request: inference.request,
    result: inference.result,
    safety: inference.safety,
  } satisfies AiInferResult;
}

export async function executeAiInference(input: AiInferInput): Promise<AiInferResult> {
  const db = input.db ?? defaultDb;
  const idempotencyKey = requiredString(input.idempotencyKey, "idempotencyKey");
  const budgetAccountId = requiredUuid(input.budgetAccountId, "config.budgetAccountId");
  const taskId = optionalUuid(cleanString(input.taskId), "config.taskId");
  const objectId = optionalUuid(cleanString(input.objectId), "config.objectId");
  const capabilityId = optionalUuid(cleanString(input.capabilityId), "config.capabilityId");
  const maxUnits = positiveInteger(input.maxUnits, "config.maxUnits");
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
  const routeSelector = {
    routeKey: cleanString(input.routeKey) ?? null,
    routePurpose: cleanString(input.routePurpose) ?? "default",
  };
  const rawInput = jsonObject(input.input);
  const redaction = jsonObject(input.redaction);
  const evaluation = jsonObject(input.evaluation);
  const idempotency = coreIdempotencyFingerprint("ai.infer", {
    ...routeSelector,
    budgetAccountId,
    maxUnits,
    costUsd,
    actor,
    taskId: taskId ?? null,
    objectId: objectId ?? null,
    capabilityId: capabilityId ?? null,
    input: rawInput,
    redaction,
    evaluation,
  });
  const replay = await replayedInference({
    db,
    tenantId: operator.tenantId,
    idempotencyKey,
    fingerprint: idempotency,
  });

  if (replay) {
    return replay;
  }

  await Promise.all([
    assertActor(db, operator.tenantId, actor),
    assertReference({ db, tenantId: operator.tenantId, table: "budgetAccount", id: budgetAccountId, field: "config.budgetAccountId" }),
    assertReference({ db, tenantId: operator.tenantId, table: "task", id: taskId, field: "config.taskId" }),
    assertReference({ db, tenantId: operator.tenantId, table: "object", id: objectId, field: "config.objectId" }),
    assertReference({ db, tenantId: operator.tenantId, table: "capability", id: capabilityId, field: "config.capabilityId" }),
  ]);

  const route = await routeFor({
    db,
    tenantId: operator.tenantId,
    routeKey: routeSelector.routeKey ?? undefined,
    routePurpose: routeSelector.routePurpose,
  });
  const fields = redactionFields(redaction);
  const redactedInput = redactValue(rawInput, fields) as JsonObject;
  const redactedInputRefs = objectValue(redactValue(rawInput.inputRefs, fields));
  const promptHash = hashObject({
    routeKey: route.routeKey,
    model: route.model,
    input: redactedInput,
  });
  const request = {
    route: {
      key: route.routeKey,
      purpose: route.purpose,
      model: route.model,
      provider: route.providerKey,
    },
    input: redactedInput,
    inputRefs: redactedInputRefs,
    redaction: {
      mode: cleanString(input.redaction?.mode) ?? "key_redaction",
      fields: Array.from(fields).sort(),
    },
    evaluation,
    maxUnits,
    externalExecution: "blocked",
  };
  const safety = {
    providerExecution: "disabled",
    externalExecution: "blocked",
    liveProviderCall: false,
    routeRules: objectValue(route.rules),
    redaction: {
      applied: true,
      fields: Array.from(fields).sort(),
    },
    policy: {
      maxUnits,
      costUsd,
      budgetAccountId,
    },
  };
  const result = {
    mode: "deterministic",
    content: `deterministic:${promptHash.slice(0, 16)}`,
    routeKey: route.routeKey,
    model: route.model,
    provider: route.providerKey,
    externalExecution: "blocked",
  };
  const reservation = await reserveBudget({
    operatorEmail: input.operatorEmail,
    tenantSlug: operator.tenantSlug,
    idempotencyKey: `${idempotencyKey}:reserve`,
    budgetAccountId,
    units: maxUnits,
    taskId,
    capabilityId,
    reason: "Core AI gateway inference reservation",
    data: {
      routeKey: route.routeKey,
      routePurpose: route.purpose,
      promptHash,
      externalExecution: "blocked",
    },
  });
  const [inference] = await db
    .insert(inferences)
    .values({
      tenantId: operator.tenantId,
      providerId: route.providerId,
      routeId: route.routeId,
      budgetAccountId,
      taskId,
      capabilityId,
      actorType: actor.type,
      actorId: actor.id,
      promptHash,
      request,
      result,
      safety,
      promptTokens: maxUnits,
      completionTokens: 0,
      units: maxUnits,
      costUsd,
    })
    .returning();
  const usage = await chargeBudget({
    operatorEmail: input.operatorEmail,
    tenantSlug: operator.tenantSlug,
    idempotencyKey: `${idempotencyKey}:charge`,
    reservationId: reservation.reservationId,
    units: maxUnits,
    costUsd,
    actor,
    taskId,
    capabilityId,
    inferenceId: inference.id,
    reason: "Core AI gateway deterministic inference",
    data: {
      routeKey: route.routeKey,
      routePurpose: route.purpose,
      promptHash,
      providerExecution: "disabled",
      externalExecution: "blocked",
    },
  });
  const persistedResult = {
    ...result,
    usageEventId: usage.usageEventId,
    reservationId: reservation.reservationId,
  };
  const [updatedInference] = await db
    .update(inferences)
    .set({ result: persistedResult })
    .where(eq(inferences.id, inference.id))
    .returning();
  const payload = {
    inferenceId: inference.id,
    providerId: route.providerId,
    routeId: route.routeId,
    routeKey: route.routeKey,
    routePurpose: route.purpose,
    budgetAccountId,
    reservationId: reservation.reservationId,
    usageEventId: usage.usageEventId,
    promptHash,
    units: maxUnits,
    costUsd,
    actor,
    providerExecution: "disabled",
    externalExecution: "blocked",
    idempotency,
  };
  const [event] = await db
    .insert(events)
    .values({
      tenantId: operator.tenantId,
      type: "ai.inference.completed",
      source,
      actorType: actor.type,
      actorId: actor.id,
      actorRef: actor.ref,
      objectId,
      taskId,
      capabilityId,
      idempotencyKey: `${idempotencyKey}:ai_infer`,
      data: payload,
    })
    .returning({ id: events.id });
  const [audit] = await db
    .insert(auditEvents)
    .values({
      tenantId: operator.tenantId,
      type: "ai.inference.completed",
      source,
      actorType: "user",
      actorId: operator.userId,
      actorRef: operator.actorRef,
      targetType: "inference",
      targetId: inference.id,
      taskId,
      objectId,
      eventId: event.id,
      capabilityId,
      risk: "medium",
      idempotencyKey: `${idempotencyKey}:ai_infer`,
      data: payload,
    })
    .returning({ id: auditEvents.id });
  const [proof] = await db
    .insert(evidence)
    .values({
      tenantId: operator.tenantId,
      kind: "trace",
      name: "Core AI gateway deterministic inference",
      objectId,
      taskId,
      eventId: event.id,
      capabilityId,
      actorType: "user",
      actorId: operator.userId,
      hash: `${source}:${inference.id}:${promptHash}`,
      data: {
        ...payload,
        auditEventId: audit.id,
        redactedRequest: request,
      },
      redaction: {
        applied: true,
        fields: Array.from(fields).sort(),
      },
    })
    .returning({ id: evidence.id });

  return {
    created: true,
    idempotencyKey,
    inferenceId: inference.id,
    providerId: inference.providerId,
    routeId: inference.routeId,
    budgetAccountId: inference.budgetAccountId,
    reservationId: reservation.reservationId,
    usageEventId: usage.usageEventId,
    eventId: event.id,
    auditEventId: audit.id,
    evidenceId: proof.id,
    promptHash: inference.promptHash,
    units: inference.units,
    costUsd: String(inference.costUsd),
    request: updatedInference.request,
    result: updatedInference.result,
    safety: updatedInference.safety,
  };
}
