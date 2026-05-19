import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  approvalRequests,
  auditEvents,
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
  objects,
  objectVersions,
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

type Database = typeof defaultDb;

const revenueWorkerRole = "revenue_operations";
const revenueWorkflowKey = "lead_to_cash";
const source = "continuous.revenue_worker";
const runUnits = 12000;
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
  auditEventId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
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
  approvalRequestId: string | null;
  auditEventId: string | null;
  evidenceId: string | null;
  workflowRunId: string | null;
  workflowStepId: string | null;
  output: JsonObject;
  snapshot: RevenueWorkerSnapshot;
};

type TaskPriority = "low" | "normal" | "high" | "urgent";

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
    triggerEventId: string | null;
    capabilityId: string | null;
    priority: TaskPriority;
    reviewerUserId: string | null;
  } | null;
  quoteCapabilityId: string | null;
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
  const value = nested?.[key] ?? data[key];
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function outputData(data: JsonObject) {
  return objectValue(data.output);
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

  if (text.includes("roof") || text.includes("leak")) {
    return 24900;
  }

  if (text.includes("gutter")) {
    return 12900;
  }

  if (text.includes("window")) {
    return 18900;
  }

  if (text.includes("hvac") || text.includes("heat") || text.includes("air")) {
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
  const hasExplicitCoreIntake = Boolean(explicitEvidenceId || explicitEventId || explicitObjectId);

  if (hasDirectLeadPayload && hasExplicitCoreIntake) {
    throw new RevenueWorkerUnavailableError(
      "worker_intake_conflict",
      "config.intake Core references cannot be combined with config.leadPacket or config.lead; send one authoritative intake source.",
      400,
    );
  }

  if (hasDirectLeadPayload) {
    return { config, intake: {} as JsonObject };
  }

  const requestedEvidenceId = uuidValue(
    explicitEvidenceId || fallback.evidenceId,
  );
  const requestedEventId = uuidValue(explicitEventId || fallback.eventId);
  const requestedObjectId = uuidValue(explicitObjectId || fallback.objectId);

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
      mode: "core_read",
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
        id: workerRuns.id,
        eventId: workerRuns.eventId,
        idempotencyKey: workerRuns.idempotencyKey,
        state: workerRuns.state,
        mode: workerRuns.mode,
        startedAt: workerRuns.startedAt,
      })
      .from(workerRuns)
      .where(and(eq(workerRuns.tenantId, workerRow.tenantId), eq(workerRuns.workerId, workerRow.id)))
      .orderBy(desc(workerRuns.startedAt))
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

export async function runRevenueWorker(input: {
  idempotencyKey: string;
  operatorEmail: string;
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}): Promise<RevenueWorkerRunResult> {
  const db = input.db ?? defaultDb;
  const selector: RevenueWorkerSelector = {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  };
  const context = await loadWorkerContext(db, selector);
  const operator = await loadOperator(db, context.worker.tenantId, input.operatorEmail);
  const task = context.task;
  const capabilityId = task?.capabilityId ?? context.quoteCapabilityId ?? context.briefCapabilityId;

  if (!capabilityId) {
    throw new RevenueWorkerUnavailableError(
      "worker_capability_missing",
      "Revenue Worker has no capability for the selected run.",
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
  const runObjectId = task?.objectId ?? sourceObjectId;
  const inputHash = hashObject({
    schemaVersion: "revenue_worker.lead_packet.v1",
    mode: "simulation",
    idempotencyKey: input.idempotencyKey,
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    operatorUserId: operator.id,
    requestConfig,
    config,
    ...intakeTrace,
    leadPacket: leadPacket.sourceSnapshot,
  });

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${source}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select({
        id: workerRuns.id,
        mode: workerRuns.mode,
        taskId: workerRuns.taskId,
        eventId: workerRuns.eventId,
        data: workerRuns.data,
      })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, source),
          eq(workerRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      const storedInput = objectValue(existingRun.data.input);
      const storedHash = stringValue(storedInput.inputHash);

      if (existingRun.mode !== "simulation") {
        throw new RevenueWorkerUnavailableError(
          "worker_idempotency_conflict",
          "This idempotency key was already used with a different worker command.",
          409,
        );
      }

      if (storedHash && storedHash !== inputHash) {
        throw new RevenueWorkerUnavailableError(
          "worker_idempotency_conflict",
          "This idempotency key was already used with different worker input.",
          409,
        );
      }

      const output = outputData(existingRun.data);

      return {
        created: false as const,
        workerRunId: existingRun.id,
        eventId: existingRun.eventId ?? stringData(existingRun.data, "eventId"),
        taskId: stringData(existingRun.data, "taskId") ?? existingRun.taskId,
        sourceSnapshotEvidenceId: stringData(existingRun.data, "sourceSnapshotEvidenceId"),
        evidenceId: stringData(existingRun.data, "evidenceId"),
        reservationId: stringData(existingRun.data, "reservationId"),
        inferenceId: stringData(existingRun.data, "inferenceId"),
        usageEventId: stringData(existingRun.data, "usageEventId"),
        adapterRunId: stringData(existingRun.data, "adapterRunId"),
        adapterActionId: stringData(existingRun.data, "adapterActionId"),
        adapterReceiptEvidenceId: stringData(existingRun.data, "adapterReceiptEvidenceId"),
        approvalRequestId: stringData(existingRun.data, "approvalRequestId"),
        auditEventId: stringData(existingRun.data, "auditEventId"),
        workflowRunId: stringData(existingRun.data, "workflowRunId"),
        workflowStepIds: getWorkflowStepIds(existingRun.data),
        output,
      };
    }

    const [existingEvent] = await tx
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

    if (existingEvent) {
      const output = outputData(existingEvent.data);
      const eventOutput = {
        eventId: existingEvent.id,
        taskId: existingEvent.taskId ?? null,
        intake: objectValue(output.intake ?? existingEvent.data.intake),
        sourceObjectId: stringData(existingEvent.data, "sourceObjectId"),
        sourceEventRowId: stringData(existingEvent.data, "sourceEventRowId"),
        sourceEvidenceId: stringData(existingEvent.data, "sourceEvidenceId"),
        sourceSnapshotEvidenceId: stringData(existingEvent.data, "sourceSnapshotEvidenceId"),
        evidenceId: stringData(existingEvent.data, "evidenceId"),
        reservationId: stringData(existingEvent.data, "reservationId"),
        inferenceId: stringData(existingEvent.data, "inferenceId"),
        usageEventId: stringData(existingEvent.data, "usageEventId"),
        adapterRunId: stringData(existingEvent.data, "adapterRunId"),
        adapterActionId: stringData(existingEvent.data, "adapterActionId"),
        adapterReceiptEvidenceId: stringData(existingEvent.data, "adapterReceiptEvidenceId"),
        approvalRequestId: stringData(existingEvent.data, "approvalRequestId"),
        auditEventId: stringData(existingEvent.data, "auditEventId"),
        workflowRunId: stringData(existingEvent.data, "workflowRunId"),
        workflowStepIds: getWorkflowStepIds(existingEvent.data),
      };
      const [adoptedRun] = await tx
        .insert(workerRuns)
        .values({
          tenantId: context.worker.tenantId,
          workerId: context.worker.id,
          taskId: existingEvent.taskId ?? context.task?.id ?? null,
          eventId: existingEvent.id,
          capabilityId: context.task?.capabilityId ?? context.quoteCapabilityId ?? context.briefCapabilityId,
          connectionId: context.connectionId,
          budgetAccountId: context.budgetAccountId,
          source,
          idempotencyKey: input.idempotencyKey,
          state: "done",
          mode: "legacy_event",
          data: {
            input: {
              idempotencyKey: input.idempotencyKey,
              config: requestConfig,
              resolvedConfig: config,
              ...intakeTrace,
              inputHashUnavailable: true,
              adoptedFromEvent: existingEvent.id,
            },
            output: {
              ...output,
              ...eventOutput,
            },
          },
          endedAt: new Date(),
        })
        .returning({ id: workerRuns.id });

      return {
        created: false as const,
        workerRunId: adoptedRun.id,
        eventId: existingEvent.id,
        taskId: existingEvent.taskId ?? null,
        sourceSnapshotEvidenceId: stringData(existingEvent.data, "sourceSnapshotEvidenceId"),
        evidenceId: stringData(existingEvent.data, "evidenceId"),
        reservationId: stringData(existingEvent.data, "reservationId"),
        inferenceId: stringData(existingEvent.data, "inferenceId"),
        usageEventId: stringData(existingEvent.data, "usageEventId"),
        adapterRunId: stringData(existingEvent.data, "adapterRunId"),
        adapterActionId: stringData(existingEvent.data, "adapterActionId"),
        adapterReceiptEvidenceId: stringData(existingEvent.data, "adapterReceiptEvidenceId"),
        approvalRequestId: stringData(existingEvent.data, "approvalRequestId"),
        auditEventId: stringData(existingEvent.data, "auditEventId"),
        workflowRunId: eventOutput.workflowRunId,
        workflowStepIds: eventOutput.workflowStepIds,
        output: {
          ...output,
          ...eventOutput,
        },
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

    const [grant] = await tx
      .select({ id: capabilityGrants.id })
      .from(capabilityGrants)
      .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
      .where(
        and(
          eq(capabilityGrants.tenantId, context.worker.tenantId),
          eq(capabilityGrants.actorType, "worker"),
          eq(capabilityGrants.actorId, context.worker.id),
          eq(capabilityGrants.capabilityId, capabilityId),
          eq(capabilityGrants.active, true),
          eq(capabilities.active, true),
          sql`(${capabilityGrants.startsAt} is null or ${capabilityGrants.startsAt} <= ${now})`,
          sql`(${capabilityGrants.endsAt} is null or ${capabilityGrants.endsAt} > ${now})`,
        ),
      )
      .limit(1);

    if (!grant) {
      throw new RevenueWorkerUnavailableError(
        "worker_capability_not_granted",
        "Revenue Worker is not actively granted the capability required for this run.",
        403,
      );
    }

    const runInput = {
      idempotencyKey: input.idempotencyKey,
      inputHash,
      config: requestConfig,
      resolvedConfig: config,
      ...intakeTrace,
      leadPacket: leadPacket.sourceSnapshot,
      operator: {
        userId: operator.id,
        email: operator.email,
      },
      taskId: task?.id ?? null,
      objectId: runObjectId,
      capabilityId,
      connectionId: context.connectionId,
      budgetAccountId: context.budgetAccountId,
      routeId: context.routeId,
      units: runUnits,
      mode: "simulation",
    };

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task?.id ?? null,
        capabilityId,
        connectionId: context.connectionId,
        budgetAccountId: context.budgetAccountId,
        source,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: runInput,
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

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
        type: "revenue_worker.run.requested",
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
        idempotencyKey: `${input.idempotencyKey}:run_requested`,
        data: {
          operatorEmail: operator.email,
          operatorName: operator.name,
          inputHash,
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          mode: "simulation",
        },
      })
      .returning({ id: auditEvents.id });

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
          mode: "simulation",
          objective: "Classify the lead packet and prepare the next owner-visible no-send action.",
          leadPacket: leadPacket.sourceSnapshot,
          ...intakeTrace,
          workflowRunId: workflowRun.id,
          inputHash,
        },
        result: {
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
          workerRunId: workerRun.id,
          ...intakeTrace,
          workflowRunId: workflowRun.id,
          adapterRunId: adapterRun.id,
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
        objectId: runObjectId,
        taskId: task?.id,
        capabilityId,
        connectionId: context.connectionId,
        idempotencyKey: input.idempotencyKey,
        data: {
          worker: context.worker.name,
          tenant: context.tenantName,
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
        name: "Revenue Worker simulation trace",
        objectId: runObjectId,
        taskId: task?.id,
        eventId: event.id,
        capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "trace"),
        data: {
          idempotencyKey: input.idempotencyKey,
          inputHash,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
          reservationId: reservation.id,
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
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          workflowRunId: workflowRun.id,
        },
        policy: {
          externalSend: "approval_required",
          moneyMovement: "blocked",
          capabilityGrantId: grant.id,
        },
        data: {
          operatorRunAuditId: runAudit.id,
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
        idempotencyKey: `${input.idempotencyKey}:approval_requested`,
        data: {
          reviewerUserId: task?.reviewerUserId ?? operator.id,
          operatorUserId: operator.id,
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

    const workflowStepValues = [
      {
        fromState: "received",
        toState: "intake_resolved",
        kind: "worker_transition",
        name: "Revenue intake resolved",
        input: {
          ...intakeTrace,
          leadPacket: leadPacket.sourceSnapshot,
        },
        output: {
          sourceObjectId,
          sourceEventRowId,
          sourceEvidenceId,
          inputHash,
        },
      },
      {
        fromState: "intake_resolved",
        toState: "packet_prepared",
        kind: "worker_transition",
        name: "Revenue packet prepared",
        input: {
          classification: leadPacket.classification,
          quote: leadPacket.quote,
        },
        output: {
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          evidenceId: workerEvidence.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
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
        },
        output: {
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
          policy: {
            externalSend: "approval_required",
            moneyMovement: "blocked",
          },
        },
        output: {
          approvalRequestId: approval.id,
          approvalAuditEventId: approvalAudit.id,
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
          inputHash,
          workerRunId: workerRun.id,
          ...intakeTrace,
          sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
          reservationId: reservation.id,
          runAuditId: runAudit.id,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          approvalRequestId: approval.id,
          auditEventId: approvalAudit.id,
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
        workflowRunId: workflowRun.id,
        workflowStepIds,
        idempotencyKey: input.idempotencyKey,
        approvalRequestId: approval.id,
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
            runEventId: event.id,
            ...intakeTrace,
            sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
            draftResponse: leadPacket.draftResponse,
            quote: leadPacket.quote,
            adapterRunId: adapterRun.id,
            adapterActionId: action.id,
            adapterReceiptEvidenceId: receiptEvidence.id,
            approvalRequestId: approval.id,
            auditEventId: approvalAudit.id,
            workflowRunId: workflowRun.id,
            workflowStepIds,
          },
          cost: {
            units: runUnits,
            reservationId: reservation.id,
            usageEventId: usage.id,
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
          reservationId: reservation.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
          adapterRunId: adapterRun.id,
          adapterActionId: action.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          approvalRequestId: approval.id,
          auditEventId: approvalAudit.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
        },
      })
      .where(eq(events.id, event.id));

    const runOutput = {
      worker: context.worker.name,
      tenant: context.tenantName,
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
      reservationId: reservation.id,
      inferenceId: inference.id,
      usageEventId: usage.id,
      adapterRunId: adapterRun.id,
      adapterActionId: action.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      approvalRequestId: approval.id,
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
        state: "done",
        endedAt: now,
        updatedAt: now,
        data: {
          input: {
            ...runInput,
            workflowRunId: workflowRun.id,
          },
          output: runOutput,
        },
      })
      .where(eq(workerRuns.id, workerRun.id));

    return {
      created: true as const,
      workerRunId: workerRun.id,
      eventId: event.id,
      taskId: task?.id ?? null,
      sourceSnapshotEvidenceId: sourceSnapshotEvidence.id,
      evidenceId: workerEvidence.id,
      reservationId: reservation.id,
      inferenceId: inference.id,
      usageEventId: usage.id,
      adapterActionId: action.id,
      adapterRunId: adapterRun.id,
      adapterReceiptEvidenceId: receiptEvidence.id,
      approvalRequestId: approval.id,
      auditEventId: approvalAudit.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      output: runOutput,
    };
  });

  return {
    idempotencyKey: input.idempotencyKey,
    ...result,
    snapshot: await getRevenueWorkerSnapshot(db, selector),
  };
}

export async function continueRevenueWorker(input: {
  approvalId: string;
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  db?: Database;
}): Promise<RevenueWorkerContinuationResult> {
  const db = input.db ?? defaultDb;
  const approvalId = uuidValue(input.approvalId);

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

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${source}:continue:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select({
        id: workerRuns.id,
        mode: workerRuns.mode,
        taskId: workerRuns.taskId,
        eventId: workerRuns.eventId,
        data: workerRuns.data,
      })
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, source),
          eq(workerRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      const output = outputData(existingRun.data);
      const existingApprovalId = stringData(existingRun.data, "approvalRequestId");

      if (existingRun.mode !== "continuation" || existingApprovalId !== approvalId) {
        throw new RevenueWorkerUnavailableError(
          "worker_continuation_idempotency_conflict",
          "Idempotency key already belongs to a different worker operation.",
          409,
        );
      }

      return {
        created: false as const,
        workerRunId: existingRun.id,
        originalWorkerRunId: stringData(existingRun.data, "originalWorkerRunId"),
        eventId: existingRun.eventId ?? stringData(existingRun.data, "eventId"),
        taskId: stringData(existingRun.data, "taskId") ?? existingRun.taskId,
        approvalRequestId: stringData(existingRun.data, "approvalRequestId"),
        auditEventId: stringData(existingRun.data, "auditEventId"),
        evidenceId: stringData(existingRun.data, "evidenceId"),
        workflowRunId: stringData(existingRun.data, "workflowRunId"),
        workflowStepId: stringData(existingRun.data, "workflowStepId"),
        output,
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

    if (approval.state !== "revision_requested") {
      throw new RevenueWorkerUnavailableError(
        "worker_continuation_unsupported_state",
        "Revenue Worker continuation currently supports revision_requested approvals.",
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

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: approval.taskId,
        eventId: approval.eventId,
        capabilityId: approval.capabilityId,
        connectionId: originalRun.connectionId ?? context.connectionId,
        budgetAccountId: originalRun.budgetAccountId ?? context.budgetAccountId,
        source,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "continuation",
        data: {
          input: {
            idempotencyKey: input.idempotencyKey,
            ...continuationInput,
            operator: {
              userId: operator.id,
              email: operator.email,
            },
          },
          output: {},
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "revenue_worker.revision.requested",
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
          note: revisionNote,
          externalExecution: "blocked",
          externalSend: false,
        },
        occurredAt: now,
      })
      .returning({ id: events.id });

    const [audit] = await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "revenue_worker.continuation.requested",
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
          nextAction: "prepare_revised_packet",
          externalExecution: "blocked",
          externalSend: false,
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
          externalExecution: "blocked",
          externalSend: false,
        },
      })
      .returning({ id: evidence.id });

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
        name: `${workflow.definition.key}:revision_requested`,
        state: "done",
        priority: approval.priority,
        risk: approval.risk,
        fromState: workflow.run.state,
        toState: "revision_requested",
        attempt: 1,
        maxAttempts: 1,
        leaseOwner: `worker:${context.worker.id}`,
        leasedUntil: now,
        idempotencyKey: `${input.idempotencyKey}:revision_requested`,
        input: continuationInput,
        output: {
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          originalWorkerRunId: originalRun.id,
          auditEventId: audit.id,
          evidenceId: trace.id,
          nextAction: "prepare_revised_packet",
          externalExecution: "blocked",
          externalSend: false,
        },
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowSteps.id });

    const output = {
      status: "revision_continuation_queued",
      approvalRequestId: approval.id,
      originalWorkerRunId: originalRun.id,
      workerRunId: workerRun.id,
      workflowRunId: workflow.run.id,
      workflowStepId: workflowStep.id,
      eventId: event.id,
      auditEventId: audit.id,
      evidenceId: trace.id,
      nextAction: "prepare_revised_packet",
      externalExecution: "blocked",
      externalSend: false,
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
        state: "revision_requested",
        data: {
          ...workflowData,
          revisionContinuation,
          lastWorkerContinuation: revisionContinuation,
          workflowStepIds: appendString(workflowData.workflowStepIds, workflowStep.id),
        },
        blockers: {
          ...objectValue(workflow.run.blockers),
          open: ["revision_requested", "external_execution_blocked"],
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
          state: "active",
          outcome: {
            ...objectValue(task?.outcome),
            status: "revision_continuation_queued",
            revisionContinuation,
            externalExecution: "blocked",
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
        state: "done",
        endedAt: now,
        updatedAt: now,
        data: {
          input: {
            idempotencyKey: input.idempotencyKey,
            ...continuationInput,
            operator: {
              userId: operator.id,
              email: operator.email,
            },
          },
          output,
        },
      })
      .where(eq(workerRuns.id, workerRun.id));

    return {
      created: true as const,
      workerRunId: workerRun.id,
      originalWorkerRunId: originalRun.id,
      eventId: event.id,
      taskId: approval.taskId,
      approvalRequestId: approval.id,
      auditEventId: audit.id,
      evidenceId: trace.id,
      workflowRunId: workflow.run.id,
      workflowStepId: workflowStep.id,
      output,
    };
  });

  return {
    idempotencyKey: input.idempotencyKey,
    ...result,
    snapshot: await getRevenueWorkerSnapshot(db, selector),
  };
}
