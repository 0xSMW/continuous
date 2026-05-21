import { createHash } from "node:crypto";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapters,
  adapterActions,
  adapterRuns,
  approvalRequests,
  auditEvents,
  bankAccounts,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  decisions,
  documents,
  evidence,
  evidencePackets,
  evaluations,
  events,
  generatedViews,
  inferences,
  invoices,
  modelRoutes,
  objects,
  objectLinks,
  objectVersions,
  payments,
  paymentInstructions,
  tasks,
  tenants,
  usageEvents,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  users,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";
import { approvedAdapterExecutionReceiptFor } from "../core/adapters";
import { recordExternalActionForOperator } from "../core/primitives";
import { completeCoreWorkerRun, startCoreWorkerRun } from "../core/worker-runs";
import { pollLeadSourceConnection, type LeadSourcePollResult } from "./lead-source-connectors";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

const revenueWorkerRole = "revenue_operations";
const revenueWorkflowKey = "lead_to_cash";
const source = "continuous.worker";
const coreWorkerRunSource = "continuous.core.worker_runs";
const schedulerSource = "continuous.worker_scheduler";
const connectionHealthSource = "continuous.core.connection_health";
const runUnits = 12000;
const leadReadUnits = 1000;
const leadClassifyUnits = 2000;
const responseDraftUnits = 4000;
const paymentLinkPrepareUnits = 3000;
const revenueContinuationUnits = 1000;
const revenueContinuationApprovalKinds = new Set([
  "quote_approval",
  "quote_revision_approval",
  "payment_link_approval",
]);
type RevenueRunCommand = "run" | "quote.prepare";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    workerRunId: string | null;
    eventId: string | null;
    idempotencyKey: string | null;
    occurredAt: string;
    state: string;
    mode: string;
  } | null;
};

type RevenueReadinessCheckState = "ready" | "blocked";

export type RevenueReadinessCheck = {
  key: string;
  label: string;
  state: RevenueReadinessCheckState;
  details: JsonObject;
};

export type RevenueReadinessGate = {
  key: string;
  state: RevenueReadinessCheckState;
  label: string;
  reason: string;
  requiredFor: string;
  details: JsonObject;
};

export type RevenueWorkerReadiness = {
  worker: RevenueWorkerSnapshot["worker"];
  status: RevenueReadinessCheckState;
  dryRunReady: boolean;
  launchStatus: RevenueReadinessCheckState;
  launchReady: boolean;
  checks: RevenueReadinessCheck[];
  blockers: RevenueReadinessCheck[];
  launchGates: RevenueReadinessGate[];
  proof: {
    latestWorkerRunId: string | null;
    latestWorkerRunMode: string | null;
    latestWorkerRunState: string | null;
    latestWorkerRunIdempotencyKey: string | null;
    latestWorkerRunAt: string | null;
    workflowDefinitionId: string | null;
    quoteApprovalViewId: string | null;
    paymentReviewViewId: string | null;
    adapterReceiptEvidenceId: string | null;
  };
};

export type RevenueWorkerRunResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  eventId: string | null;
  taskId: string | null;
  sourceSnapshotEvidenceId: string | null;
  evidenceId: string | null;
  reservationId: string | null;
  inferenceId: string | null;
  usageEventId: string | null;
  adapterRunId: string | null;
  adapterActionId: string | null;
  adapterReceiptEvidenceId: string | null;
  approvalRequestId: string | null;
  quoteApprovalViewId: string | null;
  auditEventId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  output: JsonObject;
  snapshot: RevenueWorkerSnapshot;
};

export type RevenueLeadReadResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  eventId: string | null;
  reservationId: string | null;
  usageEventId: string | null;
  auditEventId: string | null;
  readCount: number;
  selectors: JsonObject[];
  output: JsonObject;
  snapshot: RevenueWorkerSnapshot;
};

export type RevenueWorkerActionResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  eventId: string | null;
  reservationId: string | null;
  inferenceId: string | null;
  usageEventId: string | null;
  evidenceId: string | null;
  auditEventId: string | null;
  output: JsonObject;
  snapshot: RevenueWorkerSnapshot;
};

export type RevenueWorkerContinuationResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  originalWorkerRunId: string | null;
  eventId: string | null;
  taskId: string | null;
  reservationId: string | null;
  usageEventId: string | null;
  approvalRequestId: string | null;
  auditEventId: string | null;
  evidenceId: string | null;
  workflowRunId: string | null;
  workflowStepId: string | null;
  output: JsonObject;
  snapshot: RevenueWorkerSnapshot;
};

export type RevenuePaymentLinkPrepareResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string | null;
  taskId: string | null;
  eventId: string | null;
  reservationId: string | null;
  inferenceId: string | null;
  usageEventId: string | null;
  paymentObjectId: string | null;
  paymentId: string | null;
  paymentInstructionId: string | null;
  invoiceObjectId: string | null;
  invoiceId: string | null;
  quoteObjectId: string | null;
  approvalRequestId: string | null;
  adapterRunId: string | null;
  adapterActionId: string | null;
  adapterReceiptEvidenceId: string | null;
  evidenceId: string | null;
  draftEvidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  paymentReviewViewId: string | null;
  auditEventId: string | null;
  output: JsonObject;
  snapshot: RevenueWorkerSnapshot;
};

type TaskPriority = "low" | "normal" | "high" | "urgent";

type WorkerContext = {
  worker: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    name: string;
    kpis: JsonObject;
  };
  tenantName: string;
  task: {
    id: string;
    objectId: string | null;
    triggerEventId: string | null;
    capabilityId: string | null;
    priority: TaskPriority;
    reviewerUserId: string | null;
  } | null;
  leadReadCapabilityId: string | null;
  leadClassifyCapabilityId: string | null;
  responseDraftCapabilityId: string | null;
  quoteCapabilityId: string | null;
  paymentLinkCapabilityId: string | null;
  briefCapabilityId: string | null;
  budgetAccountId: string;
  connectionId: string;
  routeId: string | null;
};

type OperatorContext = {
  id: string;
  email: string;
  name: string;
  actorRef: string;
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

function optionalNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    const number = Number(value);

    return Number.isFinite(number) ? number : undefined;
  }

  return undefined;
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

function stableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableJson);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableJson(nested)]),
    );
  }

  return value;
}

function hashObject(value: JsonObject) {
  return createHash("sha256").update(JSON.stringify(stableJson(value))).digest("hex");
}

function stringData(data: JsonObject, key: string) {
  const output = data.output;
  const nested =
    output && typeof output === "object" && !Array.isArray(output) ? (output as JsonObject) : null;
  const completion = objectValue(data.completion);
  const completionBudget = objectValue(completion.budget);
  const value = nested?.[key] ?? data[key] ?? completion[key] ?? completionBudget[key];
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function outputData(data: JsonObject) {
  const output = objectValue(data.output);

  if (Object.keys(output).length > 0) {
    return output;
  }

  return objectValue(objectValue(data.pendingCompletion).output);
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function getWorkflowStepIds(data: JsonObject) {
  return stringList(outputData(data).workflowStepIds ?? data.workflowStepIds);
}

function appendString(value: unknown, next: string) {
  return Array.from(new Set([...stringList(value), next]));
}

function booleanValue(value: unknown) {
  return value === true;
}

function uuidValue(value: unknown) {
  const output = stringValue(value);
  return output && uuidPattern.test(output) ? output : "";
}

function optionalUuid(value: unknown, fieldName: string) {
  const output = stringValue(value);

  if (!output) {
    return "";
  }

  if (!uuidPattern.test(output)) {
    throw new RevenueWorkerUnavailableError(
      "invalid_worker_command_config",
      `${fieldName} must be a tenant-scoped Core id.`,
      400,
    );
  }

  return output;
}

function firstNumberValue(...values: unknown[]) {
  for (const value of values) {
    const number = optionalNumber(value);

    if (number !== undefined) {
      return number;
    }
  }

  return undefined;
}

function normalizedUrgency(value: unknown) {
  const urgency = stringValue(value, "normal").toLowerCase();

  if (["urgent", "emergency", "same_day"].includes(urgency)) {
    return "urgent";
  }

  if (["high", "normal", "low"].includes(urgency)) {
    return urgency;
  }

  return "normal";
}

function centsForIntent(intent: string, serviceArea: string) {
  const text = `${intent} ${serviceArea}`.toLowerCase();
  const terms = new Set(text.split(/[^a-z0-9]+/).filter(Boolean));

  if (terms.has("roof") || terms.has("roofing") || terms.has("leak") || terms.has("leakage")) {
    return 24900;
  }

  if (terms.has("gutter") || terms.has("gutters")) {
    return 12900;
  }

  if (terms.has("window") || terms.has("windows")) {
    return 18900;
  }

  if (
    terms.has("hvac") ||
    terms.has("heat") ||
    terms.has("heating") ||
    terms.has("cooling") ||
    terms.has("ac") ||
    terms.has("air")
  ) {
    return 21900;
  }

  return 15900;
}

function formatUsd(cents: number) {
  return `$${(cents / 100).toFixed(2)}`;
}

function nestedLeadPacket(...values: unknown[]) {
  for (const value of values) {
    const object = objectValue(value);
    const leadPacket = objectValue(object.leadPacket ?? object.lead);

    if (Object.keys(leadPacket).length > 0) {
      return leadPacket;
    }
  }

  return {};
}

function firstStringValue(...values: unknown[]) {
  for (const value of values) {
    const output = stringValue(value);

    if (output) {
      return output;
    }
  }

  return "";
}

function firstStringList(...values: unknown[]) {
  for (const value of values) {
    const output = stringList(value);

    if (output.length > 0) {
      return output;
    }
  }

  return [];
}

async function lookupLeadIntakeBySource(
  db: Database,
  tenantId: string,
  sourceName: string,
  sourceEventId: string,
) {
  const [eventByIdempotencyKey] = await db
    .select({
      id: events.id,
      objectId: events.objectId,
    })
    .from(events)
    .where(
      and(
        eq(events.tenantId, tenantId),
        eq(events.source, sourceName),
        eq(events.idempotencyKey, sourceEventId),
      ),
    )
    .orderBy(desc(events.occurredAt))
    .limit(1);
  let event = eventByIdempotencyKey;

  const [objectByEvent] = event?.objectId
    ? await db
        .select({ id: objects.id })
        .from(objects)
        .where(and(eq(objects.tenantId, tenantId), eq(objects.id, event.objectId)))
        .limit(1)
    : [];
  const [objectByExternalId] =
    objectByEvent
      ? []
      : await db
          .select({ id: objects.id })
          .from(objects)
          .where(
            and(
              eq(objects.tenantId, tenantId),
              eq(objects.source, sourceName),
              eq(objects.externalId, sourceEventId),
            ),
          )
          .orderBy(desc(objects.updatedAt))
          .limit(1);
  let object = objectByEvent ?? objectByExternalId;

  if (!event) {
    const [eventByData] = await db
      .select({
        id: events.id,
        objectId: events.objectId,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.source, sourceName),
          sql`${events.data}->>'sourceEventId' = ${sourceEventId}`,
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(1);
    event = eventByData;
  }

  if (!object) {
    const [objectByData] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(
        and(
          eq(objects.tenantId, tenantId),
          eq(objects.source, sourceName),
          sql`${objects.data}->>'sourceEventId' = ${sourceEventId}`,
        ),
      )
      .orderBy(desc(objects.updatedAt))
      .limit(1);
    object = objectByData;
  }

  if (!object && event?.objectId) {
    const [objectByEventData] = await db
      .select({ id: objects.id })
      .from(objects)
      .where(and(eq(objects.tenantId, tenantId), eq(objects.id, event.objectId)))
      .limit(1);
    object = objectByEventData;
  }

  if (!event && object?.id) {
    const [eventByObject] = await db
      .select({
        id: events.id,
        objectId: events.objectId,
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          eq(events.source, sourceName),
          eq(events.objectId, object.id),
        ),
      )
      .orderBy(desc(events.occurredAt))
      .limit(1);
    event = eventByObject;
  }

  if (!event && !object) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_source_not_found",
      "config.intake.source and config.intake.sourceEventId do not match persisted Core intake for this tenant.",
      404,
    );
  }

  return {
    objectId: object?.id ?? event?.objectId ?? null,
    eventId: event?.id ?? null,
  };
}

async function resolveLeadIntake(
  db: Database,
  tenantId: string,
  config: JsonObject,
  fallback: { objectId?: string | null; eventId?: string | null; evidenceId?: string | null } = {},
) {
  const directLeadPacket = objectValue(config.leadPacket);
  const directLead = objectValue(config.lead);
  const hasDirectLeadPayload =
    Object.keys(directLeadPacket).length > 0 || Object.keys(directLead).length > 0;
  const intake = objectValue(config.intake);
  const explicitEvidenceId = uuidValue(intake.evidenceId ?? config.evidenceId);
  const explicitEventId = uuidValue(intake.eventId);
  const explicitObjectId = uuidValue(intake.objectId ?? config.objectId);
  const sourceSelectorSource = stringValue(intake.source);
  const sourceSelectorEventId = stringValue(intake.sourceEventId);
  const hasExplicitCoreIntake = Boolean(explicitEvidenceId || explicitEventId || explicitObjectId);
  const hasSourceSelector = Boolean(sourceSelectorSource && sourceSelectorEventId);

  if (!hasExplicitCoreIntake && (sourceSelectorSource || sourceSelectorEventId) && !hasSourceSelector) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_source_selector_invalid",
      "config.intake.source and config.intake.sourceEventId are both required for source-based worker intake.",
      400,
    );
  }

  if (hasDirectLeadPayload && (hasExplicitCoreIntake || hasSourceSelector)) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_conflict",
      "config.intake Core references cannot be combined with config.leadPacket or config.lead; send one authoritative intake source.",
      400,
    );
  }

  if (!hasDirectLeadPayload && !hasExplicitCoreIntake && !hasSourceSelector) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_required",
      "Revenue Worker commands require config.intake, config.leadPacket, or config.lead.",
      400,
    );
  }

  if (hasDirectLeadPayload) {
    return { config, intake: {} as JsonObject };
  }

  const sourceLookup =
    !hasExplicitCoreIntake && hasSourceSelector
      ? await lookupLeadIntakeBySource(
          db,
          tenantId,
          sourceSelectorSource,
          sourceSelectorEventId,
        )
      : null;
  const requestedEvidenceId = uuidValue(
    explicitEvidenceId || fallback.evidenceId,
  );
  const requestedEventId = uuidValue(
    explicitEventId || sourceLookup?.eventId || (!sourceLookup ? fallback.eventId : ""),
  );
  const requestedObjectId = uuidValue(
    explicitObjectId || sourceLookup?.objectId || (!sourceLookup ? fallback.objectId : ""),
  );

  if (!requestedEventId && !requestedObjectId && !requestedEvidenceId) {
    return { config, intake: {} as JsonObject };
  }

  const [directEvidence] = requestedEvidenceId
    ? await db
        .select({
          id: evidence.id,
          kind: evidence.kind,
          name: evidence.name,
          objectId: evidence.objectId,
          eventId: evidence.eventId,
          data: evidence.data,
        })
        .from(evidence)
        .where(and(eq(evidence.tenantId, tenantId), eq(evidence.id, requestedEvidenceId)))
        .limit(1)
    : [];

  if (requestedEvidenceId && !directEvidence) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_evidence_not_found",
      "config.intake.evidenceId does not match Core evidence in this tenant.",
      404,
    );
  }

  const eventId = requestedEventId || directEvidence?.eventId || "";
  const [event] = eventId
    ? await db
        .select({
          id: events.id,
          source: events.source,
          idempotencyKey: events.idempotencyKey,
          objectId: events.objectId,
          data: events.data,
          occurredAt: events.occurredAt,
        })
        .from(events)
        .where(and(eq(events.tenantId, tenantId), eq(events.id, eventId)))
        .limit(1)
    : [];

  if (eventId && !event) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_event_not_found",
      "config.intake.eventId does not match a Core event in this tenant.",
      404,
    );
  }

  const resolvedObjectId = requestedObjectId || event?.objectId || directEvidence?.objectId || "";
  const [object] = resolvedObjectId
    ? await db
        .select({
          id: objects.id,
          type: objects.type,
          name: objects.name,
          state: objects.state,
          source: objects.source,
          externalId: objects.externalId,
          data: objects.data,
        })
        .from(objects)
        .where(and(eq(objects.tenantId, tenantId), eq(objects.id, resolvedObjectId)))
        .limit(1)
    : [];

  if (resolvedObjectId && !object) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_object_not_found",
      "config.intake.objectId does not match a Core object in this tenant.",
      404,
    );
  }

  const [linkedEvidence] =
    directEvidence || (!event?.id && !object?.id)
      ? []
      : await db
          .select({
            id: evidence.id,
            kind: evidence.kind,
            name: evidence.name,
            objectId: evidence.objectId,
            eventId: evidence.eventId,
            data: evidence.data,
          })
          .from(evidence)
          .where(
            and(
              eq(evidence.tenantId, tenantId),
              event?.id ? eq(evidence.eventId, event.id) : eq(evidence.objectId, object?.id ?? ""),
            ),
          )
          .orderBy(desc(evidence.createdAt))
          .limit(1);
  const evidenceRecord = directEvidence ?? linkedEvidence;
  const eventData = objectValue(event?.data);
  const objectData = objectValue(object?.data);
  const evidenceData = objectValue(evidenceRecord?.data);
  const lead = nestedLeadPacket(evidenceData, eventData, objectData, intake);
  const leadPacket = {
    source: firstStringValue(
      lead.source,
      intake.source,
      evidenceData.source,
      eventData.source,
      objectData.source,
      event?.source,
      object?.source,
      "core_intake",
    ),
    sourceEventId: firstStringValue(
      lead.sourceEventId,
      intake.sourceEventId,
      eventData.sourceEventId,
      event?.idempotencyKey,
      event?.id,
      object?.externalId,
    ),
    customerName: firstStringValue(
      lead.customerName,
      lead.name,
      evidenceData.customerName,
      eventData.customerName,
      objectData.customerName,
      object?.name,
    ),
    customerIntent: firstStringValue(
      lead.customerIntent,
      lead.intent,
      evidenceData.customerIntent,
      eventData.customerIntent,
      objectData.customerIntent,
      objectData.intent,
      object?.type,
    ),
    serviceArea: firstStringValue(
      lead.serviceArea,
      evidenceData.serviceArea,
      eventData.serviceArea,
      objectData.serviceArea,
    ),
    urgency: firstStringValue(lead.urgency, evidenceData.urgency, eventData.urgency, objectData.urgency),
    missingFacts: firstStringList(
      lead.missingFacts,
      evidenceData.missingFacts,
      eventData.missingFacts,
      objectData.missingFacts,
    ),
    raw: {
      intake,
      object: object
        ? {
            id: object.id,
            type: object.type,
            state: object.state,
            source: object.source,
            externalId: object.externalId,
            data: object.data,
          }
        : null,
      event: event
        ? {
            id: event.id,
            source: event.source,
            idempotencyKey: event.idempotencyKey,
            occurredAt: event.occurredAt.toISOString(),
            data: event.data,
          }
        : null,
      evidence: evidenceRecord
        ? {
            id: evidenceRecord.id,
            kind: evidenceRecord.kind,
            name: evidenceRecord.name,
            data: evidenceRecord.data,
          }
        : null,
    },
  };

  return {
    config: {
      ...config,
      leadPacket,
    },
    intake: {
      mode: sourceLookup ? "core_source_lookup" : "core_read",
      objectId: object?.id ?? null,
      eventId: event?.id ?? null,
      evidenceId: evidenceRecord?.id ?? null,
      source: leadPacket.source,
      sourceEventId: leadPacket.sourceEventId,
    },
  };
}

function leadPacketFromConfig(config: JsonObject) {
  const lead = objectValue(config.leadPacket ?? config.lead);
  const intake = objectValue(config.intake);
  const pricing = objectValue(config.pricing);
  const urgency = normalizedUrgency(lead.urgency);
  const customerName = stringValue(lead.customerName, stringValue(lead.name, "Customer"));
  const customerIntent = stringValue(lead.customerIntent, stringValue(lead.intent, "service request"));
  const serviceArea = stringValue(lead.serviceArea, "field service");
  const missingFacts = stringList(lead.missingFacts);
  const source = stringValue(lead.source, "operator_payload");
  const sourceEventId = stringValue(
    lead.sourceEventId,
    stringValue(intake.sourceEventId, stringValue(config.sourceEventId, "")),
  );
  const baseCents = numberValue(pricing.baseCents) || centsForIntent(customerIntent, serviceArea);
  const urgencyFeeCents = urgency === "urgent" ? 7500 : urgency === "high" ? 2500 : 0;
  const totalCents = baseCents + urgencyFeeCents;
  const classification =
    urgency === "urgent"
      ? "urgent_quote_ready_for_owner_approval"
      : missingFacts.length >= 3
        ? "quote_needs_facts_for_owner_review"
        : "quote_ready_for_owner_approval";
  const firstName = customerName.split(/\s+/)[0] || "there";
  const missingFactText =
    missingFacts.length > 0
      ? ` I still need ${missingFacts.join(", ")} before anything is sent.`
      : " The packet has the facts needed for owner review.";
  const draftResponse =
    `Hi ${firstName}, we can help with ${customerIntent}. ` +
    `I prepared a ${formatUsd(totalCents)} ${serviceArea} quote packet for owner review.${missingFactText} ` +
    "No message will be sent until the owner approves it.";
  const expectedAction = stringValue(config.expectedAction, "draft_customer_response");

  if (booleanValue(config.externalSend) || booleanValue(lead.externalSend)) {
    throw new RevenueWorkerUnavailableError(
      "worker_external_send_blocked",
      "Revenue Worker cannot send externally in the current no-send runtime.",
      403,
    );
  }

  return {
    source,
    sourceEventId: sourceEventId || null,
    customerName,
    customerIntent,
    serviceArea,
    urgency,
    missingFacts,
    classification,
    expectedAction,
    draftResponse,
    quote: {
      currency: "USD",
      subtotalCents: baseCents,
      urgencyFeeCents,
      totalCents,
      lines: [
        {
          label: customerIntent,
          amountCents: baseCents,
        },
        ...(urgencyFeeCents > 0
          ? [
              {
                label: "priority response",
                amountCents: urgencyFeeCents,
              },
            ]
          : []),
      ],
      policy: {
        approvalRequired: true,
        externalSend: false,
        moneyMovement: "blocked",
      },
    },
    sourceSnapshot: {
      source,
      sourceEventId: sourceEventId || null,
      customerName,
      customerIntent,
      serviceArea,
      urgency,
      missingFacts,
      raw: lead,
    },
  };
}

type ParsedLeadSourceRecord = {
  sourceEventId: string;
  sourceCursor: string | null;
  occurredAt: Date | null;
  leadPacket: JsonObject;
};

type LeadSourceReader = {
  kind: string;
  source: string;
  provider: string;
  credentialRef: string | null;
  connectionRef: string | null;
  cursor: string | null;
  authState: string;
  readOnly: true;
  externalExecution: "blocked";
  externalSend: false;
  connectionId?: string | null;
  connectionName?: string | null;
  connectionExternalAccountId?: string | null;
  sourceMode?: "payload" | "connection_buffer" | "connection_api";
};

type LeadSourceConnection = typeof connections.$inferSelect;
type LeadSourceConnectionCandidate = {
  connection: LeadSourceConnection;
  adapterKey: string;
  adapterKind: string;
  adapterCapabilities: JsonObject;
};

type LeadSourceConnectionRead = {
  connection: LeadSourceConnection;
  records: JsonObject[];
  sourceReader: LeadSourceReader;
  pollingReceipt: JsonObject | null;
};

function inferredSourceReaderKind(sourceName: string) {
  const source = sourceName.toLowerCase();

  if (source.includes("inbox") || source.includes("gmail") || source.includes("email")) {
    return "inbox";
  }

  if (source.includes("crm") || source.includes("hubspot") || source.includes("salesforce")) {
    return "crm";
  }

  if (source.includes("form")) {
    return "website_form";
  }

  return "source_record";
}

function rejectEmbeddedReaderCredentials(reader: JsonObject) {
  const forbiddenFields = ["token", "apiKey", "password", "secret", "accessToken", "refreshToken"];
  const embedded = forbiddenFields.filter((field) => reader[field] !== undefined);

  if (embedded.length > 0) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_embedded_credentials",
      "config.reader must reference credentials by credentialRef instead of embedding credential material.",
      400,
    );
  }
}

function parseSourceReader(config: JsonObject, sourceName: string): LeadSourceReader {
  const reader = objectValue(config.reader ?? config.sourceReader);
  rejectEmbeddedReaderCredentials(reader);

  const kind = firstStringValue(reader.kind, reader.type, config.sourceKind, inferredSourceReaderKind(sourceName))
    .toLowerCase()
    .replace(/[^a-z0-9_:-]/g, "_");
  const provider = firstStringValue(reader.provider, reader.adapter, reader.system, sourceName);
  const credentialRef = firstStringValue(reader.credentialRef, reader.connectionRef);
  const connectionRef = firstStringValue(reader.connectionRef, reader.connectionId);
  const cursor = firstStringValue(reader.cursor, reader.syncCursor);
  const requiresCredential = kind === "inbox" || kind === "crm";
  const readerMode = firstStringValue(reader.mode, "read_only");

  if (booleanValue(config.externalSend) || booleanValue(config.externalExecution)) {
    throw new RevenueWorkerUnavailableError(
      "worker_external_send_blocked",
      "Revenue Worker lead.read cannot execute external actions.",
      403,
    );
  }

  if (
    booleanValue(reader.externalSend) ||
    booleanValue(reader.externalExecution) ||
    !["read_only", "read", "snapshot"].includes(readerMode)
  ) {
    throw new RevenueWorkerUnavailableError(
      "worker_external_send_blocked",
      "Revenue Worker source readers must be read-only.",
      403,
    );
  }

  if (requiresCredential && !credentialRef) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_credential_ref_missing",
      "config.reader.credentialRef is required for inbox and CRM lead readers.",
      400,
    );
  }

  return {
    kind,
    source: sourceName,
    provider,
    credentialRef: credentialRef || null,
    connectionRef: connectionRef || null,
    cursor: cursor || null,
    authState: requiresCredential ? "credential_ref_present" : "not_required",
    readOnly: true,
    externalExecution: "blocked",
    externalSend: false,
  };
}

function displayNameFromAddress(value: unknown) {
  const address = stringValue(value);

  if (!address) {
    return "";
  }

  const match = address.match(/^"?([^"<]+?)"?\s*<[^>]+>$/);
  return stringValue(match?.[1], address).replace(/\s+/g, " ").trim();
}

function textExcerpt(value: unknown) {
  return stringValue(value).replace(/\s+/g, " ").trim().slice(0, 220);
}

function inboxRecordDetails(record: JsonObject, payload: JsonObject) {
  return {
    messageId: firstStringValue(record.messageId, payload.messageId, record.externalId, record.id),
    threadId: firstStringValue(record.threadId, payload.threadId),
    from: firstStringValue(record.from, payload.from, record.sender, payload.sender),
    subject: firstStringValue(record.subject, payload.subject),
    snippet: textExcerpt(record.snippet ?? payload.snippet ?? record.bodyText ?? payload.bodyText),
    receivedAt: firstStringValue(record.receivedAt, payload.receivedAt, record.occurredAt, payload.occurredAt),
  };
}

function crmRecordDetails(record: JsonObject, payload: JsonObject) {
  return {
    externalId: firstStringValue(record.externalId, payload.externalId, record.dealId, payload.dealId, record.id),
    accountName: firstStringValue(record.accountName, payload.accountName, record.companyName, payload.companyName),
    contactName: firstStringValue(record.contactName, payload.contactName, record.customerName, payload.customerName),
    opportunityName: firstStringValue(
      record.opportunityName,
      payload.opportunityName,
      record.dealName,
      payload.dealName,
      record.name,
      payload.name,
    ),
    stage: firstStringValue(record.stage, payload.stage, record.pipelineStage, payload.pipelineStage),
    ownerRef: firstStringValue(record.ownerRef, payload.ownerRef, record.owner, payload.owner),
    updatedAt: firstStringValue(record.updatedAt, payload.updatedAt, record.occurredAt, payload.occurredAt),
  };
}

function sourceRecordDetails(readerKind: string, record: JsonObject, payload: JsonObject) {
  if (readerKind === "inbox") {
    return inboxRecordDetails(record, payload);
  }

  if (readerKind === "crm") {
    return crmRecordDetails(record, payload);
  }

  return {};
}

function sourceEventIdFor(readerKind: string, record: JsonObject, lead: JsonObject, payload: JsonObject) {
  const inbox = inboxRecordDetails(record, payload);
  const crm = crmRecordDetails(record, payload);

  return firstStringValue(
    record.sourceEventId,
    record.externalId,
    readerKind === "inbox" ? inbox.messageId : "",
    readerKind === "crm" ? crm.externalId : "",
    record.messageId,
    record.id,
    lead.sourceEventId,
    payload.sourceEventId,
  );
}

function customerNameFor(readerKind: string, record: JsonObject, lead: JsonObject, payload: JsonObject) {
  const inbox = inboxRecordDetails(record, payload);
  const crm = crmRecordDetails(record, payload);

  return firstStringValue(
    lead.customerName,
    lead.name,
    record.customerName,
    record.name,
    payload.customerName,
    payload.name,
    readerKind === "crm" ? crm.contactName : "",
    readerKind === "crm" ? crm.accountName : "",
    readerKind === "crm" ? crm.opportunityName : "",
    readerKind === "inbox" ? displayNameFromAddress(inbox.from) : "",
    "Customer",
  );
}

function customerIntentFor(readerKind: string, record: JsonObject, lead: JsonObject, payload: JsonObject) {
  const inbox = inboxRecordDetails(record, payload);
  const crm = crmRecordDetails(record, payload);

  return firstStringValue(
    lead.customerIntent,
    lead.intent,
    record.customerIntent,
    record.intent,
    payload.customerIntent,
    payload.intent,
    readerKind === "crm" ? crm.opportunityName : "",
    readerKind === "crm" ? crm.stage : "",
    readerKind === "inbox" ? inbox.subject : "",
    readerKind === "inbox" ? inbox.snippet : "",
    "service request",
  );
}

function occurredAtFor(readerKind: string, record: JsonObject, payload: JsonObject, index: number) {
  const inbox = inboxRecordDetails(record, payload);
  const crm = crmRecordDetails(record, payload);

  return optionalRecordDate(
    record.occurredAt ??
      payload.occurredAt ??
      (readerKind === "inbox" ? inbox.receivedAt : undefined) ??
      (readerKind === "crm" ? crm.updatedAt : undefined),
    `config.records[${index}].occurredAt`,
  );
}

function configRecords(config: JsonObject, sourceReader: LeadSourceReader) {
  const record = objectValue(config.record);

  if (Object.keys(record).length > 0) {
    return [record];
  }

  const records = config.records ?? config.items ?? config.leads;

  if (!Array.isArray(records)) {
    if (sourceReader.credentialRef || sourceReader.connectionRef) {
      return null;
    }

    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_records_missing",
      "config.records must be a non-empty array for lead.read.",
      400,
    );
  }

  const objects = records.map((item) => objectValue(item));

  if (objects.length === 0 || objects.some((item) => Object.keys(item).length === 0)) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_records_missing",
      "config.records must contain at least one source record object.",
      400,
    );
  }

  if (objects.length > 25) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_records_limit",
      "lead.read accepts at most 25 source records per command.",
      400,
    );
  }

  return objects;
}

function optionalRecordDate(value: unknown, field: string) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const date = new Date(stringValue(value));

  if (Number.isNaN(date.getTime())) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_date_invalid",
      `${field} must be an ISO date when provided.`,
      400,
    );
  }

  return date;
}

function parseLeadSourceRequest(config: JsonObject) {
  const sourceName = stringValue(config.source ?? objectValue(config.intake).source);

  if (!sourceName) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_source_missing",
      "config.source is required for lead.read.",
      400,
    );
  }

  const sourceReader = parseSourceReader(config, sourceName);
  const records = configRecords(config, sourceReader);

  return { sourceName, sourceReader, records };
}

function parseLeadSourceRecords(
  sourceName: string,
  sourceReader: LeadSourceReader,
  recordInputs: JsonObject[],
) {
  if (recordInputs.length === 0) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_records_missing",
      "connection-backed lead.read did not find any source records.",
      409,
    );
  }

  const records = recordInputs.map((record, index): ParsedLeadSourceRecord => {
    const payload = objectValue(record.payload ?? record.data ?? record.raw);
    const lead = objectValue(record.leadPacket ?? record.lead);
    const readerKind = stringValue(sourceReader.kind, "source_record");
    const sourceEventId = sourceEventIdFor(readerKind, record, lead, payload);

    if (!sourceEventId) {
      throw new RevenueWorkerUnavailableError(
        "worker_lead_read_source_event_missing",
        `config.records[${index}].sourceEventId is required for lead.read.`,
        400,
      );
    }

    const customerName = customerNameFor(readerKind, record, lead, payload);
    const customerIntent = customerIntentFor(readerKind, record, lead, payload);
    const serviceArea = firstStringValue(
      lead.serviceArea,
      record.serviceArea,
      payload.serviceArea,
      "field service",
    );
    const missingFacts = firstStringList(lead.missingFacts, record.missingFacts, payload.missingFacts);
    const sourceRecord = sourceRecordDetails(readerKind, record, payload);

    return {
      sourceEventId,
      sourceCursor: firstStringValue(record.sourceCursor, record.cursor, payload.sourceCursor, sourceEventId) || null,
      occurredAt: occurredAtFor(readerKind, record, payload, index),
      leadPacket: {
        source: sourceName,
        sourceEventId,
        sourceReader,
        sourceRecord,
        customerName,
        customerIntent,
        serviceArea,
        urgency: normalizedUrgency(lead.urgency ?? record.urgency ?? payload.urgency),
        missingFacts,
        raw: {
          record,
          payload,
        },
      },
    };
  });

  return { sourceName, sourceReader, records };
}

function normalizeConnectionRef(value: string) {
  return value.replace(/^connection:/, "").trim();
}

function normalizeMatchToken(value: unknown) {
  return stringValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function stringTokenList(...values: unknown[]) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => stringList(value).concat(stringValue(value)))
        .map(normalizeMatchToken)
        .filter((value) => value.length > 0),
    ),
  );
}

function controlledExecutionConfig(config: JsonObject) {
  if (Object.prototype.hasOwnProperty.call(config, "controlledSend")) {
    throw new RevenueWorkerUnavailableError(
      "worker_controlled_send_config_alias",
      "Controlled send receipt recording only accepts execution details under config.execution.",
      400,
    );
  }

  if (Object.prototype.hasOwnProperty.call(config, "externalAction")) {
    throw new RevenueWorkerUnavailableError(
      "worker_controlled_send_config_alias",
      "Controlled send receipt recording only accepts execution details under config.execution.",
      400,
    );
  }

  const execution = objectValue(config.execution);

  return Object.keys(execution).length > 0 ? execution : null;
}

function storedContinuationConfig(params: {
  approvalId: string;
  config: JsonObject;
  execution: JsonObject | null;
}) {
  const extraFields = Object.keys(params.config).filter(
    (field) => field !== "approvalId" && field !== "execution",
  );
  const stored: JsonObject = {
    approvalId: params.approvalId,
  };

  if (params.execution) {
    stored.execution = {
      schemaVersion: "worker.execution_config_summary.v1",
      provided: true,
      inputHash: hashObject(params.execution),
    };
  }

  if (extraFields.length > 0) {
    stored.extraFields = extraFields.sort();
  }

  return stored;
}

async function customerMessageExecutionReceiptFor(input: {
  tx: Transaction;
  tenantId: string;
  execution: JsonObject | null;
  approvalId: string;
  adapterRunId: string;
  adapterActionId: string;
  now: Date;
}) {
  return approvedAdapterExecutionReceiptFor({
    db: input.tx,
    tenantId: input.tenantId,
    operation: "customer_message.send",
    approvalId: input.approvalId,
    execution: input.execution,
    adapterRunId: input.adapterRunId,
    adapterActionId: input.adapterActionId,
    now: input.now,
    configPath: "config.execution",
    defaultChannel: "email",
  });
}

function tokensMatch(left: string, right: string) {
  return left === right || left.startsWith(`${right}_`) || right.startsWith(`${left}_`);
}

function connectionCompatibleWithReader(
  candidate: LeadSourceConnectionCandidate,
  sourceReader: LeadSourceReader,
) {
  const connectionConfig = objectValue(candidate.connection.config);
  const connectionReader = objectValue(connectionConfig.reader ?? connectionConfig.sourceReader);
  const capabilities = objectValue(candidate.adapterCapabilities);
  const sourceTokens = stringTokenList(sourceReader.source, sourceReader.provider, sourceReader.kind);
  const connectionTokens = stringTokenList(
    candidate.adapterKey,
    candidate.adapterKind === "lead_source" ? "" : candidate.adapterKind,
    connectionConfig.source,
    connectionConfig.provider,
    connectionConfig.kind,
    connectionReader.source,
    connectionReader.provider,
    connectionReader.kind,
    connectionConfig.sources,
    connectionConfig.supportedSources,
    connectionConfig.providers,
    connectionConfig.supportedProviders,
    connectionConfig.readerKinds,
    connectionConfig.supportedReaderKinds,
    capabilities.sources,
    capabilities.supportedSources,
    capabilities.providers,
    capabilities.supportedProviders,
    capabilities.readerKinds,
    capabilities.supportedReaderKinds,
  );

  return sourceTokens.some((sourceToken) =>
    connectionTokens.some((connectionToken) => tokensMatch(sourceToken, connectionToken)),
  );
}

function connectionRecordArrays(config: JsonObject, readerKind: string): unknown[][] {
  const inbox = objectValue(config.inbox);
  const crm = objectValue(config.crm);
  const sourceConfig = objectValue(config.source);
  const leads = objectValue(config.leads);
  const candidates: unknown[] = [
    config.leadRecords,
    config.pendingLeadRecords,
    config.sourceRecords,
    config.records,
    sourceConfig.records,
    leads.records,
  ];

  if (readerKind === "inbox") {
    candidates.push(config.messages, inbox.messages, inbox.records);
  }

  if (readerKind === "crm") {
    candidates.push(config.deals, config.opportunities, crm.deals, crm.opportunities, crm.records);
  }

  return candidates.filter((candidate): candidate is unknown[] => Array.isArray(candidate));
}

function recordCursor(sourceReader: LeadSourceReader, record: JsonObject) {
  const payload = objectValue(record.payload ?? record.data ?? record.raw);
  const lead = objectValue(record.leadPacket ?? record.lead);

  return firstStringValue(
    record.sourceCursor,
    record.cursor,
    payload.sourceCursor,
    sourceEventIdFor(sourceReader.kind, record, lead, payload),
  );
}

function unreadConnectionRecords(params: {
  records: JsonObject[];
  connectionConfig: JsonObject;
  sourceReader: LeadSourceReader;
  missingCode: string;
  missingMessage: string;
  exhaustedMessage: string;
}) {
  const previousCursor = stringValue(objectValue(params.connectionConfig.lastLeadRead).cursor);
  const cursorIndex = previousCursor
    ? params.records.findIndex((record) => recordCursor(params.sourceReader, record) === previousCursor)
    : -1;
  const unreadRecords = cursorIndex >= 0 ? params.records.slice(cursorIndex + 1) : params.records;

  if (unreadRecords.length === 0) {
    throw new RevenueWorkerUnavailableError(
      previousCursor
        ? "worker_lead_read_connection_records_exhausted"
        : params.missingCode,
      previousCursor
        ? params.exhaustedMessage
        : params.missingMessage,
      409,
    );
  }

  return unreadRecords.slice(0, 25);
}

function recordsFromConnection(connection: LeadSourceConnection, sourceReader: LeadSourceReader) {
  const config = objectValue(connection.config);
  const arrays = connectionRecordArrays(config, sourceReader.kind);
  const records = arrays[0]?.map((item) => objectValue(item)).filter((item) => Object.keys(item).length > 0) ?? [];

  return unreadConnectionRecords({
    records,
    connectionConfig: config,
    sourceReader,
    missingCode: "worker_lead_read_connection_records_missing",
    missingMessage: "The referenced connection has no buffered lead source records to read.",
    exhaustedMessage: "The referenced connection has no unread buffered lead source records after its cursor.",
  });
}

function recordsFromPollResult(
  connection: LeadSourceConnection,
  sourceReader: LeadSourceReader,
  pollResult: LeadSourcePollResult,
) {
  const records = pollResult.records.map((record) => objectValue(record)).filter((record) => Object.keys(record).length > 0);

  return unreadConnectionRecords({
    records,
    connectionConfig: objectValue(connection.config),
    sourceReader,
    missingCode: "worker_lead_read_live_records_missing",
    missingMessage: "The referenced connection returned no lead source records from its read-only API poll.",
    exhaustedMessage: "The referenced connection has no unread API-polled lead source records after its cursor.",
  });
}

async function resolveLeadSourceConnection(
  db: Database,
  tenantId: string,
  sourceReader: LeadSourceReader,
): Promise<LeadSourceConnectionRead> {
  const refs = [sourceReader.connectionRef, sourceReader.credentialRef]
    .filter((ref): ref is string => Boolean(ref))
    .map(normalizeConnectionRef);

  if (refs.length === 0) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_records_missing",
      "config.records are required unless config.reader references an active connection.",
      400,
    );
  }

  const rows = await db
    .select({
      connection: connections,
      adapterKey: adapters.key,
      adapterKind: adapters.kind,
      adapterCapabilities: adapters.capabilities,
    })
    .from(connections)
    .innerJoin(adapters, eq(connections.adapterId, adapters.id))
    .where(and(eq(connections.tenantId, tenantId), eq(connections.state, "active")))
    .orderBy(connections.createdAt);
  const connection = rows.find((row) => {
    return refs.some(
      (ref) =>
        ref === row.connection.id ||
        ref === row.connection.externalAccountId ||
        ref === row.connection.name ||
        `connection:${row.connection.id}` === sourceReader.credentialRef ||
        (row.connection.externalAccountId
          ? `connection:${row.connection.externalAccountId}` === sourceReader.credentialRef
          : false),
    );
  });

  if (!connection) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_connection_missing",
      "config.reader must reference an active tenant connection for connection-backed lead.read.",
      404,
    );
  }

  if (!connectionCompatibleWithReader(connection, sourceReader)) {
    throw new RevenueWorkerUnavailableError(
      "worker_lead_read_connection_incompatible",
      "config.reader references a connection that is not compatible with the requested lead source.",
      409,
    );
  }

  const pollResult = await pollLeadSourceConnection({
    connectionId: connection.connection.id,
    connectionConfig: objectValue(connection.connection.config),
    sourceReader,
  });
  const records = pollResult
    ? recordsFromPollResult(connection.connection, sourceReader, pollResult)
    : recordsFromConnection(connection.connection, sourceReader);

  return {
    connection: connection.connection,
    records,
    sourceReader: {
      ...sourceReader,
      connectionId: connection.connection.id,
      connectionName: connection.connection.name,
      connectionExternalAccountId: connection.connection.externalAccountId ?? null,
      sourceMode: pollResult ? ("connection_api" as const) : ("connection_buffer" as const),
    },
    pollingReceipt: pollResult?.receipt ?? null,
  };
}

function lastSourceCursor(records: ParsedLeadSourceRecord[]) {
  const last = records.at(-1);

  return last?.sourceCursor ?? last?.sourceEventId ?? null;
}

function schedulerLeadReadProof(input: {
  config: JsonObject;
  connectionId: string;
  idempotencyKey: string;
}) {
  const scheduler = objectValue(input.config.scheduler);
  const leadPollIdempotencyKey = firstStringValue(
    scheduler.leadPollIdempotencyKey,
    scheduler.idempotencyKey,
  );
  const connectionId = firstStringValue(scheduler.connectionId);
  const source = firstStringValue(scheduler.source);
  const leaseOwner = firstStringValue(scheduler.leaseOwner);
  const expectedPrefix = `scheduler-lead-read:${input.connectionId}:`;
  const verified =
    source === schedulerSource &&
    connectionId === input.connectionId &&
    leadPollIdempotencyKey === input.idempotencyKey &&
    input.idempotencyKey.startsWith(expectedPrefix) &&
    Boolean(leaseOwner);

  if (!source && !connectionId && !leadPollIdempotencyKey && !leaseOwner) {
    return null;
  }

  return {
    schemaVersion: "worker.scheduler.lead_read_cursor_proof.v1",
    state: verified ? "verified" : "ignored",
    source: source || null,
    leaseOwner: leaseOwner || null,
    connectionId: connectionId || null,
    leadPollIdempotencyKey: leadPollIdempotencyKey || null,
    expectedPrefix,
    externalExecution: "blocked",
  } satisfies JsonObject;
}

function revisedPacketFromOriginal(params: {
  originalOutput: JsonObject;
  revisionNote: string;
  now: Date;
  approvalRequestId: string;
  originalWorkerRunId: string;
  workerRunId: string;
  workflowRunId: string;
}) {
  const previousPacket = objectValue(params.originalOutput.revisedPacket);
  const basePacket = Object.keys(previousPacket).length > 0 ? previousPacket : params.originalOutput;
  const previousQuote = objectValue(basePacket.quote ?? params.originalOutput.quote);
  const previousPolicy = objectValue(previousQuote.policy);
  const previousDraft = stringValue(
    basePacket.draftResponse ?? params.originalOutput.draftResponse,
    "A revised customer response is ready for owner review.",
  );
  const previousHistory = Array.isArray(basePacket.revisionHistory)
    ? basePacket.revisionHistory
    : [];
  const revisionNumber = previousHistory.length + 1;
  const generatedAt = params.now.toISOString();
  const revision = {
    number: revisionNumber,
    action: "revision_requested",
    note: params.revisionNote,
    originalApprovalRequestId: params.approvalRequestId,
    originalWorkerRunId: params.originalWorkerRunId,
    workerRunId: params.workerRunId,
    workflowRunId: params.workflowRunId,
    generatedAt,
  };

  return {
    schemaVersion: "worker.revenue_operations.revised_packet.v1",
    status: "revised_packet_ready_for_owner_approval",
    revision,
    revisionHistory: [...previousHistory, revision],
    source: stringValue(basePacket.source ?? params.originalOutput.source, "unknown"),
    sourceEventId: stringValue(basePacket.sourceEventId ?? params.originalOutput.sourceEventId) || null,
    classification: "revised_quote_ready_for_owner_approval",
    previousClassification: stringValue(
      basePacket.classification ?? params.originalOutput.classification,
      "quote_ready_for_owner_approval",
    ),
    draftResponse:
      `${previousDraft}\n\nOwner revision request: ${params.revisionNote} ` +
      "Revised packet is ready for owner review; no customer message will be sent until approval.",
    quote: {
      ...previousQuote,
      policy: {
        ...previousPolicy,
        approvalRequired: true,
        externalSend: false,
        moneyMovement: "blocked",
      },
      revision,
    },
    guardrails: ["no_external_send", "no_money_movement", "owner_approval_required"],
    externalExecution: "blocked",
    externalSend: false,
    requiresApproval: true,
    nextAction: "owner_approval",
  } satisfies JsonObject;
}

function approvedExecutionPacketFromOriginal(params: {
  originalOutput: JsonObject;
  approvalNote: string;
  now: Date;
  approvalRequestId: string;
  originalWorkerRunId: string;
  workerRunId: string;
  workflowRunId: string;
  controlledSendReceipt?: JsonObject | null;
}) {
  const approvedPacket = objectValue(params.originalOutput.revisedPacket);
  const basePacket = Object.keys(approvedPacket).length > 0 ? approvedPacket : params.originalOutput;
  const quote = objectValue(basePacket.quote ?? params.originalOutput.quote);
  const draftResponse = stringValue(
    basePacket.draftResponse ?? params.originalOutput.draftResponse,
    "Approved customer response is ready, but external execution is disabled.",
  );
  const approvedAt = params.now.toISOString();
  const controlledSendReceipt = objectValue(params.controlledSendReceipt);
  const hasControlledSendReceipt = Object.keys(controlledSendReceipt).length > 0;
  const status = hasControlledSendReceipt
    ? "approved_execution_recorded"
    : "approved_execution_blocked";
  const externalExecution = hasControlledSendReceipt ? "recorded" : "blocked";
  const externalSend = hasControlledSendReceipt;
  const nextAction = hasControlledSendReceipt
    ? "reconcile_controlled_send_receipt"
    : "enable_scoped_adapter_execution";
  const adapterMode = hasControlledSendReceipt ? "controlled_record" : "dry_run";
  const classification = hasControlledSendReceipt
    ? "approved_quote_controlled_send_recorded"
    : "approved_quote_ready_for_blocked_execution";
  const guardrails = hasControlledSendReceipt
    ? [
        "owner_approval_recorded",
        "scoped_credential_reference_required",
        "adapter_receipt_recorded",
        "rollback_plan_attached",
      ]
    : [
        "no_external_send",
        "no_money_movement",
        "scoped_live_credentials_required",
        "rollback_plan_required",
      ];

  return {
    schemaVersion: "worker.revenue_operations.approved_execution_packet.v1",
    status,
    approval: {
      approvalRequestId: params.approvalRequestId,
      note: params.approvalNote,
      approvedAt,
    },
    originalWorkerRunId: params.originalWorkerRunId,
    workerRunId: params.workerRunId,
    workflowRunId: params.workflowRunId,
    source: stringValue(basePacket.source ?? params.originalOutput.source, "unknown"),
    sourceEventId: stringValue(basePacket.sourceEventId ?? params.originalOutput.sourceEventId) || null,
    classification,
    draftResponse,
    quote: {
      ...quote,
      policy: {
        ...objectValue(quote.policy),
        approvalRequired: false,
        externalSend,
        moneyMovement: "blocked",
      },
    },
    preparedAction: stringValue(basePacket.expectedAction ?? params.originalOutput.expectedAction, "draft_customer_response"),
    adapterMode,
    guardrails,
    ...(hasControlledSendReceipt ? { controlledSendReceipt } : {}),
    externalExecution,
    externalSend,
    continuousExecuted: false,
    requiresApproval: false,
    nextAction,
  } satisfies JsonObject;
}

function rejectedPacketFromOriginal(params: {
  originalOutput: JsonObject;
  rejectionNote: string;
  now: Date;
  approvalRequestId: string;
  originalWorkerRunId: string;
  workerRunId: string;
  workflowRunId: string;
}) {
  const revisedPacket = objectValue(params.originalOutput.revisedPacket);
  const basePacket = Object.keys(revisedPacket).length > 0 ? revisedPacket : params.originalOutput;
  const rejectedAt = params.now.toISOString();

  return {
    schemaVersion: "worker.revenue_operations.rejected_packet.v1",
    status: "rejected_closed",
    rejection: {
      approvalRequestId: params.approvalRequestId,
      note: params.rejectionNote,
      rejectedAt,
    },
    originalWorkerRunId: params.originalWorkerRunId,
    workerRunId: params.workerRunId,
    workflowRunId: params.workflowRunId,
    source: stringValue(basePacket.source ?? params.originalOutput.source, "unknown"),
    sourceEventId: stringValue(basePacket.sourceEventId ?? params.originalOutput.sourceEventId) || null,
    classification: "quote_rejected_by_owner",
    previousClassification: stringValue(
      basePacket.classification ?? params.originalOutput.classification,
      "quote_ready_for_owner_approval",
    ),
    stoppedAction: stringValue(basePacket.expectedAction ?? params.originalOutput.expectedAction, "draft_customer_response"),
    guardrails: ["no_external_send", "no_money_movement", "prepared_action_stopped"],
    externalExecution: "blocked",
    externalSend: false,
    requiresApproval: false,
    nextAction: "stop_prepared_action",
  } satisfies JsonObject;
}

function paymentLinkBasePacket(originalOutput: JsonObject) {
  const previousPacket = objectValue(
    originalOutput.revisedPaymentLinkPacket ?? originalOutput.approvedPaymentLinkPacket,
  );

  return Object.keys(previousPacket).length > 0 ? previousPacket : originalOutput;
}

function paymentLinkPacketDetails(originalOutput: JsonObject) {
  const basePacket = paymentLinkBasePacket(originalOutput);
  const approval = objectValue(basePacket.approval);
  const revision = objectValue(basePacket.revision);
  const rejection = objectValue(basePacket.rejection);

  return {
    basePacket,
    paymentObjectId: uuidValue(basePacket.paymentObjectId ?? originalOutput.paymentObjectId),
    paymentId: uuidValue(basePacket.paymentId ?? originalOutput.paymentId),
    paymentInstructionId: uuidValue(basePacket.paymentInstructionId ?? originalOutput.paymentInstructionId),
    invoiceId: uuidValue(basePacket.invoiceId ?? originalOutput.invoiceId),
    invoiceObjectId: uuidValue(basePacket.invoiceObjectId ?? originalOutput.invoiceObjectId),
    quoteObjectId: uuidValue(basePacket.quoteObjectId ?? originalOutput.quoteObjectId),
    amountCents: numberValue(basePacket.amountCents ?? originalOutput.amountCents),
    currency: stringValue(basePacket.currency ?? originalOutput.currency, "USD"),
    customerName: stringValue(basePacket.customerName ?? originalOutput.customerName, "Customer"),
    dueAt: stringValue(basePacket.dueAt ?? originalOutput.dueAt) || null,
    blockers: stringList(basePacket.blockers ?? originalOutput.blockers),
    revisionHistory: Array.isArray(basePacket.revisionHistory) ? basePacket.revisionHistory : [],
    previousStatus: stringValue(
      basePacket.status ??
        approval.status ??
        revision.status ??
        rejection.status ??
        originalOutput.status,
      "payment_link_prepared_for_owner_approval",
    ),
  };
}

function approvedPaymentLinkPacketFromOriginal(params: {
  originalOutput: JsonObject;
  approvalNote: string;
  now: Date;
  approvalRequestId: string;
  originalWorkerRunId: string;
  workerRunId: string;
  workflowRunId: string;
}) {
  const details = paymentLinkPacketDetails(params.originalOutput);
  const approvedAt = params.now.toISOString();

  return {
    schemaVersion: "worker.revenue_operations.payment_link_approved_packet.v1",
    status: "approved_payment_link_execution_blocked",
    approval: {
      approvalRequestId: params.approvalRequestId,
      note: params.approvalNote,
      approvedAt,
    },
    originalWorkerRunId: params.originalWorkerRunId,
    workerRunId: params.workerRunId,
    workflowRunId: params.workflowRunId,
    paymentObjectId: details.paymentObjectId,
    paymentId: details.paymentId,
    paymentInstructionId: details.paymentInstructionId,
    invoiceId: details.invoiceId,
    invoiceObjectId: details.invoiceObjectId,
    quoteObjectId: details.quoteObjectId,
    amountCents: details.amountCents,
    currency: details.currency,
    customerName: details.customerName,
    dueAt: details.dueAt,
    blockers: details.blockers,
    previousStatus: details.previousStatus,
    preparedAction: "provider_payment_link.create",
    adapterMode: "dry_run",
    guardrails: [
      "owner_approval_recorded",
      "provider_payment_link_creation_blocked",
      "money_movement_blocked",
      "scoped_payment_provider_credentials_required",
      "rollback_plan_required",
    ],
    externalExecution: "blocked",
    externalMutation: false,
    externalSend: false,
    providerPaymentLinkCreation: "blocked",
    moneyMovement: "blocked",
    continuousExecuted: false,
    requiresApproval: false,
    nextAction: "enable_scoped_payment_provider_execution",
  } satisfies JsonObject;
}

function revisedPaymentLinkPacketFromOriginal(params: {
  originalOutput: JsonObject;
  revisionNote: string;
  now: Date;
  approvalRequestId: string;
  originalWorkerRunId: string;
  workerRunId: string;
  workflowRunId: string;
}) {
  const details = paymentLinkPacketDetails(params.originalOutput);
  const generatedAt = params.now.toISOString();
  const revisionNumber = details.revisionHistory.length + 1;
  const revision = {
    number: revisionNumber,
    action: "revision_requested",
    note: params.revisionNote,
    originalApprovalRequestId: params.approvalRequestId,
    originalWorkerRunId: params.originalWorkerRunId,
    workerRunId: params.workerRunId,
    workflowRunId: params.workflowRunId,
    generatedAt,
  };

  return {
    schemaVersion: "worker.revenue_operations.payment_link_revised_packet.v1",
    status: "revised_payment_link_packet_ready_for_owner_approval",
    revision,
    revisionHistory: [...details.revisionHistory, revision],
    paymentObjectId: details.paymentObjectId,
    paymentId: details.paymentId,
    paymentInstructionId: details.paymentInstructionId,
    invoiceId: details.invoiceId,
    invoiceObjectId: details.invoiceObjectId,
    quoteObjectId: details.quoteObjectId,
    amountCents: details.amountCents,
    currency: details.currency,
    customerName: details.customerName,
    dueAt: details.dueAt,
    blockers: details.blockers,
    previousStatus: details.previousStatus,
    revisionNote: params.revisionNote,
    guardrails: [
      "owner_approval_required",
      "provider_payment_link_creation_blocked",
      "money_movement_blocked",
      "external_execution_blocked",
    ],
    externalExecution: "blocked",
    externalMutation: false,
    externalSend: false,
    providerPaymentLinkCreation: "blocked",
    moneyMovement: "blocked",
    requiresApproval: true,
    nextAction: "owner_approval",
  } satisfies JsonObject;
}

function rejectedPaymentLinkPacketFromOriginal(params: {
  originalOutput: JsonObject;
  rejectionNote: string;
  now: Date;
  approvalRequestId: string;
  originalWorkerRunId: string;
  workerRunId: string;
  workflowRunId: string;
}) {
  const details = paymentLinkPacketDetails(params.originalOutput);
  const rejectedAt = params.now.toISOString();

  return {
    schemaVersion: "worker.revenue_operations.payment_link_rejected_packet.v1",
    status: "payment_link_rejected_closed",
    rejection: {
      approvalRequestId: params.approvalRequestId,
      note: params.rejectionNote,
      rejectedAt,
    },
    originalWorkerRunId: params.originalWorkerRunId,
    workerRunId: params.workerRunId,
    workflowRunId: params.workflowRunId,
    paymentObjectId: details.paymentObjectId,
    paymentId: details.paymentId,
    paymentInstructionId: details.paymentInstructionId,
    invoiceId: details.invoiceId,
    invoiceObjectId: details.invoiceObjectId,
    quoteObjectId: details.quoteObjectId,
    amountCents: details.amountCents,
    currency: details.currency,
    customerName: details.customerName,
    dueAt: details.dueAt,
    blockers: details.blockers,
    previousStatus: details.previousStatus,
    stoppedAction: "provider_payment_link.create",
    guardrails: ["provider_payment_link_creation_blocked", "money_movement_blocked", "prepared_action_stopped"],
    externalExecution: "blocked",
    externalMutation: false,
    externalSend: false,
    providerPaymentLinkCreation: "blocked",
    moneyMovement: "blocked",
    requiresApproval: false,
    nextAction: "stop_provider_payment_link_preparation",
  } satisfies JsonObject;
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
      tenantSlug: tenants.slug,
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
      triggerEventId: tasks.triggerEventId,
      capabilityId: tasks.capabilityId,
      priority: tasks.priority,
      reviewerUserId: tasks.reviewerUserId,
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
    .where(and(eq(capabilities.key, "quote.prepare"), eq(capabilities.active, true)))
    .limit(1);

  const [paymentLinkCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, "payment_link.prepare"), eq(capabilities.active, true)))
    .limit(1);

  const [leadReadCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, "lead.read"), eq(capabilities.active, true)))
    .limit(1);

  const [leadClassifyCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, "lead.classify"), eq(capabilities.active, true)))
    .limit(1);

  const [responseDraftCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, "response.draft"), eq(capabilities.active, true)))
    .limit(1);

  const [briefCapability] = await db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, "owner_brief.generate"), eq(capabilities.active, true)))
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
      tenantSlug: workerRow.tenantSlug,
      name: workerRow.name,
      kpis: workerRow.kpis,
    },
    tenantName: workerRow.tenantName,
    task: taskRow ?? null,
    leadReadCapabilityId: leadReadCapability?.id ?? null,
    leadClassifyCapabilityId: leadClassifyCapability?.id ?? null,
    responseDraftCapabilityId: responseDraftCapability?.id ?? null,
    quoteCapabilityId: quoteCapability?.id ?? null,
    paymentLinkCapabilityId: paymentLinkCapability?.id ?? null,
    briefCapabilityId: briefCapability?.id ?? null,
    budgetAccountId: budgetAccount.id,
    connectionId: connection.id,
    routeId: route?.id ?? null,
  };
}

async function loadOperator(
  db: Database,
  tenantId: string,
  operatorEmail: string,
): Promise<OperatorContext> {
  const email = operatorEmail.trim().toLowerCase();
  const [operator] = await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
    })
    .from(users)
    .where(and(eq(users.tenantId, tenantId), eq(users.email, email), eq(users.state, "active")))
    .limit(1);

  if (!operator) {
    throw new RevenueWorkerUnavailableError(
      "operator_not_found",
      "Revenue Worker run requires an active operator user for the configured email.",
      403,
    );
  }

  return {
    id: operator.id,
    email: operator.email,
    name: operator.name,
    actorRef: `user:${operator.id}`,
  };
}

async function getTenantObject(db: Database, tenantId: string, id: string) {
  if (!uuidPattern.test(id)) {
    return null;
  }

  const [object] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, id)))
    .limit(1);

  return object ?? null;
}

async function loadRevenueInvoiceRef(db: Database, tenantId: string, ref: string) {
  const [invoiceRow] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, ref)))
    .limit(1);
  const invoiceObject = invoiceRow?.objectId
    ? await getTenantObject(db, tenantId, invoiceRow.objectId)
    : await getTenantObject(db, tenantId, ref);
  const resolvedInvoice =
    invoiceRow ??
    (invoiceObject?.type === "invoice"
      ? (
          await db
            .select()
            .from(invoices)
            .where(and(eq(invoices.tenantId, tenantId), eq(invoices.objectId, invoiceObject.id)))
            .limit(1)
        )[0]
      : null);

  if (!resolvedInvoice || !invoiceObject || invoiceObject.type !== "invoice") {
    throw new RevenueWorkerUnavailableError(
      "revenue_invoice_not_found",
      "payment_link.prepare requires a tenant-scoped invoice id or invoice object id.",
      404,
    );
  }

  return {
    invoice: resolvedInvoice,
    invoiceObject,
  };
}

async function loadRevenuePaymentRef(db: Database, tenantId: string, ref: string) {
  const [paymentRow] = await db
    .select()
    .from(payments)
    .where(and(eq(payments.tenantId, tenantId), eq(payments.id, ref)))
    .limit(1);
  const paymentObject = paymentRow?.objectId
    ? await getTenantObject(db, tenantId, paymentRow.objectId)
    : await getTenantObject(db, tenantId, ref);
  const resolvedPayment =
    paymentRow ??
    (paymentObject?.type === "payment"
      ? (
          await db
            .select()
            .from(payments)
            .where(and(eq(payments.tenantId, tenantId), eq(payments.objectId, paymentObject.id)))
            .limit(1)
        )[0]
      : null);

  if (!resolvedPayment && !paymentObject) {
    throw new RevenueWorkerUnavailableError(
      "revenue_payment_not_found",
      "config.paymentId must reference a tenant-scoped payment row or payment object.",
      404,
    );
  }

  if (paymentObject && paymentObject.type !== "payment") {
    throw new RevenueWorkerUnavailableError(
      "revenue_payment_not_found",
      "config.paymentId must reference a payment object when it references a Core object.",
      404,
    );
  }

  return {
    payment: resolvedPayment ?? null,
    paymentObject: paymentObject ?? null,
  };
}

async function loadRevenuePaymentLinkRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const invoiceRef = optionalUuid(
    config.invoiceId ??
      config.invoiceObjectId ??
      sourceRefs.invoiceId ??
      sourceRefs.invoiceObjectId,
    "config.invoiceId or config.invoiceObjectId",
  );

  if (!invoiceRef) {
    throw new RevenueWorkerUnavailableError(
      "invalid_worker_command_config",
      "config.invoiceId, config.invoiceObjectId, config.sourceRefs.invoiceId or config.sourceRefs.invoiceObjectId is required for payment_link.prepare.",
      400,
    );
  }

  const invoiceRefResult = await loadRevenueInvoiceRef(db, tenantId, invoiceRef);
  const invoiceData = objectValue(invoiceRefResult.invoice.data);
  const invoiceObjectData = objectValue(invoiceRefResult.invoiceObject.data);
  const quoteRef = optionalUuid(
    config.quoteObjectId ?? sourceRefs.quoteObjectId ?? invoiceData.quoteObjectId ?? invoiceObjectData.quoteObjectId,
    "config.quoteObjectId",
  );
  const quoteObject = quoteRef ? await getTenantObject(db, tenantId, quoteRef) : null;

  if (quoteRef && quoteObject?.type !== "quote") {
    throw new RevenueWorkerUnavailableError(
      "revenue_quote_not_found",
      "config.quoteObjectId must reference a tenant-scoped quote object.",
      404,
    );
  }

  const paymentRef = optionalUuid(
    config.paymentId ?? config.paymentObjectId ?? sourceRefs.paymentId ?? sourceRefs.paymentObjectId,
    "config.paymentId",
  );
  const sourcePayment = paymentRef ? await loadRevenuePaymentRef(db, tenantId, paymentRef) : null;
  const bankAccountRef = optionalUuid(
    config.bankAccountId ?? sourceRefs.bankAccountId,
    "config.bankAccountId",
  );
  const bankAccountConditions = [
    eq(bankAccounts.tenantId, tenantId),
    eq(bankAccounts.state, "verified"),
  ];

  if (bankAccountRef) {
    bankAccountConditions.push(eq(bankAccounts.id, bankAccountRef));
  }

  const [bankAccount] = await db
    .select({
      id: bankAccounts.id,
      name: bankAccounts.name,
      state: bankAccounts.state,
      data: bankAccounts.data,
    })
    .from(bankAccounts)
    .where(and(...bankAccountConditions))
    .orderBy(sql`case when ${bankAccounts.state} = 'verified' then 0 else 1 end`, bankAccounts.createdAt)
    .limit(1);

  if (bankAccountRef && !bankAccount) {
    throw new RevenueWorkerUnavailableError(
      "revenue_bank_account_not_found",
      "config.bankAccountId must reference a verified tenant-scoped bank account.",
      404,
    );
  }

  const quoteData = objectValue(quoteObject?.data);
  const paymentData = objectValue(sourcePayment?.payment?.data);
  const paymentObjectData = objectValue(sourcePayment?.paymentObject?.data);
  const amountCents =
    firstNumberValue(
      config.amountCents,
      sourceRefs.amountCents,
      invoiceData.totalCents,
      invoiceData.total_cents,
      invoiceData.amountCents,
      invoiceData.amount_cents,
      invoiceObjectData.totalCents,
      invoiceObjectData.total_cents,
      quoteData.totalCents,
      quoteData.total_cents,
      paymentData.amountCents,
      paymentData.amount_cents,
      paymentObjectData.amountCents,
      paymentObjectData.amount_cents,
    ) ?? 0;
  const currency = firstStringValue(
    config.currency,
    sourceRefs.currency,
    invoiceData.currency,
    invoiceObjectData.currency,
    quoteData.currency,
    paymentData.currency,
    paymentObjectData.currency,
    "USD",
  )
    .toUpperCase()
    .slice(0, 3);
  const customerName = firstStringValue(
    config.customerName,
    sourceRefs.customerName,
    invoiceData.customerName,
    invoiceObjectData.customerName,
    quoteData.customerName,
    invoiceRefResult.invoiceObject.name,
    "Customer",
  );
  const dueAt = firstStringValue(config.dueAt, sourceRefs.dueAt, invoiceData.dueAt, invoiceObjectData.dueAt);
  const approvalRef = optionalUuid(
    config.approvalRequestId ?? sourceRefs.approvalRequestId,
    "config.approvalRequestId",
  );
  const [sourceApproval] = approvalRef
    ? await db
        .select({ id: approvalRequests.id, state: approvalRequests.state })
        .from(approvalRequests)
        .where(and(eq(approvalRequests.tenantId, tenantId), eq(approvalRequests.id, approvalRef)))
        .limit(1)
    : [];

  if (approvalRef && !sourceApproval) {
    throw new RevenueWorkerUnavailableError(
      "revenue_approval_not_found",
      "config.approvalRequestId must reference a tenant-scoped approval request.",
      404,
    );
  }

  const blockers = [
    ...(amountCents > 0 ? [] : ["amount_missing"]),
    ...(bankAccount ? [] : ["verified_bank_account_missing"]),
    "provider_payment_link_creation_blocked",
    "money_movement_blocked",
  ];

  return {
    sourceRefs,
    invoice: invoiceRefResult.invoice,
    invoiceObject: invoiceRefResult.invoiceObject,
    sourcePayment,
    quoteObject,
    sourceApproval: sourceApproval ?? null,
    bankAccount: bankAccount ?? null,
    amountCents,
    currency: currency.length === 3 ? currency : "USD",
    customerName,
    dueAt: dueAt || null,
    policy: objectValue(config.policy),
    blockers,
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
    latestWorkerRun,
    latestEventRun,
  ] = await Promise.all([
    db
      .select({ value: count() })
      .from(capabilityGrants)
      .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
      .where(
        and(
          eq(capabilityGrants.tenantId, workerRow.tenantId),
          eq(capabilityGrants.actorType, "worker"),
          eq(capabilityGrants.actorId, workerRow.id),
          eq(capabilityGrants.active, true),
          eq(capabilities.active, true),
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
      .orderBy(desc(tasks.updatedAt), desc(tasks.id))
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
        id: workerRuns.id,
        eventId: workerRuns.eventId,
        idempotencyKey: workerRuns.idempotencyKey,
        state: workerRuns.state,
        mode: workerRuns.mode,
        startedAt: workerRuns.startedAt,
      })
      .from(workerRuns)
      .where(and(eq(workerRuns.tenantId, workerRow.tenantId), eq(workerRuns.workerId, workerRow.id)))
      .orderBy(desc(workerRuns.startedAt), desc(workerRuns.id))
      .limit(1),
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
          eq(events.type, "worker.revenue_operations.run.completed"),
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
    latestRun: latestWorkerRun[0]
      ? {
          id: latestWorkerRun[0].id,
          workerRunId: latestWorkerRun[0].id,
          eventId: latestWorkerRun[0].eventId,
          idempotencyKey: latestWorkerRun[0].idempotencyKey,
          occurredAt: latestWorkerRun[0].startedAt.toISOString(),
          state: latestWorkerRun[0].state,
          mode: latestWorkerRun[0].mode,
        }
      : latestEventRun[0]
        ? {
            id: latestEventRun[0].id,
            workerRunId: null,
            eventId: latestEventRun[0].id,
            idempotencyKey: latestEventRun[0].idempotencyKey,
            occurredAt: latestEventRun[0].occurredAt.toISOString(),
            state: "done",
            mode: "legacy_event",
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

const revenueReadinessCapabilityKeys = [
  "lead.read",
  "lead.classify",
  "response.draft",
  "quote.prepare",
  "payment_link.prepare",
] as const;

function revenueReadinessCheck(input: {
  key: string;
  label: string;
  ready: boolean;
  details: JsonObject;
}): RevenueReadinessCheck {
  return {
    key: input.key,
    label: input.label,
    state: input.ready ? "ready" : "blocked",
    details: input.details,
  };
}

function revenueReadinessGate(input: {
  key: string;
  label: string;
  ready?: boolean;
  reason: string;
  requiredFor: string;
  details?: JsonObject;
}): RevenueReadinessGate {
  return {
    key: input.key,
    state: input.ready ? "ready" : "blocked",
    label: input.label,
    reason: input.reason,
    requiredFor: input.requiredFor,
    details: input.details ?? {},
  };
}

function revenueExecutionCredentialGates(): RevenueReadinessGate[] {
  return [
    revenueReadinessGate({
      key: "controlled_customer_send_credentials",
      label: "Controlled customer send credentials",
      reason:
        "Production sender and CRM managed credential references must be provisioned before external customer communication can execute.",
      requiredFor: "live_external_send",
    }),
    revenueReadinessGate({
      key: "controlled_send_receipt_and_rollback",
      label: "Controlled-send receipt and rollback proof",
      reason:
        "A first controlled send needs provider receipt capture plus rollback or escalation evidence before live execution is unblocked.",
      requiredFor: "live_external_send",
    }),
    revenueReadinessGate({
      key: "cash_and_payment_handoff_credentials",
      label: "Cash and payment handoff credentials",
      reason:
        "Accounting, payment, and bank credentials remain explicit handoff gates; Revenue may prepare packets but cannot move money.",
      requiredFor: "cash_handoff",
    }),
  ];
}

function sourcePollingConfig(config: JsonObject) {
  return objectValue(config.polling ?? config.liveRead ?? config.apiRead);
}

function pollingMode(config: JsonObject) {
  const polling = sourcePollingConfig(config);

  return firstStringValue(polling.mode, polling.sourceMode, polling.strategy).toLowerCase();
}

function connectionUsesBufferedPolling(config: JsonObject) {
  return ["buffer", "buffered", "connection_buffer"].includes(pollingMode(config));
}

function connectionReadScopes(scopes: JsonObject) {
  return Array.from(
    new Set([
      ...stringList(scopes.read),
      ...stringList(scopes.reads),
      ...stringList(scopes.lead),
      ...stringList(scopes.leads),
    ]),
  );
}

function connectionCredentialRef(config: JsonObject) {
  const polling = sourcePollingConfig(config);
  const auth = objectValue(config.auth);

  return firstStringValue(
    polling.credentialRef,
    polling.accessTokenRef,
    auth.credentialRef,
    auth.accessTokenRef,
    config.credentialRef,
    config.accessTokenRef,
  );
}

function connectionCredentialKind(ref: string) {
  if (!ref) {
    return null;
  }

  return ref.includes(":") ? ref.split(":")[0] : "unknown";
}

function connectionConfiguredSource(input: {
  adapterKey: string;
  config: JsonObject;
}) {
  const polling = sourcePollingConfig(input.config);

  return firstStringValue(
    polling.source,
    stringList(input.config.sources)[0],
    stringList(input.config.supportedSources)[0],
    input.config.source,
    input.adapterKey,
  );
}

function connectionConfiguredProvider(input: {
  adapterKey: string;
  config: JsonObject;
}) {
  const polling = sourcePollingConfig(input.config);

  return firstStringValue(
    polling.provider,
    stringList(input.config.providers)[0],
    stringList(input.config.supportedProviders)[0],
    input.config.provider,
    input.adapterKey,
  );
}

function lastLeadReadAt(config: JsonObject) {
  return stringValue(objectValue(config.lastLeadRead).readAt);
}

function connectionHasSchedulerCursor(input: {
  connection: typeof connections.$inferSelect;
  config: JsonObject;
}) {
  const lastLeadRead = objectValue(input.config.lastLeadRead);
  const schedulerProof = objectValue(lastLeadRead.schedulerProof);

  return (
    Boolean(input.connection.lastSyncAt || lastLeadReadAt(input.config)) &&
    schedulerProof.state === "verified" &&
    schedulerProof.source === schedulerSource
  );
}

function latestConnectionHealthStatus(data: JsonObject) {
  return stringValue(objectValue(data.report).status);
}

async function revenueLeadSourceReadinessGates(input: {
  db: Database;
  tenantId: string;
}): Promise<RevenueReadinessGate[]> {
  const rows = await input.db
    .select({
      connection: connections,
      adapterKey: adapters.key,
      adapterKind: adapters.kind,
      adapterCapabilities: adapters.capabilities,
    })
    .from(connections)
    .innerJoin(adapters, eq(connections.adapterId, adapters.id))
    .where(
      and(
        eq(connections.tenantId, input.tenantId),
        eq(connections.state, "active"),
      ),
    )
    .orderBy(desc(connections.updatedAt), desc(connections.createdAt));
  const connectionSummaries = rows.flatMap((row) => {
    const config = objectValue(row.connection.config);
    const scopes = objectValue(row.connection.scopes);
    const adapterCapabilities = objectValue(row.adapterCapabilities);
    const polling = sourcePollingConfig(config);
    const pollingEnabled = polling.enabled === true;
    const buffered = connectionUsesBufferedPolling(config);
    const credentialRef = connectionCredentialRef(config);
    const sourceName = connectionConfiguredSource({
      adapterKey: row.adapterKey,
      config,
    });
    const provider = connectionConfiguredProvider({
      adapterKey: row.adapterKey,
      config,
    });
    const readScopes = connectionReadScopes(scopes);
    const adapterReadCapabilities = stringList(adapterCapabilities.read);
    const leadSourceConnection =
      row.adapterKind === "lead_source" ||
      adapterReadCapabilities.includes("lead.read") ||
      readScopes.includes("lead") ||
      readScopes.includes("lead.read");

    if (!leadSourceConnection) {
      return [];
    }

    const pollable =
      pollingEnabled &&
      Boolean(sourceName && provider) &&
      readScopes.length > 0 &&
      (buffered || credentialRef.toLowerCase().startsWith("env:"));

    return {
      id: row.connection.id,
      name: row.connection.name,
      adapterKey: row.adapterKey,
      adapterKind: row.adapterKind,
      source: sourceName || null,
      provider: provider || null,
      pollingEnabled,
      pollingMode: buffered ? "connection_buffer" : pollingMode(config) || null,
      pollable,
      schedulerCursor: connectionHasSchedulerCursor({
        connection: row.connection,
        config,
      }),
      lastSyncAt: row.connection.lastSyncAt?.toISOString() ?? null,
      lastLeadReadAt: lastLeadReadAt(config) || null,
      readScopes,
      credentialRefKind: connectionCredentialKind(credentialRef),
    };
  });
  const pollableConnectionIds = connectionSummaries
    .filter((connection) => connection.pollable)
    .map((connection) => connection.id);
  const latestHealth = new Map<string, JsonObject>();

  if (pollableConnectionIds.length > 0) {
    const healthRows = await input.db
      .select({
        targetId: auditEvents.targetId,
        data: auditEvents.data,
      })
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.tenantId, input.tenantId),
          eq(auditEvents.source, connectionHealthSource),
          eq(auditEvents.targetType, "connection"),
          inArray(auditEvents.targetId, pollableConnectionIds),
        ),
      )
      .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id));

    for (const row of healthRows) {
      if (row.targetId && !latestHealth.has(row.targetId)) {
        latestHealth.set(row.targetId, objectValue(row.data));
      }
    }
  }

  const pollableConnections = connectionSummaries.filter((connection) => connection.pollable);
  const healthReadyConnections = pollableConnections.filter((connection) => {
    const status = latestConnectionHealthStatus(latestHealth.get(connection.id) ?? {});

    return status === "ready";
  });
  const schedulerReadyConnections = pollableConnections.filter((connection) => connection.schedulerCursor);

  return [
    revenueReadinessGate({
      key: "lead_source_connection",
      label: "Live lead source connection configured",
      ready: pollableConnections.length > 0,
      reason:
        pollableConnections.length > 0
          ? "At least one active lead-source connection is pollable through a read-only source-reader shape."
          : "Provision an active inbox or CRM lead-source connection with source, provider, read scopes, and an env-backed credential or buffered polling mode.",
      requiredFor: "live_source_coverage",
      details: {
        activeLeadSourceConnections: connectionSummaries.length,
        pollableConnections: pollableConnections.length,
        connections: connectionSummaries,
      },
    }),
    revenueReadinessGate({
      key: "lead_source_connection_health",
      label: "Lead source connection health recorded",
      ready: healthReadyConnections.length > 0,
      reason:
        healthReadyConnections.length > 0
          ? "At least one pollable lead-source connection has a ready connection.health.record report."
          : "Run /core command=connection.health.record for a pollable lead-source connection and keep the report ready before customer-data launch.",
      requiredFor: "live_source_coverage",
      details: {
        readyConnectionIds: healthReadyConnections.map((connection) => connection.id),
        latestHealth: Object.fromEntries(
          pollableConnections.map((connection) => [
            connection.id,
            latestConnectionHealthStatus(latestHealth.get(connection.id) ?? {}) || null,
          ]),
        ),
      },
    }),
    revenueReadinessGate({
      key: "scheduler_lead_read_cursor",
      label: "Scheduler lead-read cursor proof",
      ready: schedulerReadyConnections.length > 0,
      reason:
        schedulerReadyConnections.length > 0
          ? "At least one pollable lead-source connection has scheduler cursor proof from connection-backed lead.read."
          : "Let the scheduler complete connection-backed lead.read and write lastLeadRead/lastSyncAt proof before customer-data launch.",
      requiredFor: "live_source_coverage",
      details: {
        readyConnectionIds: schedulerReadyConnections.map((connection) => connection.id),
        pollableConnections: pollableConnections.map((connection) => ({
          id: connection.id,
          lastSyncAt: connection.lastSyncAt,
          lastLeadReadAt: connection.lastLeadReadAt,
        })),
      },
    }),
  ];
}

function revenueReadinessFromChecks(input: {
  worker: RevenueWorkerSnapshot["worker"];
  checks: RevenueReadinessCheck[];
  launchGates?: RevenueReadinessGate[];
  proof?: Partial<RevenueWorkerReadiness["proof"]>;
}) {
  const blockers = input.checks.filter((check) => check.state === "blocked");
  const launchGates = input.launchGates ?? revenueExecutionCredentialGates();
  const launchBlockers = launchGates.filter((gate) => gate.state === "blocked");

  return {
    worker: input.worker,
    status: blockers.length === 0 ? "ready" : "blocked",
    dryRunReady: blockers.length === 0,
    launchStatus: launchBlockers.length === 0 && blockers.length === 0 ? "ready" : "blocked",
    launchReady: blockers.length === 0 && launchBlockers.length === 0,
    checks: input.checks,
    blockers,
    launchGates,
    proof: {
      latestWorkerRunId: input.proof?.latestWorkerRunId ?? null,
      latestWorkerRunMode: input.proof?.latestWorkerRunMode ?? null,
      latestWorkerRunState: input.proof?.latestWorkerRunState ?? null,
      latestWorkerRunIdempotencyKey: input.proof?.latestWorkerRunIdempotencyKey ?? null,
      latestWorkerRunAt: input.proof?.latestWorkerRunAt ?? null,
      workflowDefinitionId: input.proof?.workflowDefinitionId ?? null,
      quoteApprovalViewId: input.proof?.quoteApprovalViewId ?? null,
      paymentReviewViewId: input.proof?.paymentReviewViewId ?? null,
      adapterReceiptEvidenceId: input.proof?.adapterReceiptEvidenceId ?? null,
    },
  } satisfies RevenueWorkerReadiness;
}

export async function getRevenueReadiness(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}): Promise<RevenueWorkerReadiness> {
  const db = input.db ?? defaultDb;
  const snapshot = await getRevenueWorkerSnapshot(db, input);

  if (!snapshot.worker) {
    return revenueReadinessFromChecks({
      worker: null,
      checks: [
        revenueReadinessCheck({
          key: "worker_registered",
          label: "Revenue worker registered",
          ready: false,
          details: {
            expectedRole: input.role ?? revenueWorkerRole,
            tenantSlug: input.tenantSlug ?? null,
          },
        }),
      ],
    });
  }

  const now = new Date();
  const [workerRow] = await db
    .select({
      id: workers.id,
      tenantId: workers.tenantId,
      state: workers.state,
    })
    .from(workers)
    .where(eq(workers.id, snapshot.worker.id))
    .limit(1);

  if (!workerRow) {
    return revenueReadinessFromChecks({
      worker: snapshot.worker,
      checks: [
        revenueReadinessCheck({
          key: "worker_registered",
          label: "Revenue worker registered",
          ready: false,
          details: {
            workerId: snapshot.worker.id,
            reason: "worker_row_missing",
          },
        }),
      ],
    });
  }

  const [
    activeCapabilities,
    activeGrants,
    budgetAccountRows,
    workflowRows,
    latestDryRunRows,
    quoteApprovalViews,
    paymentReviewViews,
  ] = await Promise.all([
    db
      .select({ id: capabilities.id, key: capabilities.key })
      .from(capabilities)
      .where(and(inArray(capabilities.key, [...revenueReadinessCapabilityKeys]), eq(capabilities.active, true))),
    db
      .select({ grantId: capabilityGrants.id, key: capabilities.key })
      .from(capabilityGrants)
      .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
      .where(
        and(
          eq(capabilityGrants.tenantId, workerRow.tenantId),
          eq(capabilityGrants.actorType, "worker"),
          eq(capabilityGrants.actorId, workerRow.id),
          eq(capabilityGrants.active, true),
          eq(capabilities.active, true),
          inArray(capabilities.key, [...revenueReadinessCapabilityKeys]),
          sql`(${capabilityGrants.startsAt} is null or ${capabilityGrants.startsAt} <= ${now})`,
          sql`(${capabilityGrants.endsAt} is null or ${capabilityGrants.endsAt} > ${now})`,
        ),
      ),
    db
      .select({
        id: budgetAccounts.id,
        name: budgetAccounts.name,
        policyId: budgetAccounts.policyId,
        policyActive: budgetPolicies.active,
        monthlyUnits: budgetPolicies.monthlyUnits,
        perTaskUnits: budgetPolicies.perTaskUnits,
      })
      .from(budgetAccounts)
      .leftJoin(budgetPolicies, eq(budgetAccounts.policyId, budgetPolicies.id))
      .where(
        and(
          eq(budgetAccounts.tenantId, workerRow.tenantId),
          eq(budgetAccounts.target, "worker"),
          eq(budgetAccounts.targetId, workerRow.id),
          eq(budgetAccounts.active, true),
        ),
      )
      .orderBy(budgetAccounts.createdAt)
      .limit(1),
    db
      .select({ id: workflowDefinitions.id, key: workflowDefinitions.key, version: workflowDefinitions.version })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, revenueWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(workflowDefinitions.version)
      .limit(1),
    db
      .select({
        id: workerRuns.id,
        state: workerRuns.state,
        mode: workerRuns.mode,
        idempotencyKey: workerRuns.idempotencyKey,
        startedAt: workerRuns.startedAt,
        data: workerRuns.data,
      })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, workerRow.tenantId),
          eq(workerRuns.workerId, workerRow.id),
          eq(workerRuns.state, "done"),
          inArray(workerRuns.mode, ["simulation", "quote_preparation", "payment_link_preparation"]),
        ),
      )
      .orderBy(desc(workerRuns.startedAt), desc(workerRuns.id))
      .limit(1),
    db
      .select({ id: generatedViews.id, key: generatedViews.key, active: generatedViews.active })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, workerRow.tenantId),
          eq(generatedViews.key, "quote.approval.review"),
          eq(generatedViews.active, true),
        ),
      )
      .orderBy(desc(generatedViews.updatedAt), desc(generatedViews.id))
      .limit(1),
    db
      .select({ id: generatedViews.id, key: generatedViews.key, active: generatedViews.active })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, workerRow.tenantId),
          eq(generatedViews.key, "payment.approval.review"),
          eq(generatedViews.active, true),
        ),
      )
      .orderBy(desc(generatedViews.updatedAt), desc(generatedViews.id))
      .limit(1),
  ]);

  const budgetAccount = budgetAccountRows[0];
  const allocationRows = budgetAccount
    ? await db
        .select({
          value: count(),
          units: sql<number>`coalesce(sum(${budgetAllocations.units}), 0)`,
        })
        .from(budgetAllocations)
        .where(
          and(
            eq(budgetAllocations.tenantId, workerRow.tenantId),
            eq(budgetAllocations.accountId, budgetAccount.id),
            sql`${budgetAllocations.startsAt} <= ${now}`,
            sql`${budgetAllocations.endsAt} > ${now}`,
          ),
        )
    : [{ value: 0, units: 0 }];
  const activeCapabilityKeys = new Set(activeCapabilities.map((capability) => capability.key));
  const grantedCapabilityKeys = new Set(activeGrants.map((grant) => grant.key));
  const missingCapabilities = revenueReadinessCapabilityKeys.filter(
    (key) => !activeCapabilityKeys.has(key),
  );
  const missingGrants = revenueReadinessCapabilityKeys.filter(
    (key) => activeCapabilityKeys.has(key) && !grantedCapabilityKeys.has(key),
  );
  const workflow = workflowRows[0];
  const latestDryRun = latestDryRunRows[0];
  const latestRunData = objectValue(latestDryRun?.data);
  const latestRunOutput = outputData(latestRunData);
  const adapterReceiptEvidenceId = stringData(latestRunData, "adapterReceiptEvidenceId");
  const workflowRunId = stringData(latestRunData, "workflowRunId");
  const quoteApprovalViewId =
    stringData(latestRunData, "quoteApprovalViewId") ||
    stringValue(latestRunOutput.quoteApprovalViewId) ||
    quoteApprovalViews[0]?.id ||
    null;
  const paymentReviewViewId =
    stringData(latestRunData, "paymentReviewViewId") ||
    stringValue(latestRunOutput.paymentReviewViewId) ||
    paymentReviewViews[0]?.id ||
    null;
  const latestRunMode = latestDryRun?.mode ?? null;
  const leadSourceGates = await revenueLeadSourceReadinessGates({
    db,
    tenantId: workerRow.tenantId,
  });
  const allocationCount = allocationRows[0]?.value ?? 0;
  const allocationUnits = numberValue(allocationRows[0]?.units);
  const budgetReady = Boolean(
    budgetAccount?.id && budgetAccount.policyId && budgetAccount.policyActive === true && allocationCount > 0,
  );
  const dryRunProofReady = Boolean(latestDryRun?.id && adapterReceiptEvidenceId && workflowRunId);

  return revenueReadinessFromChecks({
    worker: snapshot.worker,
    checks: [
      revenueReadinessCheck({
        key: "worker_registered",
        label: "Revenue worker registered",
        ready: ["training", "active"].includes(workerRow.state),
        details: {
          workerId: workerRow.id,
          state: workerRow.state,
          role: snapshot.worker.role,
        },
      }),
      revenueReadinessCheck({
        key: "capability_grants",
        label: "Required capability grants active",
        ready: missingCapabilities.length === 0 && missingGrants.length === 0,
        details: {
          required: [...revenueReadinessCapabilityKeys],
          granted: [...grantedCapabilityKeys],
          missingCapabilities,
          missingGrants,
        },
      }),
      revenueReadinessCheck({
        key: "budget",
        label: "Budget account, policy, and allocation ready",
        ready: budgetReady,
        details: {
          accountId: budgetAccount?.id ?? null,
          policyId: budgetAccount?.policyId ?? null,
          policyActive: budgetAccount?.policyActive ?? false,
          monthlyUnits: budgetAccount?.monthlyUnits ?? null,
          perTaskUnits: budgetAccount?.perTaskUnits ?? null,
          activeAllocations: allocationCount,
          activeAllocationUnits: allocationUnits,
        },
      }),
      revenueReadinessCheck({
        key: "workflow",
        label: "Lead-to-cash workflow definition active",
        ready: Boolean(workflow?.id),
        details: {
          workflowKey: revenueWorkflowKey,
          workflowDefinitionId: workflow?.id ?? null,
          version: workflow?.version ?? null,
        },
      }),
      revenueReadinessCheck({
        key: "latest_dry_run_proof",
        label: "Latest dry-run worker proof complete",
        ready: dryRunProofReady,
        details: {
          workerRunId: latestDryRun?.id ?? null,
          state: latestDryRun?.state ?? null,
          mode: latestDryRun?.mode ?? null,
          workflowRunId: workflowRunId || null,
          adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
        },
      }),
      revenueReadinessCheck({
        key: "quote_approval_view",
        label: "Quote approval review view published",
        ready: Boolean(quoteApprovalViewId),
        details: {
          key: "quote.approval.review",
          viewId: quoteApprovalViewId,
        },
      }),
      revenueReadinessCheck({
        key: "payment_review_view",
        label: "Payment review view published when payment-link proof is latest",
        ready: latestRunMode === "payment_link_preparation" ? Boolean(paymentReviewViewId) : true,
        details: {
          key: "payment.approval.review",
          viewId: paymentReviewViewId,
          latestWorkerRunMode: latestRunMode,
        },
      }),
    ],
    launchGates: [
      ...leadSourceGates,
      ...revenueExecutionCredentialGates(),
    ],
    proof: {
      latestWorkerRunId: latestDryRun?.id ?? null,
      latestWorkerRunMode: latestRunMode,
      latestWorkerRunState: latestDryRun?.state ?? null,
      latestWorkerRunIdempotencyKey: latestDryRun?.idempotencyKey ?? null,
      latestWorkerRunAt: latestDryRun?.startedAt.toISOString() ?? null,
      workflowDefinitionId: workflow?.id ?? null,
      quoteApprovalViewId,
      paymentReviewViewId,
      adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
    },
  });
}

export async function getRevenueReadinessSafe(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}): Promise<{ ok: boolean; readiness: RevenueWorkerReadiness; error: string | null }> {
  try {
    return {
      ok: true,
      readiness: await getRevenueReadiness(input),
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown Revenue Worker readiness error.";

    return {
      ok: false,
      readiness: revenueReadinessFromChecks({
        worker: null,
        checks: [
          revenueReadinessCheck({
            key: "readiness_query",
            label: "Revenue readiness query",
            ready: false,
            details: { error: message },
          }),
        ],
      }),
      error: message,
    };
  }
}

function replayedLeadReadResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: RevenueWorkerSnapshot,
): RevenueLeadReadResult {
  const output = outputData(run.data);
  const selectors = Array.isArray(output.selectors)
    ? output.selectors.map((selector) => objectValue(selector))
    : [];

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    eventId: run.eventId ?? stringData(run.data, "eventId"),
    reservationId: stringData(run.data, "reservationId"),
    usageEventId: stringData(run.data, "usageEventId"),
    auditEventId: stringData(run.data, "auditEventId"),
    readCount: numberValue(output.readCount),
    selectors,
    output,
    snapshot,
  };
}

export async function readRevenueLeads(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}): Promise<RevenueLeadReadResult> {
  const db = input.db ?? defaultDb;
  const requestConfig = input.config ?? {};
  const sourceRequest = parseLeadSourceRequest(requestConfig);
  const context = await loadWorkerContext(db, {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  });
  const operator = await loadOperator(db, context.worker.tenantId, input.operatorEmail);
  const capabilityId = context.leadReadCapabilityId;

  if (!capabilityId) {
    throw new RevenueWorkerUnavailableError(
      "worker_capability_missing",
      "Revenue Worker requires the lead.read capability for lead.read.",
      409,
    );
  }

  const requestHash = hashObject({
    schemaVersion: "worker.revenue_operations.lead_read.request.v1",
    idempotencyKey: input.idempotencyKey,
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    operatorUserId: operator.id,
    config: requestConfig,
    source: sourceRequest.sourceName,
    sourceReader: sourceRequest.sourceReader,
  });

  if (!sourceRequest.records) {
    const [existingRun] = await db
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, coreWorkerRunSource),
          eq(workerRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      const existingInput = objectValue(existingRun.data.input);
      const existingRequest = objectValue(existingInput.request);
      const existingRequestHash = stringValue(existingRequest.requestHash) || stringValue(existingInput.requestHash);
      const existingOutput = outputData(existingRun.data);

      if (
        stringValue(existingInput.command) !== "lead.read" ||
        (existingRequestHash && existingRequestHash !== requestHash)
      ) {
        throw new RevenueWorkerUnavailableError(
          "worker_idempotency_conflict",
          "This idempotency key was already used with different worker input.",
          409,
        );
      }

      if (stringValue(existingOutput.command) === "lead.read") {
        const snapshot = await getRevenueWorkerSnapshot(db, {
          tenantSlug: input.tenantSlug,
          workerId: context.worker.id,
          role: revenueWorkerRole,
        });

        return replayedLeadReadResult(existingRun, snapshot);
      }
    }
  }

  const connectionRead = sourceRequest.records
    ? null
    : await resolveLeadSourceConnection(
        db,
        context.worker.tenantId,
        sourceRequest.sourceReader,
      );
  const schedulerProof = connectionRead
    ? schedulerLeadReadProof({
        config: requestConfig,
        connectionId: connectionRead.connection.id,
        idempotencyKey: input.idempotencyKey,
      })
    : null;
  const sourceReader = connectionRead?.sourceReader ?? {
    ...sourceRequest.sourceReader,
    sourceMode: "payload" as const,
  };
  const { sourceName, records } = parseLeadSourceRecords(
    sourceRequest.sourceName,
    sourceReader,
    connectionRead?.records ?? sourceRequest.records ?? [],
  );

  const inputHash = hashObject({
    schemaVersion: "worker.revenue_operations.lead_read.v1",
    requestHash,
    idempotencyKey: input.idempotencyKey,
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    operatorUserId: operator.id,
    config: requestConfig,
    source: sourceName,
    sourceReader,
    records: records.map((record) => record.leadPacket),
  });
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: revenueWorkerRole,
    },
    command: "lead.read",
    mode: "read_only",
    capabilityId,
    connectionId: connectionRead?.connection.id ?? undefined,
    budgetAccountId: context.budgetAccountId,
    units: leadReadUnits,
    input: {
      requestHash,
      inputHash,
      config: requestConfig,
      source: sourceName,
      sourceReader,
      connectionId: connectionRead?.connection.id ?? null,
      pollingReceipt: connectionRead?.pollingReceipt ?? null,
      schedulerProof,
      records: records.map((record) => record.leadPacket),
    },
    policy: {
      externalExecution: "blocked",
      sourceRead: "read_only",
    },
    evidence: {
      command: "lead.read",
      required: ["lead_source_snapshot", "source_event", "intake_selector"],
      externalExecution: "blocked",
      externalSend: false,
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = stringValue(coreBudget.reservationId);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [run] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new RevenueWorkerUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Revenue Worker run.",
        409,
      );
    }

    const existingInput = objectValue(run.data.input);
    const existingRequest = objectValue(existingInput.request);
    const existingHash = stringValue(existingRequest.inputHash) || stringValue(existingInput.inputHash);
    const existingRequestHash = stringValue(existingRequest.requestHash) || stringValue(existingInput.requestHash);

    if (
      stringValue(existingInput.command) !== "lead.read" ||
      (existingRequestHash && existingRequestHash !== requestHash) ||
      (!existingRequestHash && existingHash && existingHash !== inputHash)
    ) {
      throw new RevenueWorkerUnavailableError(
        "worker_idempotency_conflict",
        "This idempotency key was already used with different worker input.",
        409,
      );
    }

    const existingOutput = outputData(run.data);

    if (stringValue(existingOutput.command) === "lead.read") {
      return {
        created: false as const,
        run,
        output: existingOutput,
        eventId: run.eventId ?? stringData(run.data, "eventId"),
        reservationId: stringData(run.data, "reservationId"),
        usageEventId: stringData(run.data, "usageEventId"),
        auditEventId: stringData(run.data, "auditEventId"),
      };
    }

    const now = new Date();

    const selectors = [] as JsonObject[];

    for (const record of records) {
      const leadPacket = record.leadPacket;
      const sourceEventId = record.sourceEventId;
      const objectData = {
        ...leadPacket,
        leadPacket,
        sourceRead: {
          workerRunId: run.id,
          idempotencyKey: input.idempotencyKey,
          command: "lead.read",
          sourceReader,
          readAt: now.toISOString(),
        },
        externalExecution: "blocked",
        externalSend: false,
      };
      const [existingObject] = await tx
        .select()
        .from(objects)
        .where(
          and(
            eq(objects.tenantId, context.worker.tenantId),
            eq(objects.source, sourceName),
            eq(objects.externalId, sourceEventId),
          ),
        )
        .limit(1);
      const [object] = existingObject
        ? await tx
            .update(objects)
            .set({
              type: "lead",
              name: stringValue(leadPacket.customerName, "Lead"),
              state: "received",
              data: objectData,
              updatedAt: now,
            })
            .where(eq(objects.id, existingObject.id))
            .returning()
        : await tx
            .insert(objects)
            .values({
              tenantId: context.worker.tenantId,
              type: "lead",
              name: stringValue(leadPacket.customerName, "Lead"),
              state: "received",
              source: sourceName,
              externalId: sourceEventId,
              data: objectData,
              createdByWorkerId: context.worker.id,
              effectiveAt: record.occurredAt ?? now,
              createdAt: now,
              updatedAt: now,
            })
            .returning();
      const [nextVersion] = await tx
        .select({
          value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
        })
        .from(objectVersions)
        .where(eq(objectVersions.objectId, object.id));

      await tx.insert(objectVersions).values({
        tenantId: context.worker.tenantId,
        objectId: object.id,
        version: Number(nextVersion?.value ?? 1),
        data: objectData,
        changedByType: "worker",
        changedById: context.worker.id,
        reason: "Revenue Worker read a lead source record.",
        createdAt: now,
      });

      const eventData = {
        ...leadPacket,
        leadPacket,
        sourceRead: {
          workerRunId: run.id,
          command: "lead.read",
          sourceReader,
          readAt: now.toISOString(),
        },
        externalExecution: "blocked",
        externalSend: false,
      };
      const [existingEvent] = await tx
        .select({ id: events.id })
        .from(events)
        .where(
          and(
            eq(events.tenantId, context.worker.tenantId),
            eq(events.source, sourceName),
            eq(events.idempotencyKey, sourceEventId),
          ),
        )
        .limit(1);
      const eventId =
        existingEvent?.id ??
        (
          await tx
            .insert(events)
            .values({
              tenantId: context.worker.tenantId,
              type: "lead.received",
              source: sourceName,
              actorType: "worker",
              actorId: context.worker.id,
              actorRef: `worker:${context.worker.id}`,
              objectId: object.id,
              capabilityId,
              idempotencyKey: sourceEventId,
              data: eventData,
              occurredAt: record.occurredAt ?? now,
              createdAt: now,
            })
            .returning({ id: events.id })
        )[0].id;
      const [sourceSnapshot] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "snapshot",
          name: "Lead source snapshot",
          objectId: object.id,
          eventId,
          capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: hashObject(leadPacket),
          data: {
            ...leadPacket,
            leadPacket,
            sourceObjectId: object.id,
            sourceEventRowId: eventId,
            source: sourceName,
            sourceReader,
            sourceEventId,
            workerRunId: run.id,
            externalExecution: "blocked",
            externalSend: false,
          },
          redaction: {
            raw: "retained_internal",
            externalSend: false,
          },
          createdAt: now,
        })
        .returning({ id: evidence.id });

      selectors.push({
        source: sourceName,
        sourceEventId,
        sourceReader,
        objectId: object.id,
        eventId,
        evidenceId: sourceSnapshot.id,
        intake: {
          source: sourceName,
          sourceEventId,
        },
      });
    }

    const output = {
      command: "lead.read",
      source: sourceName,
      sourceReader,
      readCount: records.length,
      selectors,
      objectIds: selectors.map((selector) => selector.objectId),
      eventIds: selectors.map((selector) => selector.eventId),
      evidenceIds: selectors.map((selector) => selector.evidenceId),
      reservationId: coreReservationId || null,
      usageEventId: null,
      connectionId: connectionRead?.connection.id ?? null,
      cursor: lastSourceCursor(records),
      pollingReceipt: connectionRead?.pollingReceipt ?? null,
      schedulerProof,
      externalExecution: "blocked",
      externalSend: false,
    };

    if (connectionRead) {
      const connectionConfig = objectValue(connectionRead.connection.config);
      const pollingReceipt = objectValue(connectionRead.pollingReceipt);
      const apiCursor = firstStringValue(pollingReceipt.nextPageToken, pollingReceipt.nextAfter);

      await tx
        .update(connections)
        .set({
          lastSyncAt: now,
          updatedAt: now,
          config: {
            ...connectionConfig,
            lastLeadRead: {
              command: "lead.read",
              workerRunId: run.id,
              idempotencyKey: input.idempotencyKey,
              source: sourceName,
              sourceMode: sourceReader.sourceMode ?? null,
              readCount: records.length,
              cursor: lastSourceCursor(records),
              apiCursor: apiCursor || null,
              pollingReceipt: connectionRead.pollingReceipt,
              schedulerProof,
              readAt: now.toISOString(),
              externalExecution: "blocked",
            },
          },
        })
        .where(eq(connections.id, connectionRead.connection.id));
    }

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.revenue_operations.lead_read.completed",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:lead_read_completed`,
        data: {
          workerRunId: run.id,
          output,
          externalExecution: "blocked",
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.revenue_operations.lead_read.completed",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "worker_run",
        targetId: run.id,
        workerRunId: run.id,
        eventId: event.id,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:lead_read_completed`,
        data: {
          source: sourceName,
          sourceReader,
          readCount: records.length,
          selectors,
          reservationId: coreReservationId || null,
          usageEventId: null,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        data: {
          ...objectValue(run.data),
          businessEventId: event.id,
          businessAuditEventId: audit.id,
          reservationId: coreReservationId || null,
          auditEventId: audit.id,
          eventId: event.id,
          pendingCompletion: {
            output,
          },
          externalExecution: "blocked",
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, run.id));
    await tx
      .update(workers)
      .set({
        kpis: {
          ...context.worker.kpis,
          lastLeadReadAt: now.toISOString(),
          leads_read: numberValue(context.worker.kpis.leads_read) + records.length,
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      created: true as const,
      workerRunId: run.id,
      eventId: event.id,
      reservationId: coreReservationId || null,
      usageEventId: null,
      auditEventId: audit.id,
      output,
    };
  });
  const completion = result.created
    ? await completeCoreWorkerRun({
        operatorEmail: input.operatorEmail,
        tenantSlug: context.worker.tenantSlug,
        idempotencyKey: input.idempotencyKey,
        worker: {
          id: context.worker.id,
          role: revenueWorkerRole,
        },
        workerRunId: result.workerRunId,
        state: "done",
        reason: "Revenue Worker read lead source records with external execution blocked.",
        output: result.output,
        costUsd: 0,
        evidence: {
          command: "lead.read",
          eventId: result.eventId,
          auditEventId: result.auditEventId,
          source: sourceName,
          sourceReader,
          readCount: records.length,
          externalExecution: "blocked",
          externalSend: false,
        },
        db,
      })
    : null;
  const completionBudget = objectValue(completion?.budget);
  const settledReservationId = stringValue(completionBudget.reservationId) || result.reservationId;
  const settledUsageEventId = stringValue(completionBudget.usageEventId) || result.usageEventId;
  const settledOutput = {
    ...result.output,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
  } satisfies JsonObject;
  const snapshot = await getRevenueWorkerSnapshot(db, {
    tenantSlug: input.tenantSlug,
    workerId: context.worker.id,
    role: revenueWorkerRole,
  });

  if (!result.created) {
    return replayedLeadReadResult(result.run, snapshot);
  }

  const selectors = Array.isArray(result.output.selectors)
    ? result.output.selectors.map((selector) => objectValue(selector))
    : [];

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    eventId: result.eventId,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
    auditEventId: result.auditEventId,
    readCount: records.length,
    selectors,
    output: settledOutput,
    snapshot,
  };
}

function replayedRevenueActionResult(
  run: typeof workerRuns.$inferSelect,
  snapshot: RevenueWorkerSnapshot,
): RevenueWorkerActionResult {
  const output = outputData(run.data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    eventId: stringData(run.data, "eventId") ?? run.eventId,
    reservationId: stringData(run.data, "reservationId"),
    inferenceId: stringData(run.data, "inferenceId"),
    usageEventId: stringData(run.data, "usageEventId"),
    evidenceId: stringData(run.data, "evidenceId"),
    auditEventId: stringData(run.data, "auditEventId"),
    output,
    snapshot,
  };
}

function revenueActionOutput(command: "lead.classify" | "response.draft", leadPacket: JsonObject): JsonObject {
  const quote = objectValue(leadPacket.quote);
  const output = {
    command,
    source: leadPacket.source ?? null,
    sourceEventId: leadPacket.sourceEventId ?? null,
    customerName: leadPacket.customerName ?? "Customer",
    customerIntent: leadPacket.customerIntent ?? "service request",
    serviceArea: leadPacket.serviceArea ?? "field service",
    urgency: leadPacket.urgency ?? "normal",
    missingFacts: stringList(leadPacket.missingFacts),
    classification: leadPacket.classification ?? "quote_ready_for_owner_approval",
    expectedAction: leadPacket.expectedAction ?? "draft_customer_response",
    externalExecution: "blocked",
    externalSend: false,
  };

  if (command === "lead.classify") {
    return {
      ...output,
      reason:
        output.missingFacts.length > 0
          ? "Lead needs owner-visible missing-fact review before any external send."
          : "Lead has enough structured facts for owner quote review.",
    };
  }

  return {
    ...output,
    draftResponse: leadPacket.draftResponse ?? "",
    quote,
    reason: "Draft response is prepared for owner review only; external send remains blocked.",
  };
}

async function runRevenueActionCommand(input: {
  command: "lead.classify" | "response.draft";
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}): Promise<RevenueWorkerActionResult> {
  const db = input.db ?? defaultDb;
  const requestConfig = input.config ?? {};
  const selector: RevenueWorkerSelector = {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  };
  const context = await loadWorkerContext(db, selector);
  const operator = await loadOperator(db, context.worker.tenantId, input.operatorEmail);
  const capabilityId =
    input.command === "lead.classify"
      ? context.leadClassifyCapabilityId
      : context.responseDraftCapabilityId;

  if (!capabilityId) {
    throw new RevenueWorkerUnavailableError(
      "worker_capability_missing",
      `Revenue Worker requires the ${input.command} capability for ${input.command}.`,
      409,
    );
  }

  const resolvedInput = await resolveLeadIntake(db, context.worker.tenantId, requestConfig, {
    objectId: context.task?.objectId,
    eventId: context.task?.triggerEventId,
  });
  const config = resolvedInput.config;
  const intake = resolvedInput.intake;
  const leadPacket = leadPacketFromConfig(config);
  const sourceObjectId = stringValue(intake.objectId) || context.task?.objectId || null;
  const sourceEventRowId = stringValue(intake.eventId) || context.task?.triggerEventId || null;
  const sourceEvidenceId = stringValue(intake.evidenceId) || null;
  const intakeTrace = {
    intake,
    sourceObjectId,
    sourceEventRowId,
    sourceEvidenceId,
  };
  const units = input.command === "lead.classify" ? leadClassifyUnits : responseDraftUnits;
  const mode = input.command === "lead.classify" ? "classification" : "draft";
  const eventType =
    input.command === "lead.classify"
      ? "worker.revenue_operations.lead_classify.completed"
      : "worker.revenue_operations.response_draft.completed";
  const evidenceName =
    input.command === "lead.classify"
      ? "Revenue lead classification trace"
      : "Revenue response draft";
  const inputHash = hashObject({
    schemaVersion: `worker.revenue_operations.${input.command}.v1`,
    command: input.command,
    idempotencyKey: input.idempotencyKey,
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    operatorUserId: operator.id,
    requestConfig,
    config,
    ...intakeTrace,
    leadPacket: leadPacket.sourceSnapshot,
  });
  const actionRunInput = {
    command: input.command,
    inputHash,
    config: requestConfig,
    resolvedConfig: config,
    ...intakeTrace,
    leadPacket: leadPacket.sourceSnapshot,
    operator: {
      userId: operator.id,
      email: operator.email,
    },
  };
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: revenueWorkerRole,
    },
    command: input.command,
    mode,
    taskId: context.task?.id,
    capabilityId,
    budgetAccountId: context.budgetAccountId,
    units,
    input: actionRunInput,
    policy: {
      externalExecution: "blocked",
      externalSend: false,
      moneyMovement: "blocked",
    },
    evidence: {
      command: input.command,
      required: ["lead_intake", "inference_trace", "action_evidence", "action_audit"],
      externalExecution: "blocked",
      externalSend: false,
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = stringValue(coreBudget.reservationId);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${coreWorkerRunSource}:${input.idempotencyKey}`}))`,
    );

    const [run] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new RevenueWorkerUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Revenue Worker action run.",
        409,
      );
    }

    const existingInput = objectValue(run.data.input);
    const existingRequest = objectValue(existingInput.request);
    const existingHash = stringValue(existingRequest.inputHash) || stringValue(existingInput.inputHash);

    if (stringValue(existingInput.command) !== input.command || (existingHash && existingHash !== inputHash)) {
      throw new RevenueWorkerUnavailableError(
        "worker_idempotency_conflict",
        "This idempotency key was already used with different worker input.",
        409,
      );
    }

    const existingOutput = outputData(run.data);

    if (stringValue(existingOutput.command) === input.command) {
      return {
        created: false as const,
        run,
      };
    }

    const now = new Date();
    const output = revenueActionOutput(input.command, leadPacket);
    const [inference] = await tx
      .insert(inferences)
      .values({
        tenantId: context.worker.tenantId,
        routeId: context.routeId,
        budgetAccountId: context.budgetAccountId,
        taskId: context.task?.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        promptHash: traceHash(input.idempotencyKey, input.command),
        request: {
          command: input.command,
          mode,
          leadPacket: leadPacket.sourceSnapshot,
          ...intakeTrace,
          inputHash,
        },
        result: output,
        safety: {
          externalExecution: "blocked",
          externalSend: false,
          moneyMovement: "blocked",
        },
        promptTokens: input.command === "lead.classify" ? 320 : 520,
        completionTokens: input.command === "lead.classify" ? 120 : 220,
        units,
        costUsd: "0.000000",
        latencyMs: input.command === "lead.classify" ? 110 : 170,
        createdAt: now,
      })
      .returning({ id: inferences.id });
    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: eventType,
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: sourceObjectId,
        taskId: context.task?.id,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:${input.command}`,
        data: {
          workerRunId: run.id,
          command: input.command,
          inputHash,
          output,
          ...intakeTrace,
          externalExecution: "blocked",
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });
    const [actionEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: input.command === "lead.classify" ? "trace" : "draft",
        name: evidenceName,
        objectId: sourceObjectId,
        taskId: context.task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, input.command),
        data: {
          workerRunId: run.id,
          command: input.command,
          inputHash,
          output,
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
          inferenceId: inference.id,
          usageEventId: null,
          reservationId: coreReservationId || null,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });
    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: eventType,
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "worker_run",
        targetId: run.id,
        taskId: context.task?.id,
        workerRunId: run.id,
        eventId: event.id,
        objectId: sourceObjectId,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:${input.command}`,
        data: {
          operatorEmail: operator.email,
          command: input.command,
          inputHash,
          output,
          evidenceId: actionEvidence.id,
          inferenceId: inference.id,
          usageEventId: null,
          reservationId: coreReservationId || null,
          ...intakeTrace,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        data: {
          ...objectValue(run.data),
          businessEventId: event.id,
          businessAuditEventId: audit.id,
          pendingCompletion: {
            output,
          },
          eventId: event.id,
          reservationId: coreReservationId || null,
          inferenceId: inference.id,
          evidenceId: actionEvidence.id,
          auditEventId: audit.id,
          externalExecution: "blocked",
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, run.id));

    const nextKpis =
      input.command === "lead.classify"
        ? {
            ...context.worker.kpis,
            lastLeadClassifiedAt: now.toISOString(),
            leads_classified: numberValue(context.worker.kpis.leads_classified) + 1,
          }
        : {
            ...context.worker.kpis,
            lastResponseDraftedAt: now.toISOString(),
            responses_drafted: numberValue(context.worker.kpis.responses_drafted) + 1,
          };

    await tx
      .update(workers)
      .set({
        kpis: nextKpis,
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      created: true as const,
      workerRunId: run.id,
      eventId: event.id,
      reservationId: coreReservationId || null,
      inferenceId: inference.id,
      usageEventId: null,
      evidenceId: actionEvidence.id,
      auditEventId: audit.id,
      output,
    };
  });
  const completion = result.created
    ? await completeCoreWorkerRun({
        operatorEmail: input.operatorEmail,
        tenantSlug: context.worker.tenantSlug,
        idempotencyKey: input.idempotencyKey,
        worker: {
          id: context.worker.id,
          role: revenueWorkerRole,
        },
        workerRunId: result.workerRunId,
        state: "done",
        reason: `Revenue Worker completed ${input.command} with external execution blocked.`,
        output: result.output,
        costUsd: 0,
        evidence: {
          command: input.command,
          eventId: result.eventId,
          auditEventId: result.auditEventId,
          evidenceId: result.evidenceId,
          inferenceId: result.inferenceId,
          ...intakeTrace,
          externalExecution: "blocked",
          externalSend: false,
        },
        db,
      })
    : null;
  const snapshot = await getRevenueWorkerSnapshot(db, {
    tenantSlug: input.tenantSlug,
    workerId: context.worker.id,
    role: revenueWorkerRole,
  });

  if (!result.created) {
    return replayedRevenueActionResult(result.run, snapshot);
  }

  const completionBudget = objectValue(completion?.budget);
  const settledReservationId = stringValue(completionBudget.reservationId) || result.reservationId;
  const settledUsageEventId = stringValue(completionBudget.usageEventId) || result.usageEventId;

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    eventId: result.eventId,
    reservationId: settledReservationId,
    inferenceId: result.inferenceId,
    usageEventId: settledUsageEventId,
    evidenceId: result.evidenceId,
    auditEventId: result.auditEventId,
    output: result.output,
    snapshot,
  };
}

export async function classifyRevenueLead(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}) {
  return runRevenueActionCommand({
    ...input,
    command: "lead.classify",
  });
}

export async function draftRevenueResponse(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}) {
  return runRevenueActionCommand({
    ...input,
    command: "response.draft",
  });
}

export async function runRevenueWorker(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
  command?: RevenueRunCommand;
}): Promise<RevenueWorkerRunResult> {
  const db = input.db ?? defaultDb;
  const command = input.command ?? "run";
  const commandLabel = command === "quote.prepare" ? "quote.prepare" : "run";
  const runMode = command === "quote.prepare" ? "quote_preparation" : "simulation";
  const requestedEventType =
    command === "quote.prepare"
      ? "worker.revenue_operations.quote_prepare.requested"
      : "worker.revenue_operations.run.requested";
  const completedEventType =
    command === "quote.prepare"
      ? "worker.revenue_operations.quote_prepare.completed"
      : "worker.revenue_operations.run.completed";
  const selector: RevenueWorkerSelector = {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  };
  const context = await loadWorkerContext(db, selector);
  const operator = await loadOperator(db, context.worker.tenantId, input.operatorEmail);
  let task = context.task;
  const capabilityId =
    command === "quote.prepare"
      ? context.quoteCapabilityId
      : context.quoteCapabilityId ?? context.briefCapabilityId;

  if (!capabilityId) {
    throw new RevenueWorkerUnavailableError(
      "worker_capability_missing",
      `Revenue Worker has no capability for ${commandLabel}.`,
    );
  }

  const requestConfig = input.config ?? {};
  const resolvedInput = await resolveLeadIntake(db, context.worker.tenantId, requestConfig, {
    objectId: task?.objectId,
    eventId: task?.triggerEventId,
  });
  const config = resolvedInput.config;
  const intake = resolvedInput.intake;
  const leadPacket = leadPacketFromConfig(config);
  const sourceObjectId = stringValue(intake.objectId) || null;
  const sourceEventRowId = stringValue(intake.eventId) || null;
  const sourceEvidenceId = stringValue(intake.evidenceId) || null;
  const intakeTrace = {
    intake,
    sourceObjectId,
    sourceEventRowId,
    sourceEvidenceId,
  };
  const runObjectId = sourceObjectId;
  const inputHash = hashObject(
    command === "run"
      ? {
          schemaVersion: "worker.revenue_operations.lead_packet.v1",
          mode: "simulation",
          idempotencyKey: input.idempotencyKey,
          tenantId: context.worker.tenantId,
          workerId: context.worker.id,
          operatorUserId: operator.id,
          requestConfig,
          config,
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
        }
      : {
          schemaVersion: "worker.revenue_operations.quote_prepare.v1",
          command,
          mode: runMode,
          idempotencyKey: input.idempotencyKey,
          tenantId: context.worker.tenantId,
          workerId: context.worker.id,
          operatorUserId: operator.id,
          requestConfig,
          config,
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
        },
  );
  const runInput = {
    idempotencyKey: input.idempotencyKey,
    command,
    inputHash,
    config: requestConfig,
    resolvedConfig: config,
    ...intakeTrace,
    leadPacket: leadPacket.sourceSnapshot,
    operator: {
      userId: operator.id,
      email: operator.email,
    },
    taskId: null,
    objectId: sourceObjectId,
    capabilityId,
    connectionId: context.connectionId,
    budgetAccountId: context.budgetAccountId,
    routeId: context.routeId,
    units: runUnits,
    mode: runMode,
  };
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: revenueWorkerRole,
    },
    command,
    mode: runMode,
    capabilityId,
    connectionId: context.connectionId,
    budgetAccountId: context.budgetAccountId,
    units: runUnits,
    input: runInput,
    policy: {
      externalExecution: "blocked",
      externalSend: false,
      moneyMovement: "blocked",
    },
    evidence: {
      command,
      required: ["lead_intake", "quote_packet", "owner_approval", "adapter_receipt"],
      externalExecution: "blocked",
      externalSend: false,
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = stringValue(coreBudget.reservationId);
  const coreCapability = objectValue(coreRun.capability);
  const coreCapabilityGrantId = stringValue(coreCapability.capabilityGrantId);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${coreWorkerRunSource}:${input.idempotencyKey}`}))`,
    );

    const [run] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new RevenueWorkerUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Revenue Worker run.",
        409,
      );
    }

    const existingInput = objectValue(run.data.input);
    const existingRequest = objectValue(existingInput.request);
    const storedHash = stringValue(existingRequest.inputHash) || stringValue(existingInput.inputHash);

    if (
      stringValue(existingInput.command) !== command ||
      run.mode !== runMode ||
      (storedHash && storedHash !== inputHash)
    ) {
      throw new RevenueWorkerUnavailableError(
        "worker_idempotency_conflict",
        "This idempotency key was already used with different worker input.",
        409,
      );
    }

    const existingOutput = outputData(run.data);

    if (stringValue(existingOutput.command) === command) {
      const existingCompletionBudget = objectValue(objectValue(run.data.completion).budget);

      return {
        created: false as const,
        needsCompletion: run.state === "running",
        workerRunId: run.id,
        eventId: stringData(run.data, "eventId") ?? run.eventId,
        taskId: stringData(run.data, "taskId") ?? run.taskId,
        sourceSnapshotEvidenceId: stringData(run.data, "sourceSnapshotEvidenceId"),
        evidenceId: stringData(run.data, "evidenceId"),
        reservationId:
          stringData(run.data, "reservationId") ??
          stringValue(existingCompletionBudget.reservationId) ??
          coreReservationId ??
          null,
        inferenceId: stringData(run.data, "inferenceId"),
        usageEventId: stringData(run.data, "usageEventId") ?? stringValue(existingCompletionBudget.usageEventId),
        adapterRunId: stringData(run.data, "adapterRunId"),
        adapterActionId: stringData(run.data, "adapterActionId"),
        adapterReceiptEvidenceId: stringData(run.data, "adapterReceiptEvidenceId"),
        approvalRequestId: stringData(run.data, "approvalRequestId"),
        quoteApprovalViewId:
          stringData(existingOutput, "quoteApprovalViewId") ?? stringData(run.data, "quoteApprovalViewId"),
        auditEventId: stringData(run.data, "auditEventId"),
        workflowRunId: stringData(run.data, "workflowRunId"),
        workflowStepIds: getWorkflowStepIds(run.data),
        output: existingOutput,
      };
    }

    const now = new Date();

    if (!task) {
      const taskPriority =
        leadPacket.urgency === "urgent" ? "urgent" : leadPacket.urgency === "high" ? "high" : "normal";
      const [createdTask] = await tx
        .insert(tasks)
        .values({
          tenantId: context.worker.tenantId,
          objectId: runObjectId,
          capabilityId,
          triggerEventId: sourceEventRowId,
          title: `Review quote for ${leadPacket.customerName}`,
          state: "active",
          priority: taskPriority,
          ownerType: "worker",
          ownerId: context.worker.id,
          ownerRef: `worker:${context.worker.id}`,
          reviewerUserId: operator.id,
          evidence: {
            required: ["source_snapshot", "quote_packet", "owner_approval"],
            ...intakeTrace,
            externalExecution: "blocked",
          },
          outcome: {
            status: "intake_ready",
            classification: leadPacket.classification,
            externalExecution: "blocked",
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning({
          id: tasks.id,
          objectId: tasks.objectId,
          triggerEventId: tasks.triggerEventId,
          capabilityId: tasks.capabilityId,
          priority: tasks.priority,
          reviewerUserId: tasks.reviewerUserId,
        });

      task = createdTask;
    }

    const workerRun = run;
    const reservationId = coreReservationId || null;
    const usageEventId = null;

    const [workflowDefinition] = await tx
      .select({
        id: workflowDefinitions.id,
        key: workflowDefinitions.key,
        name: workflowDefinitions.name,
      })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, revenueWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(workflowDefinitions.version)
      .limit(1);

    if (!workflowDefinition) {
      throw new RevenueWorkerUnavailableError(
        "worker_workflow_definition_missing",
        "Revenue Worker requires the lead_to_cash workflow definition.",
        409,
      );
    }

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: workflowDefinition.id,
        objectId: runObjectId,
        workerId: context.worker.id,
        state: "received",
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          command,
          inputHash,
          ...intakeTrace,
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
          leadPacket: leadPacket.sourceSnapshot,
          externalExecution: "blocked",
        },
        blockers: {
          open: ["owner_approval_required", "external_execution_blocked"],
        },
        metrics: {
          budgetUnits: runUnits,
          missingFacts: leadPacket.missingFacts.length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [runAudit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: requestedEventType,
        source,
        actorType: "user",
        actorId: operator.id,
        actorRef: operator.actorRef,
        targetType: "worker_run",
        targetId: workerRun.id,
        taskId: task?.id,
        workerRunId: workerRun.id,
        objectId: runObjectId,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:${command}:requested`,
        data: {
          operatorEmail: operator.email,
          operatorName: operator.name,
          command,
          inputHash,
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          mode: runMode,
        },
      })
      .returning({ id: auditEvents.id });

    const [adapterRun] = await tx
      .insert(adapterRuns)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        workerRunId: workerRun.id,
        mode: "dry_run",
        operation: "draft_customer_response",
        idempotencyKey: `${input.idempotencyKey}:adapter_run`,
        state: "running",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        cursor: input.idempotencyKey,
        readCount: 1,
        writeCount: 0,
        data: {
          workerRunId: workerRun.id,
          command,
          workflowRunId: workflowRun.id,
          capabilityId,
          inputHash,
          ...intakeTrace,
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
          externalMutation: false,
          dryRun: true,
        },
        startedAt: now,
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
          mode: runMode,
          command,
          objective: "Classify the lead packet and prepare the next owner-visible no-send action.",
          leadPacket: leadPacket.sourceSnapshot,
          ...intakeTrace,
          workflowRunId: workflowRun.id,
          inputHash,
        },
        result: {
          command,
          classification: leadPacket.classification,
          nextAction: "owner_approval",
          workflowRunId: workflowRun.id,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
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

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: completedEventType,
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: runObjectId,
        taskId: task?.id,
        capabilityId,
        connectionId: context.connectionId,
        idempotencyKey: input.idempotencyKey,
        data: {
          worker: context.worker.name,
          tenant: context.tenantName,
          command,
          inputHash,
          ...intakeTrace,
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          budgetUnits: runUnits,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          taskId: task?.id ?? null,
          operatorUserId: operator.id,
          auditEventId: runAudit.id,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [sourceSnapshotEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "snapshot",
        name: "Lead source snapshot",
        objectId: runObjectId,
        taskId: task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "source_snapshot"),
        data: {
          idempotencyKey: input.idempotencyKey,
          command,
          inputHash,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          ...intakeTrace,
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
          leadPacket: leadPacket.sourceSnapshot,
          externalSend: false,
        },
      })
      .returning({ id: evidence.id });

    const [workerEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name:
          command === "quote.prepare"
            ? "Revenue Worker quote preparation trace"
            : "Revenue Worker simulation trace",
        objectId: runObjectId,
        taskId: task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "trace"),
        data: {
          idempotencyKey: input.idempotencyKey,
          command,
          inputHash,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          inferenceId: inference.id,
          usageEventId,
          reservationId,
          runAuditId: runAudit.id,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          decision: "prepared_lead_packet_for_owner_approval",
          guardrails: ["no_external_send", "no_money_movement", "owner_approval_required"],
        },
      })
      .returning({ id: evidence.id });

    const [action] = await tx
      .insert(adapterActions)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        adapterRunId: adapterRun.id,
        capabilityId,
        taskId: task?.id,
        eventId: event.id,
        idempotencyKey: input.idempotencyKey,
        state: "done",
        mode: "dry_run",
        operation: "draft_customer_response",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "matched",
        request: {
          action: leadPacket.expectedAction,
          workerRunId: workerRun.id,
          command,
          workflowRunId: workflowRun.id,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          externalSend: false,
          dryRun: true,
        },
        response: {
          status: "prepared",
          preparedAction: leadPacket.expectedAction,
          command,
          ...intakeTrace,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          externalSend: false,
          nextStep: "owner_approval",
          reconciliation: "matched",
        },
        receipt: {
          mode: "dry_run",
          receiptId: traceHash(input.idempotencyKey, "adapter_receipt"),
          adapterRunId: adapterRun.id,
          workerRunId: workerRun.id,
          command,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          externalMutation: false,
          externalSend: false,
          reconciliationState: "matched",
          checkedAt: now.toISOString(),
        },
      })
      .returning({ id: adapterActions.id });

    const [receiptEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "receipt",
        name: "Adapter dry-run receipt",
        objectId: runObjectId,
        taskId: task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "adapter",
        actorId: context.connectionId,
        hash: traceHash(input.idempotencyKey, "adapter_receipt"),
        data: {
          mode: "dry_run",
          workerRunId: workerRun.id,
          command,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          idempotencyKey: input.idempotencyKey,
          operation: "draft_customer_response",
          preparedAction: leadPacket.expectedAction,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          externalMutation: false,
          externalSend: false,
          reconciliationState: "matched",
          checkedAt: now.toISOString(),
        },
      })
      .returning({ id: evidence.id });

    await tx
      .update(adapterRuns)
      .set({
        eventId: event.id,
        state: "done",
        reconciliationState: "matched",
        receipt: {
          mode: "dry_run",
          receiptEvidenceId: receiptEvidence.id,
          adapterActionId: action.id,
          command,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          externalMutation: false,
          externalSend: false,
          reconciliationState: "matched",
          checkedAt: now.toISOString(),
        },
        endedAt: now,
      })
      .where(eq(adapterRuns.id, adapterRun.id));

    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task?.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        objectId: runObjectId,
        capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: task?.reviewerUserId ?? operator.id,
        kind: "quote_approval",
        state: "pending",
        priority: task?.priority ?? "high",
        risk: "medium",
        title: `Approve ${leadPacket.serviceArea} quote packet`,
        summary: `Revenue Worker prepared a ${formatUsd(numberValue(leadPacket.quote.totalCents))} quote packet for ${leadPacket.customerName}; external send remains blocked.`,
        requestedAction: {
          action: "review_prepared_packet",
          adapterActionId: action.id,
          command,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          externalSend: false,
          currentMode: "dry_run",
        },
        evidence: {
          eventId: event.id,
          command,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          inferenceId: inference.id,
          usageEventId,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          workflowRunId: workflowRun.id,
        },
        policy: {
          externalSend: "approval_required",
          moneyMovement: "blocked",
          capabilityGrantId: coreCapabilityGrantId || null,
        },
        data: {
          operatorRunAuditId: runAudit.id,
          command,
          inputHash,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
        },
      })
      .returning({ id: approvalRequests.id });

    const [approvalAudit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "approval.requested",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "approval_request",
        targetId: approval.id,
        taskId: task?.id,
        workerRunId: workerRun.id,
        approvalRequestId: approval.id,
        eventId: event.id,
        objectId: runObjectId,
        capabilityId,
        risk: "medium",
        idempotencyKey: `${input.idempotencyKey}:${command}:approval_requested`,
        data: {
          reviewerUserId: task?.reviewerUserId ?? operator.id,
          operatorUserId: operator.id,
          command,
          inputHash,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          classification: leadPacket.classification,
          externalExecution: "blocked",
          externalSend: false,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          workflowRunId: workflowRun.id,
        },
      })
      .returning({ id: auditEvents.id });

    const quoteApprovalViewKey = "quote.approval.review";
    const quoteApprovalViewVersion = "1.0.0";
    const quoteApprovalContract = {
      schemaVersion: "continuous.ui.quote_approval.v1",
      subject: {
        type: "approval_request",
        kind: "quote_approval",
      },
      sections: [
        {
          key: "customer_summary",
          title: "Customer",
          fields: ["customerName", "serviceArea", "urgency", "source", "sourceEventId"],
        },
        {
          key: "scope_summary",
          title: "Scope",
          fields: ["classification", "missingFacts", "expectedAction"],
        },
        {
          key: "price_and_margin",
          title: "Price",
          fields: ["quote.subtotalCents", "quote.totalCents", "quote.currency", "quote.policy"],
        },
        {
          key: "draft_message",
          title: "Draft response",
          fields: ["draftResponse"],
        },
        {
          key: "evidence_timeline",
          title: "Evidence",
          refs: [
            "sourceSnapshotEvidenceId",
            "evidenceId",
            "adapterRunId",
            "adapterActionId",
            "adapterReceiptEvidenceId",
            "workflowRunId",
          ],
        },
        {
          key: "action_bar",
          title: "Decision",
          actions: ["approved", "revision_requested", "rejected"],
        },
      ],
      externalExecution: "blocked",
    } as JsonObject;
    const quoteApprovalActions = {
      decisionSurface: "/approval",
      decisionCommand: "approval.decide",
      valid: [
        {
          action: "approved",
          label: "Approve",
          config: { action: "approved" },
        },
        {
          action: "revision_requested",
          label: "Request revision",
          config: { action: "revision_requested" },
        },
        {
          action: "rejected",
          label: "Reject",
          config: { action: "rejected" },
        },
      ],
      postDecisionSurface: "/worker",
      postDecisionCommand: "continue",
      externalExecution: "blocked",
    } as JsonObject;
    const quoteApprovalData = {
      bindings: {
        approvalRequestId: "approval.id",
        taskId: "approval.taskId",
        workerRunId: "approval.workerRunId",
        workflowRunId: "approval.workflowRunId",
        quote: "approval.requestedAction.quote",
        draftResponse: "approval.requestedAction.draftResponse",
        evidenceRefs: "approval.evidenceRefs",
      },
      latest: {
        command,
        approvalRequestId: approval.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
        taskId: task?.id ?? null,
        objectId: runObjectId,
        ...intakeTrace,
        sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
        evidenceId: workerEvidence.id,
        adapterRunId: adapterRun.id,
        adapterActionId: action.id,
        adapterReceiptEvidenceId: receiptEvidence.id,
        quote: leadPacket.quote,
        draftResponse: leadPacket.draftResponse,
        externalExecution: "blocked",
        externalSend: false,
      },
    } as JsonObject;
    const [existingQuoteApprovalView] = await tx
      .select({ id: generatedViews.id })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, context.worker.tenantId),
          eq(generatedViews.key, quoteApprovalViewKey),
          eq(generatedViews.version, quoteApprovalViewVersion),
        ),
      )
      .limit(1);
    const quoteApprovalViewValues = {
      capabilityId,
      key: quoteApprovalViewKey,
      version: quoteApprovalViewVersion,
      name: "Quote approval review",
      purpose: "Let an owner approve, revise, or reject a prepared quote packet with linked evidence.",
      surface: "web",
      objectType: "quote",
      taskState: "approval_required" as const,
      contract: quoteApprovalContract,
      actions: quoteApprovalActions,
      data: quoteApprovalData,
      mask: {
        customer_contact: "redacted_by_default",
        payment_fields: true,
        externalExecution: "blocked",
      } as JsonObject,
      active: true,
      updatedAt: now,
    };
    const [quoteApprovalView] = existingQuoteApprovalView
      ? await tx
          .update(generatedViews)
          .set(quoteApprovalViewValues)
          .where(eq(generatedViews.id, existingQuoteApprovalView.id))
          .returning({ id: generatedViews.id })
      : await tx
          .insert(generatedViews)
          .values({
            tenantId: context.worker.tenantId,
            ...quoteApprovalViewValues,
            createdAt: now,
          })
          .returning({ id: generatedViews.id });
    const [quoteApprovalViewEvent] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: existingQuoteApprovalView ? "view.updated" : "view.published",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: runObjectId,
        taskId: task?.id,
        capabilityId,
        idempotencyKey: `${input.idempotencyKey}:${command}:quote_approval_view`,
        data: {
          viewId: quoteApprovalView.id,
          key: quoteApprovalViewKey,
          version: quoteApprovalViewVersion,
          command,
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
        },
        occurredAt: now,
      })
      .returning({ id: events.id });
    const [quoteApprovalViewAudit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: existingQuoteApprovalView ? "view.updated" : "view.published",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "ui_contract",
        targetId: quoteApprovalView.id,
        taskId: task?.id,
        workerRunId: workerRun.id,
        approvalRequestId: approval.id,
        eventId: quoteApprovalViewEvent.id,
        objectId: runObjectId,
        capabilityId,
        risk: "low",
        idempotencyKey: `${input.idempotencyKey}:${command}:quote_approval_view`,
        data: {
          viewId: quoteApprovalView.id,
          key: quoteApprovalViewKey,
          version: quoteApprovalViewVersion,
          command,
          approvalRequestId: approval.id,
          externalExecution: "blocked",
        },
      })
      .returning({ id: auditEvents.id });
    const quoteApprovalViewLink = JSON.stringify({
      quoteApprovalViewId: quoteApprovalView.id,
      quoteApprovalViewAuditEventId: quoteApprovalViewAudit.id,
    });

    await tx
      .update(approvalRequests)
      .set({
        requestedAction: sql`${approvalRequests.requestedAction} || ${quoteApprovalViewLink}::jsonb`,
        evidence: sql`${approvalRequests.evidence} || ${quoteApprovalViewLink}::jsonb`,
        data: sql`${approvalRequests.data} || ${quoteApprovalViewLink}::jsonb`,
      })
      .where(eq(approvalRequests.id, approval.id));

    const workflowStepValues = [
      {
        fromState: "received",
        toState: "intake_resolved",
        kind: "worker_transition",
        name: "Revenue intake resolved",
        input: {
          command,
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
        },
        output: {
          sourceObjectId,
          sourceEventRowId,
          sourceEvidenceId,
          command,
          inputHash,
        },
      },
      {
        fromState: "intake_resolved",
        toState: "packet_prepared",
        kind: "worker_transition",
        name: "Revenue packet prepared",
        input: {
          command,
          classification: leadPacket.classification,
          quote: leadPacket.quote,
        },
        output: {
          command,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          inferenceId: inference.id,
          usageEventId,
        },
      },
      {
        fromState: "packet_prepared",
        toState: "adapter_dry_run_recorded",
        kind: "worker_transition",
        name: "Revenue adapter dry run recorded",
        input: {
          operation: "draft_customer_response",
          mode: "dry_run",
          command,
        },
        output: {
          command,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          externalExecution: "blocked",
          externalSend: false,
        },
      },
      {
        fromState: "adapter_dry_run_recorded",
        toState: "approval_requested",
        kind: "approval_request",
        name: "Revenue owner approval requested",
        input: {
          command,
          policy: {
            externalSend: "approval_required",
            moneyMovement: "blocked",
          },
        },
        output: {
          command,
          approvalRequestId: approval.id,
          approvalAuditEventId: approvalAudit.id,
          quoteApprovalViewId: quoteApprovalView.id,
          externalExecution: "blocked",
        },
      },
    ];

    const workflowStepRows = await tx
      .insert(workflowSteps)
      .values(
        workflowStepValues.map((step) => ({
          tenantId: context.worker.tenantId,
          definitionId: workflowDefinition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: step.toState === "approval_requested" ? approval.id : null,
          taskId: task?.id,
          objectId: runObjectId,
          workerId: context.worker.id,
          capabilityId,
          kind: step.kind,
          name: step.name,
          state: "done" as const,
          priority: task?.priority ?? "high",
          risk: "medium" as const,
          fromState: step.fromState,
          toState: step.toState,
          attempt: 1,
          maxAttempts: 3,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:${step.toState}`,
          input: step.input as unknown as JsonObject,
          output: step.output as unknown as JsonObject,
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        })),
      )
      .returning({ id: workflowSteps.id });

    const workflowStepIds = workflowStepRows.map((step) => step.id);

    await tx
      .update(workflowRuns)
      .set({
        state: "approval_requested",
        data: {
          workerRunId: workerRun.id,
          command,
          eventId: event.id,
          approvalRequestId: approval.id,
          approvalAuditEventId: approvalAudit.id,
          workflowStepIds,
          inputHash,
          ...intakeTrace,
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          externalExecution: "blocked",
          externalSend: false,
          quoteApprovalViewId: quoteApprovalView.id,
        },
        blockers: {
          open: ["owner_approval_required", "external_execution_blocked"],
        },
        metrics: {
          budgetUnits: runUnits,
          quoteTotalCents: leadPacket.quote.totalCents,
          missingFacts: leadPacket.missingFacts.length,
        },
        updatedAt: now,
      })
      .where(eq(workflowRuns.id, workflowRun.id));

    await tx
      .update(evidence)
      .set({
        data: {
          idempotencyKey: input.idempotencyKey,
          command,
          inputHash,
          workerRunId: workerRun.id,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          inferenceId: inference.id,
          usageEventId,
          reservationId,
          runAuditId: runAudit.id,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          approvalRequestId: approval.id,
          auditEventId: approvalAudit.id,
          quoteApprovalViewId: quoteApprovalView.id,
          quoteApprovalViewAuditEventId: quoteApprovalViewAudit.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          decision: "prepared_lead_packet_for_owner_approval",
          guardrails: ["no_external_send", "no_money_movement", "owner_approval_required"],
        },
      })
      .where(eq(evidence.id, workerEvidence.id));

    await tx.insert(decisions).values({
      tenantId: context.worker.tenantId,
      taskId: task?.id,
      eventId: event.id,
      capabilityId,
      actorType: "worker",
      actorId: context.worker.id,
      kind: "approval_recommendation",
      state: "proposed",
      decision: "request_owner_approval",
      rationale: "Prepared lead packet is ready for owner review; external communication and money movement are blocked.",
      data: {
        command,
        inputHash,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
        workflowStepIds,
        ...intakeTrace,
        sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
        adapterRunId: adapterRun.id,
        adapterActionId: action.id,
        adapterReceiptEvidenceId: receiptEvidence.id,
        approvalRequestId: approval.id,
        idempotencyKey: input.idempotencyKey,
        classification: leadPacket.classification,
        draftResponse: leadPacket.draftResponse,
        quote: leadPacket.quote,
        autonomyLevel: 2,
      },
    });

    await tx.insert(evaluations).values({
      tenantId: context.worker.tenantId,
      workerId: context.worker.id,
      taskId: task?.id,
      eventId: event.id,
      kind: "simulation_quality",
      score: "0.860",
      data: {
        workerRunId: workerRun.id,
        command,
        workflowRunId: workflowRun.id,
        workflowStepIds,
        idempotencyKey: input.idempotencyKey,
        approvalRequestId: approval.id,
        quoteApprovalViewId: quoteApprovalView.id,
        inputHash,
        ...intakeTrace,
        sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
        classification: leadPacket.classification,
        dimensions: {
          source_snapshot_present: true,
          input_derived_output: true,
          evidence_complete: true,
          within_budget: true,
          external_execution_blocked: true,
          owner_approval_required: true,
          external_send_blocked: true,
          workflow_spine_present: true,
          quote_approval_view_present: true,
        },
      },
    });

    if (task?.id) {
      await tx
        .update(tasks)
        .set({
          state: "approval_required",
          outcome: {
            status: leadPacket.classification,
            workerRunId: workerRun.id,
            command,
            runEventId: event.id,
            ...intakeTrace,
            sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
            draftResponse: leadPacket.draftResponse,
            quote: leadPacket.quote,
            adapterRunId: adapterRun.id,
            adapterActionId: action.id,
            adapterReceiptEvidenceId: receiptEvidence.id,
            approvalRequestId: approval.id,
            quoteApprovalViewId: quoteApprovalView.id,
            auditEventId: approvalAudit.id,
            workflowRunId: workflowRun.id,
            workflowStepIds,
          },
          cost: {
            units: runUnits,
            reservationId,
            usageEventId,
          },
          kpi: {
            quotePrepared: true,
            quotedAmountCents: leadPacket.quote.totalCents,
            ownerTimeSavedMinutes: 18,
            responseTimeTarget: "under_5_minutes",
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, task.id));
    }

    if (runObjectId) {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext('object_version'), hashtext(${runObjectId}))`,
      );

      const [version] = await tx
        .select({
          value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
        })
        .from(objectVersions)
        .where(eq(objectVersions.objectId, runObjectId));

      await tx.insert(objectVersions).values({
        tenantId: context.worker.tenantId,
        objectId: runObjectId,
        version: numberValue(version?.value),
        data: {
          state: "approval_required",
          workerRunId: workerRun.id,
          command,
          sourceEventId: event.id,
          inputHash,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          approvalRequestId: approval.id,
          quoteApprovalViewId: quoteApprovalView.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
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
          command,
          inputHash,
          ...intakeTrace,
          source: leadPacket.source,
          sourceEventId: leadPacket.sourceEventId,
          classification: leadPacket.classification,
          draftResponse: leadPacket.draftResponse,
          quote: leadPacket.quote,
          budgetUnits: runUnits,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
          workerRunId: workerRun.id,
          taskId: task?.id ?? null,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          reservationId,
          inferenceId: inference.id,
          usageEventId,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          approvalRequestId: approval.id,
          quoteApprovalViewId: quoteApprovalView.id,
          auditEventId: approvalAudit.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
        },
      })
      .where(eq(events.id, event.id));

    const runOutput = {
      worker: context.worker.name,
      tenant: context.tenantName,
      command,
      inputHash,
      ...intakeTrace,
      source: leadPacket.source,
      sourceEventId: leadPacket.sourceEventId,
      classification: leadPacket.classification,
      draftResponse: leadPacket.draftResponse,
      quote: leadPacket.quote,
      budgetUnits: runUnits,
      externalExecution: "blocked",
      externalSend: false,
      requiresApproval: true,
      taskId: task?.id ?? null,
      eventId: event.id,
      sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
      evidenceId: workerEvidence.id,
      reservationId,
      inferenceId: inference.id,
      usageEventId,
      adapterRunId: adapterRun.id,
      adapterActionId: action.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      approvalRequestId: approval.id,
      quoteApprovalViewId: quoteApprovalView.id,
      auditEventId: approvalAudit.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
    };

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        taskId: task?.id,
        capabilityId,
        updatedAt: now,
        data: {
          ...objectValue(workerRun.data),
          businessEventId: event.id,
          businessAuditEventId: approvalAudit.id,
          taskId: task?.id ?? null,
          workflowRunId: workflowRun.id,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          reservationId,
          inferenceId: inference.id,
          usageEventId,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          approvalRequestId: approval.id,
          auditEventId: approvalAudit.id,
          quoteApprovalViewId: quoteApprovalView.id,
          pendingCompletion: {
            output: runOutput,
          },
        },
      })
      .where(eq(workerRuns.id, workerRun.id));

    return {
      created: true as const,
      needsCompletion: true,
      workerRunId: workerRun.id,
      eventId: event.id,
      taskId: task?.id ?? null,
      sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
      evidenceId: workerEvidence.id,
      reservationId,
      inferenceId: inference.id,
      usageEventId,
      adapterActionId: action.id,
      adapterRunId: adapterRun.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      approvalRequestId: approval.id,
      quoteApprovalViewId: quoteApprovalView.id,
      auditEventId: approvalAudit.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      output: runOutput,
    };
  });

  const completion = result.needsCompletion
    ? await completeCoreWorkerRun({
        operatorEmail: input.operatorEmail,
        tenantSlug: context.worker.tenantSlug,
        idempotencyKey: input.idempotencyKey,
        worker: {
          id: context.worker.id,
          role: revenueWorkerRole,
        },
        workerRunId: result.workerRunId,
        state: "done",
        reason: `Revenue Worker completed ${commandLabel} with external execution blocked.`,
        output: result.output,
        costUsd: 0,
        evidence: {
          command,
          eventId: result.eventId,
          auditEventId: result.auditEventId,
          evidenceId: result.evidenceId,
          sourceSnapshotEvidenceId: result.sourceSnapshotEvidenceId,
          inferenceId: result.inferenceId,
          adapterRunId: result.adapterRunId,
          adapterActionId: result.adapterActionId,
          adapterReceiptEvidenceId: result.adapterReceiptEvidenceId,
          approvalRequestId: result.approvalRequestId,
          quoteApprovalViewId: result.quoteApprovalViewId,
          workflowRunId: result.workflowRunId,
          ...intakeTrace,
          externalExecution: "blocked",
          externalSend: false,
        },
        db,
      })
    : null;
  const completionBudget = objectValue(completion?.budget);
  const settledReservationId = stringValue(completionBudget.reservationId) || result.reservationId;
  const settledUsageEventId = stringValue(completionBudget.usageEventId) || result.usageEventId;
  const settledOutput = {
    ...result.output,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
  };

  return {
    idempotencyKey: input.idempotencyKey,
    created: result.created,
    workerRunId: result.workerRunId,
    eventId: result.eventId,
    taskId: result.taskId,
    sourceSnapshotEvidenceId: result.sourceSnapshotEvidenceId,
    evidenceId: result.evidenceId,
    reservationId: settledReservationId,
    inferenceId: result.inferenceId,
    usageEventId: settledUsageEventId,
    adapterRunId: result.adapterRunId,
    adapterActionId: result.adapterActionId,
    adapterReceiptEvidenceId: result.adapterReceiptEvidenceId,
    approvalRequestId: result.approvalRequestId,
    quoteApprovalViewId: result.quoteApprovalViewId,
    auditEventId: result.auditEventId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    output: settledOutput,
    snapshot: await getRevenueWorkerSnapshot(db, selector),
  };
}

export async function prepareRevenueQuote(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}): Promise<RevenueWorkerRunResult> {
  return runRevenueWorker({
    ...input,
    command: "quote.prepare",
  });
}

export async function prepareRevenuePaymentLink(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}): Promise<RevenuePaymentLinkPrepareResult> {
  const db = input.db ?? defaultDb;
  const requestConfig = input.config ?? {};
  const requestSourceRefs = objectValue(requestConfig.sourceRefs);

  if (
    !stringValue(
      requestConfig.invoiceId ??
        requestConfig.invoiceObjectId ??
        requestSourceRefs.invoiceId ??
        requestSourceRefs.invoiceObjectId,
    )
  ) {
    throw new RevenueWorkerUnavailableError(
      "invalid_worker_command_config",
      "config.invoiceId, config.invoiceObjectId, config.sourceRefs.invoiceId or config.sourceRefs.invoiceObjectId is required for payment_link.prepare.",
      400,
    );
  }

  const selector: RevenueWorkerSelector = {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  };
  const context = await loadWorkerContext(db, selector);
  const operator = await loadOperator(db, context.worker.tenantId, input.operatorEmail);
  const capabilityId = context.paymentLinkCapabilityId;

  if (!capabilityId) {
    throw new RevenueWorkerUnavailableError(
      "worker_capability_missing",
      "Revenue Worker requires the payment_link.prepare capability.",
      409,
    );
  }

  const refs = await loadRevenuePaymentLinkRefs(db, context.worker.tenantId, requestConfig);
  const inputHash = hashObject({
    schemaVersion: "worker.revenue_operations.payment_link_prepare.v1",
    command: "payment_link.prepare",
    idempotencyKey: input.idempotencyKey,
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    operatorUserId: operator.id,
    requestConfig,
    resolved: {
      invoiceId: refs.invoice.id,
      invoiceObjectId: refs.invoiceObject.id,
      quoteObjectId: refs.quoteObject?.id ?? null,
      sourcePaymentId: refs.sourcePayment?.payment?.id ?? null,
      sourcePaymentObjectId: refs.sourcePayment?.paymentObject?.id ?? null,
      bankAccountId: refs.bankAccount?.id ?? null,
      amountCents: refs.amountCents,
      currency: refs.currency,
    },
  });
  const runInput = {
    idempotencyKey: input.idempotencyKey,
    command: "payment_link.prepare",
    inputHash,
    config: requestConfig,
    resolved: {
      invoiceId: refs.invoice.id,
      invoiceObjectId: refs.invoiceObject.id,
      quoteObjectId: refs.quoteObject?.id ?? null,
      sourcePaymentId: refs.sourcePayment?.payment?.id ?? null,
      sourcePaymentObjectId: refs.sourcePayment?.paymentObject?.id ?? null,
      bankAccountId: refs.bankAccount?.id ?? null,
      amountCents: refs.amountCents,
      currency: refs.currency,
    },
    operator: {
      userId: operator.id,
      email: operator.email,
    },
    capabilityId,
    connectionId: context.connectionId,
    budgetAccountId: context.budgetAccountId,
    routeId: context.routeId,
    units: paymentLinkPrepareUnits,
    mode: "payment_link_preparation",
  };
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: revenueWorkerRole,
    },
    command: "payment_link.prepare",
    mode: "payment_link_preparation",
    capabilityId,
    connectionId: context.connectionId,
    budgetAccountId: context.budgetAccountId,
    units: paymentLinkPrepareUnits,
    input: runInput,
    policy: {
      externalExecution: "blocked",
      externalMutation: false,
      providerPaymentLinkCreation: "blocked",
      moneyMovement: "blocked",
    },
    evidence: {
      command: "payment_link.prepare",
      required: ["invoice_draft", "payment_link_packet", "manager_approval", "adapter_receipt"],
      externalExecution: "blocked",
      providerPaymentLinkCreation: "blocked",
      moneyMovement: "blocked",
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = stringValue(coreBudget.reservationId);
  const coreCapability = objectValue(coreRun.capability);
  const coreCapabilityGrantId = stringValue(coreCapability.capabilityGrantId);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${coreWorkerRunSource}:payment_link.prepare:${input.idempotencyKey}`}))`,
    );

    const [run] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new RevenueWorkerUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Revenue payment-link run.",
        409,
      );
    }

    const existingInput = objectValue(run.data.input);
    const existingRequest = objectValue(existingInput.request);
    const existingHash = stringValue(existingRequest.inputHash) || stringValue(existingInput.inputHash);

    if (
      run.mode !== "payment_link_preparation" ||
      stringValue(existingInput.command) !== "payment_link.prepare" ||
      (existingHash && existingHash !== inputHash)
    ) {
      throw new RevenueWorkerUnavailableError(
        "worker_idempotency_conflict",
        "This idempotency key was already used with different worker input.",
        409,
      );
    }

    const existingOutput = outputData(run.data);

    if (stringValue(existingOutput.command) === "payment_link.prepare") {
      const existingCompletionBudget = objectValue(objectValue(run.data.completion).budget);
      return {
        created: false as const,
        needsCompletion: run.state === "running",
        workerRunId: run.id,
        taskId: stringData(run.data, "taskId") ?? run.taskId,
        eventId: stringData(run.data, "eventId") ?? run.eventId,
        reservationId:
          stringData(run.data, "reservationId") ??
          stringValue(existingCompletionBudget.reservationId) ??
          coreReservationId ??
          null,
        inferenceId: stringData(run.data, "inferenceId"),
        usageEventId: stringData(run.data, "usageEventId") ?? stringValue(existingCompletionBudget.usageEventId),
        paymentObjectId: stringData(run.data, "paymentObjectId"),
        paymentId: stringData(run.data, "paymentId"),
        paymentInstructionId: stringData(run.data, "paymentInstructionId"),
        invoiceObjectId: stringData(run.data, "invoiceObjectId"),
        invoiceId: stringData(run.data, "invoiceId"),
        quoteObjectId: stringData(run.data, "quoteObjectId"),
        approvalRequestId: stringData(run.data, "approvalRequestId"),
        adapterRunId: stringData(run.data, "adapterRunId"),
        adapterActionId: stringData(run.data, "adapterActionId"),
        adapterReceiptEvidenceId: stringData(run.data, "adapterReceiptEvidenceId"),
        evidenceId: stringData(run.data, "evidenceId"),
        draftEvidenceId: stringData(run.data, "draftEvidenceId"),
        packetId: stringData(run.data, "packetId"),
        documentId: stringData(run.data, "documentId"),
        workflowRunId: stringData(run.data, "workflowRunId"),
        workflowStepIds: getWorkflowStepIds(run.data),
        paymentReviewViewId: stringData(run.data, "paymentReviewViewId"),
        auditEventId: stringData(run.data, "auditEventId"),
        output: existingOutput,
      };
    }

    const now = new Date();
    const state = refs.amountCents > 0 && refs.bankAccount ? "approval_required" : "blocked";
    const workflowState = state === "approval_required" ? "approval_requested" : "blocked";
    const paymentAmountCents = Math.max(0, Math.round(refs.amountCents));
    const reservationId = coreReservationId || null;
    const usageEventId = null;

    const [workflowDefinition] = await tx
      .select({
        id: workflowDefinitions.id,
        key: workflowDefinitions.key,
        name: workflowDefinitions.name,
      })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, revenueWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(workflowDefinitions.version)
      .limit(1);

    if (!workflowDefinition) {
      throw new RevenueWorkerUnavailableError(
        "worker_workflow_definition_missing",
        "Revenue Worker requires the lead_to_cash workflow definition.",
        409,
      );
    }

    const paymentData = {
      kind: "payment_link",
      command: "payment_link.prepare",
      inputHash,
      invoiceId: refs.invoice.id,
      invoiceObjectId: refs.invoiceObject.id,
      quoteObjectId: refs.quoteObject?.id ?? null,
      sourcePaymentId: refs.sourcePayment?.payment?.id ?? null,
      sourcePaymentObjectId: refs.sourcePayment?.paymentObject?.id ?? null,
      sourceApprovalRequestId: refs.sourceApproval?.id ?? null,
      sourceApprovalState: refs.sourceApproval?.state ?? null,
      sourceRefs: refs.sourceRefs,
      bankAccountId: refs.bankAccount?.id ?? null,
      bankAccountName: refs.bankAccount?.name ?? null,
      amountCents: paymentAmountCents,
      currency: refs.currency,
      customerName: refs.customerName,
      dueAt: refs.dueAt,
      policy: refs.policy,
      blockers: refs.blockers,
      requiresApproval: true,
      providerPaymentLink: "blocked",
      providerPaymentLinkCreation: "blocked",
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
      moneyMovement: "blocked",
      nextAction: state === "approval_required" ? "owner_review" : "resolve_blockers",
    } satisfies JsonObject;

    const [paymentObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "payment",
        name: `Payment link draft for ${refs.customerName}`,
        state,
        source,
        externalId: `revenue-payment-link:${input.idempotencyKey}`,
        data: paymentData,
        createdByUserId: operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: paymentObject.id,
      version: 1,
      data: paymentData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "Revenue Worker prepared a blocked payment-link draft.",
      createdAt: now,
    });

    const [payment] = await tx
      .insert(payments)
      .values({
        tenantId: context.worker.tenantId,
        objectId: paymentObject.id,
        state,
        externalId: `revenue-payment-link:${input.idempotencyKey}`,
        data: paymentData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: payments.id });

    let paymentInstructionId: string | null = null;

    if (refs.bankAccount) {
      const [paymentInstruction] = await tx
        .insert(paymentInstructions)
        .values({
          tenantId: context.worker.tenantId,
          bankAccountId: refs.bankAccount.id,
          objectId: paymentObject.id,
          kind: "revenue_payment_link",
          state,
          amountCents: paymentAmountCents,
          currency: refs.currency,
          data: {
            ...paymentData,
            paymentId: payment.id,
            paymentObjectId: paymentObject.id,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: paymentInstructions.id });

      paymentInstructionId = paymentInstruction.id;
    }

    const linkValues: Array<typeof objectLinks.$inferInsert> = [
      {
        tenantId: context.worker.tenantId,
        fromId: paymentObject.id,
        toId: refs.invoiceObject.id,
        type: "for_invoice",
        data: { source, command: "payment_link.prepare" },
        effectiveAt: now,
      },
    ];

    if (refs.quoteObject) {
      linkValues.push({
        tenantId: context.worker.tenantId,
        fromId: paymentObject.id,
        toId: refs.quoteObject.id,
        type: "from_quote",
        data: { source, command: "payment_link.prepare" },
        effectiveAt: now,
      });
    }

    if (refs.sourcePayment?.paymentObject) {
      linkValues.push({
        tenantId: context.worker.tenantId,
        fromId: paymentObject.id,
        toId: refs.sourcePayment.paymentObject.id,
        type: "prepared_from_payment",
        data: { source, command: "payment_link.prepare" },
        effectiveAt: now,
      });
    }

    await tx.insert(objectLinks).values(linkValues).onConflictDoNothing();

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: paymentObject.id,
        capabilityId,
        title: `Review payment link for ${refs.customerName}`,
        state,
        priority: "high",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: operator.id,
        evidence: {
          required: ["invoice_draft", "payment_link_packet", "manager_approval"],
          blockers: refs.blockers,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
        },
        outcome: {
          status: state === "approval_required" ? "payment_link_review_required" : "payment_link_blocked",
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        cost: { units: paymentLinkPrepareUnits },
        kpi: { payment_links_prepared: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const workerRun = run;

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: workflowDefinition.id,
        objectId: paymentObject.id,
        workerId: context.worker.id,
        state: workflowState,
        idempotencyKey: input.idempotencyKey,
        data: {
          command: "payment_link.prepare",
          workerRunId: workerRun.id,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          inputHash,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        blockers: { open: refs.blockers },
        metrics: {
          budgetUnits: paymentLinkPrepareUnits,
          amountCents: paymentAmountCents,
          blockerCount: refs.blockers.length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [inference] = await tx
      .insert(inferences)
      .values({
        tenantId: context.worker.tenantId,
        routeId: context.routeId,
        budgetAccountId: context.budgetAccountId,
        taskId: task.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        promptHash: traceHash(input.idempotencyKey, "payment_link.prepare"),
        request: {
          mode: "deterministic",
          objective: "Prepare a manager-reviewable payment-link packet from a tenant-scoped invoice.",
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          quoteObjectId: refs.quoteObject?.id ?? null,
          inputHash,
        },
        result: {
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          amountCents: paymentAmountCents,
          currency: refs.currency,
          blockers: refs.blockers,
        },
        safety: {
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        promptTokens: 280,
        completionTokens: 120,
        units: paymentLinkPrepareUnits,
        costUsd: "0.000000",
        latencyMs: 90,
        createdAt: now,
      })
      .returning({ id: inferences.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.revenue_operations.payment_link_prepare.completed",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: paymentObject.id,
        taskId: task.id,
        capabilityId,
        connectionId: context.connectionId,
        idempotencyKey: `${input.idempotencyKey}:payment_link.prepare`,
        data: {
          command: "payment_link.prepare",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          amountCents: paymentAmountCents,
          currency: refs.currency,
          blockers: refs.blockers,
          inputHash,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    const [adapterRun] = await tx
      .insert(adapterRuns)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        workerRunId: workerRun.id,
        eventId: event.id,
        mode: "dry_run",
        operation: "prepare_payment_link",
        idempotencyKey: `${input.idempotencyKey}:payment_link_adapter`,
        state: "running",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "pending",
        cursor: input.idempotencyKey,
        readCount: 1,
        writeCount: 0,
        data: {
          command: "payment_link.prepare",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          inputHash,
          externalMutation: false,
          providerPaymentLinkCreation: "blocked",
          dryRun: true,
        },
        startedAt: now,
      })
      .returning({ id: adapterRuns.id });

    const [adapterAction] = await tx
      .insert(adapterActions)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.connectionId,
        adapterRunId: adapterRun.id,
        capabilityId,
        taskId: task.id,
        eventId: event.id,
        idempotencyKey: `${input.idempotencyKey}:payment_link_action`,
        state: "done",
        mode: "dry_run",
        operation: "prepare_payment_link",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "matched",
        request: {
          command: "payment_link.prepare",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          amountCents: paymentAmountCents,
          currency: refs.currency,
          dryRun: true,
          externalMutation: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        response: {
          status: "prepared",
          providerPaymentLinkCreation: "blocked",
          externalMutation: false,
          moneyMovement: "blocked",
          reconciliation: "matched",
          nextStep: "owner_approval",
        },
        receipt: {
          mode: "dry_run",
          receiptId: traceHash(input.idempotencyKey, "payment_link_adapter_receipt"),
          adapterRunId: adapterRun.id,
          workerRunId: workerRun.id,
          command: "payment_link.prepare",
          externalMutation: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          reconciliationState: "matched",
          checkedAt: now.toISOString(),
        },
      })
      .returning({ id: adapterActions.id });

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Revenue payment-link preparation trace",
        objectId: paymentObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          command: "payment_link.prepare",
          inputHash,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          inferenceId: inference.id,
          usageEventId,
          reservationId,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          blockers: refs.blockers,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [draftEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "draft",
        name: "Revenue payment-link draft",
        objectId: paymentObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "payment_link_draft"),
        data: {
          ...paymentData,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [receiptEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "receipt",
        name: "Payment-link adapter dry-run receipt",
        objectId: paymentObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId,
        actorType: "adapter",
        actorId: context.connectionId,
        hash: traceHash(input.idempotencyKey, "payment_link_adapter_receipt"),
        data: {
          mode: "dry_run",
          command: "payment_link.prepare",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          externalMutation: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          reconciliationState: "matched",
          checkedAt: now.toISOString(),
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    await tx
      .update(adapterRuns)
      .set({
        state: "done",
        reconciliationState: "matched",
        receipt: {
          mode: "dry_run",
          receiptEvidenceId: receiptEvidence.id,
          adapterActionId: adapterAction.id,
          command: "payment_link.prepare",
          externalMutation: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          reconciliationState: "matched",
          checkedAt: now.toISOString(),
        },
        endedAt: now,
      })
      .where(eq(adapterRuns.id, adapterRun.id));

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: paymentObject.id,
        workflowRunId: workflowRun.id,
        kind: "revenue_payment_link_packet",
        name: `Payment link packet for ${refs.customerName}`,
        state,
        sensitivity: "high",
        hash: traceHash(input.idempotencyKey, "payment_link_document"),
        data: {
          ...paymentData,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        objectId: paymentObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId,
        kind: "revenue_payment_link_packet",
        name: `Payment link packet for ${refs.customerName}`,
        state,
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id, draftEvidence.id, receiptEvidence.id] },
        documentIds: { ids: [document.id] },
        data: {
          command: "payment_link.prepare",
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          blockers: refs.blockers,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        hash: traceHash(input.idempotencyKey, "payment_link_packet"),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });

    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        objectId: paymentObject.id,
        capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: operator.id,
        kind: "payment_link_approval",
        state: "pending",
        priority: "high",
        risk: "high",
        title: `Approve payment link packet for ${refs.customerName}`,
        summary: `Revenue Worker prepared a ${formatUsd(paymentAmountCents)} payment-link packet; provider creation and money movement remain blocked.`,
        requestedAction: {
          action: "review_payment_link_packet",
          command: "payment_link.prepare",
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          amountCents: paymentAmountCents,
          currency: refs.currency,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          currentMode: "dry_run",
        },
        evidence: {
          eventId: event.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          documentId: document.id,
          packetId: packet.id,
          workflowRunId: workflowRun.id,
        },
        policy: {
          providerPaymentLinkCreation: "approval_required_but_currently_blocked",
          externalExecution: "blocked",
          moneyMovement: "blocked",
          capabilityGrantId: coreCapabilityGrantId || null,
        },
        data: {
          command: "payment_link.prepare",
          inputHash,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          workflowRunId: workflowRun.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });

    const paymentReviewViewKey = `payment.approval.review.${approval.id}`;
    const paymentReviewViewVersion = "1.0.0";
    const paymentReviewContract = {
      schemaVersion: "continuous.ui.payment_approval.v1",
      subject: {
        type: "approval_request",
        kind: "payment_link_approval",
        approvalRequestId: approval.id,
      },
      sections: [
        { key: "customer", title: "Customer", fields: ["customerName", "amountCents", "currency", "dueAt"] },
        { key: "source", title: "Source", fields: ["invoiceId", "invoiceObjectId", "quoteObjectId"] },
        { key: "policy", title: "Policy", fields: ["externalExecution", "providerPaymentLinkCreation", "moneyMovement"] },
        { key: "evidence", title: "Evidence", refs: ["traceEvidenceId", "draftEvidenceId", "adapterReceiptEvidenceId", "packetId"] },
        { key: "decision", title: "Decision", actions: ["approved", "revision_requested", "rejected"] },
      ],
      externalExecution: "blocked",
      providerPaymentLinkCreation: "blocked",
      moneyMovement: "blocked",
    } as JsonObject;
    const paymentReviewActions = {
      decisionSurface: "/approval",
      decisionCommand: "approval.decide",
      valid: [
        { action: "approved", label: "Approve", config: { action: "approved" } },
        { action: "revision_requested", label: "Request revision", config: { action: "revision_requested" } },
        { action: "rejected", label: "Reject", config: { action: "rejected" } },
      ],
      postDecisionSurface: "/worker",
      postDecisionCommand: "continue",
      externalExecution: "blocked",
      providerPaymentLinkCreation: "blocked",
      moneyMovement: "blocked",
    } as JsonObject;
    const paymentReviewData = {
      bindings: {
        approvalRequestId: "approval.id",
        paymentObjectId: "approval.objectId",
        workerRunId: "approval.workerRunId",
        workflowRunId: "approval.workflowRunId",
        evidenceRefs: "approval.evidenceRefs",
      },
      viewFamily: "payment.approval.review",
      latest: {
        command: "payment_link.prepare",
        approvalRequestId: approval.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
        taskId: task.id,
        paymentObjectId: paymentObject.id,
        paymentId: payment.id,
        paymentInstructionId,
        invoiceId: refs.invoice.id,
        invoiceObjectId: refs.invoiceObject.id,
        quoteObjectId: refs.quoteObject?.id ?? null,
        amountCents: paymentAmountCents,
        currency: refs.currency,
        customerName: refs.customerName,
        blockers: refs.blockers,
        traceEvidenceId: traceEvidence.id,
        draftEvidenceId: draftEvidence.id,
        adapterRunId: adapterRun.id,
        adapterActionId: adapterAction.id,
        adapterReceiptEvidenceId: receiptEvidence.id,
        documentId: document.id,
        packetId: packet.id,
        externalExecution: "blocked",
        providerPaymentLinkCreation: "blocked",
        moneyMovement: "blocked",
      },
    } as JsonObject;
    const paymentReviewViewValues = {
      capabilityId,
      key: paymentReviewViewKey,
      version: paymentReviewViewVersion,
      name: "Payment approval review",
      purpose: "Let an owner review a prepared payment-link packet while provider creation and money movement stay blocked.",
      surface: "web",
      objectType: "payment",
      taskState: state as "approval_required" | "blocked",
      contract: paymentReviewContract,
      actions: paymentReviewActions,
      data: paymentReviewData,
      mask: {
        bankAccount: "masked",
        customerContact: "redacted_by_default",
        providerPaymentLinkCreation: "blocked",
        moneyMovement: "blocked",
      } as JsonObject,
      active: true,
      updatedAt: now,
    };
    const [existingPaymentReviewView] = await tx
      .select({ id: generatedViews.id })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, context.worker.tenantId),
          eq(generatedViews.key, paymentReviewViewKey),
          eq(generatedViews.version, paymentReviewViewVersion),
        ),
      )
      .limit(1);
    const [paymentReviewView] = existingPaymentReviewView
      ? await tx
          .update(generatedViews)
          .set(paymentReviewViewValues)
          .where(eq(generatedViews.id, existingPaymentReviewView.id))
          .returning({ id: generatedViews.id })
      : await tx
          .insert(generatedViews)
          .values({
            tenantId: context.worker.tenantId,
            ...paymentReviewViewValues,
            createdAt: now,
          })
          .returning({ id: generatedViews.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.revenue_operations.payment_link_prepare.completed",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "worker_run",
        targetId: workerRun.id,
        taskId: task.id,
        workerRunId: workerRun.id,
        approvalRequestId: approval.id,
        eventId: event.id,
        objectId: paymentObject.id,
        capabilityId,
        risk: "high",
        idempotencyKey: `${input.idempotencyKey}:payment_link.prepare:completed`,
        data: {
          operatorEmail: operator.email,
          command: "payment_link.prepare",
          inputHash,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceId: refs.invoice.id,
          invoiceObjectId: refs.invoiceObject.id,
          approvalRequestId: approval.id,
          paymentReviewViewId: paymentReviewView.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          documentId: document.id,
          packetId: packet.id,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: auditEvents.id });

    const workflowStepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: workflowDefinition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: paymentObject.id,
          workerId: context.worker.id,
          capabilityId,
          kind: "worker_transition",
          name: "Revenue invoice resolved",
          state: "done",
          priority: "high",
          risk: "high",
          fromState: "received",
          toState: "invoice_resolved",
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:invoice_resolved`,
          input: { invoiceId: refs.invoice.id, invoiceObjectId: refs.invoiceObject.id },
          output: { paymentObjectId: paymentObject.id, inputHash },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: workflowDefinition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: paymentObject.id,
          workerId: context.worker.id,
          capabilityId,
          kind: "worker_transition",
          name: "Payment-link packet prepared",
          state: "done",
          priority: "high",
          risk: "high",
          fromState: "invoice_resolved",
          toState: "packet_prepared",
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:packet_prepared`,
          input: { paymentObjectId: paymentObject.id, paymentId: payment.id, paymentInstructionId },
          output: { traceEvidenceId: traceEvidence.id, draftEvidenceId: draftEvidence.id, documentId: document.id, packetId: packet.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: workflowDefinition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: paymentObject.id,
          workerId: context.worker.id,
          capabilityId,
          kind: "adapter_dry_run",
          name: "Provider payment-link dry run blocked",
          state: "done",
          priority: "high",
          risk: "high",
          fromState: "packet_prepared",
          toState: "adapter_dry_run_recorded",
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:adapter_dry_run_recorded`,
          input: { operation: "prepare_payment_link", mode: "dry_run" },
          output: { adapterRunId: adapterRun.id, adapterActionId: adapterAction.id, adapterReceiptEvidenceId: receiptEvidence.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: workflowDefinition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          taskId: task.id,
          objectId: paymentObject.id,
          workerId: context.worker.id,
          capabilityId,
          kind: "approval_request",
          name: "Payment-link owner approval requested",
          state: "done",
          priority: "high",
          risk: "high",
          fromState: "adapter_dry_run_recorded",
          toState: "approval_requested",
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:approval_requested`,
          input: { approvalRequestId: approval.id, paymentReviewViewId: paymentReviewView.id },
          output: {
            approvalRequestId: approval.id,
            auditEventId: audit.id,
            paymentReviewViewId: paymentReviewView.id,
            externalExecution: "blocked",
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
          },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);
    const output = {
      command: "payment_link.prepare",
      worker: context.worker.name,
      tenant: context.tenantName,
      inputHash,
      taskId: task.id,
      eventId: event.id,
      workerRunId: workerRun.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      paymentObjectId: paymentObject.id,
      paymentId: payment.id,
      paymentInstructionId,
      reservationId,
      inferenceId: inference.id,
      usageEventId,
      invoiceId: refs.invoice.id,
      invoiceObjectId: refs.invoiceObject.id,
      quoteObjectId: refs.quoteObject?.id ?? null,
      approvalRequestId: approval.id,
      paymentReviewViewId: paymentReviewView.id,
      adapterRunId: adapterRun.id,
      adapterActionId: adapterAction.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      evidenceId: traceEvidence.id,
      draftEvidenceId: draftEvidence.id,
      documentId: document.id,
      packetId: packet.id,
      auditEventId: audit.id,
      amountCents: paymentAmountCents,
      currency: refs.currency,
      customerName: refs.customerName,
      dueAt: refs.dueAt,
      blockers: refs.blockers,
      budgetUnits: paymentLinkPrepareUnits,
      requiresApproval: true,
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
      providerPaymentLinkCreation: "blocked",
      moneyMovement: "blocked",
    } satisfies JsonObject;

    await tx
      .update(workflowRuns)
      .set({
        state: workflowState,
        data: {
          ...output,
          adapterReceiptEvidenceId: receiptEvidence.id,
        },
        blockers: { open: refs.blockers },
        metrics: {
          budgetUnits: paymentLinkPrepareUnits,
          amountCents: paymentAmountCents,
          blockerCount: refs.blockers.length,
        },
        updatedAt: now,
      })
      .where(eq(workflowRuns.id, workflowRun.id));

    await tx
      .update(events)
      .set({
        data: output,
      })
      .where(eq(events.id, event.id));

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        taskId: task.id,
        capabilityId,
        data: {
          ...objectValue(workerRun.data),
          businessEventId: event.id,
          businessAuditEventId: audit.id,
          taskId: task.id,
          eventId: event.id,
          reservationId,
          inferenceId: inference.id,
          usageEventId,
          paymentObjectId: paymentObject.id,
          paymentId: payment.id,
          paymentInstructionId,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoice.id,
          quoteObjectId: refs.quoteObject?.id ?? null,
          approvalRequestId: approval.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          evidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          paymentReviewViewId: paymentReviewView.id,
          auditEventId: audit.id,
          pendingCompletion: {
            output,
          },
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, workerRun.id));

    await tx
      .update(workers)
      .set({
        state: "active",
        kpis: sql`jsonb_set(
          jsonb_set(
            jsonb_set(
              coalesce(${workers.kpis}, '{}'::jsonb),
              '{lastPaymentLinkPreparedAt}',
              to_jsonb(${now.toISOString()}::text),
              true
            ),
            '{payment_links_prepared}',
            to_jsonb((coalesce((${workers.kpis}->>'payment_links_prepared')::int, 0) + 1)),
            true
          ),
          '{owner_review_packets}',
          to_jsonb((coalesce((${workers.kpis}->>'owner_review_packets')::int, 0) + 1)),
          true
        )`,
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      created: true as const,
      needsCompletion: true,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      reservationId,
      inferenceId: inference.id,
      usageEventId,
      paymentObjectId: paymentObject.id,
      paymentId: payment.id,
      paymentInstructionId,
      invoiceObjectId: refs.invoiceObject.id,
      invoiceId: refs.invoice.id,
      quoteObjectId: refs.quoteObject?.id ?? null,
      approvalRequestId: approval.id,
      adapterRunId: adapterRun.id,
      adapterActionId: adapterAction.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      evidenceId: traceEvidence.id,
      draftEvidenceId: draftEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      paymentReviewViewId: paymentReviewView.id,
      auditEventId: audit.id,
      output,
    };
  });
  const completion = result.needsCompletion
    ? await completeCoreWorkerRun({
        operatorEmail: input.operatorEmail,
        tenantSlug: context.worker.tenantSlug,
        idempotencyKey: input.idempotencyKey,
        worker: {
          id: context.worker.id,
          role: revenueWorkerRole,
        },
        workerRunId: result.workerRunId,
        state: "done",
        reason: "Revenue Worker prepared a payment-link packet with provider creation and money movement blocked.",
        output: result.output,
        costUsd: 0,
        evidence: {
          command: "payment_link.prepare",
          eventId: result.eventId,
          auditEventId: result.auditEventId,
          evidenceId: result.evidenceId,
          draftEvidenceId: result.draftEvidenceId,
          inferenceId: result.inferenceId,
          adapterRunId: result.adapterRunId,
          adapterActionId: result.adapterActionId,
          adapterReceiptEvidenceId: result.adapterReceiptEvidenceId,
          approvalRequestId: result.approvalRequestId,
          paymentReviewViewId: result.paymentReviewViewId,
          workflowRunId: result.workflowRunId,
          paymentObjectId: result.paymentObjectId,
          paymentId: result.paymentId,
          paymentInstructionId: result.paymentInstructionId,
          invoiceId: result.invoiceId,
          invoiceObjectId: result.invoiceObjectId,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          externalExecution: "blocked",
          externalSend: false,
        },
        db,
      })
    : null;
  const completionBudget = objectValue(completion?.budget);
  const settledReservationId = stringValue(completionBudget.reservationId) || result.reservationId;
  const settledUsageEventId = stringValue(completionBudget.usageEventId) || result.usageEventId;
  const settledOutput = {
    ...result.output,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
  } satisfies JsonObject;
  const snapshot = await getRevenueWorkerSnapshot(db, {
    tenantSlug: input.tenantSlug,
    workerId: context.worker.id,
    role: revenueWorkerRole,
  });

  return {
    idempotencyKey: input.idempotencyKey,
    created: result.created,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    reservationId: settledReservationId,
    inferenceId: result.inferenceId,
    usageEventId: settledUsageEventId,
    paymentObjectId: result.paymentObjectId,
    paymentId: result.paymentId,
    paymentInstructionId: result.paymentInstructionId,
    invoiceObjectId: result.invoiceObjectId,
    invoiceId: result.invoiceId,
    quoteObjectId: result.quoteObjectId,
    approvalRequestId: result.approvalRequestId,
    adapterRunId: result.adapterRunId,
    adapterActionId: result.adapterActionId,
    adapterReceiptEvidenceId: result.adapterReceiptEvidenceId,
    evidenceId: result.evidenceId,
    draftEvidenceId: result.draftEvidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    paymentReviewViewId: result.paymentReviewViewId,
    auditEventId: result.auditEventId,
    output: settledOutput,
    snapshot,
  };
}

export async function continueRevenueWorker(input: {
  approvalId: string;
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<RevenueWorkerContinuationResult> {
  const db = input.db ?? defaultDb;
  const approvalId = uuidValue(input.approvalId);
  const commandConfig = objectValue(input.config);

  if (!approvalId) {
    throw new RevenueWorkerUnavailableError(
      "invalid_worker_continuation_config",
      "config.approvalId must be a valid approval id.",
      400,
    );
  }

  const selector = {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    role: revenueWorkerRole,
  };
  const context = await loadWorkerContext(db, selector);
  const operator = await loadOperator(db, context.worker.tenantId, input.operatorEmail);
  const now = new Date();
  const requestedExecution = controlledExecutionConfig(commandConfig);
  const storedConfig = storedContinuationConfig({
    approvalId,
    config: commandConfig,
    execution: requestedExecution,
  });
  const inputHash = hashObject({
    approvalId,
    config: commandConfig,
  });
  const [legacyRun] = await db
    .select()
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.tenantId, context.worker.tenantId),
        eq(workerRuns.source, source),
        eq(workerRuns.idempotencyKey, input.idempotencyKey),
      ),
    )
    .limit(1);

  if (legacyRun) {
    const output = outputData(legacyRun.data);
    const legacyApprovalId =
      stringData(legacyRun.data, "originalApprovalRequestId") ??
      stringData(legacyRun.data, "approvalRequestId");

    if (legacyRun.mode !== "continuation" || legacyApprovalId !== approvalId) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_idempotency_conflict",
        "Idempotency key already belongs to a different worker operation.",
        409,
      );
    }

    const legacyInput = objectValue(legacyRun.data.input);
    const legacyHash = stringValue(legacyInput.inputHash);

    if (!legacyHash) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_idempotency_conflict",
        "Idempotency key belongs to a worker continuation without a config hash. Use a new idempotency key.",
        409,
      );
    }

    if (legacyHash !== inputHash) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_idempotency_conflict",
        "Idempotency key already belongs to a different worker continuation payload.",
        409,
      );
    }

    return {
      idempotencyKey: input.idempotencyKey,
      created: false,
      workerRunId: legacyRun.id,
      originalWorkerRunId: stringData(legacyRun.data, "originalWorkerRunId"),
      eventId: legacyRun.eventId ?? stringData(legacyRun.data, "eventId"),
      taskId: stringData(legacyRun.data, "taskId") ?? legacyRun.taskId,
      reservationId: stringData(legacyRun.data, "reservationId"),
      usageEventId: stringData(legacyRun.data, "usageEventId"),
      approvalRequestId: stringData(legacyRun.data, "approvalRequestId"),
      auditEventId: stringData(legacyRun.data, "auditEventId"),
      evidenceId: stringData(legacyRun.data, "evidenceId"),
      workflowRunId: stringData(legacyRun.data, "workflowRunId"),
      workflowStepId: stringData(legacyRun.data, "workflowStepId"),
      output,
      snapshot: await getRevenueWorkerSnapshot(db, selector),
    };
  }

  const [startApproval] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.tenantId, context.worker.tenantId), eq(approvalRequests.id, approvalId)))
    .limit(1);

  if (!startApproval) {
    throw new RevenueWorkerUnavailableError(
      "worker_continuation_approval_not_found",
      "No worker approval request matches this id.",
      404,
    );
  }

  if (!revenueContinuationApprovalKinds.has(startApproval.kind)) {
    throw new RevenueWorkerUnavailableError(
      "worker_continuation_unsupported_approval_kind",
      "Revenue Worker continuation supports quote and payment-link approval continuations. Use a dedicated command for this approval kind.",
      409,
    );
  }

  if (!["approved", "revision_requested", "rejected"].includes(startApproval.state)) {
    throw new RevenueWorkerUnavailableError(
      "worker_continuation_unsupported_state",
      "Revenue Worker continuation supports approved, revision_requested, and rejected approvals.",
      409,
    );
  }

  if (
    requestedExecution &&
    startApproval.kind === "payment_link_approval"
  ) {
    throw new RevenueWorkerUnavailableError(
      "worker_payment_link_execution_not_supported",
      "config.execution is reserved for controlled customer-message sends; payment-link provider creation remains blocked.",
      409,
    );
  }

  if (!startApproval.workerRunId || !startApproval.workflowRunId) {
    throw new RevenueWorkerUnavailableError(
      "worker_continuation_missing_links",
      "Revenue Worker continuation requires linked worker and workflow runs.",
    );
  }

  const [startOriginalRun] = await db
    .select()
    .from(workerRuns)
    .where(
      and(
        eq(workerRuns.tenantId, context.worker.tenantId),
        eq(workerRuns.id, startApproval.workerRunId),
      ),
    )
    .limit(1);

  if (!startOriginalRun) {
    throw new RevenueWorkerUnavailableError(
      "worker_continuation_run_not_found",
      "The approval's original worker run is not available.",
      404,
    );
  }

  if (startOriginalRun.workerId !== context.worker.id) {
    throw new RevenueWorkerUnavailableError(
      "worker_continuation_worker_mismatch",
      "The selected worker does not own this approval continuation.",
      403,
    );
  }

  if (requestedExecution && startApproval.state !== "approved") {
    throw new RevenueWorkerUnavailableError(
      "worker_controlled_send_approval_required",
      "config.execution can only be used when the approval state is approved.",
      409,
    );
  }

  if (requestedExecution) {
    const preflightDecision = objectValue(startApproval.decision);
    const preflightContinuation = objectValue(preflightDecision.continuation);
    const preflightOriginalOutput = outputData(startOriginalRun.data);
    const preflightAdapterRunId = uuidValue(
      preflightContinuation.adapterRunId ?? preflightOriginalOutput.adapterRunId,
    );
    const preflightAdapterActionId = uuidValue(
      preflightContinuation.adapterActionId ?? preflightOriginalOutput.adapterActionId,
    );

    await db.transaction(async (tx) => {
      await customerMessageExecutionReceiptFor({
        tx,
        tenantId: context.worker.tenantId,
        execution: requestedExecution,
        approvalId,
        adapterRunId: preflightAdapterRunId,
        adapterActionId: preflightAdapterActionId,
        now,
      });
    });
  }

  const continuationRunInput = {
    idempotencyKey: input.idempotencyKey,
    command: "continue",
    inputHash,
    config: storedConfig,
    approvalId,
    approvalKind: startApproval.kind,
    approvalState: startApproval.state,
    originalWorkerRunId: startOriginalRun.id,
    workflowRunId: startApproval.workflowRunId,
    operator: {
      userId: operator.id,
      email: operator.email,
    },
  };
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: revenueWorkerRole,
    },
    command: "continue",
    mode: "continuation",
    taskId: startApproval.taskId ?? undefined,
    capabilityId: startApproval.capabilityId ?? startOriginalRun.capabilityId ?? undefined,
    connectionId: startOriginalRun.connectionId ?? context.connectionId,
    budgetAccountId: startOriginalRun.budgetAccountId ?? context.budgetAccountId,
    units: revenueContinuationUnits,
    input: continuationRunInput,
    policy: {
      externalExecution: "blocked",
      externalSend: false,
      moneyMovement: "blocked",
    },
    evidence: {
      command: "continue",
      approvalId,
      approvalKind: startApproval.kind,
      originalWorkerRunId: startOriginalRun.id,
      workflowRunId: startApproval.workflowRunId,
      required: ["approval_decision", "continuation_packet", "workflow_step", "audit"],
      externalExecution: "blocked",
      externalSend: false,
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = stringValue(coreBudget.reservationId);

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${coreWorkerRunSource}:continue:${input.idempotencyKey}`}))`,
    );

    const [run] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!run) {
      throw new RevenueWorkerUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Revenue continuation run.",
        409,
      );
    }

    const existingInput = objectValue(run.data.input);
    const existingRequest = objectValue(existingInput.request);
    const existingRequestConfig = objectValue(existingRequest.config);
    const existingHash = stringValue(existingRequest.inputHash) || stringValue(existingInput.inputHash);
    const existingApprovalId =
      stringValue(existingRequest.approvalId) ||
      stringValue(existingRequestConfig.approvalId) ||
      stringData(run.data, "originalApprovalRequestId") ||
      stringData(run.data, "approvalRequestId");

    if (
      run.mode !== "continuation" ||
      stringValue(existingInput.command) !== "continue" ||
      existingApprovalId !== approvalId ||
      !existingHash ||
      existingHash !== inputHash
    ) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_idempotency_conflict",
        "Idempotency key already belongs to a different worker continuation payload.",
        409,
      );
    }

    const existingOutput = outputData(run.data);

    if (stringValue(existingOutput.status)) {
      const existingCompletionBudget = objectValue(objectValue(run.data.completion).budget);
      return {
        created: false as const,
        needsCompletion: run.state === "running",
        workerRunId: run.id,
        originalWorkerRunId: stringData(run.data, "originalWorkerRunId"),
        eventId: stringData(run.data, "eventId") ?? run.eventId,
        taskId: stringData(run.data, "taskId") ?? run.taskId,
        reservationId:
          stringData(run.data, "reservationId") ??
          stringValue(existingCompletionBudget.reservationId) ??
          coreReservationId ??
          null,
        usageEventId: stringData(run.data, "usageEventId") ?? stringValue(existingCompletionBudget.usageEventId),
        approvalRequestId: stringData(run.data, "approvalRequestId"),
        auditEventId: stringData(run.data, "auditEventId"),
        evidenceId: stringData(run.data, "evidenceId"),
        workflowRunId: stringData(run.data, "workflowRunId"),
        workflowStepId: stringData(run.data, "workflowStepId"),
        output: existingOutput,
      };
    }

    const [approval] = await tx
      .select()
      .from(approvalRequests)
      .where(and(eq(approvalRequests.tenantId, context.worker.tenantId), eq(approvalRequests.id, approvalId)))
      .limit(1);

    if (!approval) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_approval_not_found",
        "No worker approval request matches this id.",
        404,
      );
    }

    if (!revenueContinuationApprovalKinds.has(approval.kind)) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_unsupported_approval_kind",
        "Revenue Worker continuation supports quote and payment-link approval continuations. Use a dedicated command for this approval kind.",
        409,
      );
    }

    if (!["approved", "revision_requested", "rejected"].includes(approval.state)) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_unsupported_state",
        "Revenue Worker continuation supports approved, revision_requested, and rejected approvals.",
        409,
      );
    }

    if (
      requestedExecution &&
      approval.kind === "payment_link_approval"
    ) {
      throw new RevenueWorkerUnavailableError(
        "worker_payment_link_execution_not_supported",
        "config.execution is reserved for controlled customer-message sends; payment-link provider creation remains blocked.",
        409,
      );
    }

    if (!approval.workerRunId || !approval.workflowRunId) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_missing_links",
        "Revenue Worker continuation requires linked worker and workflow runs.",
      );
    }

    const [originalRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, approval.workerRunId),
        ),
      )
      .limit(1);

    if (!originalRun) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_run_not_found",
        "The approval's original worker run is not available.",
        404,
      );
    }

    if (originalRun.workerId !== context.worker.id) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_worker_mismatch",
        "The selected worker does not own this approval continuation.",
        403,
      );
    }

    const [workflow] = await tx
      .select({
        run: workflowRuns,
        definition: workflowDefinitions,
      })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowRuns.definitionId, workflowDefinitions.id))
      .where(
        and(
          eq(workflowRuns.tenantId, context.worker.tenantId),
          eq(workflowRuns.id, approval.workflowRunId),
        ),
      )
      .limit(1);

    if (!workflow || workflow.definition.key !== revenueWorkflowKey) {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_workflow_not_found",
        "The approval's Revenue workflow run is not available.",
        404,
      );
    }

    const approvalDecision = objectValue(approval.decision);
    const approvalContinuation = objectValue(approvalDecision.continuation);
    const originalOutput = outputData(originalRun.data);

    if (requestedExecution && approval.state !== "approved") {
      throw new RevenueWorkerUnavailableError(
        "worker_controlled_send_approval_required",
        "config.execution can only be used when the approval state is approved.",
        409,
      );
    }

    if (approval.kind === "payment_link_approval") {
      const workerRun = run;
      const adapterRunId = uuidValue(approvalContinuation.adapterRunId ?? originalOutput.adapterRunId);
      const adapterActionId = uuidValue(
        approvalContinuation.adapterActionId ?? originalOutput.adapterActionId,
      );
      const adapterReceiptEvidenceId = uuidValue(
        approvalContinuation.adapterReceiptEvidenceId ?? originalOutput.adapterReceiptEvidenceId,
      );
      const continuationInput = {
        approvalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workflowRunId: workflow.run.id,
        workflowState: workflow.run.state,
        action: approval.state,
        note: stringValue(approvalDecision.note),
        originalOutput,
        approvalContinuation,
      };

      if (approval.state === "approved") {
        const approvalNote = stringValue(approvalDecision.note, "Approved by operator.");
        const approvedPaymentLinkPacket = approvedPaymentLinkPacketFromOriginal({
          originalOutput,
          approvalNote,
          now,
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
        });
        const approvedPaymentLinkHash = hashObject(approvedPaymentLinkPacket);
        const paymentObjectId = uuidValue(approvedPaymentLinkPacket.paymentObjectId ?? approval.objectId);
        const paymentId = uuidValue(approvedPaymentLinkPacket.paymentId);
        const paymentInstructionId = uuidValue(approvedPaymentLinkPacket.paymentInstructionId);

        const [event] = await tx
          .insert(events)
          .values({
            tenantId: context.worker.tenantId,
            type: "worker.revenue_operations.payment_link_approval.blocked",
            source,
            actorType: "worker",
            actorId: context.worker.id,
            actorRef: `worker:${context.worker.id}`,
            objectId: approval.objectId,
            taskId: approval.taskId,
            capabilityId: approval.capabilityId,
            connectionId: originalRun.connectionId ?? context.connectionId,
            idempotencyKey: input.idempotencyKey,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              action: "approved",
              status: "approved_payment_link_execution_blocked",
              note: approvalNote,
              adapterRunId: adapterRunId || null,
              adapterActionId: adapterActionId || null,
              adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
              approvedPaymentLinkPacket,
              approvedPaymentLinkHash,
              nextAction: "enable_scoped_payment_provider_execution",
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            occurredAt: now,
          })
          .returning({ id: events.id });
        const [audit] = await tx
          .insert(auditEvents)
          .values({
            tenantId: context.worker.tenantId,
            type: "worker.revenue_operations.continuation.completed",
            source,
            actorType: "worker",
            actorId: context.worker.id,
            actorRef: `worker:${context.worker.id}`,
            targetType: "worker_run",
            targetId: workerRun.id,
            taskId: approval.taskId,
            workerRunId: workerRun.id,
            approvalRequestId: approval.id,
            eventId: event.id,
            objectId: approval.objectId,
            capabilityId: approval.capabilityId,
            risk: approval.risk,
            idempotencyKey: `${input.idempotencyKey}:payment_link_execution_blocked`,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workflowRunId: workflow.run.id,
              workflowState: workflow.run.state,
              action: "approved",
              status: "approved_payment_link_execution_blocked",
              nextAction: "enable_scoped_payment_provider_execution",
              adapterRunId: adapterRunId || null,
              adapterActionId: adapterActionId || null,
              adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
              approvedPaymentLinkPacket,
              approvedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
          })
          .returning({ id: auditEvents.id });
        const [trace] = await tx
          .insert(evidence)
          .values({
            tenantId: context.worker.tenantId,
            kind: "trace",
            name: "Revenue payment-link approved continuation",
            objectId: approval.objectId,
            taskId: approval.taskId,
            eventId: event.id,
            capabilityId: approval.capabilityId,
            actorType: "worker",
            actorId: context.worker.id,
            hash: traceHash(input.idempotencyKey, "payment_link_approved_continuation"),
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              auditEventId: audit.id,
              action: "approved",
              note: approvalNote,
              originalOutput,
              approvalContinuation,
              adapterRunId: adapterRunId || null,
              adapterActionId: adapterActionId || null,
              adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
              approvedPaymentLinkPacket,
              approvedPaymentLinkHash,
              nextAction: "enable_scoped_payment_provider_execution",
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
          })
          .returning({ id: evidence.id });
        const [approvedPaymentLinkEvidence] = await tx
          .insert(evidence)
          .values({
            tenantId: context.worker.tenantId,
            kind: "draft",
            name: "Revenue approved payment-link packet",
            objectId: approval.objectId,
            taskId: approval.taskId,
            eventId: event.id,
            capabilityId: approval.capabilityId,
            actorType: "worker",
            actorId: context.worker.id,
            hash: approvedPaymentLinkHash,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              traceEvidenceId: trace.id,
              action: "approved",
              note: approvalNote,
              approvedPaymentLinkPacket,
              approvedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
          })
          .returning({ id: evidence.id });
        const [approvedPaymentLinkDocument] = await tx
          .insert(documents)
          .values({
            tenantId: context.worker.tenantId,
            objectId: approval.objectId,
            workflowRunId: workflow.run.id,
            kind: "revenue_payment_link_approved_packet",
            name: "Revenue approved payment-link packet",
            state: "blocked",
            sensitivity: approval.risk,
            hash: approvedPaymentLinkHash,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              eventId: event.id,
              traceEvidenceId: trace.id,
              approvedPaymentLinkEvidenceId: approvedPaymentLinkEvidence.id,
              approvedPaymentLinkPacket,
              approvedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: documents.id });
        const [approvedPaymentLinkEvidencePacket] = await tx
          .insert(evidencePackets)
          .values({
            tenantId: context.worker.tenantId,
            documentId: approvedPaymentLinkDocument.id,
            objectId: approval.objectId,
            taskId: approval.taskId,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            capabilityId: approval.capabilityId,
            kind: "revenue_payment_link_approved_packet",
            name: "Revenue approved payment-link packet",
            state: "blocked",
            sensitivity: approval.risk,
            evidenceIds: { ids: [trace.id, approvedPaymentLinkEvidence.id] },
            documentIds: { ids: [approvedPaymentLinkDocument.id] },
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              eventId: event.id,
              approvedPaymentLinkPacket,
              approvedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            hash: approvedPaymentLinkHash,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: evidencePackets.id });
        const continuationLinks = {
          approvedPaymentLinkEvidenceId: approvedPaymentLinkEvidence.id,
          approvedPaymentLinkDocumentId: approvedPaymentLinkDocument.id,
          approvedPaymentLinkEvidencePacketId: approvedPaymentLinkEvidencePacket.id,
        };

        const [workflowStep] = await tx
          .insert(workflowSteps)
          .values({
            tenantId: context.worker.tenantId,
            definitionId: workflow.definition.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            approvalRequestId: approval.id,
            taskId: approval.taskId,
            objectId: approval.objectId,
            workerId: context.worker.id,
            capabilityId: approval.capabilityId,
            kind: "worker_continuation",
            name: `${workflow.definition.key}:payment_link_execution_blocked`,
            state: "done",
            priority: approval.priority,
            risk: approval.risk,
            fromState: workflow.run.state,
            toState: "execution_blocked",
            attempt: 1,
            maxAttempts: 1,
            leaseOwner: `worker:${context.worker.id}`,
            leasedUntil: now,
            idempotencyKey: `${input.idempotencyKey}:payment_link_execution_blocked`,
            input: continuationInput,
            output: {
              approvalRequestId: approval.id,
              originalApprovalRequestId: approval.id,
              workerRunId: workerRun.id,
              originalWorkerRunId: originalRun.id,
              auditEventId: audit.id,
              evidenceId: trace.id,
              adapterRunId: adapterRunId || null,
              adapterActionId: adapterActionId || null,
              adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
              ...continuationLinks,
              approvedPaymentLinkPacket,
              nextAction: "enable_scoped_payment_provider_execution",
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .returning({ id: workflowSteps.id });

        const output = {
          command: "continue",
          status: "approved_payment_link_execution_blocked",
          approvalRequestId: approval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          eventId: event.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          reservationId: coreReservationId || null,
          usageEventId: null,
          paymentObjectId: paymentObjectId || null,
          paymentId: paymentId || null,
          paymentInstructionId: paymentInstructionId || null,
          invoiceId: uuidValue(approvedPaymentLinkPacket.invoiceId) || null,
          invoiceObjectId: uuidValue(approvedPaymentLinkPacket.invoiceObjectId) || null,
          quoteObjectId: uuidValue(approvedPaymentLinkPacket.quoteObjectId) || null,
          amountCents: numberValue(approvedPaymentLinkPacket.amountCents),
          currency: stringValue(approvedPaymentLinkPacket.currency, "USD"),
          customerName: stringValue(approvedPaymentLinkPacket.customerName, "Customer"),
          dueAt: stringValue(approvedPaymentLinkPacket.dueAt) || null,
          adapterRunId: adapterRunId || null,
          adapterActionId: adapterActionId || null,
          adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
          ...continuationLinks,
          approvedPaymentLinkPacket,
          approvedPaymentLinkHash,
          nextAction: "enable_scoped_payment_provider_execution",
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          requiresApproval: false,
        };
        const workflowData = objectValue(workflow.run.data);
        const approvedPaymentLinkContinuation = {
          ...output,
          note: approvalNote,
          action: "approved",
          continuedAt: now.toISOString(),
        };

        await tx
          .update(workflowRuns)
          .set({
            state: "execution_blocked",
            data: {
              ...workflowData,
              approvedPaymentLinkContinuation,
              lastWorkerContinuation: approvedPaymentLinkContinuation,
              workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
            },
            blockers: {
              ...objectValue(workflow.run.blockers),
              open: [
                "provider_payment_link_creation_blocked",
                "money_movement_blocked",
                "scoped_payment_provider_credentials_required",
              ],
            },
            completedAt: null,
            updatedAt: now,
          })
          .where(eq(workflowRuns.id, workflow.run.id));

        if (approval.taskId) {
          const [task] = await tx
            .select({ outcome: tasks.outcome })
            .from(tasks)
            .where(and(eq(tasks.tenantId, context.worker.tenantId), eq(tasks.id, approval.taskId)))
            .limit(1);

          await tx
            .update(tasks)
            .set({
              state: "waiting",
              outcome: {
                ...objectValue(task?.outcome),
                status: "approved_payment_link_execution_blocked",
                approvalRequestId: approval.id,
                approvedPaymentLinkContinuation,
                ...continuationLinks,
                approvedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              updatedAt: now,
            })
            .where(eq(tasks.id, approval.taskId));
        }

        if (paymentObjectId) {
          const [paymentObject] = await tx
            .select({ data: objects.data })
            .from(objects)
            .where(and(eq(objects.tenantId, context.worker.tenantId), eq(objects.id, paymentObjectId)))
            .limit(1);

          await tx
            .update(objects)
            .set({
              state: "execution_blocked",
              data: {
                ...objectValue(paymentObject?.data),
                approvedPaymentLinkContinuation,
                ...continuationLinks,
                approvedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              updatedAt: now,
            })
            .where(eq(objects.id, paymentObjectId));
        }

        if (paymentId) {
          const [payment] = await tx
            .select({ data: payments.data })
            .from(payments)
            .where(and(eq(payments.tenantId, context.worker.tenantId), eq(payments.id, paymentId)))
            .limit(1);

          await tx
            .update(payments)
            .set({
              state: "execution_blocked",
              data: {
                ...objectValue(payment?.data),
                approvedPaymentLinkContinuation,
                ...continuationLinks,
                approvedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              updatedAt: now,
            })
            .where(eq(payments.id, paymentId));
        }

        if (paymentInstructionId) {
          const [paymentInstruction] = await tx
            .select({ data: paymentInstructions.data })
            .from(paymentInstructions)
            .where(
              and(
                eq(paymentInstructions.tenantId, context.worker.tenantId),
                eq(paymentInstructions.id, paymentInstructionId),
              ),
            )
            .limit(1);

          await tx
            .update(paymentInstructions)
            .set({
              state: "execution_blocked",
              data: {
                ...objectValue(paymentInstruction?.data),
                approvedPaymentLinkContinuation,
                ...continuationLinks,
                approvedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              updatedAt: now,
            })
            .where(eq(paymentInstructions.id, paymentInstructionId));
        }

        await tx
          .update(workerRuns)
          .set({
            data: {
              ...objectValue(originalRun.data),
              output: {
                ...originalOutput,
                approvedPaymentLinkContinuation,
                ...continuationLinks,
                approvedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              lastWorkerContinuation: approvedPaymentLinkContinuation,
            },
            updatedAt: now,
          })
          .where(eq(workerRuns.id, originalRun.id));

        if (adapterActionId) {
          const [adapterAction] = await tx
            .select({
              response: adapterActions.response,
              receipt: adapterActions.receipt,
            })
            .from(adapterActions)
            .where(and(eq(adapterActions.tenantId, context.worker.tenantId), eq(adapterActions.id, adapterActionId)))
            .limit(1);

          if (adapterAction) {
            await tx
              .update(adapterActions)
              .set({
                response: {
                  ...adapterAction.response,
                  approvedPaymentLinkContinuation,
                  approvedPaymentLinkPacket,
                  externalExecution: "blocked",
                  externalMutation: false,
                  externalSend: false,
                  providerPaymentLinkCreation: "blocked",
                  moneyMovement: "blocked",
                },
                receipt: {
                  ...adapterAction.receipt,
                  approvedPaymentLinkContinuation,
                  externalMutation: false,
                  externalSend: false,
                  providerPaymentLinkCreation: "blocked",
                  moneyMovement: "blocked",
                },
              })
              .where(eq(adapterActions.id, adapterActionId));
          }
        }

        if (adapterRunId) {
          const [adapterRun] = await tx
            .select({
              data: adapterRuns.data,
              receipt: adapterRuns.receipt,
            })
            .from(adapterRuns)
            .where(and(eq(adapterRuns.tenantId, context.worker.tenantId), eq(adapterRuns.id, adapterRunId)))
            .limit(1);

          if (adapterRun) {
            await tx
              .update(adapterRuns)
              .set({
                data: {
                  ...adapterRun.data,
                  approvedPaymentLinkContinuation,
                  externalExecution: "blocked",
                  externalMutation: false,
                  externalSend: false,
                  providerPaymentLinkCreation: "blocked",
                  moneyMovement: "blocked",
                },
                receipt: {
                  ...adapterRun.receipt,
                  approvedPaymentLinkContinuation,
                  externalMutation: false,
                  externalSend: false,
                  providerPaymentLinkCreation: "blocked",
                  moneyMovement: "blocked",
                },
              })
              .where(eq(adapterRuns.id, adapterRunId));
          }
        }

        await tx
          .update(workerRuns)
          .set({
            eventId: event.id,
            updatedAt: now,
            data: {
              ...objectValue(workerRun.data),
              businessEventId: event.id,
              businessAuditEventId: audit.id,
              taskId: approval.taskId,
              originalWorkerRunId: originalRun.id,
              eventId: event.id,
              approvalRequestId: approval.id,
              auditEventId: audit.id,
              evidenceId: trace.id,
              workflowRunId: workflow.run.id,
              workflowStepId: workflowStep.id,
              reservationId: coreReservationId || null,
              usageEventId: null,
              pendingCompletion: {
                output,
              },
            },
          })
          .where(eq(workerRuns.id, workerRun.id));

        return {
          created: true as const,
          needsCompletion: true,
          workerRunId: workerRun.id,
          originalWorkerRunId: originalRun.id,
          eventId: event.id,
          taskId: approval.taskId,
          reservationId: coreReservationId || null,
          usageEventId: null,
          approvalRequestId: approval.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          output,
        };
      }

      if (approval.state === "rejected") {
        const rejectionNote = stringValue(approvalDecision.note, "Rejected by operator.");
        const rejectedPaymentLinkPacket = rejectedPaymentLinkPacketFromOriginal({
          originalOutput,
          rejectionNote,
          now,
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
        });
        const rejectedPaymentLinkHash = hashObject(rejectedPaymentLinkPacket);
        const paymentObjectId = uuidValue(rejectedPaymentLinkPacket.paymentObjectId ?? approval.objectId);
        const paymentId = uuidValue(rejectedPaymentLinkPacket.paymentId);
        const paymentInstructionId = uuidValue(rejectedPaymentLinkPacket.paymentInstructionId);

        const [event] = await tx
          .insert(events)
          .values({
            tenantId: context.worker.tenantId,
            type: "worker.revenue_operations.payment_link_rejection.closed",
            source,
            actorType: "worker",
            actorId: context.worker.id,
            actorRef: `worker:${context.worker.id}`,
            objectId: approval.objectId,
            taskId: approval.taskId,
            capabilityId: approval.capabilityId,
            connectionId: originalRun.connectionId ?? context.connectionId,
            idempotencyKey: input.idempotencyKey,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              action: "rejected",
              status: "payment_link_rejected_closed",
              note: rejectionNote,
              adapterRunId: adapterRunId || null,
              adapterActionId: adapterActionId || null,
              adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
              rejectedPaymentLinkPacket,
              rejectedPaymentLinkHash,
              nextAction: "stop_provider_payment_link_preparation",
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            occurredAt: now,
          })
          .returning({ id: events.id });
        const [audit] = await tx
          .insert(auditEvents)
          .values({
            tenantId: context.worker.tenantId,
            type: "worker.revenue_operations.continuation.completed",
            source,
            actorType: "worker",
            actorId: context.worker.id,
            actorRef: `worker:${context.worker.id}`,
            targetType: "worker_run",
            targetId: workerRun.id,
            taskId: approval.taskId,
            workerRunId: workerRun.id,
            approvalRequestId: approval.id,
            eventId: event.id,
            objectId: approval.objectId,
            capabilityId: approval.capabilityId,
            risk: approval.risk,
            idempotencyKey: `${input.idempotencyKey}:payment_link_rejected_closed`,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workflowRunId: workflow.run.id,
              workflowState: workflow.run.state,
              action: "rejected",
              status: "payment_link_rejected_closed",
              nextAction: "stop_provider_payment_link_preparation",
              rejectedPaymentLinkPacket,
              rejectedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
          })
          .returning({ id: auditEvents.id });
        const [trace] = await tx
          .insert(evidence)
          .values({
            tenantId: context.worker.tenantId,
            kind: "trace",
            name: "Revenue payment-link rejection continuation",
            objectId: approval.objectId,
            taskId: approval.taskId,
            eventId: event.id,
            capabilityId: approval.capabilityId,
            actorType: "worker",
            actorId: context.worker.id,
            hash: traceHash(input.idempotencyKey, "payment_link_rejection_continuation"),
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              auditEventId: audit.id,
              action: "rejected",
              note: rejectionNote,
              originalOutput,
              approvalContinuation,
              rejectedPaymentLinkPacket,
              rejectedPaymentLinkHash,
              nextAction: "stop_provider_payment_link_preparation",
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
          })
          .returning({ id: evidence.id });
        const [rejectedPaymentLinkEvidence] = await tx
          .insert(evidence)
          .values({
            tenantId: context.worker.tenantId,
            kind: "draft",
            name: "Revenue rejected payment-link packet",
            objectId: approval.objectId,
            taskId: approval.taskId,
            eventId: event.id,
            capabilityId: approval.capabilityId,
            actorType: "worker",
            actorId: context.worker.id,
            hash: rejectedPaymentLinkHash,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              traceEvidenceId: trace.id,
              action: "rejected",
              note: rejectionNote,
              rejectedPaymentLinkPacket,
              rejectedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
          })
          .returning({ id: evidence.id });
        const [rejectedPaymentLinkDocument] = await tx
          .insert(documents)
          .values({
            tenantId: context.worker.tenantId,
            objectId: approval.objectId,
            workflowRunId: workflow.run.id,
            kind: "revenue_payment_link_rejected_packet",
            name: "Revenue rejected payment-link packet",
            state: "closed",
            sensitivity: approval.risk,
            hash: rejectedPaymentLinkHash,
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              eventId: event.id,
              traceEvidenceId: trace.id,
              rejectedPaymentLinkEvidenceId: rejectedPaymentLinkEvidence.id,
              rejectedPaymentLinkPacket,
              rejectedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: documents.id });
        const [rejectedPaymentLinkEvidencePacket] = await tx
          .insert(evidencePackets)
          .values({
            tenantId: context.worker.tenantId,
            documentId: rejectedPaymentLinkDocument.id,
            objectId: approval.objectId,
            taskId: approval.taskId,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            capabilityId: approval.capabilityId,
            kind: "revenue_payment_link_rejected_packet",
            name: "Revenue rejected payment-link packet",
            state: "closed",
            sensitivity: approval.risk,
            evidenceIds: { ids: [trace.id, rejectedPaymentLinkEvidence.id] },
            documentIds: { ids: [rejectedPaymentLinkDocument.id] },
            data: {
              approvalRequestId: approval.id,
              originalWorkerRunId: originalRun.id,
              workerRunId: workerRun.id,
              workflowRunId: workflow.run.id,
              eventId: event.id,
              rejectedPaymentLinkPacket,
              rejectedPaymentLinkHash,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            hash: rejectedPaymentLinkHash,
            createdAt: now,
            updatedAt: now,
          })
          .returning({ id: evidencePackets.id });
        const continuationLinks = {
          rejectedPaymentLinkEvidenceId: rejectedPaymentLinkEvidence.id,
          rejectedPaymentLinkDocumentId: rejectedPaymentLinkDocument.id,
          rejectedPaymentLinkEvidencePacketId: rejectedPaymentLinkEvidencePacket.id,
        };

        const [workflowStep] = await tx
          .insert(workflowSteps)
          .values({
            tenantId: context.worker.tenantId,
            definitionId: workflow.definition.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            approvalRequestId: approval.id,
            taskId: approval.taskId,
            objectId: approval.objectId,
            workerId: context.worker.id,
            capabilityId: approval.capabilityId,
            kind: "worker_continuation",
            name: `${workflow.definition.key}:payment_link_rejected_closed`,
            state: "done",
            priority: approval.priority,
            risk: approval.risk,
            fromState: workflow.run.state,
            toState: "rejected",
            attempt: 1,
            maxAttempts: 1,
            leaseOwner: `worker:${context.worker.id}`,
            leasedUntil: now,
            idempotencyKey: `${input.idempotencyKey}:payment_link_rejected_closed`,
            input: continuationInput,
            output: {
              approvalRequestId: approval.id,
              originalApprovalRequestId: approval.id,
              workerRunId: workerRun.id,
              originalWorkerRunId: originalRun.id,
              auditEventId: audit.id,
              evidenceId: trace.id,
              adapterRunId: adapterRunId || null,
              adapterActionId: adapterActionId || null,
              adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
              ...continuationLinks,
              rejectedPaymentLinkPacket,
              nextAction: "stop_provider_payment_link_preparation",
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
              requiresApproval: false,
            },
            startedAt: now,
            completedAt: now,
            updatedAt: now,
          })
          .returning({ id: workflowSteps.id });

        const output = {
          command: "continue",
          status: "payment_link_rejected_closed",
          approvalRequestId: approval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          eventId: event.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          reservationId: coreReservationId || null,
          usageEventId: null,
          paymentObjectId: paymentObjectId || null,
          paymentId: paymentId || null,
          paymentInstructionId: paymentInstructionId || null,
          invoiceId: uuidValue(rejectedPaymentLinkPacket.invoiceId) || null,
          invoiceObjectId: uuidValue(rejectedPaymentLinkPacket.invoiceObjectId) || null,
          quoteObjectId: uuidValue(rejectedPaymentLinkPacket.quoteObjectId) || null,
          amountCents: numberValue(rejectedPaymentLinkPacket.amountCents),
          currency: stringValue(rejectedPaymentLinkPacket.currency, "USD"),
          customerName: stringValue(rejectedPaymentLinkPacket.customerName, "Customer"),
          dueAt: stringValue(rejectedPaymentLinkPacket.dueAt) || null,
          adapterRunId: adapterRunId || null,
          adapterActionId: adapterActionId || null,
          adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
          ...continuationLinks,
          rejectedPaymentLinkPacket,
          rejectedPaymentLinkHash,
          nextAction: "stop_provider_payment_link_preparation",
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          providerPaymentLinkCreation: "blocked",
          moneyMovement: "blocked",
          requiresApproval: false,
        };
        const workflowData = objectValue(workflow.run.data);
        const rejectionContinuation = {
          ...output,
          note: rejectionNote,
          action: "rejected",
          continuedAt: now.toISOString(),
        };

        await tx
          .update(workflowRuns)
          .set({
            state: "rejected",
            data: {
              ...workflowData,
              paymentLinkRejectionContinuation: rejectionContinuation,
              lastWorkerContinuation: rejectionContinuation,
              workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
            },
            blockers: {
              ...objectValue(workflow.run.blockers),
              open: [],
            },
            completedAt: workflow.run.completedAt ?? now,
            updatedAt: now,
          })
          .where(eq(workflowRuns.id, workflow.run.id));

        if (approval.taskId) {
          const [task] = await tx
            .select({ outcome: tasks.outcome })
            .from(tasks)
            .where(and(eq(tasks.tenantId, context.worker.tenantId), eq(tasks.id, approval.taskId)))
            .limit(1);

          await tx
            .update(tasks)
            .set({
              state: "blocked",
              outcome: {
                ...objectValue(task?.outcome),
                status: "payment_link_rejected_closed",
                approvalRequestId: approval.id,
                rejectionContinuation,
                ...continuationLinks,
                rejectedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              updatedAt: now,
            })
            .where(eq(tasks.id, approval.taskId));
        }

        if (paymentObjectId) {
          await tx.update(objects).set({ state: "blocked", updatedAt: now }).where(eq(objects.id, paymentObjectId));
        }

        if (paymentId) {
          await tx.update(payments).set({ state: "blocked", updatedAt: now }).where(eq(payments.id, paymentId));
        }

        if (paymentInstructionId) {
          await tx
            .update(paymentInstructions)
            .set({ state: "blocked", updatedAt: now })
            .where(eq(paymentInstructions.id, paymentInstructionId));
        }

        await tx
          .update(workerRuns)
          .set({
            data: {
              ...objectValue(originalRun.data),
              output: {
                ...originalOutput,
                paymentLinkRejectionContinuation: rejectionContinuation,
                ...continuationLinks,
                rejectedPaymentLinkPacket,
                externalExecution: "blocked",
                externalMutation: false,
                externalSend: false,
                providerPaymentLinkCreation: "blocked",
                moneyMovement: "blocked",
              },
              lastWorkerContinuation: rejectionContinuation,
            },
            updatedAt: now,
          })
          .where(eq(workerRuns.id, originalRun.id));

        await tx
          .update(workerRuns)
          .set({
            eventId: event.id,
            updatedAt: now,
            data: {
              ...objectValue(workerRun.data),
              businessEventId: event.id,
              businessAuditEventId: audit.id,
              taskId: approval.taskId,
              originalWorkerRunId: originalRun.id,
              eventId: event.id,
              approvalRequestId: approval.id,
              auditEventId: audit.id,
              evidenceId: trace.id,
              workflowRunId: workflow.run.id,
              workflowStepId: workflowStep.id,
              reservationId: coreReservationId || null,
              usageEventId: null,
              pendingCompletion: {
                output,
              },
            },
          })
          .where(eq(workerRuns.id, workerRun.id));

        return {
          created: true as const,
          needsCompletion: true,
          workerRunId: workerRun.id,
          originalWorkerRunId: originalRun.id,
          eventId: event.id,
          taskId: approval.taskId,
          reservationId: coreReservationId || null,
          usageEventId: null,
          approvalRequestId: approval.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          output,
        };
      }

      const revisionNote = stringValue(approvalDecision.note, "Revision requested by operator.");
      const revisedPaymentLinkPacket = revisedPaymentLinkPacketFromOriginal({
        originalOutput,
        revisionNote,
        now,
        approvalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
      });
      const revisedPaymentLinkHash = hashObject(revisedPaymentLinkPacket);
      const paymentObjectId = uuidValue(revisedPaymentLinkPacket.paymentObjectId ?? approval.objectId);
      const paymentId = uuidValue(revisedPaymentLinkPacket.paymentId);
      const paymentInstructionId = uuidValue(revisedPaymentLinkPacket.paymentInstructionId);

      const [event] = await tx
        .insert(events)
        .values({
          tenantId: context.worker.tenantId,
          type: "worker.revenue_operations.payment_link_revision.prepared",
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          objectId: approval.objectId,
          taskId: approval.taskId,
          capabilityId: approval.capabilityId,
          connectionId: originalRun.connectionId ?? context.connectionId,
          idempotencyKey: input.idempotencyKey,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            action: "revision_requested",
            status: "revised_payment_link_packet_ready_for_owner_approval",
            note: revisionNote,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            nextAction: "owner_approval",
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
          occurredAt: now,
        })
        .returning({ id: events.id });
      const [audit] = await tx
        .insert(auditEvents)
        .values({
          tenantId: context.worker.tenantId,
          type: "worker.revenue_operations.continuation.completed",
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          targetType: "worker_run",
          targetId: workerRun.id,
          taskId: approval.taskId,
          workerRunId: workerRun.id,
          approvalRequestId: approval.id,
          eventId: event.id,
          objectId: approval.objectId,
          capabilityId: approval.capabilityId,
          risk: approval.risk,
          idempotencyKey: `${input.idempotencyKey}:payment_link_revision_continuation`,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workflowRunId: workflow.run.id,
            workflowState: workflow.run.state,
            action: "revision_requested",
            status: "revised_payment_link_packet_ready_for_owner_approval",
            nextAction: "owner_approval",
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
        })
        .returning({ id: auditEvents.id });
      const [trace] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "trace",
          name: "Revenue payment-link revision continuation",
          objectId: approval.objectId,
          taskId: approval.taskId,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: traceHash(input.idempotencyKey, "payment_link_revision_continuation"),
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            auditEventId: audit.id,
            action: "revision_requested",
            note: revisionNote,
            originalOutput,
            approvalContinuation,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            nextAction: "owner_approval",
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
        })
        .returning({ id: evidence.id });
      const [revisedPaymentLinkEvidence] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "draft",
          name: "Revenue revised payment-link packet",
          objectId: approval.objectId,
          taskId: approval.taskId,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: revisedPaymentLinkHash,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            traceEvidenceId: trace.id,
            action: "revision_requested",
            note: revisionNote,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
        })
        .returning({ id: evidence.id });
      const [revisedPaymentLinkDocument] = await tx
        .insert(documents)
        .values({
          tenantId: context.worker.tenantId,
          objectId: approval.objectId,
          workflowRunId: workflow.run.id,
          kind: "revenue_payment_link_revision_packet",
          name: "Revenue payment-link revision packet",
          state: "prepared",
          sensitivity: approval.risk,
          hash: revisedPaymentLinkHash,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            traceEvidenceId: trace.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: documents.id });
      const [revisedPaymentLinkEvidencePacket] = await tx
        .insert(evidencePackets)
        .values({
          tenantId: context.worker.tenantId,
          documentId: revisedPaymentLinkDocument.id,
          objectId: approval.objectId,
          taskId: approval.taskId,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          kind: "revenue_payment_link_revision_packet",
          name: "Revenue payment-link revision packet",
          state: "prepared",
          sensitivity: approval.risk,
          evidenceIds: { ids: [trace.id, revisedPaymentLinkEvidence.id] },
          documentIds: { ids: [revisedPaymentLinkDocument.id] },
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
          hash: revisedPaymentLinkHash,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: evidencePackets.id });
      const [revisionApproval] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: context.worker.tenantId,
          taskId: approval.taskId,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          objectId: approval.objectId,
          capabilityId: approval.capabilityId,
          requesterType: "worker",
          requesterId: context.worker.id,
          requesterRef: `worker:${context.worker.id}`,
          reviewerUserId: approval.reviewerUserId ?? operator.id,
          kind: "payment_link_approval",
          state: "pending",
          priority: approval.priority,
          risk: approval.risk,
          title: "Review revised payment-link packet",
          summary: "Revenue Worker prepared a revised payment-link packet for owner approval; provider creation and money movement remain blocked.",
          requestedAction: {
            action: "review_payment_link_packet",
            originalApprovalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
            revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
            paymentObjectId,
            paymentId,
            paymentInstructionId,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            revisedPaymentLinkPacket,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            currentMode: "dry_run",
          },
          evidence: {
            eventId: event.id,
            traceEvidenceId: trace.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
            revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
            originalApprovalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workflowRunId: workflow.run.id,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
          },
          policy: {
            ...objectValue(approval.policy),
            providerPaymentLinkCreation: "approval_required_but_currently_blocked",
            moneyMovement: "blocked",
            revisionOfApprovalRequestId: approval.id,
          },
          data: {
            originalApprovalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            auditEventId: audit.id,
            traceEvidenceId: trace.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
            revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            revisionNote,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
          },
        })
        .returning({ id: approvalRequests.id });
      const [revisionApprovalAudit] = await tx
        .insert(auditEvents)
        .values({
          tenantId: context.worker.tenantId,
          type: "approval.requested",
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          targetType: "approval_request",
          targetId: revisionApproval.id,
          taskId: approval.taskId,
          workerRunId: workerRun.id,
          approvalRequestId: revisionApproval.id,
          eventId: event.id,
          objectId: approval.objectId,
          capabilityId: approval.capabilityId,
          risk: approval.risk,
          idempotencyKey: `${input.idempotencyKey}:payment_link_approval_requested`,
          data: {
            originalApprovalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            reviewerUserId: approval.reviewerUserId ?? operator.id,
            operatorUserId: operator.id,
            workflowRunId: workflow.run.id,
            traceEvidenceId: trace.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
            revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
            revisedPaymentLinkHash,
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
          },
        })
        .returning({ id: auditEvents.id });
      const [workflowStep] = await tx
        .insert(workflowSteps)
        .values({
          tenantId: context.worker.tenantId,
          definitionId: workflow.definition.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          approvalRequestId: revisionApproval.id,
          taskId: approval.taskId,
          objectId: approval.objectId,
          workerId: context.worker.id,
          capabilityId: approval.capabilityId,
          kind: "worker_continuation",
          name: `${workflow.definition.key}:payment_link_revision_prepared`,
          state: "done",
          priority: approval.priority,
          risk: approval.risk,
          fromState: workflow.run.state,
          toState: "approval_requested",
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:payment_link_approval_requested`,
          input: continuationInput,
          output: {
            approvalRequestId: revisionApproval.id,
            originalApprovalRequestId: approval.id,
            revisionApprovalRequestId: revisionApproval.id,
            revisionApprovalAuditEventId: revisionApprovalAudit.id,
            workerRunId: workerRun.id,
            originalWorkerRunId: originalRun.id,
            auditEventId: audit.id,
            evidenceId: trace.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
            revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
            revisedPaymentLinkPacket,
            nextAction: "owner_approval",
            externalExecution: "blocked",
            externalMutation: false,
            externalSend: false,
            providerPaymentLinkCreation: "blocked",
            moneyMovement: "blocked",
            requiresApproval: true,
          },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .returning({ id: workflowSteps.id });

      const output = {
        command: "continue",
        status: "revised_payment_link_packet_ready_for_owner_approval",
        approvalRequestId: revisionApproval.id,
        originalApprovalRequestId: approval.id,
        revisionApprovalRequestId: revisionApproval.id,
        revisionApprovalAuditEventId: revisionApprovalAudit.id,
        originalWorkerRunId: originalRun.id,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
        workflowStepId: workflowStep.id,
        eventId: event.id,
        auditEventId: audit.id,
        evidenceId: trace.id,
        reservationId: coreReservationId || null,
        usageEventId: null,
        paymentObjectId: paymentObjectId || null,
        paymentId: paymentId || null,
        paymentInstructionId: paymentInstructionId || null,
        invoiceId: uuidValue(revisedPaymentLinkPacket.invoiceId) || null,
        invoiceObjectId: uuidValue(revisedPaymentLinkPacket.invoiceObjectId) || null,
        quoteObjectId: uuidValue(revisedPaymentLinkPacket.quoteObjectId) || null,
        amountCents: numberValue(revisedPaymentLinkPacket.amountCents),
        currency: stringValue(revisedPaymentLinkPacket.currency, "USD"),
        customerName: stringValue(revisedPaymentLinkPacket.customerName, "Customer"),
        dueAt: stringValue(revisedPaymentLinkPacket.dueAt) || null,
        revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
        revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
        revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
        revisedPaymentLinkPacket,
        revisedPaymentLinkHash,
        nextAction: "owner_approval",
        externalExecution: "blocked",
        externalMutation: false,
        externalSend: false,
        providerPaymentLinkCreation: "blocked",
        moneyMovement: "blocked",
        requiresApproval: true,
      };
      const workflowData = objectValue(workflow.run.data);
      const revisionContinuation = {
        ...output,
        note: revisionNote,
        action: "revision_requested",
        continuedAt: now.toISOString(),
      };

      await tx
        .update(workflowRuns)
        .set({
          state: "approval_requested",
          data: {
            ...workflowData,
            approvalRequestId: revisionApproval.id,
            originalApprovalRequestId: approval.id,
            revisionApprovalRequestId: revisionApproval.id,
            revisionApprovalAuditEventId: revisionApprovalAudit.id,
            revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
            revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
            revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
            revisedPaymentLinkPacket,
            revisedPaymentLinkHash,
            paymentLinkRevisionContinuation: revisionContinuation,
            lastWorkerContinuation: revisionContinuation,
            workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
          },
          blockers: {
            ...objectValue(workflow.run.blockers),
            open: [
              "owner_approval_required",
              "provider_payment_link_creation_blocked",
              "money_movement_blocked",
            ],
          },
          completedAt: null,
          updatedAt: now,
        })
        .where(eq(workflowRuns.id, workflow.run.id));

      if (approval.taskId) {
        const [task] = await tx
          .select({ outcome: tasks.outcome })
          .from(tasks)
          .where(and(eq(tasks.tenantId, context.worker.tenantId), eq(tasks.id, approval.taskId)))
          .limit(1);

        await tx
          .update(tasks)
          .set({
            state: "approval_required",
            outcome: {
              ...objectValue(task?.outcome),
              status: "revised_payment_link_packet_ready_for_owner_approval",
              approvalRequestId: revisionApproval.id,
              originalApprovalRequestId: approval.id,
              revisionApprovalRequestId: revisionApproval.id,
              revisionApprovalAuditEventId: revisionApprovalAudit.id,
              revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
              revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
              revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
              revisedPaymentLinkPacket,
              paymentLinkRevisionContinuation: revisionContinuation,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
            },
            updatedAt: now,
          })
          .where(eq(tasks.id, approval.taskId));
      }

      if (paymentObjectId) {
        await tx
          .update(objects)
          .set({ state: "approval_required", updatedAt: now })
          .where(eq(objects.id, paymentObjectId));
      }

      if (paymentId) {
        await tx
          .update(payments)
          .set({ state: "approval_required", updatedAt: now })
          .where(eq(payments.id, paymentId));
      }

      if (paymentInstructionId) {
        await tx
          .update(paymentInstructions)
          .set({ state: "approval_required", updatedAt: now })
          .where(eq(paymentInstructions.id, paymentInstructionId));
      }

      await tx
        .update(workerRuns)
        .set({
          data: {
            ...objectValue(originalRun.data),
            output: {
              ...originalOutput,
              paymentLinkRevisionContinuation: revisionContinuation,
              revisionApprovalRequestId: revisionApproval.id,
              revisedPaymentLinkEvidenceId: revisedPaymentLinkEvidence.id,
              revisedPaymentLinkDocumentId: revisedPaymentLinkDocument.id,
              revisedPaymentLinkEvidencePacketId: revisedPaymentLinkEvidencePacket.id,
              revisedPaymentLinkPacket,
              externalExecution: "blocked",
              externalMutation: false,
              externalSend: false,
              providerPaymentLinkCreation: "blocked",
              moneyMovement: "blocked",
            },
            lastWorkerContinuation: revisionContinuation,
          },
          updatedAt: now,
        })
        .where(eq(workerRuns.id, originalRun.id));

      await tx
        .update(workerRuns)
        .set({
          eventId: event.id,
          updatedAt: now,
          data: {
            ...objectValue(workerRun.data),
            businessEventId: event.id,
            businessAuditEventId: audit.id,
            taskId: approval.taskId,
            originalWorkerRunId: originalRun.id,
            eventId: event.id,
            approvalRequestId: revisionApproval.id,
            auditEventId: audit.id,
            evidenceId: trace.id,
            workflowRunId: workflow.run.id,
            workflowStepId: workflowStep.id,
            reservationId: coreReservationId || null,
            usageEventId: null,
            pendingCompletion: {
              output,
            },
          },
        })
        .where(eq(workerRuns.id, workerRun.id));

      return {
        created: true as const,
        needsCompletion: true,
        workerRunId: workerRun.id,
        originalWorkerRunId: originalRun.id,
        eventId: event.id,
        taskId: approval.taskId,
        reservationId: coreReservationId || null,
        usageEventId: null,
        approvalRequestId: revisionApproval.id,
        auditEventId: audit.id,
        evidenceId: trace.id,
        workflowRunId: workflow.run.id,
        workflowStepId: workflowStep.id,
        output,
      };
    }

    if (approval.state === "approved") {
      const approvalNote = stringValue(approvalDecision.note, "Approved by operator.");
      const continuationInput = {
        approvalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workflowRunId: workflow.run.id,
        workflowState: workflow.run.state,
        action: "approved",
        note: approvalNote,
        originalOutput,
        approvalContinuation,
      };

      const workerRun = run;
      const adapterRunId = uuidValue(approvalContinuation.adapterRunId ?? originalOutput.adapterRunId);
      const adapterActionId = uuidValue(
        approvalContinuation.adapterActionId ?? originalOutput.adapterActionId,
      );
      const adapterReceiptEvidenceId = uuidValue(
        approvalContinuation.adapterReceiptEvidenceId ?? originalOutput.adapterReceiptEvidenceId,
      );
      const controlledSendReceipt = await customerMessageExecutionReceiptFor({
        tx,
        tenantId: context.worker.tenantId,
        execution: requestedExecution,
        approvalId: approval.id,
        adapterRunId,
        adapterActionId,
        now,
      });
      const executionRecorded = Boolean(controlledSendReceipt);
      const controlledConnectionId = uuidValue(objectValue(controlledSendReceipt).connectionId);

      if (executionRecorded && !adapterActionId) {
        throw new RevenueWorkerUnavailableError(
          "worker_controlled_send_adapter_action_required",
          "Controlled customer-message execution requires a tenant-scoped adapter action target.",
          409,
        );
      }

      if (executionRecorded && !controlledConnectionId) {
        throw new RevenueWorkerUnavailableError(
          "worker_controlled_send_connection_required",
          "Controlled customer-message execution requires a tenant-scoped execution connection.",
          409,
        );
      }

      const controlledReceiptObject = objectValue(controlledSendReceipt);
      const controlledReceipt = objectValue(controlledReceiptObject.receipt);

      if (executionRecorded) {
        await tx
          .update(adapterActions)
          .set({
            state: "done",
            connectionId: controlledConnectionId,
            mode: "controlled_record",
            operation: "customer_message.send",
            reconciliationState: "matched",
            updatedAt: now,
          })
          .where(and(eq(adapterActions.tenantId, context.worker.tenantId), eq(adapterActions.id, adapterActionId)));

        if (adapterRunId) {
          await tx
            .update(adapterRuns)
            .set({
              state: "done",
              connectionId: controlledConnectionId,
              mode: "controlled_record",
              operation: "customer_message.send",
              reconciliationState: "matched",
              writeCount: 1,
            })
            .where(and(eq(adapterRuns.tenantId, context.worker.tenantId), eq(adapterRuns.id, adapterRunId)));
        }
      }

      const externalActionRecord = executionRecorded
        ? await recordExternalActionForOperator(
            tx,
            {
              tenantId: context.worker.tenantId,
              tenantSlug: context.worker.tenantSlug,
              userId: operator.id,
              email: operator.email,
              name: operator.name,
              actorRef: operator.actorRef,
            },
            {
              idempotencyKey: `${input.idempotencyKey}:customer_message_send`,
              targetType: "adapter_action",
              targetId: adapterActionId,
              kind: "customer_message.send",
              state: "done",
              connectionId: controlledConnectionId || undefined,
              adapterActionId,
              taskId: approval.taskId ?? undefined,
              capabilityId: approval.capabilityId ?? undefined,
              occurredAt:
                firstStringValue(
                  controlledReceipt.sentAt,
                  controlledReceipt.deliveredAt,
                  controlledReceiptObject.recordedAt,
                ) ?? now.toISOString(),
              receipt: {
                ...controlledReceipt,
                operation: controlledReceiptObject.operation,
                channel: controlledReceiptObject.channel,
                recipient: controlledReceiptObject.recipient,
                credential: controlledReceiptObject.credential,
                requiredScopes: controlledReceiptObject.requiredScopes,
                grantedScopes: controlledReceiptObject.grantedScopes,
                rollback: controlledReceiptObject.rollback,
                externalExecution: controlledReceiptObject.externalExecution,
                externalMutation: controlledReceiptObject.externalMutation,
                externalSend: controlledReceiptObject.externalSend,
                continuousExecuted: controlledReceiptObject.continuousExecuted,
              },
              response: {
                status: "recorded",
                executionBoundary: controlledReceiptObject.executionBoundary ?? "core.adapter_execution",
                externalExecution: controlledReceiptObject.externalExecution,
                externalMutation: controlledReceiptObject.externalMutation,
                externalSend: controlledReceiptObject.externalSend,
              },
              data: {
                schemaVersion: "worker.revenue_operations.customer_message_send_external_action.v1",
                approvalRequestId: approval.id,
                approvalKind: approval.kind,
                approvalState: approval.state,
                originalWorkerRunId: originalRun.id,
                workerRunId: workerRun.id,
                workflowRunId: workflow.run.id,
                adapterRunId: adapterRunId || null,
                adapterActionId,
                controlledSendReceipt,
              },
            },
          )
        : null;
      const executionStatus = executionRecorded
        ? "approved_execution_recorded"
        : "approved_execution_blocked";
      const executionEventType = executionRecorded
        ? "worker.revenue_operations.approved_execution.recorded"
        : "worker.revenue_operations.approved_execution.blocked";
      const executionAuditSuffix = executionRecorded
        ? "approved_execution_recorded"
        : "approved_execution_blocked";
      const nextAction = executionRecorded
        ? "reconcile_controlled_send_receipt"
        : "enable_scoped_adapter_execution";
      const externalExecution = executionRecorded ? "recorded" : "blocked";
      const externalSend = executionRecorded;
      const workflowToState = executionRecorded ? "execution_recorded" : "execution_blocked";
      const workflowStepName = executionRecorded
        ? `${workflow.definition.key}:approved_execution_recorded`
        : `${workflow.definition.key}:approved_execution_blocked`;
      const workflowStepKey = executionRecorded ? "execution_recorded" : "execution_blocked";
      const workflowBlockers = executionRecorded
        ? []
        : ["external_execution_blocked", "scoped_live_credentials_required"];
      const taskState = executionRecorded ? "done" : "waiting";
      const artifactState = executionRecorded ? "recorded" : "blocked";
      const adapterMode = executionRecorded ? "controlled_record" : "dry_run";
      const approvedExecutionPacket = approvedExecutionPacketFromOriginal({
        originalOutput,
        approvalNote,
        now,
        approvalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
        controlledSendReceipt,
      });
      const approvedExecutionHash = hashObject(approvedExecutionPacket);

      const [event] = await tx
        .insert(events)
        .values({
          tenantId: context.worker.tenantId,
          type: executionEventType,
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          objectId: approval.objectId,
          taskId: approval.taskId,
          capabilityId: approval.capabilityId,
          connectionId: originalRun.connectionId ?? context.connectionId,
          idempotencyKey: input.idempotencyKey,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            action: "approved",
            status: executionStatus,
            note: approvalNote,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            approvedExecutionPacket,
            approvedExecutionHash,
            controlledSendReceipt,
            externalActionRecord,
            nextAction,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
          occurredAt: now,
        })
        .returning({ id: events.id });
      const [audit] = await tx
        .insert(auditEvents)
        .values({
          tenantId: context.worker.tenantId,
          type: "worker.revenue_operations.continuation.completed",
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          targetType: "worker_run",
          targetId: workerRun.id,
          taskId: approval.taskId,
          workerRunId: workerRun.id,
          approvalRequestId: approval.id,
          eventId: event.id,
          objectId: approval.objectId,
          capabilityId: approval.capabilityId,
          risk: approval.risk,
          idempotencyKey: `${input.idempotencyKey}:${executionAuditSuffix}`,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workflowRunId: workflow.run.id,
            workflowState: workflow.run.state,
            action: "approved",
            status: executionStatus,
            nextAction,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            approvedExecutionPacket,
            approvedExecutionHash,
            controlledSendReceipt,
            externalActionRecord,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
        })
        .returning({ id: auditEvents.id });
      const [trace] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "trace",
          name: "Revenue Worker approved execution continuation",
          objectId: approval.objectId,
          taskId: approval.taskId,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: traceHash(input.idempotencyKey, "approved_execution_continuation"),
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            auditEventId: audit.id,
            action: "approved",
            note: approvalNote,
            originalOutput,
            approvalContinuation,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            approvedExecutionPacket,
            approvedExecutionHash,
            controlledSendReceipt,
            externalActionRecord,
            nextAction,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
        })
        .returning({ id: evidence.id });
      const [approvedExecutionEvidence] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "draft",
          name: "Revenue Worker approved execution packet",
          objectId: approval.objectId,
          taskId: approval.taskId,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: approvedExecutionHash,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            traceEvidenceId: trace.id,
            action: "approved",
            note: approvalNote,
            approvedExecutionPacket,
            approvedExecutionHash,
            controlledSendReceipt,
            externalActionRecord,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
        })
        .returning({ id: evidence.id });
      const [approvedExecutionDocument] = await tx
        .insert(documents)
        .values({
          tenantId: context.worker.tenantId,
          objectId: approval.objectId,
          workflowRunId: workflow.run.id,
          kind: "revenue_quote_approved_execution_packet",
          name: "Revenue quote approved execution packet",
          state: artifactState,
          sensitivity: approval.risk,
          hash: approvedExecutionHash,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            traceEvidenceId: trace.id,
            approvedExecutionEvidenceId: approvedExecutionEvidence.id,
            approvedExecutionPacket,
            approvedExecutionHash,
            controlledSendReceipt,
            externalActionRecord,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: documents.id });
      const [approvedEvidencePacket] = await tx
        .insert(evidencePackets)
        .values({
          tenantId: context.worker.tenantId,
          documentId: approvedExecutionDocument.id,
          objectId: approval.objectId,
          taskId: approval.taskId,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          kind: "revenue_quote_approved_execution_packet",
          name: "Revenue quote approved execution packet",
          state: artifactState,
          sensitivity: approval.risk,
          evidenceIds: { ids: [trace.id, approvedExecutionEvidence.id] },
          documentIds: { ids: [approvedExecutionDocument.id] },
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            approvedExecutionPacket,
            approvedExecutionHash,
            controlledSendReceipt,
            externalActionRecord,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
          hash: approvedExecutionHash,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: evidencePackets.id });
      const continuationLinks = {
        approvedExecutionEvidenceId: approvedExecutionEvidence.id,
        approvedExecutionDocumentId: approvedExecutionDocument.id,
        approvedEvidencePacketId: approvedEvidencePacket.id,
      };

      const [workflowStep] = await tx
        .insert(workflowSteps)
        .values({
          tenantId: context.worker.tenantId,
          definitionId: workflow.definition.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          taskId: approval.taskId,
          objectId: approval.objectId,
          workerId: context.worker.id,
          capabilityId: approval.capabilityId,
          kind: "worker_continuation",
          name: workflowStepName,
          state: "done",
          priority: approval.priority,
          risk: approval.risk,
          fromState: workflow.run.state,
          toState: workflowToState,
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:${workflowStepKey}`,
          input: continuationInput,
          output: {
            approvalRequestId: approval.id,
            originalApprovalRequestId: approval.id,
            workerRunId: workerRun.id,
            originalWorkerRunId: originalRun.id,
            auditEventId: audit.id,
            evidenceId: trace.id,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            ...continuationLinks,
            approvedExecutionPacket,
            controlledSendReceipt,
            externalActionRecord,
            nextAction,
            externalExecution,
            externalSend,
            requiresApproval: false,
          },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .returning({ id: workflowSteps.id });

      const output = {
        command: "continue",
        status: executionStatus,
        approvalRequestId: approval.id,
        originalApprovalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
        workflowStepId: workflowStep.id,
        eventId: event.id,
        auditEventId: audit.id,
        evidenceId: trace.id,
        reservationId: coreReservationId || null,
        usageEventId: null,
        adapterRunId: adapterRunId || null,
        adapterActionId: adapterActionId || null,
        adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
        ...continuationLinks,
        approvedExecutionPacket,
        approvedExecutionHash,
        controlledSendReceipt,
        externalActionRecord,
        nextAction,
        externalExecution,
        externalSend,
        requiresApproval: false,
      };
      const workflowData = objectValue(workflow.run.data);
      const approvedExecutionContinuation = {
        ...output,
        note: approvalNote,
        action: "approved",
        continuedAt: now.toISOString(),
      };

      await tx
        .update(workflowRuns)
        .set({
          state: workflowToState,
          data: {
            ...workflowData,
            approvedExecutionContinuation,
            lastWorkerContinuation: approvedExecutionContinuation,
            workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
          },
          blockers: {
            ...objectValue(workflow.run.blockers),
            open: workflowBlockers,
          },
          completedAt: executionRecorded ? now : null,
          updatedAt: now,
        })
        .where(eq(workflowRuns.id, workflow.run.id));

      if (approval.taskId) {
        const [task] = await tx
          .select({ outcome: tasks.outcome })
          .from(tasks)
          .where(and(eq(tasks.tenantId, context.worker.tenantId), eq(tasks.id, approval.taskId)))
          .limit(1);

        await tx
          .update(tasks)
          .set({
            state: taskState,
            outcome: {
              ...objectValue(task?.outcome),
              status: executionStatus,
              approvalRequestId: approval.id,
              approvedExecutionContinuation,
              ...continuationLinks,
              approvedExecutionPacket,
              controlledSendReceipt,
              externalActionRecord,
              externalExecution,
              externalSend,
            },
            updatedAt: now,
          })
          .where(eq(tasks.id, approval.taskId));
      }

      await tx
        .update(workerRuns)
        .set({
          data: {
            ...objectValue(originalRun.data),
            output: {
              ...originalOutput,
              approvedExecutionContinuation,
              ...continuationLinks,
              approvedExecutionPacket,
              controlledSendReceipt,
              externalActionRecord,
              externalExecution,
              externalSend,
            },
            lastWorkerContinuation: approvedExecutionContinuation,
          },
          updatedAt: now,
        })
        .where(eq(workerRuns.id, originalRun.id));

      if (adapterActionId) {
        const [adapterAction] = await tx
          .select({
            response: adapterActions.response,
            receipt: adapterActions.receipt,
          })
          .from(adapterActions)
          .where(and(eq(adapterActions.tenantId, context.worker.tenantId), eq(adapterActions.id, adapterActionId)))
          .limit(1);

        if (adapterAction) {
          await tx
            .update(adapterActions)
            .set({
              ...(executionRecorded
                ? {
                    state: "done" as const,
                    connectionId: controlledConnectionId,
                    mode: adapterMode,
                    operation: "customer_message.send",
                    reconciliationState: "matched",
                  }
                : {}),
              response: {
                ...adapterAction.response,
                approvedExecutionContinuation,
                approvedExecutionPacket,
                controlledSendReceipt,
                externalActionRecord,
                externalExecution,
                externalSend,
              },
              receipt: {
                ...adapterAction.receipt,
                approvedExecutionContinuation,
                controlledSendReceipt,
                externalActionRecord,
                externalMutation: executionRecorded,
                externalSend,
              },
            })
            .where(eq(adapterActions.id, adapterActionId));
        }
      }

      if (adapterRunId) {
        const [adapterRun] = await tx
          .select({
            data: adapterRuns.data,
            receipt: adapterRuns.receipt,
          })
          .from(adapterRuns)
          .where(and(eq(adapterRuns.tenantId, context.worker.tenantId), eq(adapterRuns.id, adapterRunId)))
          .limit(1);

        if (adapterRun) {
          await tx
            .update(adapterRuns)
            .set({
              ...(executionRecorded
                ? {
                    state: "done" as const,
                    connectionId: controlledConnectionId,
                    mode: adapterMode,
                    operation: "customer_message.send",
                    reconciliationState: "matched",
                    writeCount: 1,
                  }
                : {}),
              data: {
                ...adapterRun.data,
                approvedExecutionContinuation,
                controlledSendReceipt,
                externalActionRecord,
                externalExecution,
                externalSend,
              },
              receipt: {
                ...adapterRun.receipt,
                approvedExecutionContinuation,
                controlledSendReceipt,
                externalActionRecord,
                externalMutation: executionRecorded,
                externalSend,
              },
            })
            .where(eq(adapterRuns.id, adapterRunId));
        }
      }

      await tx
        .update(workerRuns)
        .set({
          eventId: event.id,
          updatedAt: now,
          data: {
            ...objectValue(workerRun.data),
            businessEventId: event.id,
            businessAuditEventId: audit.id,
            taskId: approval.taskId,
            originalWorkerRunId: originalRun.id,
            eventId: event.id,
            approvalRequestId: approval.id,
            auditEventId: audit.id,
            evidenceId: trace.id,
            workflowRunId: workflow.run.id,
            workflowStepId: workflowStep.id,
            reservationId: coreReservationId || null,
            usageEventId: null,
            pendingCompletion: {
              output,
            },
          },
        })
        .where(eq(workerRuns.id, workerRun.id));

      return {
        created: true as const,
        needsCompletion: true,
        workerRunId: workerRun.id,
        originalWorkerRunId: originalRun.id,
        eventId: event.id,
        taskId: approval.taskId,
        reservationId: coreReservationId || null,
        usageEventId: null,
        approvalRequestId: approval.id,
        auditEventId: audit.id,
        evidenceId: trace.id,
        workflowRunId: workflow.run.id,
        workflowStepId: workflowStep.id,
        output,
      };
    }

    if (approval.state === "rejected") {
      const rejectionNote = stringValue(approvalDecision.note, "Rejected by operator.");
      const continuationInput = {
        approvalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workflowRunId: workflow.run.id,
        workflowState: workflow.run.state,
        action: "rejected",
        note: rejectionNote,
        originalOutput,
        approvalContinuation,
      };

      const workerRun = run;
      const rejectedPacket = rejectedPacketFromOriginal({
        originalOutput,
        rejectionNote,
        now,
        approvalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
      });
      const rejectedPacketHash = hashObject(rejectedPacket);
      const adapterRunId = uuidValue(approvalContinuation.adapterRunId ?? originalOutput.adapterRunId);
      const adapterActionId = uuidValue(
        approvalContinuation.adapterActionId ?? originalOutput.adapterActionId,
      );
      const adapterReceiptEvidenceId = uuidValue(
        approvalContinuation.adapterReceiptEvidenceId ?? originalOutput.adapterReceiptEvidenceId,
      );

      const [event] = await tx
        .insert(events)
        .values({
          tenantId: context.worker.tenantId,
          type: "worker.revenue_operations.rejection.closed",
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          objectId: approval.objectId,
          taskId: approval.taskId,
          capabilityId: approval.capabilityId,
          connectionId: originalRun.connectionId ?? context.connectionId,
          idempotencyKey: input.idempotencyKey,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            action: "rejected",
            status: "rejected_closed",
            note: rejectionNote,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            rejectedPacket,
            rejectedPacketHash,
            nextAction: "stop_prepared_action",
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
          occurredAt: now,
        })
        .returning({ id: events.id });
      const [audit] = await tx
        .insert(auditEvents)
        .values({
          tenantId: context.worker.tenantId,
          type: "worker.revenue_operations.continuation.completed",
          source,
          actorType: "worker",
          actorId: context.worker.id,
          actorRef: `worker:${context.worker.id}`,
          targetType: "worker_run",
          targetId: workerRun.id,
          taskId: approval.taskId,
          workerRunId: workerRun.id,
          approvalRequestId: approval.id,
          eventId: event.id,
          objectId: approval.objectId,
          capabilityId: approval.capabilityId,
          risk: approval.risk,
          idempotencyKey: `${input.idempotencyKey}:rejected_closed`,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workflowRunId: workflow.run.id,
            workflowState: workflow.run.state,
            action: "rejected",
            status: "rejected_closed",
            nextAction: "stop_prepared_action",
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            rejectedPacket,
            rejectedPacketHash,
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
        })
        .returning({ id: auditEvents.id });
      const [trace] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "trace",
          name: "Revenue Worker rejection continuation",
          objectId: approval.objectId,
          taskId: approval.taskId,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: traceHash(input.idempotencyKey, "rejection_continuation"),
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            auditEventId: audit.id,
            action: "rejected",
            note: rejectionNote,
            originalOutput,
            approvalContinuation,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            rejectedPacket,
            rejectedPacketHash,
            nextAction: "stop_prepared_action",
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
        })
        .returning({ id: evidence.id });
      const [rejectedPacketEvidence] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          kind: "draft",
          name: "Revenue Worker rejected packet",
          objectId: approval.objectId,
          taskId: approval.taskId,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          actorType: "worker",
          actorId: context.worker.id,
          hash: rejectedPacketHash,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            traceEvidenceId: trace.id,
            action: "rejected",
            note: rejectionNote,
            rejectedPacket,
            rejectedPacketHash,
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
        })
        .returning({ id: evidence.id });
      const [rejectedPacketDocument] = await tx
        .insert(documents)
        .values({
          tenantId: context.worker.tenantId,
          objectId: approval.objectId,
          workflowRunId: workflow.run.id,
          kind: "revenue_quote_rejected_packet",
          name: "Revenue quote rejected packet",
          state: "closed",
          sensitivity: approval.risk,
          hash: rejectedPacketHash,
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            traceEvidenceId: trace.id,
            rejectedPacketEvidenceId: rejectedPacketEvidence.id,
            rejectedPacket,
            rejectedPacketHash,
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: documents.id });
      const [rejectedEvidencePacket] = await tx
        .insert(evidencePackets)
        .values({
          tenantId: context.worker.tenantId,
          documentId: rejectedPacketDocument.id,
          objectId: approval.objectId,
          taskId: approval.taskId,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          capabilityId: approval.capabilityId,
          kind: "revenue_quote_rejected_packet",
          name: "Revenue quote rejected packet",
          state: "closed",
          sensitivity: approval.risk,
          evidenceIds: { ids: [trace.id, rejectedPacketEvidence.id] },
          documentIds: { ids: [rejectedPacketDocument.id] },
          data: {
            approvalRequestId: approval.id,
            originalWorkerRunId: originalRun.id,
            workerRunId: workerRun.id,
            workflowRunId: workflow.run.id,
            eventId: event.id,
            rejectedPacket,
            rejectedPacketHash,
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
          hash: rejectedPacketHash,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: evidencePackets.id });
      const continuationLinks = {
        rejectedPacketEvidenceId: rejectedPacketEvidence.id,
        rejectedPacketDocumentId: rejectedPacketDocument.id,
        rejectedEvidencePacketId: rejectedEvidencePacket.id,
      };

      const [workflowStep] = await tx
        .insert(workflowSteps)
        .values({
          tenantId: context.worker.tenantId,
          definitionId: workflow.definition.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          taskId: approval.taskId,
          objectId: approval.objectId,
          workerId: context.worker.id,
          capabilityId: approval.capabilityId,
          kind: "worker_continuation",
          name: `${workflow.definition.key}:rejected_closed`,
          state: "done",
          priority: approval.priority,
          risk: approval.risk,
          fromState: workflow.run.state,
          toState: "rejected",
          attempt: 1,
          maxAttempts: 1,
          leaseOwner: `worker:${context.worker.id}`,
          leasedUntil: now,
          idempotencyKey: `${input.idempotencyKey}:rejected_closed`,
          input: continuationInput,
          output: {
            approvalRequestId: approval.id,
            originalApprovalRequestId: approval.id,
            workerRunId: workerRun.id,
            originalWorkerRunId: originalRun.id,
            auditEventId: audit.id,
            evidenceId: trace.id,
            adapterRunId: adapterRunId || null,
            adapterActionId: adapterActionId || null,
            adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
            ...continuationLinks,
            rejectedPacket,
            nextAction: "stop_prepared_action",
            externalExecution: "blocked",
            externalSend: false,
            requiresApproval: false,
          },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        })
        .returning({ id: workflowSteps.id });

      const output = {
        command: "continue",
        status: "rejected_closed",
        approvalRequestId: approval.id,
        originalApprovalRequestId: approval.id,
        originalWorkerRunId: originalRun.id,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
        workflowStepId: workflowStep.id,
        eventId: event.id,
        auditEventId: audit.id,
        evidenceId: trace.id,
        reservationId: coreReservationId || null,
        usageEventId: null,
        adapterRunId: adapterRunId || null,
        adapterActionId: adapterActionId || null,
        adapterReceiptEvidenceId: adapterReceiptEvidenceId || null,
        ...continuationLinks,
        rejectedPacket,
        rejectedPacketHash,
        nextAction: "stop_prepared_action",
        externalExecution: "blocked",
        externalSend: false,
        requiresApproval: false,
      };
      const workflowData = objectValue(workflow.run.data);
      const rejectionContinuation = {
        ...output,
        note: rejectionNote,
        action: "rejected",
        continuedAt: now.toISOString(),
      };

      await tx
        .update(workflowRuns)
        .set({
          state: "rejected",
          data: {
            ...workflowData,
            rejectionContinuation,
            lastWorkerContinuation: rejectionContinuation,
            workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
          },
          blockers: {
            ...objectValue(workflow.run.blockers),
            open: [],
          },
          completedAt: workflow.run.completedAt ?? now,
          updatedAt: now,
        })
        .where(eq(workflowRuns.id, workflow.run.id));

      if (approval.taskId) {
        const [task] = await tx
          .select({ outcome: tasks.outcome })
          .from(tasks)
          .where(and(eq(tasks.tenantId, context.worker.tenantId), eq(tasks.id, approval.taskId)))
          .limit(1);

        await tx
          .update(tasks)
          .set({
            state: "blocked",
            outcome: {
              ...objectValue(task?.outcome),
              status: "rejected_closed",
              approvalRequestId: approval.id,
              rejectionContinuation,
              ...continuationLinks,
              rejectedPacket,
              externalExecution: "blocked",
              externalSend: false,
            },
            updatedAt: now,
          })
          .where(eq(tasks.id, approval.taskId));
      }

      await tx
        .update(workerRuns)
        .set({
          data: {
            ...objectValue(originalRun.data),
            output: {
              ...originalOutput,
              rejectionContinuation,
              ...continuationLinks,
              rejectedPacket,
              externalExecution: "blocked",
              externalSend: false,
            },
            lastWorkerContinuation: rejectionContinuation,
          },
          updatedAt: now,
        })
        .where(eq(workerRuns.id, originalRun.id));

      if (adapterActionId) {
        const [adapterAction] = await tx
          .select({
            response: adapterActions.response,
            receipt: adapterActions.receipt,
          })
          .from(adapterActions)
          .where(and(eq(adapterActions.tenantId, context.worker.tenantId), eq(adapterActions.id, adapterActionId)))
          .limit(1);

        if (adapterAction) {
          await tx
            .update(adapterActions)
            .set({
              response: {
                ...adapterAction.response,
                rejectionContinuation,
                rejectedPacket,
                externalExecution: "blocked",
                externalSend: false,
              },
              receipt: {
                ...adapterAction.receipt,
                rejectionContinuation,
                externalMutation: false,
                externalSend: false,
              },
            })
            .where(eq(adapterActions.id, adapterActionId));
        }
      }

      if (adapterRunId) {
        const [adapterRun] = await tx
          .select({
            data: adapterRuns.data,
            receipt: adapterRuns.receipt,
          })
          .from(adapterRuns)
          .where(and(eq(adapterRuns.tenantId, context.worker.tenantId), eq(adapterRuns.id, adapterRunId)))
          .limit(1);

        if (adapterRun) {
          await tx
            .update(adapterRuns)
            .set({
              data: {
                ...adapterRun.data,
                rejectionContinuation,
                externalExecution: "blocked",
                externalSend: false,
              },
              receipt: {
                ...adapterRun.receipt,
                rejectionContinuation,
                externalMutation: false,
                externalSend: false,
              },
            })
            .where(eq(adapterRuns.id, adapterRunId));
        }
      }

      await tx
        .update(workerRuns)
        .set({
          eventId: event.id,
          updatedAt: now,
          data: {
            ...objectValue(workerRun.data),
            businessEventId: event.id,
            businessAuditEventId: audit.id,
            taskId: approval.taskId,
            originalWorkerRunId: originalRun.id,
            eventId: event.id,
            approvalRequestId: approval.id,
            auditEventId: audit.id,
            evidenceId: trace.id,
            workflowRunId: workflow.run.id,
            workflowStepId: workflowStep.id,
            reservationId: coreReservationId || null,
            usageEventId: null,
            pendingCompletion: {
              output,
            },
          },
        })
        .where(eq(workerRuns.id, workerRun.id));

      return {
        created: true as const,
        needsCompletion: true,
        workerRunId: workerRun.id,
        originalWorkerRunId: originalRun.id,
        eventId: event.id,
        taskId: approval.taskId,
        reservationId: coreReservationId || null,
        usageEventId: null,
        approvalRequestId: approval.id,
        auditEventId: audit.id,
        evidenceId: trace.id,
        workflowRunId: workflow.run.id,
        workflowStepId: workflowStep.id,
        output,
      };
    }

    const revisionNote = stringValue(approvalDecision.note, "Revision requested by operator.");
    const continuationInput = {
      approvalRequestId: approval.id,
      originalWorkerRunId: originalRun.id,
      workflowRunId: workflow.run.id,
      workflowState: workflow.run.state,
      action: "revision_requested",
      note: revisionNote,
      originalOutput,
      approvalContinuation,
    };

    const workerRun = run;
    const revisedPacket = revisedPacketFromOriginal({
      originalOutput,
      revisionNote,
      now,
      approvalRequestId: approval.id,
      originalWorkerRunId: originalRun.id,
      workerRunId: workerRun.id,
      workflowRunId: workflow.run.id,
    });
    const revisedPacketHash = hashObject(revisedPacket);

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.revenue_operations.revision.prepared",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: approval.objectId,
        taskId: approval.taskId,
        capabilityId: approval.capabilityId,
        connectionId: originalRun.connectionId ?? context.connectionId,
        idempotencyKey: input.idempotencyKey,
        data: {
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          action: "revision_requested",
          status: "revised_packet_ready_for_owner_approval",
          note: revisionNote,
          revisedPacket,
          revisedPacketHash,
          nextAction: "owner_approval",
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.revenue_operations.continuation.completed",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "worker_run",
        targetId: workerRun.id,
        taskId: approval.taskId,
        workerRunId: workerRun.id,
        approvalRequestId: approval.id,
        eventId: event.id,
        objectId: approval.objectId,
        capabilityId: approval.capabilityId,
        risk: approval.risk,
        idempotencyKey: `${input.idempotencyKey}:revision_continuation`,
        data: {
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workflowRunId: workflow.run.id,
          workflowState: workflow.run.state,
          action: "revision_requested",
          status: "revised_packet_ready_for_owner_approval",
          nextAction: "owner_approval",
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .returning({ id: auditEvents.id });

    const [trace] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Revenue Worker revision continuation",
        objectId: approval.objectId,
        taskId: approval.taskId,
        eventId: event.id,
        capabilityId: approval.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "revision_continuation"),
        data: {
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          auditEventId: audit.id,
          action: "revision_requested",
          note: revisionNote,
          originalOutput,
          approvalContinuation,
          revisedPacket,
          revisedPacketHash,
          nextAction: "owner_approval",
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .returning({ id: evidence.id });
    const [revisedPacketEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "draft",
        name: "Revenue Worker revised packet",
        objectId: approval.objectId,
        taskId: approval.taskId,
        eventId: event.id,
        capabilityId: approval.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: revisedPacketHash,
        data: {
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          traceEvidenceId: trace.id,
          action: "revision_requested",
          note: revisionNote,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .returning({ id: evidence.id });
    const [revisedPacketDocument] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: approval.objectId,
        workflowRunId: workflow.run.id,
        kind: "revenue_quote_revision_packet",
        name: "Revenue quote revision packet",
        state: "prepared",
        sensitivity: approval.risk,
        hash: revisedPacketHash,
        data: {
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          traceEvidenceId: trace.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });
    const [revisedEvidencePacket] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: revisedPacketDocument.id,
        objectId: approval.objectId,
        taskId: approval.taskId,
        workflowRunId: workflow.run.id,
        eventId: event.id,
        capabilityId: approval.capabilityId,
        kind: "revenue_quote_revision_packet",
        name: "Revenue quote revision packet",
        state: "prepared",
        sensitivity: approval.risk,
        evidenceIds: { ids: [trace.id, revisedPacketEvidence.id] },
        documentIds: { ids: [revisedPacketDocument.id] },
        data: {
          approvalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
        hash: revisedPacketHash,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });
    const revisedQuote = objectValue(revisedPacket.quote);
    const revision = objectValue(revisedPacket.revision);
    const [revisionApproval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        taskId: approval.taskId,
        workerRunId: workerRun.id,
        workflowRunId: workflow.run.id,
        eventId: event.id,
        objectId: approval.objectId,
        capabilityId: approval.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: approval.reviewerUserId ?? operator.id,
        kind: "quote_revision_approval",
        state: "pending",
        priority: approval.priority,
        risk: approval.risk,
        title: "Review revised quote packet",
        summary: `Revenue Worker prepared revision ${numberValue(revision.number)} of the quote packet for owner approval; external send remains blocked.`,
        requestedAction: {
          action: "review_revised_packet",
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacketDocumentId: revisedPacketDocument.id,
          revisedEvidencePacketId: revisedEvidencePacket.id,
          revisedPacket,
          quote: revisedQuote,
          externalSend: false,
          currentMode: "dry_run",
        },
        evidence: {
          eventId: event.id,
          traceEvidenceId: trace.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacketDocumentId: revisedPacketDocument.id,
          revisedEvidencePacketId: revisedEvidencePacket.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workflowRunId: workflow.run.id,
        },
        policy: {
          ...objectValue(approval.policy),
          externalSend: "approval_required",
          moneyMovement: "blocked",
          revisionOfApprovalRequestId: approval.id,
        },
        data: {
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          auditEventId: audit.id,
          traceEvidenceId: trace.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacketDocumentId: revisedPacketDocument.id,
          revisedEvidencePacketId: revisedEvidencePacket.id,
          revisionNote,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
        },
      })
      .returning({ id: approvalRequests.id });
    const [revisionApprovalAudit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "approval.requested",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "approval_request",
        targetId: revisionApproval.id,
        taskId: approval.taskId,
        workerRunId: workerRun.id,
        approvalRequestId: revisionApproval.id,
        eventId: event.id,
        objectId: approval.objectId,
        capabilityId: approval.capabilityId,
        risk: approval.risk,
        idempotencyKey: `${input.idempotencyKey}:revision_approval_requested`,
        data: {
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          reviewerUserId: approval.reviewerUserId ?? operator.id,
          operatorUserId: operator.id,
          workflowRunId: workflow.run.id,
          traceEvidenceId: trace.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacketDocumentId: revisedPacketDocument.id,
          revisedEvidencePacketId: revisedEvidencePacket.id,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
        },
      })
      .returning({ id: auditEvents.id });
    const continuationLinks = {
      revisionApprovalRequestId: revisionApproval.id,
      revisionApprovalAuditEventId: revisionApprovalAudit.id,
      revisedPacketEvidenceId: revisedPacketEvidence.id,
      revisedPacketDocumentId: revisedPacketDocument.id,
      revisedEvidencePacketId: revisedEvidencePacket.id,
    };

    await tx
      .update(evidence)
      .set({
        data: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          traceEvidenceId: trace.id,
          action: "revision_requested",
          note: revisionNote,
          ...continuationLinks,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .where(eq(evidence.id, revisedPacketEvidence.id));
    await tx
      .update(documents)
      .set({
        data: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          traceEvidenceId: trace.id,
          ...continuationLinks,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
        updatedAt: now,
      })
      .where(eq(documents.id, revisedPacketDocument.id));
    await tx
      .update(evidencePackets)
      .set({
        data: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          eventId: event.id,
          ...continuationLinks,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
        updatedAt: now,
      })
      .where(eq(evidencePackets.id, revisedEvidencePacket.id));

    await tx
      .update(events)
      .set({
        data: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          action: "revision_requested",
          status: "revised_packet_ready_for_owner_approval",
          note: revisionNote,
          ...continuationLinks,
          revisedPacket,
          revisedPacketHash,
          nextAction: "owner_approval",
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .where(eq(events.id, event.id));
    await tx
      .update(auditEvents)
      .set({
        data: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workflowRunId: workflow.run.id,
          workflowState: workflow.run.state,
          action: "revision_requested",
          status: "revised_packet_ready_for_owner_approval",
          nextAction: "owner_approval",
          ...continuationLinks,
          revisedPacket,
          revisedPacketHash,
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .where(eq(auditEvents.id, audit.id));
    await tx
      .update(evidence)
      .set({
        data: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          originalWorkerRunId: originalRun.id,
          workerRunId: workerRun.id,
          workflowRunId: workflow.run.id,
          auditEventId: audit.id,
          action: "revision_requested",
          note: revisionNote,
          originalOutput,
          approvalContinuation,
          ...continuationLinks,
          revisedPacket,
          revisedPacketHash,
          nextAction: "owner_approval",
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
      })
      .where(eq(evidence.id, trace.id));

    const [workflowStep] = await tx
      .insert(workflowSteps)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: workflow.definition.id,
        workflowRunId: workflow.run.id,
        eventId: event.id,
        approvalRequestId: revisionApproval.id,
        taskId: approval.taskId,
        objectId: approval.objectId,
        workerId: context.worker.id,
        capabilityId: approval.capabilityId,
        kind: "worker_continuation",
        name: `${workflow.definition.key}:revision_prepared`,
        state: "done",
        priority: approval.priority,
        risk: approval.risk,
        fromState: workflow.run.state,
        toState: "approval_requested",
        attempt: 1,
        maxAttempts: 1,
        leaseOwner: `worker:${context.worker.id}`,
        leasedUntil: now,
        idempotencyKey: `${input.idempotencyKey}:approval_requested`,
        input: continuationInput,
        output: {
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          revisionApprovalRequestId: revisionApproval.id,
          revisionApprovalAuditEventId: revisionApprovalAudit.id,
          workerRunId: workerRun.id,
          originalWorkerRunId: originalRun.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacketDocumentId: revisedPacketDocument.id,
          revisedEvidencePacketId: revisedEvidencePacket.id,
          revisedPacket,
          nextAction: "owner_approval",
          externalExecution: "blocked",
          externalSend: false,
          requiresApproval: true,
        },
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowSteps.id });

    const output = {
      command: "continue",
      status: "revised_packet_ready_for_owner_approval",
      approvalRequestId: revisionApproval.id,
      originalApprovalRequestId: approval.id,
      revisionApprovalRequestId: revisionApproval.id,
      revisionApprovalAuditEventId: revisionApprovalAudit.id,
      originalWorkerRunId: originalRun.id,
      workerRunId: workerRun.id,
      workflowRunId: workflow.run.id,
      workflowStepId: workflowStep.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: trace.id,
      reservationId: coreReservationId || null,
      usageEventId: null,
      revisedPacketEvidenceId: revisedPacketEvidence.id,
      revisedPacketDocumentId: revisedPacketDocument.id,
      revisedEvidencePacketId: revisedEvidencePacket.id,
      revisedPacket,
      revisedPacketHash,
      nextAction: "owner_approval",
      externalExecution: "blocked",
      externalSend: false,
      requiresApproval: true,
    };
    const workflowData = objectValue(workflow.run.data);
    const revisionContinuation = {
      ...output,
      note: revisionNote,
      action: "revision_requested",
      continuedAt: now.toISOString(),
    };

    await tx
      .update(workflowRuns)
      .set({
        state: "approval_requested",
        data: {
          ...workflowData,
          approvalRequestId: revisionApproval.id,
          originalApprovalRequestId: approval.id,
          revisionApprovalRequestId: revisionApproval.id,
          revisionApprovalAuditEventId: revisionApprovalAudit.id,
          revisedPacketEvidenceId: revisedPacketEvidence.id,
          revisedPacketDocumentId: revisedPacketDocument.id,
          revisedEvidencePacketId: revisedEvidencePacket.id,
          revisedPacket,
          revisedPacketHash,
          revisionContinuation,
          lastWorkerContinuation: revisionContinuation,
          workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
        },
        blockers: {
          ...objectValue(workflow.run.blockers),
          open: ["owner_approval_required", "external_execution_blocked"],
        },
        completedAt: null,
        updatedAt: now,
      })
      .where(eq(workflowRuns.id, workflow.run.id));

    if (approval.taskId) {
      const [task] = await tx
        .select({ outcome: tasks.outcome })
        .from(tasks)
        .where(and(eq(tasks.tenantId, context.worker.tenantId), eq(tasks.id, approval.taskId)))
        .limit(1);

      await tx
        .update(tasks)
        .set({
          state: "approval_required",
          outcome: {
            ...objectValue(task?.outcome),
            status: "revised_packet_ready_for_owner_approval",
            approvalRequestId: revisionApproval.id,
            originalApprovalRequestId: approval.id,
            revisionApprovalRequestId: revisionApproval.id,
            revisionApprovalAuditEventId: revisionApprovalAudit.id,
            revisedPacketEvidenceId: revisedPacketEvidence.id,
            revisedPacketDocumentId: revisedPacketDocument.id,
            revisedEvidencePacketId: revisedEvidencePacket.id,
            revisedPacket,
            revisionContinuation,
            externalExecution: "blocked",
            externalSend: false,
          },
          updatedAt: now,
        })
        .where(eq(tasks.id, approval.taskId));
    }

    await tx
      .update(workerRuns)
      .set({
        data: {
          ...objectValue(originalRun.data),
          output: {
            ...originalOutput,
            revisionContinuation,
            revisionApprovalRequestId: revisionApproval.id,
            revisedPacketEvidenceId: revisedPacketEvidence.id,
            revisedPacketDocumentId: revisedPacketDocument.id,
            revisedEvidencePacketId: revisedEvidencePacket.id,
            revisedPacket,
            externalExecution: "blocked",
            externalSend: false,
          },
          lastWorkerContinuation: revisionContinuation,
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, originalRun.id));

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        updatedAt: now,
        data: {
          ...objectValue(workerRun.data),
          businessEventId: event.id,
          businessAuditEventId: audit.id,
          taskId: approval.taskId,
          originalWorkerRunId: originalRun.id,
          eventId: event.id,
          approvalRequestId: revisionApproval.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          workflowRunId: workflow.run.id,
          workflowStepId: workflowStep.id,
          reservationId: coreReservationId || null,
          usageEventId: null,
          pendingCompletion: {
            output,
          },
        },
      })
      .where(eq(workerRuns.id, workerRun.id));

    return {
      created: true as const,
      needsCompletion: true,
      workerRunId: workerRun.id,
      originalWorkerRunId: originalRun.id,
      eventId: event.id,
      taskId: approval.taskId,
      reservationId: coreReservationId || null,
      usageEventId: null,
      approvalRequestId: revisionApproval.id,
      auditEventId: audit.id,
      evidenceId: trace.id,
      workflowRunId: workflow.run.id,
      workflowStepId: workflowStep.id,
      output,
    };
  });

  const completion = result.needsCompletion
    ? await completeCoreWorkerRun({
        operatorEmail: input.operatorEmail,
        tenantSlug: context.worker.tenantSlug,
        idempotencyKey: input.idempotencyKey,
        worker: {
          id: context.worker.id,
          role: revenueWorkerRole,
        },
        workerRunId: result.workerRunId,
        state: "done",
        reason: "Revenue Worker continued an owner approval decision with external execution controlled.",
        output: result.output,
        costUsd: 0,
        evidence: {
          command: "continue",
          eventId: result.eventId,
          auditEventId: result.auditEventId,
          evidenceId: result.evidenceId,
          approvalRequestId: result.approvalRequestId,
          originalWorkerRunId: result.originalWorkerRunId,
          workflowRunId: result.workflowRunId,
          workflowStepId: result.workflowStepId,
          externalExecution: objectValue(result.output).externalExecution ?? "blocked",
          externalSend: booleanValue(objectValue(result.output).externalSend),
        },
        db,
      })
    : null;
  const completionBudget = objectValue(completion?.budget);
  const settledReservationId = stringValue(completionBudget.reservationId) || result.reservationId;
  const settledUsageEventId = stringValue(completionBudget.usageEventId) || result.usageEventId;
  const settledOutput = {
    ...result.output,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
  };

  return {
    idempotencyKey: input.idempotencyKey,
    created: result.created,
    workerRunId: result.workerRunId,
    originalWorkerRunId: result.originalWorkerRunId,
    eventId: result.eventId,
    taskId: result.taskId,
    reservationId: settledReservationId,
    usageEventId: settledUsageEventId,
    approvalRequestId: result.approvalRequestId,
    auditEventId: result.auditEventId,
    evidenceId: result.evidenceId,
    workflowRunId: result.workflowRunId,
    workflowStepId: result.workflowStepId,
    output: settledOutput,
    snapshot: await getRevenueWorkerSnapshot(db, selector),
  };
}
