import { and, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapters,
  auditEvents,
  capabilities,
  connections,
  decisions,
  documents,
  events,
  evidence,
  objects,
  objectVersions,
  tasks,
  workflowRuns,
  type JsonObject,
} from "../db/schema";
import { PlatformUnavailableError } from "./errors";
import { loadOperatorContext, type OperatorContext } from "./operators";

type Database = typeof defaultDb;
type QueryClient = Pick<Database, "execute" | "select">;
type ActorType = "user" | "worker" | "adapter" | "system";
type EvidenceKind = "snapshot" | "draft" | "approval" | "receipt" | "trace" | "export" | "note";
type RiskLevel = "low" | "medium" | "high" | "critical";

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actorTypes = new Set<ActorType>(["user", "worker", "adapter", "system"]);
const evidenceKinds = new Set<EvidenceKind>([
  "snapshot",
  "draft",
  "approval",
  "receipt",
  "trace",
  "export",
  "note",
]);
const riskLevels = new Set<RiskLevel>(["low", "medium", "high", "critical"]);

const objectSource = "continuous.core.objects";
const eventSource = "continuous.core.events";
const evidenceSource = "continuous.core.evidence";
const documentSource = "continuous.core.documents";
const decisionSource = "continuous.core.decisions";

export type ActorInput = {
  type?: string;
  id?: string;
  ref?: string;
};

export type CoreObjectUpsertInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  objectId?: string;
  type: string;
  name: string;
  state?: string;
  source?: string;
  externalId?: string;
  data?: JsonObject;
  effectiveAt?: string;
  archivedAt?: string;
  reason?: string;
  version?: JsonObject;
  db?: Database;
};

export type CoreEventIngestInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  type: string;
  source?: string;
  actor?: ActorInput;
  objectId?: string;
  taskId?: string;
  capabilityId?: string;
  adapterId?: string;
  connectionId?: string;
  data?: JsonObject;
  occurredAt?: string;
  db?: Database;
};

export type CoreEvidenceAttachInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  name: string;
  actor?: ActorInput;
  objectId?: string;
  taskId?: string;
  eventId?: string;
  capabilityId?: string;
  uri?: string;
  hash?: string;
  data?: JsonObject;
  redaction?: JsonObject;
  retainedUntil?: string;
  db?: Database;
};

export type CoreDocumentCreateInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  name: string;
  state?: string;
  sensitivity?: string;
  objectId?: string;
  workflowRunId?: string;
  hash?: string;
  data?: JsonObject;
  retainedUntil?: string;
  db?: Database;
};

export type CoreDecisionRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  decision: string;
  rationale?: string;
  state?: string;
  actor?: ActorInput;
  taskId?: string;
  eventId?: string;
  workflowRunId?: string;
  capabilityId?: string;
  data?: JsonObject;
  db?: Database;
};

function cleanString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function requiredString(value: unknown, field: string) {
  const output = cleanString(value);

  if (!output) {
    throw new PlatformUnavailableError("core_field_required", `${field} is required.`, 400);
  }

  return output;
}

function jsonObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function optionalUuid(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  if (!uuidPattern.test(value)) {
    throw new PlatformUnavailableError(
      "core_reference_invalid",
      `${field} must be a UUID.`,
      400,
    );
  }

  return value;
}

function optionalDate(value: string | undefined, field: string) {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new PlatformUnavailableError("core_date_invalid", `${field} must be an ISO date.`, 400);
  }

  return date;
}

function parseActor(actor: ActorInput | undefined, operator: OperatorContext) {
  const requestedType = cleanString(actor?.type);
  const type = requestedType && actorTypes.has(requestedType as ActorType)
    ? (requestedType as ActorType)
    : "user";

  if (requestedType && !actorTypes.has(requestedType as ActorType)) {
    throw new PlatformUnavailableError(
      "core_actor_type_invalid",
      "config.actor.type must be user, worker, adapter, or system.",
      400,
    );
  }

  const id =
    optionalUuid(cleanString(actor?.id), "config.actor.id") ??
    (type === "user" ? operator.userId : undefined);
  const ref = cleanString(actor?.ref) ?? (type === "user" ? operator.actorRef : type);

  return {
    type,
    id: type === "system" ? undefined : id,
    ref,
  };
}

function parseEvidenceKind(value: string) {
  if (evidenceKinds.has(value as EvidenceKind)) {
    return value as EvidenceKind;
  }

  throw new PlatformUnavailableError(
    "core_evidence_kind_invalid",
    "config.kind must be snapshot, draft, approval, receipt, trace, export, or note.",
    400,
  );
}

function parseRisk(value: string | undefined) {
  if (!value) {
    return "medium" as const;
  }

  if (riskLevels.has(value as RiskLevel)) {
    return value as RiskLevel;
  }

  throw new PlatformUnavailableError(
    "core_risk_invalid",
    "config.sensitivity must be low, medium, high, or critical.",
    400,
  );
}

async function assertObject(tx: QueryClient, tenantId: string, objectId?: string) {
  if (!objectId) {
    return;
  }

  const [object] = await tx
    .select({ id: objects.id })
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, objectId)))
    .limit(1);

  if (!object) {
    throw new PlatformUnavailableError(
      "core_object_not_found",
      "config.objectId does not match an object in this tenant.",
      404,
    );
  }
}

async function assertTask(tx: QueryClient, tenantId: string, taskId?: string) {
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
      "core_task_not_found",
      "config.taskId does not match a task in this tenant.",
      404,
    );
  }
}

async function assertEvent(tx: QueryClient, tenantId: string, eventId?: string) {
  if (!eventId) {
    return;
  }

  const [event] = await tx
    .select({ id: events.id })
    .from(events)
    .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
    .limit(1);

  if (!event) {
    throw new PlatformUnavailableError(
      "core_event_not_found",
      "config.eventId does not match an event in this tenant.",
      404,
    );
  }
}

async function assertCapability(tx: QueryClient, capabilityId?: string) {
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
      "core_capability_not_found",
      "config.capabilityId does not match an active capability.",
      404,
    );
  }
}

async function assertAdapter(tx: QueryClient, adapterId?: string) {
  if (!adapterId) {
    return;
  }

  const [adapter] = await tx
    .select({ id: adapters.id })
    .from(adapters)
    .where(eq(adapters.id, adapterId))
    .limit(1);

  if (!adapter) {
    throw new PlatformUnavailableError(
      "core_adapter_not_found",
      "config.adapterId does not match an adapter.",
      404,
    );
  }
}

async function assertConnection(tx: QueryClient, tenantId: string, connectionId?: string) {
  if (!connectionId) {
    return;
  }

  const [connection] = await tx
    .select({ id: connections.id })
    .from(connections)
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  if (!connection) {
    throw new PlatformUnavailableError(
      "core_connection_not_found",
      "config.connectionId does not match a connection in this tenant.",
      404,
    );
  }
}

async function assertWorkflowRun(tx: QueryClient, tenantId: string, workflowRunId?: string) {
  if (!workflowRunId) {
    return;
  }

  const [run] = await tx
    .select({ id: workflowRuns.id })
    .from(workflowRuns)
    .where(and(eq(workflowRuns.tenantId, tenantId), eq(workflowRuns.id, workflowRunId)))
    .limit(1);

  if (!run) {
    throw new PlatformUnavailableError(
      "core_workflow_run_not_found",
      "config.workflowRunId does not match a workflow run in this tenant.",
      404,
    );
  }
}

async function nextObjectVersion(tx: QueryClient, objectId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('object_version'), hashtext(${objectId}))`);

  const [version] = await tx
    .select({
      value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
    })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId));

  return Number(version?.value ?? 1);
}

export async function upsertCoreObject(input: CoreObjectUpsertInput) {
  const db = input.db ?? defaultDb;
  const type = requiredString(input.type, "config.type");
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "active";
  const objectRecordSource = cleanString(input.source) ?? "continuous";
  const externalId = cleanString(input.externalId);
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const effectiveAt = optionalDate(input.effectiveAt, "config.effectiveAt");
  const archivedAt = optionalDate(input.archivedAt, "config.archivedAt");
  const objectData = jsonObject(input.data);
  const version = jsonObject(input.version);
  const versionData = jsonObject(version.data ?? objectData);
  const reason = cleanString(input.reason) ?? cleanString(version.reason) ?? "Core object upsert";
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${objectSource}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({ auditEventId: auditEvents.id, targetId: auditEvents.targetId, eventId: auditEvents.eventId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, objectSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:object_upserted`),
          eq(auditEvents.targetType, "object"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [object] = await tx
        .select()
        .from(objects)
        .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, existingAudit.targetId)))
        .limit(1);
      const [latestVersion] = await tx
        .select({ version: sql<number>`coalesce(max(${objectVersions.version}), 0)` })
        .from(objectVersions)
        .where(eq(objectVersions.objectId, existingAudit.targetId));

      if (object) {
        return {
          created: false,
          updated: false,
          objectId: object.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          version: Number(latestVersion?.version ?? 0),
          object: {
            id: object.id,
            type: object.type,
            name: object.name,
            state: object.state,
            source: object.source,
            externalId: object.externalId,
          },
        };
      }
    }

    let existingObject = null as typeof objects.$inferSelect | null;

    if (objectId) {
      const [object] = await tx
        .select()
        .from(objects)
        .where(and(eq(objects.tenantId, operator.tenantId), eq(objects.id, objectId)))
        .limit(1);
      existingObject = object ?? null;

      if (!existingObject) {
        throw new PlatformUnavailableError(
          "core_object_not_found",
          "config.objectId does not match an object in this tenant.",
          404,
        );
      }
    }

    if (externalId) {
      const [object] = await tx
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.tenantId, operator.tenantId),
            eq(objects.source, objectRecordSource),
            eq(objects.externalId, externalId),
          ),
        )
        .limit(1);

      if (object && existingObject && object.id !== existingObject.id) {
        throw new PlatformUnavailableError(
          "core_object_identity_conflict",
          "config.objectId and config.externalId refer to different objects.",
          409,
        );
      }

      existingObject = existingObject ?? object ?? null;
    }

    const now = new Date();
    const [object] = existingObject
      ? await tx
          .update(objects)
          .set({
            type,
            name,
            state,
            source: objectRecordSource,
            externalId,
            data: objectData,
            effectiveAt,
            archivedAt,
            updatedAt: now,
          })
          .where(eq(objects.id, existingObject.id))
          .returning()
      : await tx
          .insert(objects)
          .values({
            tenantId: operator.tenantId,
            type,
            name,
            state,
            source: objectRecordSource,
            externalId,
            data: objectData,
            createdByUserId: operator.userId,
            effectiveAt,
            archivedAt,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
    const versionNumber = await nextObjectVersion(tx, object.id);
    const [objectVersion] = await tx
      .insert(objectVersions)
      .values({
        tenantId: operator.tenantId,
        objectId: object.id,
        version: versionNumber,
        data: versionData,
        changedByType: "user",
        changedById: operator.userId,
        reason,
      })
      .returning({ id: objectVersions.id, version: objectVersions.version });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingObject ? "object.updated" : "object.created",
        source: objectSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: object.id,
        idempotencyKey: `${input.idempotencyKey}:object_upserted`,
        data: {
          objectId: object.id,
          objectVersionId: objectVersion.id,
          version: objectVersion.version,
          type,
          name,
          state,
          source: objectRecordSource,
          externalId: externalId ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingObject ? "object.updated" : "object.created",
        source: objectSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "object",
        targetId: object.id,
        eventId: event.id,
        objectId: object.id,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:object_upserted`,
        data: {
          objectId: object.id,
          objectVersionId: objectVersion.id,
          version: objectVersion.version,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingObject,
      updated: Boolean(existingObject),
      objectId: object.id,
      objectVersionId: objectVersion.id,
      version: objectVersion.version,
      eventId: event.id,
      auditEventId: audit.id,
      object: {
        id: object.id,
        type: object.type,
        name: object.name,
        state: object.state,
        source: object.source,
        externalId: object.externalId,
      },
    };
  });
}

export async function ingestCoreEvent(input: CoreEventIngestInput) {
  const db = input.db ?? defaultDb;
  const type = requiredString(input.type, "config.type");
  const source = cleanString(input.source) ?? eventSource;
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const adapterId = optionalUuid(input.adapterId, "config.adapterId");
  const connectionId = optionalUuid(input.connectionId, "config.connectionId");
  const occurredAt = optionalDate(input.occurredAt, "config.occurredAt") ?? new Date();
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = parseActor(input.actor, operator);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingEvent] = await tx
      .select({ id: events.id })
      .from(events)
      .where(
        and(
          eq(events.tenantId, operator.tenantId),
          eq(events.source, source),
          eq(events.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingEvent) {
      const [existingAudit] = await tx
        .select({ id: auditEvents.id })
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.tenantId, operator.tenantId),
            eq(auditEvents.source, eventSource),
            eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:event_ingested`),
          ),
        )
        .limit(1);

      return {
        created: false,
        eventId: existingEvent.id,
        auditEventId: existingAudit?.id ?? null,
      };
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertTask(tx, operator.tenantId, taskId),
      assertCapability(tx, capabilityId),
      assertAdapter(tx, adapterId),
      assertConnection(tx, operator.tenantId, connectionId),
    ]);

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type,
        source,
        actorType: actor.type,
        actorId: actor.id,
        actorRef: actor.ref,
        objectId,
        taskId,
        capabilityId,
        adapterId,
        connectionId,
        idempotencyKey: input.idempotencyKey,
        data: jsonObject(input.data),
        occurredAt,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "event.ingested",
        source: eventSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "event",
        targetId: event.id,
        eventId: event.id,
        objectId,
        taskId,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:event_ingested`,
        data: {
          eventType: type,
          eventSource: source,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}

export async function attachCoreEvidence(input: CoreEvidenceAttachInput) {
  const db = input.db ?? defaultDb;
  const kind = parseEvidenceKind(requiredString(input.kind, "config.kind"));
  const name = requiredString(input.name, "config.name");
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const retainedUntil = optionalDate(input.retainedUntil, "config.retainedUntil");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = parseActor(input.actor, operator);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${evidenceSource}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({ auditEventId: auditEvents.id, targetId: auditEvents.targetId })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, evidenceSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:evidence_attached`),
          eq(auditEvents.targetType, "evidence"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      return {
        created: false,
        evidenceId: existingAudit.targetId,
        auditEventId: existingAudit.auditEventId,
      };
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
      assertCapability(tx, capabilityId),
    ]);

    const [item] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind,
        name,
        objectId,
        taskId,
        eventId,
        capabilityId,
        actorType: actor.type,
        actorId: actor.id,
        uri: cleanString(input.uri),
        hash: cleanString(input.hash),
        data: jsonObject(input.data),
        redaction: jsonObject(input.redaction),
        retainedUntil,
      })
      .returning({ id: evidence.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "evidence.attached",
        source: evidenceSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "evidence",
        targetId: item.id,
        taskId,
        eventId,
        objectId,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:evidence_attached`,
        data: {
          evidenceKind: kind,
          evidenceName: name,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      evidenceId: item.id,
      auditEventId: audit.id,
    };
  });
}

export async function createCoreDocument(input: CoreDocumentCreateInput) {
  const db = input.db ?? defaultDb;
  const kind = requiredString(input.kind, "config.kind");
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "draft";
  const sensitivity = parseRisk(cleanString(input.sensitivity));
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const retainedUntil = optionalDate(input.retainedUntil, "config.retainedUntil");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${documentSource}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        eventId: auditEvents.eventId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, documentSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:document_created`),
          eq(auditEvents.targetType, "document"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      return {
        created: false,
        documentId: existingAudit.targetId,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
      };
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertWorkflowRun(tx, operator.tenantId, workflowRunId),
    ]);

    const now = new Date();
    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: operator.tenantId,
        objectId,
        workflowRunId,
        kind,
        name,
        state,
        sensitivity,
        hash: cleanString(input.hash),
        data: jsonObject(input.data),
        retainedUntil,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "document.created",
        source: documentSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId,
        idempotencyKey: `${input.idempotencyKey}:document_created`,
        data: {
          documentId: document.id,
          workflowRunId: workflowRunId ?? null,
          kind,
          name,
          state,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "document.created",
        source: documentSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "document",
        targetId: document.id,
        eventId: event.id,
        objectId,
        risk: sensitivity,
        idempotencyKey: `${input.idempotencyKey}:document_created`,
        data: {
          documentId: document.id,
          workflowRunId: workflowRunId ?? null,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      documentId: document.id,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}

export async function recordCoreDecision(input: CoreDecisionRecordInput) {
  const db = input.db ?? defaultDb;
  const kind = requiredString(input.kind, "config.kind");
  const decisionValue = requiredString(input.decision, "config.decision");
  const state = cleanString(input.state) ?? "proposed";
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });
  const actor = parseActor(input.actor, operator);

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${decisionSource}:${input.idempotencyKey}`}))`,
    );

    const [existingAudit] = await tx
      .select({
        auditEventId: auditEvents.id,
        targetId: auditEvents.targetId,
        eventId: auditEvents.eventId,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, operator.tenantId),
          eq(auditEvents.source, decisionSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:decision_recorded`),
          eq(auditEvents.targetType, "decision"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      return {
        created: false,
        decisionId: existingAudit.targetId,
        eventId: existingAudit.eventId,
        auditEventId: existingAudit.auditEventId,
      };
    }

    await Promise.all([
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
      assertWorkflowRun(tx, operator.tenantId, workflowRunId),
      assertCapability(tx, capabilityId),
    ]);

    const [decision] = await tx
      .insert(decisions)
      .values({
        tenantId: operator.tenantId,
        taskId,
        eventId,
        workflowRunId,
        capabilityId,
        actorType: actor.type,
        actorId: actor.id,
        kind,
        state,
        decision: decisionValue,
        rationale: cleanString(input.rationale) ?? "",
        data: jsonObject(input.data),
      })
      .returning({ id: decisions.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "decision.recorded",
        source: decisionSource,
        actorType: actor.type,
        actorId: actor.id,
        actorRef: actor.ref,
        taskId,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:decision_recorded`,
        data: {
          decisionId: decision.id,
          kind,
          state,
          decision: decisionValue,
          workflowRunId: workflowRunId ?? null,
        },
        occurredAt: new Date(),
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "decision.recorded",
        source: decisionSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "decision",
        targetId: decision.id,
        taskId,
        eventId: event.id,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:decision_recorded`,
        data: {
          decisionId: decision.id,
          originalEventId: eventId ?? null,
          workflowRunId: workflowRunId ?? null,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      decisionId: decision.id,
      eventId: event.id,
      auditEventId: audit.id,
    };
  });
}
