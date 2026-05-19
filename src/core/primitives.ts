import { and, eq, inArray, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapters,
  auditEvents,
  capabilities,
  connections,
  customers,
  customerSignals,
  decisions,
  documents,
  events,
  evidence,
  evidencePackets,
  objects,
  objectLinks,
  objectVersions,
  tasks,
  uiContracts,
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
type CoreTaskState = "draft" | "active" | "waiting" | "approval_required" | "blocked" | "done" | "canceled";

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
const packetSource = "continuous.core.packets";
const decisionSource = "continuous.core.decisions";
const objectLinkSource = "continuous.core.object_links";
const customerSignalSource = "continuous.core.customer_signals";
const viewSource = "continuous.core.views";
const customerSignalTypes = new Set([
  "satisfaction_signal",
  "feedback_item",
  "complaint",
  "testimonial",
  "review",
]);

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

export type CorePacketPrepareInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  kind: string;
  name: string;
  state?: string;
  sensitivity?: string;
  objectId?: string;
  taskId?: string;
  workflowRunId?: string;
  eventId?: string;
  capabilityId?: string;
  evidenceIds?: unknown;
  documentIds?: unknown;
  sections?: JsonObject;
  data?: JsonObject;
  hash?: string;
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

export type CoreObjectLinkInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  fromObjectId: string;
  toObjectId: string;
  type: string;
  data?: JsonObject;
  effectiveAt?: string;
  endedAt?: string;
  db?: Database;
};

export type CoreCustomerSignalRecordInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  type: string;
  name: string;
  state?: string;
  source?: string;
  externalId?: string;
  customerObjectId?: string;
  relatedObjectId?: string;
  taskId?: string;
  eventId?: string;
  data?: JsonObject;
  occurredAt?: string;
  db?: Database;
};

export type CoreViewPublishInput = {
  operatorEmail: string;
  idempotencyKey: string;
  tenantSlug?: string;
  key: string;
  name: string;
  purpose: string;
  version?: string;
  surface?: string;
  capabilityId?: string;
  objectType?: string;
  taskState?: string;
  contract?: JsonObject;
  actions?: JsonObject;
  data?: JsonObject;
  mask?: JsonObject;
  active?: boolean;
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

function requiredStringMax(value: unknown, field: string, max: number) {
  const output = requiredString(value, field);

  if (output.length > max) {
    throw new PlatformUnavailableError(
      "core_field_too_long",
      `${field} must be ${max} characters or fewer.`,
      400,
    );
  }

  return output;
}

function optionalStringMax(value: unknown, field: string, max: number) {
  const output = cleanString(value);

  if (output && output.length > max) {
    throw new PlatformUnavailableError(
      "core_field_too_long",
      `${field} must be ${max} characters or fewer.`,
      400,
    );
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

function requiredUuid(value: unknown, field: string) {
  const uuid = optionalUuid(requiredString(value, field), field);

  if (!uuid) {
    throw new PlatformUnavailableError("core_reference_invalid", `${field} must be a UUID.`, 400);
  }

  return uuid;
}

function uuidList(value: unknown, field: string) {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw new PlatformUnavailableError("core_reference_invalid", `${field} must be an array of UUIDs.`, 400);
  }

  return value.map((item, index) => requiredUuid(item, `${field}[${index}]`));
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

function parseTaskState(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const taskStates = new Set<CoreTaskState>([
    "draft",
    "active",
    "waiting",
    "approval_required",
    "blocked",
    "done",
    "canceled",
  ]);

  if (taskStates.has(value as CoreTaskState)) {
    return value as CoreTaskState;
  }

  throw new PlatformUnavailableError(
    "core_task_state_invalid",
    "config.taskState must be draft, active, waiting, approval_required, blocked, done, or canceled.",
    400,
  );
}

function parseCustomerSignalType(value: string) {
  if (customerSignalTypes.has(value)) {
    return value;
  }

  throw new PlatformUnavailableError(
    "core_customer_signal_type_invalid",
    "config.type must be satisfaction_signal, feedback_item, complaint, testimonial, or review.",
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

async function assertEvidenceItems(tx: QueryClient, tenantId: string, evidenceIds: string[]) {
  if (evidenceIds.length === 0) {
    return;
  }

  const rows = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), inArray(evidence.id, evidenceIds)));

  if (rows.length !== evidenceIds.length) {
    throw new PlatformUnavailableError(
      "core_evidence_not_found",
      "config.evidenceIds must reference evidence rows in this tenant.",
      404,
    );
  }
}

async function assertDocuments(tx: QueryClient, tenantId: string, documentIds: string[]) {
  if (documentIds.length === 0) {
    return;
  }

  const rows = await tx
    .select({ id: documents.id })
    .from(documents)
    .where(and(eq(documents.tenantId, tenantId), inArray(documents.id, documentIds)));

  if (rows.length !== documentIds.length) {
    throw new PlatformUnavailableError(
      "core_document_not_found",
      "config.documentIds must reference document rows in this tenant.",
      404,
    );
  }
}

async function evidenceForAudit(tx: QueryClient, tenantId: string, auditEventId: string) {
  const [item] = await tx
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), sql`${evidence.data}->>'auditEventId' = ${auditEventId}`))
    .limit(1);

  return item?.id ?? null;
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

export async function prepareCorePacket(input: CorePacketPrepareInput) {
  const db = input.db ?? defaultDb;
  const kind = requiredString(input.kind, "config.kind");
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "prepared";
  const sensitivity = parseRisk(cleanString(input.sensitivity));
  const objectId = optionalUuid(input.objectId, "config.objectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const workflowRunId = optionalUuid(input.workflowRunId, "config.workflowRunId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const evidenceIds = uuidList(input.evidenceIds, "config.evidenceIds");
  const documentIds = uuidList(input.documentIds, "config.documentIds");
  const retainedUntil = optionalDate(input.retainedUntil, "config.retainedUntil");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${packetSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, packetSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:packet_prepared`),
          eq(auditEvents.targetType, "evidence_packet"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [packet] = await tx
        .select()
        .from(evidencePackets)
        .where(and(eq(evidencePackets.tenantId, operator.tenantId), eq(evidencePackets.id, existingAudit.targetId)))
        .limit(1);

      if (packet) {
        return {
          prepared: false,
          packetId: packet.id,
          documentId: packet.documentId,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          evidenceId: await evidenceForAudit(tx, operator.tenantId, existingAudit.auditEventId),
        };
      }
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, objectId),
      assertTask(tx, operator.tenantId, taskId),
      assertWorkflowRun(tx, operator.tenantId, workflowRunId),
      assertEvent(tx, operator.tenantId, eventId),
      assertCapability(tx, capabilityId),
      assertEvidenceItems(tx, operator.tenantId, evidenceIds),
      assertDocuments(tx, operator.tenantId, documentIds),
    ]);

    const now = new Date();
    const packetData = {
      ...jsonObject(input.data),
      sections: jsonObject(input.sections),
      evidenceIds,
      documentIds,
      externalExecution: "blocked",
    };
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
        data: packetData,
        retainedUntil,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: operator.tenantId,
        documentId: document.id,
        objectId,
        taskId,
        workflowRunId,
        eventId,
        capabilityId,
        kind,
        name,
        state,
        sensitivity,
        evidenceIds: { ids: evidenceIds },
        documentIds: { ids: documentIds },
        data: packetData,
        hash: cleanString(input.hash),
        retainedUntil,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "packet.prepared",
        source: packetSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId,
        taskId,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:packet_prepared`,
        data: {
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRunId ?? null,
          evidenceCount: evidenceIds.length,
          documentCount: documentIds.length,
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
        type: "packet.prepared",
        source: packetSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "evidence_packet",
        targetId: packet.id,
        taskId,
        eventId: event.id,
        objectId,
        capabilityId,
        risk: sensitivity,
        idempotencyKey: `${input.idempotencyKey}:packet_prepared`,
        data: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds,
          documentIds,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const [proof] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "trace",
        name: `Packet prepared: ${name}`,
        objectId,
        taskId,
        eventId: event.id,
        capabilityId,
        actorType: "user",
        actorId: operator.userId,
        hash: `${packetSource}:${packet.id}:${now.toISOString()}`,
        data: {
          packetId: packet.id,
          documentId: document.id,
          auditEventId: audit.id,
          evidenceIds,
          documentIds,
          externalExecution: "blocked",
        },
        retainedUntil,
      })
      .returning({ id: evidence.id });

    return {
      prepared: true,
      packetId: packet.id,
      documentId: document.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: proof.id,
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

export async function linkCoreObjects(input: CoreObjectLinkInput) {
  const db = input.db ?? defaultDb;
  const fromObjectId = requiredUuid(input.fromObjectId, "config.fromObjectId");
  const toObjectId = requiredUuid(input.toObjectId, "config.toObjectId");
  const type = requiredStringMax(input.type, "config.type", 80);
  const effectiveAt = optionalDate(input.effectiveAt, "config.effectiveAt");
  const endedAt = optionalDate(input.endedAt, "config.endedAt");
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${objectLinkSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, objectLinkSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:object_linked`),
          eq(auditEvents.targetType, "object_link"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [link] = await tx
        .select()
        .from(objectLinks)
        .where(
          and(
            eq(objectLinks.tenantId, operator.tenantId),
            eq(objectLinks.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (link) {
        return {
          created: false,
          updated: false,
          objectLinkId: link.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          link: {
            id: link.id,
            fromObjectId: link.fromId,
            toObjectId: link.toId,
            type: link.type,
          },
        };
      }
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, fromObjectId),
      assertObject(tx, operator.tenantId, toObjectId),
    ]);

    const [existingLink] = await tx
      .select()
      .from(objectLinks)
      .where(
        and(
          eq(objectLinks.tenantId, operator.tenantId),
          eq(objectLinks.fromId, fromObjectId),
          eq(objectLinks.toId, toObjectId),
          eq(objectLinks.type, type),
        ),
      )
      .limit(1);
    const [link] = existingLink
      ? await tx
          .update(objectLinks)
          .set({
            data: jsonObject(input.data),
            effectiveAt,
            endedAt,
          })
          .where(eq(objectLinks.id, existingLink.id))
          .returning()
      : await tx
          .insert(objectLinks)
          .values({
            tenantId: operator.tenantId,
            fromId: fromObjectId,
            toId: toObjectId,
            type,
            data: jsonObject(input.data),
            effectiveAt,
            endedAt,
          })
          .returning();
    const now = new Date();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingLink ? "object_link.updated" : "object_link.created",
        source: objectLinkSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: fromObjectId,
        idempotencyKey: `${input.idempotencyKey}:object_linked`,
        data: {
          objectLinkId: link.id,
          fromObjectId,
          toObjectId,
          type,
          endedAt: endedAt?.toISOString() ?? null,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingLink ? "object_link.updated" : "object_link.created",
        source: objectLinkSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "object_link",
        targetId: link.id,
        eventId: event.id,
        objectId: fromObjectId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:object_linked`,
        data: {
          objectLinkId: link.id,
          fromObjectId,
          toObjectId,
          type,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingLink,
      updated: Boolean(existingLink),
      objectLinkId: link.id,
      eventId: event.id,
      auditEventId: audit.id,
      link: {
        id: link.id,
        fromObjectId: link.fromId,
        toObjectId: link.toId,
        type: link.type,
      },
    };
  });
}

export async function recordCustomerSignal(input: CoreCustomerSignalRecordInput) {
  const db = input.db ?? defaultDb;
  const type = parseCustomerSignalType(requiredStringMax(input.type, "config.type", 80));
  const name = requiredString(input.name, "config.name");
  const state = cleanString(input.state) ?? "captured";
  const source = cleanString(input.source) ?? "operator_payload";
  const externalId = cleanString(input.externalId);
  const customerObjectId = optionalUuid(input.customerObjectId, "config.customerObjectId");
  const relatedObjectId = optionalUuid(input.relatedObjectId, "config.relatedObjectId");
  const taskId = optionalUuid(input.taskId, "config.taskId");
  const eventId = optionalUuid(input.eventId, "config.eventId");
  const occurredAt = optionalDate(input.occurredAt, "config.occurredAt");
  const data = jsonObject(input.data);
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${customerSignalSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, customerSignalSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:customer_signal_recorded`),
          eq(auditEvents.targetType, "customer_signal"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [signal] = await tx
        .select()
        .from(customerSignals)
        .where(
          and(
            eq(customerSignals.tenantId, operator.tenantId),
            eq(customerSignals.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (signal) {
        return {
          created: false,
          signalId: signal.id,
          objectId: signal.objectId,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          signal: {
            id: signal.id,
            type: signal.type,
            state: signal.state,
            objectId: signal.objectId,
            customerId: signal.customerId,
          },
        };
      }
    }

    await Promise.all([
      assertObject(tx, operator.tenantId, customerObjectId),
      assertObject(tx, operator.tenantId, relatedObjectId),
      assertTask(tx, operator.tenantId, taskId),
      assertEvent(tx, operator.tenantId, eventId),
    ]);

    const [customer] = customerObjectId
      ? await tx
          .select({ id: customers.id })
          .from(customers)
          .where(
            and(
              eq(customers.tenantId, operator.tenantId),
              eq(customers.objectId, customerObjectId),
            ),
          )
          .limit(1)
      : [];

    if (customerObjectId && !customer) {
      throw new PlatformUnavailableError(
        "core_customer_not_found",
        "config.customerObjectId does not match a customer in this tenant.",
        404,
      );
    }

    const [object] = await tx
      .insert(objects)
      .values({
        tenantId: operator.tenantId,
        type,
        name,
        state,
        source,
        externalId,
        data,
        createdByUserId: operator.userId,
        effectiveAt: occurredAt,
      })
      .returning({ id: objects.id });

    const [signal] = await tx
      .insert(customerSignals)
      .values({
        tenantId: operator.tenantId,
        objectId: object.id,
        customerId: customer?.id,
        type,
        state,
        source,
        externalId,
        data,
        occurredAt,
      })
      .returning({ id: customerSignals.id });

    const linkValues = [
      ...(customerObjectId
        ? [
            {
              tenantId: operator.tenantId,
              fromId: object.id,
              toId: customerObjectId,
              type: "about_customer",
              data: { signalType: type },
            },
          ]
        : []),
      ...(relatedObjectId
        ? [
            {
              tenantId: operator.tenantId,
              fromId: object.id,
              toId: relatedObjectId,
              type: "about_work_item",
              data: { signalType: type },
            },
          ]
        : []),
    ];

    if (linkValues.length > 0) {
      await tx.insert(objectLinks).values(linkValues).onConflictDoNothing();
    }

    const now = new Date();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: "customer_signal.recorded",
        source: customerSignalSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        objectId: object.id,
        taskId,
        idempotencyKey: `${input.idempotencyKey}:customer_signal_recorded`,
        data: {
          signalId: signal.id,
          signalType: type,
          customerObjectId: customerObjectId ?? null,
          relatedObjectId: relatedObjectId ?? null,
          externalExecution: "blocked",
        },
        occurredAt: occurredAt ?? now,
      })
      .returning({ id: events.id });

    const [note] = await tx
      .insert(evidence)
      .values({
        tenantId: operator.tenantId,
        kind: "note",
        name: `Customer ${type.replaceAll("_", " ")}`,
        objectId: object.id,
        taskId,
        eventId: event.id,
        actorType: "user",
        actorId: operator.userId,
        data: {
          signalId: signal.id,
          signalType: type,
          customerObjectId: customerObjectId ?? null,
          relatedObjectId: relatedObjectId ?? null,
          data,
        },
      })
      .returning({ id: evidence.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: "customer_signal.recorded",
        source: customerSignalSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "customer_signal",
        targetId: signal.id,
        taskId,
        eventId: event.id,
        objectId: object.id,
        risk: type === "complaint" ? "medium" : "low",
        idempotencyKey: `${input.idempotencyKey}:customer_signal_recorded`,
        data: {
          signalType: type,
          customerObjectId: customerObjectId ?? null,
          relatedObjectId: relatedObjectId ?? null,
          evidenceId: note.id,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: true,
      signalId: signal.id,
      objectId: object.id,
      eventId: event.id,
      evidenceId: note.id,
      auditEventId: audit.id,
      signal: {
        id: signal.id,
        type,
        state,
        objectId: object.id,
        customerId: customer?.id ?? null,
      },
    };
  });
}

export async function publishCoreView(input: CoreViewPublishInput) {
  const db = input.db ?? defaultDb;
  const key = requiredStringMax(input.key, "config.key", 140);
  const name = requiredString(input.name, "config.name");
  const purpose = requiredString(input.purpose, "config.purpose");
  const version = optionalStringMax(input.version, "config.version", 40) ?? "1.0.0";
  const surface = cleanString(input.surface) ?? "web";
  const capabilityId = optionalUuid(input.capabilityId, "config.capabilityId");
  const objectType = optionalStringMax(input.objectType, "config.objectType", 80);
  const taskState = parseTaskState(cleanString(input.taskState));
  const active = input.active ?? true;
  const operator = await loadOperatorContext({
    db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.tenantSlug,
  });

  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${operator.tenantId}), hashtext(${`${viewSource}:${input.idempotencyKey}`}))`,
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
          eq(auditEvents.source, viewSource),
          eq(auditEvents.idempotencyKey, `${input.idempotencyKey}:view_published`),
          eq(auditEvents.targetType, "ui_contract"),
        ),
      )
      .limit(1);

    if (existingAudit?.targetId) {
      const [view] = await tx
        .select()
        .from(uiContracts)
        .where(
          and(
            eq(uiContracts.tenantId, operator.tenantId),
            eq(uiContracts.id, existingAudit.targetId),
          ),
        )
        .limit(1);

      if (view) {
        return {
          created: false,
          updated: false,
          viewId: view.id,
          eventId: existingAudit.eventId,
          auditEventId: existingAudit.auditEventId,
          view: {
            id: view.id,
            key: view.key,
            version: view.version,
            name: view.name,
            active: view.active,
          },
        };
      }
    }

    await assertCapability(tx, capabilityId);

    const [existingView] = await tx
      .select()
      .from(uiContracts)
      .where(
        and(
          eq(uiContracts.tenantId, operator.tenantId),
          eq(uiContracts.key, key),
          eq(uiContracts.version, version),
        ),
      )
      .limit(1);
    const now = new Date();
    const values = {
      capabilityId,
      key,
      version,
      name,
      purpose,
      surface,
      objectType,
      taskState,
      contract: jsonObject(input.contract),
      actions: jsonObject(input.actions),
      data: jsonObject(input.data),
      mask: jsonObject(input.mask),
      active,
      updatedAt: now,
    };
    const [view] = existingView
      ? await tx.update(uiContracts).set(values).where(eq(uiContracts.id, existingView.id)).returning()
      : await tx
          .insert(uiContracts)
          .values({
            tenantId: operator.tenantId,
            ...values,
            createdAt: now,
          })
          .returning();
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: operator.tenantId,
        type: existingView ? "view.updated" : "view.published",
        source: viewSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:view_published`,
        data: {
          viewId: view.id,
          key,
          version,
          name,
          purpose,
          surface,
          objectType: objectType ?? null,
          taskState: taskState ?? null,
          active,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: operator.tenantId,
        type: existingView ? "view.updated" : "view.published",
        source: viewSource,
        actorType: "user",
        actorId: operator.userId,
        actorRef: operator.actorRef,
        targetType: "ui_contract",
        targetId: view.id,
        eventId: event.id,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:view_published`,
        data: {
          viewId: view.id,
          key,
          version,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });

    return {
      created: !existingView,
      updated: Boolean(existingView),
      viewId: view.id,
      eventId: event.id,
      auditEventId: audit.id,
      view: {
        id: view.id,
        key: view.key,
        version: view.version,
        name: view.name,
        active: view.active,
      },
    };
  });
}
