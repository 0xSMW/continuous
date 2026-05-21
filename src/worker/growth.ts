import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { PlatformUnavailableError } from "../core/errors";
import { loadOperatorContext } from "../core/operators";
import { db as defaultDb } from "../db/client";
import {
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  capabilities,
  capabilityGrants,
  customers,
  customerSignals,
  documents,
  evidence,
  evidencePackets,
  events,
  generatedViews,
  objectLinks,
  objects,
  objectVersions,
  tasks,
  tenants,
  usageEvents,
  users,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const growthWorkerRole = "growth_operations";

const growthSource = "continuous.worker";
const campaignDraftCapabilityKey = "campaign.draft";
const campaignDraftWorkflowKey = "campaign_drafting";
const campaignDraftUnits = 2800;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type GrowthWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type GrowthContext = {
  worker: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    name: string;
    role: string;
    state: string;
    mission: string;
    autonomyLevel: number;
    scope: JsonObject;
    policy: JsonObject;
    kpis: JsonObject;
    managerUserId: string | null;
    managerName: string | null;
  };
  operator: {
    id: string;
    email: string;
    name: string;
    actorRef: string;
  };
  reviewerUserId: string | null;
  capabilityId: string;
  budgetAccountId: string;
};

type ResolvedSignal = {
  id: string;
  objectId: string;
  customerId: string | null;
  customerObjectId: string | null;
  customerName: string | null;
  customerData: JsonObject | null;
  type: string;
  state: string;
  source: string;
  externalId: string | null;
  data: JsonObject;
  occurredAt: Date | null;
};

type ResolvedObject = {
  id: string;
  type: string;
  name: string;
  state: string;
  data: JsonObject;
};

type ResolvedBudgetReservation = {
  id: string;
  units: number;
  taskId: string | null;
  state: string;
  expiresAt: Date | null;
};

export type GrowthWorkerSnapshot = {
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
    pendingApprovals: number;
    generatedViews: number;
    externalExecution: "blocked";
    externalPublish: "blocked";
    externalSend: "blocked";
    adSpend: "blocked";
    trackingMutation: "blocked";
  };
  campaigns: Array<{
    id: string;
    name: string;
    state: string;
    data: JsonObject;
  }>;
  contentDrafts: Array<{
    id: string;
    name: string;
    state: string;
    data: JsonObject;
  }>;
  approvals: Array<{
    id: string;
    state: string;
    kind: string;
    title: string;
    priority: string;
  }>;
  latestRun: {
    id: string;
    workerRunId: string;
    eventId: string | null;
    idempotencyKey: string;
    state: string;
    mode: string;
    output: JsonObject;
  } | null;
};

export type GrowthCampaignsView = {
  worker: GrowthWorkerSnapshot["worker"];
  controls: GrowthWorkerSnapshot["controls"];
  filters: JsonObject;
  campaigns: GrowthWorkerSnapshot["campaigns"];
  contentDrafts: GrowthWorkerSnapshot["contentDrafts"];
  approvals: GrowthWorkerSnapshot["approvals"];
};

export type GrowthCampaignDraftResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  campaignObjectId: string | null;
  contentDraftObjectId: string | null;
  customerSignalId: string | null;
  signalObjectId: string | null;
  customerObjectId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  campaignsViewId: string | null;
  budgetReservationId: string | null;
  externalExecution: "blocked";
  externalPublish: false;
  externalSend: false;
  externalSpend: false;
  trackingMutation: "blocked";
  output: JsonObject;
  snapshot: GrowthWorkerSnapshot;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function jsonObjectList(value: unknown) {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item) => Object.keys(item).length > 0)
    : [];
}

function uuidValue(value: unknown) {
  const text = optionalString(value);

  return text && uuidPattern.test(text) ? text : undefined;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }

  return value;
}

function hashObject(value: unknown) {
  return createHash("sha256").update(JSON.stringify(stableValue(value))).digest("hex");
}

function outputData(data: JsonObject) {
  return objectValue(data.output);
}

function unsafeMutationRequested(value: unknown) {
  return value === true || value === "true" || value === "enabled" || value === "allowed";
}

function severityFrom(data: JsonObject) {
  return (
    optionalString(data.severity) ??
    optionalString(data.priority) ??
    optionalString(objectValue(data.sentiment).severity) ??
    null
  );
}

function sentimentFrom(data: JsonObject) {
  return (
    optionalString(data.sentiment) ??
    optionalString(objectValue(data.analysis).sentiment) ??
    optionalString(objectValue(data.emotion).sentiment) ??
    null
  );
}

function riskForCampaign(blockers: string[], claims: JsonObject[]) {
  if (blockers.length > 0) {
    return "high" as const;
  }

  return claims.some((claim) => unsafeMutationRequested(claim.regulated) || optionalString(claim.risk) === "high")
    ? ("high" as const)
    : ("medium" as const);
}

function channelFrom(policy: JsonObject) {
  return optionalString(policy.channel) ?? "email";
}

function audienceFrom(policy: JsonObject) {
  return optionalString(policy.audience) ?? "recent_customers";
}

function firstSignalClaim(signal: ResolvedSignal, sourceRefs: JsonObject): JsonObject {
  const signalTopic =
    optionalString(signal.data.topic) ??
    optionalString(signal.data.category) ??
    signal.type.replaceAll("_", " ");
  const sentiment = sentimentFrom(signal.data);

  return {
    text:
      sentiment === "positive"
        ? `Customer feedback supports a ${signalTopic} campaign.`
        : `Customer signal identifies ${signalTopic} as a campaign opportunity.`,
    sourceRefs: {
      customerSignalId: signal.id,
      customerSignalObjectId: signal.objectId,
      evidencePacketId: sourceRefs.evidencePacketId ?? null,
    },
  };
}

function campaignClaims(input: {
  config: JsonObject;
  signal: ResolvedSignal;
  sourceRefs: JsonObject;
}) {
  const claims = [
    ...jsonObjectList(input.config.claims),
    ...jsonObjectList(objectValue(input.config.content).claims),
  ];

  return claims.length > 0 ? claims : [firstSignalClaim(input.signal, input.sourceRefs)];
}

function claimBlockers(claims: JsonObject[]) {
  return claims.flatMap((claim, index) => {
    const sourceRefs = objectValue(claim.sourceRefs);
    const blockers: string[] = [];

    if (!optionalString(claim.text) && !optionalString(claim.claim)) {
      blockers.push(`claim_${index + 1}_text_missing`);
    }

    if (Object.keys(sourceRefs).length === 0) {
      blockers.push(`claim_${index + 1}_source_refs_missing`);
    }

    if (unsafeMutationRequested(claim.unsupported)) {
      blockers.push(`claim_${index + 1}_unsupported`);
    }

    return blockers;
  });
}

function blockerList(input: {
  signal: ResolvedSignal;
  sourceRefs: JsonObject;
  policy: JsonObject;
  claims: JsonObject[];
  customerObjectId: string | null;
}) {
  return [
    uuidValue(input.sourceRefs.customerSignalObjectId) || uuidValue(input.sourceRefs.customerSignalId)
      ? ""
      : "customer_signal_ref_missing",
    uuidValue(input.sourceRefs.evidencePacketId) ? "" : "evidence_packet_missing",
    uuidValue(input.sourceRefs.budgetReservationId) ? "" : "budget_reservation_missing",
    input.customerObjectId ? "" : "customer_ref_missing",
    optionalString(input.policy.channel) ? "" : "channel_missing",
    optionalString(input.policy.audience) ? "" : "audience_missing",
    ...claimBlockers(input.claims),
  ].filter(Boolean);
}

function draftTitle(input: { config: JsonObject; signal: ResolvedSignal; channel: string; audience: string }) {
  return (
    optionalString(input.config.title) ??
    optionalString(objectValue(input.config.content).title) ??
    `${input.channel} campaign for ${input.audience.replaceAll("_", " ")}`
  );
}

function draftBody(input: {
  config: JsonObject;
  signal: ResolvedSignal;
  channel: string;
  audience: string;
  claims: JsonObject[];
}) {
  const configured =
    optionalString(input.config.body) ??
    optionalString(input.config.copy) ??
    optionalString(objectValue(input.config.content).body);

  if (configured) {
    return configured;
  }

  const claimText =
    optionalString(input.claims[0]?.text) ??
    optionalString(input.claims[0]?.claim) ??
    "Recent customer feedback gives us a clean, source-backed reason to follow up.";

  return [
    claimText,
    `Audience: ${input.audience.replaceAll("_", " ")}.`,
    `Channel: ${input.channel}.`,
    "No publish, send, ad spend, or tracking changes are authorized from this draft.",
  ].join(" ");
}

function workerWhere(selector: GrowthWorkerSelector) {
  const conditions = [
    eq(workers.role, selector.role ?? growthWorkerRole),
    eq(workers.state, "training"),
  ];

  if (selector.workerId) {
    conditions.push(eq(workers.id, selector.workerId));
  }

  if (selector.tenantSlug) {
    conditions.push(eq(tenants.slug, selector.tenantSlug));
  }

  return and(...conditions);
}

function assertSingleWorker<T>(rows: T[], selector: GrowthWorkerSelector): T | null {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_target_ambiguous",
      "Multiple Growth Workers match this selector. Provide worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadGrowthWorker(db: Database, selector: GrowthWorkerSelector) {
  const rows = await db
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
      managerUserId: workers.managerUserId,
      tenantSlug: tenants.slug,
      tenantName: tenants.name,
      managerName: users.name,
    })
    .from(workers)
    .innerJoin(tenants, eq(workers.tenantId, tenants.id))
    .leftJoin(users, eq(workers.managerUserId, users.id))
    .where(workerWhere(selector))
    .orderBy(workers.createdAt)
    .limit(selector.workerId ? 1 : 2);

  return assertSingleWorker(rows, selector);
}

async function loadGrowthContext(input: {
  db: Database;
  selector: GrowthWorkerSelector;
  operatorEmail: string;
}): Promise<GrowthContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadGrowthWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Growth Worker matches this selector.",
      404,
    );
  }

  if (worker.tenantId !== operator.tenantId) {
    throw new PlatformUnavailableError(
      "operator_tenant_mismatch",
      "Operator is not a member of the selected worker tenant.",
      403,
    );
  }

  const [capability] = await input.db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, campaignDraftCapabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      "Growth Worker requires the campaign.draft capability.",
      409,
    );
  }

  const [grant] = await input.db
    .select({ id: capabilityGrants.id })
    .from(capabilityGrants)
    .where(
      and(
        eq(capabilityGrants.tenantId, worker.tenantId),
        eq(capabilityGrants.capabilityId, capability.id),
        eq(capabilityGrants.actorType, "worker"),
        eq(capabilityGrants.actorId, worker.id),
        eq(capabilityGrants.active, true),
      ),
    )
    .limit(1);

  if (!grant) {
    throw new PlatformUnavailableError(
      "worker_capability_not_granted",
      "Growth Worker does not have an active campaign.draft grant.",
      403,
    );
  }

  const [budgetAccount] = await input.db
    .select({ id: budgetAccounts.id })
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.tenantId, worker.tenantId),
        eq(budgetAccounts.target, "worker"),
        eq(budgetAccounts.targetId, worker.id),
        eq(budgetAccounts.active, true),
      ),
    )
    .orderBy(budgetAccounts.createdAt)
    .limit(1);

  if (!budgetAccount) {
    throw new PlatformUnavailableError(
      "worker_budget_missing",
      "Growth Worker requires an active worker budget account.",
      409,
    );
  }

  return {
    worker,
    operator: {
      id: operator.userId,
      email: operator.email,
      name: operator.name,
      actorRef: operator.actorRef,
    },
    reviewerUserId: worker.managerUserId,
    capabilityId: capability.id,
    budgetAccountId: budgetAccount.id,
  };
}

async function nextObjectVersion(db: Pick<Database, "select">, objectId: string) {
  const [latest] = await db
    .select({ version: objectVersions.version })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId))
    .orderBy(desc(objectVersions.version))
    .limit(1);

  return (latest?.version ?? 0) + 1;
}

async function resolveCustomerSignal(input: {
  db: Database;
  tenantId: string;
  sourceRefs: JsonObject;
}): Promise<ResolvedSignal> {
  const requestedSignalId = uuidValue(input.sourceRefs.customerSignalId);
  const requestedSignalObjectId = uuidValue(input.sourceRefs.customerSignalObjectId);

  if (!requestedSignalId && !requestedSignalObjectId) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.sourceRefs.customerSignalObjectId or config.sourceRefs.customerSignalId is required for campaign.draft.",
      400,
    );
  }

  const conditions = [eq(customerSignals.tenantId, input.tenantId)];

  if (requestedSignalId) {
    conditions.push(eq(customerSignals.id, requestedSignalId));
  } else if (requestedSignalObjectId) {
    conditions.push(eq(customerSignals.objectId, requestedSignalObjectId));
  }

  const [signal] = await input.db
    .select({
      id: customerSignals.id,
      objectId: customerSignals.objectId,
      customerId: customerSignals.customerId,
      type: customerSignals.type,
      state: customerSignals.state,
      source: customerSignals.source,
      externalId: customerSignals.externalId,
      data: customerSignals.data,
      occurredAt: customerSignals.occurredAt,
      customerObjectId: customers.objectId,
      customerData: customers.data,
    })
    .from(customerSignals)
    .leftJoin(customers, eq(customerSignals.customerId, customers.id))
    .where(and(...conditions))
    .limit(1);

  if (!signal) {
    throw new PlatformUnavailableError(
      "worker_customer_signal_not_found",
      "config.sourceRefs does not match a customer signal in this tenant.",
      404,
    );
  }

  return {
    ...signal,
    customerName:
      optionalString(signal.customerData?.name) ??
      optionalString(signal.customerData?.displayName) ??
      null,
  };
}

async function loadObject(input: {
  db: Database;
  tenantId: string;
  objectId?: string;
  expectedTypes: string[];
  field: string;
}): Promise<ResolvedObject | null> {
  if (!input.objectId) {
    return null;
  }

  const [object] = await input.db
    .select({
      id: objects.id,
      type: objects.type,
      name: objects.name,
      state: objects.state,
      data: objects.data,
    })
    .from(objects)
    .where(and(eq(objects.tenantId, input.tenantId), eq(objects.id, input.objectId)))
    .limit(1);

  if (!object || !input.expectedTypes.includes(object.type)) {
    throw new PlatformUnavailableError(
      "worker_source_ref_not_found",
      `${input.field} does not match a ${input.expectedTypes.join(" or ")} object in this tenant.`,
      404,
    );
  }

  return object;
}

async function assertCustomerObject(input: {
  db: Database;
  tenantId: string;
  customerObjectId?: string;
  signal: ResolvedSignal;
}) {
  const requested = input.customerObjectId;
  const resolved = input.signal.customerObjectId;

  if (!requested) {
    return resolved;
  }

  await loadObject({
    db: input.db,
    tenantId: input.tenantId,
    objectId: requested,
    expectedTypes: ["customer"],
    field: "config.sourceRefs.customerObjectId",
  });

  if (resolved && requested !== resolved) {
    throw new PlatformUnavailableError(
      "worker_customer_signal_mismatch",
      "config.sourceRefs.customerObjectId does not match the selected customer signal.",
      409,
    );
  }

  return requested;
}

async function resolveEvidencePacket(input: {
  db: Database;
  tenantId: string;
  evidencePacketId?: string;
}) {
  if (!input.evidencePacketId) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.sourceRefs.evidencePacketId is required for campaign.draft.",
      400,
    );
  }

  const [packet] = await input.db
    .select({ id: evidencePackets.id, kind: evidencePackets.kind, state: evidencePackets.state })
    .from(evidencePackets)
    .where(and(eq(evidencePackets.tenantId, input.tenantId), eq(evidencePackets.id, input.evidencePacketId)))
    .limit(1);

  if (!packet) {
    throw new PlatformUnavailableError(
      "worker_evidence_packet_not_found",
      "config.sourceRefs.evidencePacketId does not match an evidence packet in this tenant.",
      404,
    );
  }

  return packet;
}

async function resolveBudgetReservation(input: {
  tx: Transaction;
  tenantId: string;
  budgetAccountId: string;
  budgetReservationId?: string;
  now: Date;
  requiredUnits: number;
}): Promise<ResolvedBudgetReservation> {
  if (!input.budgetReservationId) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.sourceRefs.budgetReservationId is required for campaign.draft.",
      400,
    );
  }

  await input.tx.execute(
    sql`select id from budget_reservations where tenant_id = ${input.tenantId} and id = ${input.budgetReservationId} for update`,
  );

  const [reservation] = await input.tx
    .select({
      id: budgetReservations.id,
      accountId: budgetReservations.accountId,
      taskId: budgetReservations.taskId,
      units: budgetReservations.units,
      state: budgetReservations.state,
      expiresAt: budgetReservations.expiresAt,
    })
    .from(budgetReservations)
    .where(
      and(
        eq(budgetReservations.tenantId, input.tenantId),
        eq(budgetReservations.id, input.budgetReservationId),
      ),
    )
    .limit(1);

  if (!reservation) {
    throw new PlatformUnavailableError(
      "worker_budget_reservation_not_found",
      "config.sourceRefs.budgetReservationId does not match a budget reservation in this tenant.",
      404,
    );
  }

  if (reservation.accountId !== input.budgetAccountId) {
    throw new PlatformUnavailableError(
      "worker_budget_scope_mismatch",
      "config.sourceRefs.budgetReservationId is not scoped to the Growth Worker budget account.",
      403,
    );
  }

  if (reservation.expiresAt && reservation.expiresAt <= input.now) {
    await input.tx
      .update(budgetReservations)
      .set({ state: "expired", updatedAt: input.now })
      .where(eq(budgetReservations.id, reservation.id));

    throw new PlatformUnavailableError(
      "worker_budget_reservation_expired",
      "config.sourceRefs.budgetReservationId references an expired budget reservation.",
      409,
    );
  }

  if (reservation.taskId) {
    throw new PlatformUnavailableError(
      "worker_budget_reservation_already_bound",
      "config.sourceRefs.budgetReservationId is already bound to another task.",
      409,
    );
  }

  if (reservation.state !== "held") {
    throw new PlatformUnavailableError(
      "worker_budget_reservation_unavailable",
      "config.sourceRefs.budgetReservationId must reference a held budget reservation.",
      409,
    );
  }

  if (reservation.units < input.requiredUnits) {
    throw new PlatformUnavailableError(
      "worker_budget_reservation_insufficient",
      "config.sourceRefs.budgetReservationId does not reserve enough units for campaign.draft.",
      409,
    );
  }

  return reservation;
}

async function writeGeneratedCampaignsView(input: {
  tx: Transaction;
  tenantId: string;
  capabilityId: string;
  taskState: "approval_required" | "blocked";
  data: JsonObject;
  now: Date;
}) {
  const [existing] = await input.tx
    .select({ id: generatedViews.id })
    .from(generatedViews)
    .where(
      and(
        eq(generatedViews.tenantId, input.tenantId),
        eq(generatedViews.key, "growth.campaigns"),
        eq(generatedViews.version, "1.0.0"),
      ),
    )
    .limit(1);

  const values = {
    tenantId: input.tenantId,
    capabilityId: input.capabilityId,
    key: "growth.campaigns",
    version: "1.0.0",
    name: "Growth campaigns",
    purpose:
      "Review source-backed campaign drafts, claim blockers, audience policy, budget refs, and no-publish proof.",
    surface: "web",
    objectType: "campaign",
    taskState: input.taskState,
    contract: {
      version: "1.0.0",
      role: growthWorkerRole,
      sections: ["Campaign", "Audience", "Claims", "Budget", "ApprovalActions", "NoExternalMutation"],
    },
    actions: {
      primary: input.taskState === "blocked" ? "request_sources" : "approve_campaign_draft",
      secondary: ["route_claim_review", "request_revision", "reject_publish"],
    },
    data: input.data,
    mask: {
      customerContactLists: true,
      suppressionLists: "source_handles_only",
      adAccountRefs: true,
      rawTrackingIdentifiers: true,
      regulatedAudienceTraits: true,
    },
    active: true,
    updatedAt: input.now,
  } satisfies typeof generatedViews.$inferInsert;

  const [view] = existing
    ? await input.tx
        .update(generatedViews)
        .set(values)
        .where(eq(generatedViews.id, existing.id))
        .returning({ id: generatedViews.id })
    : await input.tx
        .insert(generatedViews)
        .values({ ...values, createdAt: input.now })
        .returning({ id: generatedViews.id });

  return view.id;
}

export async function prepareGrowthCampaignDraft(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<GrowthCampaignDraftResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const sourceRefs = objectValue(config.sourceRefs);
  const policy = objectValue(config.policy);

  if (
    unsafeMutationRequested(policy.allowPublish) ||
    unsafeMutationRequested(policy.allowExternalPublish) ||
    unsafeMutationRequested(policy.allowSend) ||
    unsafeMutationRequested(policy.allowSpend) ||
    unsafeMutationRequested(policy.allowTrackingMutation) ||
    unsafeMutationRequested(config.externalPublish) ||
    unsafeMutationRequested(config.externalSend) ||
    unsafeMutationRequested(config.adSpend) ||
    unsafeMutationRequested(config.trackingMutation)
  ) {
    throw new PlatformUnavailableError(
      "worker_external_mutation_blocked",
      "Growth campaign.draft cannot request publish, send, spend, or tracking mutation. Keep those policies blocked under config.policy.",
      400,
    );
  }

  const context = await loadGrowthContext({
    db,
    selector: { role: growthWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const signal = await resolveCustomerSignal({
    db,
    tenantId: context.worker.tenantId,
    sourceRefs,
  });
  const customerObjectId = await assertCustomerObject({
    db,
    tenantId: context.worker.tenantId,
    customerObjectId: uuidValue(sourceRefs.customerObjectId),
    signal,
  });
  const evidencePacket = await resolveEvidencePacket({
    db,
    tenantId: context.worker.tenantId,
    evidencePacketId: uuidValue(sourceRefs.evidencePacketId),
  });
  const requestedBudgetReservationId = uuidValue(sourceRefs.budgetReservationId);
  const reviewObject = await loadObject({
    db,
    tenantId: context.worker.tenantId,
    objectId: uuidValue(sourceRefs.reviewObjectId),
    expectedTypes: ["review", "testimonial", "feedback_item", "complaint", "satisfaction_signal"],
    field: "config.sourceRefs.reviewObjectId",
  });
  const claims = campaignClaims({ config, signal, sourceRefs });
  const blockers = blockerList({
    signal,
    sourceRefs,
    policy,
    claims,
    customerObjectId: customerObjectId ?? null,
  });
  const taskState = blockers.length > 0 ? "blocked" : "approval_required";
  const channel = channelFrom(policy);
  const audience = audienceFrom(policy);
  const title = draftTitle({ config, signal, channel, audience });
  const body = draftBody({ config, signal, channel, audience, claims });
  const bodyHash = hashObject({ title, body, claims, channel, audience });
  const safePolicy = {
    ...policy,
    channel,
    audience,
    requiresOwnerApproval: true,
    allowPublish: false,
    allowSend: false,
    allowSpend: false,
    allowTrackingMutation: false,
    externalExecution: "blocked",
    externalPublish: "blocked",
    externalSend: "blocked",
    adSpend: "blocked",
    trackingMutation: "blocked",
  } satisfies JsonObject;
  const inputHash = hashObject({
    schemaVersion: "growth.campaign.draft.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    signalId: signal.id,
    customerObjectId: customerObjectId ?? null,
    evidencePacketId: evidencePacket.id,
    budgetReservationId: requestedBudgetReservationId ?? null,
    blockers,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${growthSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, growthSource),
          eq(workerRuns.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);

    if (existingRun) {
      const existingInput = objectValue(objectValue(existingRun.data).input);
      const existingHash = optionalString(existingInput.inputHash);

      if (existingHash && existingHash !== inputHash) {
        throw new PlatformUnavailableError(
          "worker_idempotency_conflict",
          "A Growth campaign draft already exists for this idempotency key with different input.",
          409,
        );
      }

      const output = outputData(existingRun.data);

      return {
        status: "replay" as const,
        output: {
          ...output,
          created: false,
        } as JsonObject,
      };
    }

    const budgetReservation = await resolveBudgetReservation({
      tx,
      tenantId: context.worker.tenantId,
      budgetAccountId: context.budgetAccountId,
      budgetReservationId: requestedBudgetReservationId,
      now,
      requiredUnits: campaignDraftUnits,
    });

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, campaignDraftWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Growth Worker requires the campaign_drafting workflow definition.",
        409,
      );
    }

    const campaignData = {
      command: "campaign.draft",
      customerSignalId: signal.id,
      signalObjectId: signal.objectId,
      customerObjectId: customerObjectId ?? null,
      reviewObjectId: reviewObject?.id ?? null,
      signal: {
        type: signal.type,
        state: signal.state,
        source: signal.source,
        externalId: signal.externalId,
        severity: severityFrom(signal.data),
        sentiment: sentimentFrom(signal.data),
        occurredAt: signal.occurredAt?.toISOString() ?? null,
      },
      sourceRefs,
      evidencePacket: {
        id: evidencePacket.id,
        kind: evidencePacket.kind,
        state: evidencePacket.state,
      },
      budget: {
        reservationId: budgetReservation.id,
        units: budgetReservation.units,
        state: budgetReservation.state,
        expiresAt: budgetReservation.expiresAt?.toISOString() ?? null,
      },
      blockers,
      campaign: {
        title,
        channel,
        audience,
        state: taskState,
      },
      draft: {
        title,
        body,
        bodyHash,
        channel,
        audience,
        claims,
        externalPublish: false,
        externalSend: false,
        externalSpend: false,
        trackingMutation: "blocked",
      },
      policy: safePolicy,
      redaction: {
        customerContactLists: "redacted",
        suppressionLists: "source_handles_only",
        adAccountRefs: "redacted",
        rawTrackingIdentifiers: "redacted",
        regulatedAudienceTraits: "redacted",
      },
      externalExecution: "blocked",
      externalPublish: false,
      externalSend: false,
      externalSpend: false,
      trackingMutation: "blocked",
      preparedAt: now.toISOString(),
    } satisfies JsonObject;

    const [campaignObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "campaign",
        name: title,
        state: taskState,
        source: growthSource,
        externalId: `growth-campaign:${input.idempotencyKey}`,
        data: campaignData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id, name: objects.name });

    const [contentDraftObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "content_draft",
        name: `${title} content draft`,
        state: taskState === "blocked" ? "needs_sources" : "approval_pending",
        source: growthSource,
        externalId: `growth-content-draft:${input.idempotencyKey}`,
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
        },
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id, name: objects.name });

    for (const objectId of [campaignObject.id, contentDraftObject.id]) {
      const objectVersion = await nextObjectVersion(tx, objectId);

      await tx.insert(objectVersions).values({
        tenantId: context.worker.tenantId,
        objectId,
        version: objectVersion,
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
        },
        changedByType: "worker",
        changedById: context.worker.id,
        reason: "growth campaign draft prepared",
        createdAt: now,
      });
    }

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: campaignObject.id,
          toId: signal.objectId,
          type: "drafted_from_signal",
          data: { source: growthSource, command: "campaign.draft" },
          effectiveAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          fromId: campaignObject.id,
          toId: contentDraftObject.id,
          type: "uses_content",
          data: { source: growthSource, command: "campaign.draft" },
          effectiveAt: now,
        },
        ...(customerObjectId
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: campaignObject.id,
                toId: customerObjectId,
                type: "about_customer",
                data: { source: growthSource, command: "campaign.draft" },
                effectiveAt: now,
              },
            ]
          : []),
        ...(reviewObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: campaignObject.id,
                toId: reviewObject.id,
                type: "references_review",
                data: { source: growthSource, command: "campaign.draft" },
                effectiveAt: now,
              },
            ]
          : []),
      ])
      .onConflictDoNothing();

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: campaignObject.id,
        capabilityId: context.capabilityId,
        title: "Review growth campaign draft",
        state: taskState,
        priority: blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          command: "campaign.draft",
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          evidencePacketId: evidencePacket.id,
          budgetReservationId: budgetReservation.id,
          sourceRefs,
          blockers,
        },
        outcome: {
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: "blocked",
          adSpend: "blocked",
          trackingMutation: "blocked",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    await tx
      .update(budgetReservations)
      .set({ taskId: task.id, state: "used", updatedAt: now })
      .where(eq(budgetReservations.id, budgetReservation.id));

    const [run] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source: growthSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: {
            command: "campaign.draft",
            inputHash,
            config,
          },
        },
        startedAt: now,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: workerRuns.id });

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: campaignObject.id,
        workerId: context.worker.id,
        state: taskState === "blocked" ? "blocked" : "approval_pending",
        idempotencyKey: input.idempotencyKey,
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
          workerRunId: run.id,
        },
        blockers: { items: blockers },
        metrics: {
          blockerCount: blockers.length,
          claimCount: claims.length,
          budgetUnits: budgetReservation.units,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.growth_operations.campaign_draft.completed",
        source: growthSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: campaignObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:campaign_draft_completed`,
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
          workerRunId: run.id,
          workflowRunId: workflowRun.id,
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        objectId: campaignObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "trace",
        name: "Growth campaign draft trace",
        actorType: "worker",
        actorId: context.worker.id,
        hash: `${growthSource}:campaign:${campaignObject.id}:${input.idempotencyKey}`,
        data: {
          inputHash,
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          evidencePacketId: evidencePacket.id,
          budgetReservationId: budgetReservation.id,
          blockers,
          bodyHash,
          externalExecution: "blocked",
          externalPublish: false,
          externalSend: false,
          externalSpend: false,
          trackingMutation: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: campaignObject.id,
        workflowRunId: workflowRun.id,
        kind: "growth_campaign_packet",
        name: "Growth campaign packet",
        state: taskState === "blocked" ? "blocked" : "review_ready",
        sensitivity: "high",
        hash: `${growthSource}:campaign:${campaignObject.id}:${input.idempotencyKey}:document`,
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
          evidenceIds: [traceEvidence.id],
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
        objectId: campaignObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "growth_campaign_packet",
        name: "Growth campaign packet",
        state: taskState === "blocked" ? "blocked" : "prepared",
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id] },
        documentIds: { ids: [document.id] },
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
          documentId: document.id,
        },
        hash: `${growthSource}:campaign:${campaignObject.id}:${input.idempotencyKey}:packet`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });

    const [approval] = await tx
      .insert(approvalRequests)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task.id,
        workerRunId: run.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        objectId: campaignObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "growth_campaign_approval",
        state: "pending",
        priority: blockers.length > 0 ? "high" : "normal",
        risk: riskForCampaign(blockers, claims),
        title: "Review growth campaign draft",
        summary:
          "Review source-backed claims, audience policy, budget reservation, and no-publish proof before any external campaign action.",
        requestedAction: {
          action: blockers.length > 0 ? "resolve_blockers" : "approve_campaign_draft",
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: "blocked",
          adSpend: "blocked",
          trackingMutation: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds: [traceEvidence.id],
          blockers,
        },
        policy: safePolicy,
        data: {
          ...campaignData,
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
          packetId: packet.id,
          documentId: document.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });

    const workflowStepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: campaignObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "source_review",
          name: "Review customer signal and source claims",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForCampaign(blockers, claims),
          fromState: "idea",
          toState: blockers.length > 0 ? "blocked" : "source_review",
          idempotencyKey: `${input.idempotencyKey}:source_review`,
          input: { command: "campaign.draft", sourceRefs },
          output: {
            customerSignalId: signal.id,
            signalObjectId: signal.objectId,
            evidencePacketId: evidencePacket.id,
            blockers,
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: campaignObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "content_draft_prepare",
          name: "Prepare blocked campaign draft",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForCampaign(blockers, claims),
          fromState: "source_review",
          toState: taskState === "blocked" ? "blocked" : "content_draft",
          idempotencyKey: `${input.idempotencyKey}:content_draft_prepare`,
          input: { signalId: signal.id, policy },
          output: {
            campaignObjectId: campaignObject.id,
            contentDraftObjectId: contentDraftObject.id,
            bodyHash,
            externalPublish: false,
            externalSend: false,
            externalSpend: false,
            trackingMutation: "blocked",
            blockers,
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          taskId: task.id,
          objectId: campaignObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "budget_review",
          name: "Bind budget reservation",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForCampaign(blockers, claims),
          fromState: "content_draft",
          toState: taskState === "blocked" ? "blocked" : "budget_review",
          idempotencyKey: `${input.idempotencyKey}:budget_review`,
          input: { budgetReservationId: budgetReservation.id },
          output: {
            budgetReservationId: budgetReservation.id,
            units: budgetReservation.units,
            adSpend: "blocked",
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          taskId: task.id,
          objectId: campaignObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Request campaign review",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: riskForCampaign(blockers, claims),
          fromState: taskState === "blocked" ? "blocked" : "budget_review",
          toState: taskState === "blocked" ? "blocked" : "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:approval_request`,
          input: { packetId: packet.id },
          output: {
            approvalRequestId: approval.id,
            externalPublish: "blocked",
            externalSend: "blocked",
            adSpend: "blocked",
            trackingMutation: "blocked",
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);

    const campaignsViewId = await writeGeneratedCampaignsView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      taskState,
      data: {
        latest: {
          campaignObjectId: campaignObject.id,
          contentDraftObjectId: contentDraftObject.id,
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          approvalRequestId: approval.id,
          packetId: packet.id,
          documentId: document.id,
          evidenceId: traceEvidence.id,
          budgetReservationId: budgetReservation.id,
          blockers,
          externalExecution: "blocked",
          externalPublish: false,
          externalSend: false,
          externalSpend: false,
          trackingMutation: "blocked",
        },
      },
      now,
    });

    await tx.insert(usageEvents).values({
      tenantId: context.worker.tenantId,
      accountId: context.budgetAccountId,
      reservationId: budgetReservation.id,
      taskId: task.id,
      capabilityId: context.capabilityId,
      actorType: "worker",
      actorId: context.worker.id,
      units: campaignDraftUnits,
      data: {
        command: "campaign.draft",
        mode: "simulation",
      },
      createdAt: now,
    });

    const output = {
      command: "campaign.draft",
      workerRunId: run.id,
      taskId: task.id,
      eventId: event.id,
      campaignObjectId: campaignObject.id,
      contentDraftObjectId: contentDraftObject.id,
      customerSignalId: signal.id,
      signalObjectId: signal.objectId,
      customerObjectId: customerObjectId ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      campaignsViewId,
      budgetReservationId: budgetReservation.id,
      blockers,
      draft: campaignData.draft as JsonObject,
      policy: safePolicy,
      redaction: campaignData.redaction as JsonObject,
      generatedView: "growth.campaigns",
      taskState,
      handoff: {
        name: "growth.campaign_to_owner_review",
        campaignObjectId: campaignObject.id,
        contentDraftObjectId: contentDraftObject.id,
        approvalRequestId: approval.id,
        packetId: packet.id,
        documentId: document.id,
        workflowRunId: workflowRun.id,
        budgetReservationId: budgetReservation.id,
        externalExecution: "blocked",
        externalPublish: "blocked",
        externalSend: "blocked",
        adSpend: "blocked",
        trackingMutation: "blocked",
      },
      externalExecution: "blocked",
      externalPublish: false,
      externalSend: false,
      externalSpend: false,
      trackingMutation: "blocked",
      sourceRefs,
    } satisfies JsonObject;

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        state: "done",
        endedAt: now,
        updatedAt: now,
        data: {
          input: {
            command: "campaign.draft",
            inputHash,
            config,
          },
          output,
        },
      })
      .where(eq(workerRuns.id, run.id));

    await tx
      .insert(auditEvents)
      .values({
        tenantId: context.worker.tenantId,
        type: "growth.campaign_draft.prepared",
        source: growthSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        targetType: "campaign",
        targetId: campaignObject.id,
        taskId: task.id,
        eventId: event.id,
        objectId: campaignObject.id,
        workerRunId: run.id,
        approvalRequestId: approval.id,
        capabilityId: context.capabilityId,
        risk: riskForCampaign(blockers, claims),
        idempotencyKey: `${input.idempotencyKey}:campaign_draft_prepared`,
        data: {
          inputHash,
          customerSignalId: signal.id,
          signalObjectId: signal.objectId,
          customerObjectId: customerObjectId ?? null,
          packetId: packet.id,
          campaignsViewId,
          budgetReservationId: budgetReservation.id,
          blockers,
          externalExecution: "blocked",
          externalPublish: false,
          externalSend: false,
          externalSpend: false,
          trackingMutation: "blocked",
        },
      });

    return {
      status: "created" as const,
      output,
    };
  });

  const output = result.output;
  const snapshot = await getGrowthWorkerSnapshot({
    tenantSlug: context.worker.tenantSlug,
    workerId: context.worker.id,
    db,
  });

  return {
    created: result.status === "created",
    idempotencyKey: input.idempotencyKey,
    workerRunId: stringValue(output.workerRunId),
    taskId: optionalString(output.taskId) ?? null,
    eventId: optionalString(output.eventId) ?? null,
    campaignObjectId: optionalString(output.campaignObjectId) ?? null,
    contentDraftObjectId: optionalString(output.contentDraftObjectId) ?? null,
    customerSignalId: optionalString(output.customerSignalId) ?? null,
    signalObjectId: optionalString(output.signalObjectId) ?? null,
    customerObjectId: optionalString(output.customerObjectId) ?? null,
    approvalRequestId: optionalString(output.approvalRequestId) ?? null,
    evidenceId: optionalString(output.evidenceId) ?? null,
    packetId: optionalString(output.packetId) ?? null,
    documentId: optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(output.workflowRunId) ?? null,
    workflowStepIds: stringList(output.workflowStepIds),
    campaignsViewId: optionalString(output.campaignsViewId) ?? null,
    budgetReservationId: optionalString(output.budgetReservationId) ?? null,
    externalExecution: "blocked",
    externalPublish: false,
    externalSend: false,
    externalSpend: false,
    trackingMutation: "blocked",
    output,
    snapshot,
  };
}

async function getGrowthWorkerSnapshot(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}): Promise<GrowthWorkerSnapshot> {
  const db = input.db ?? defaultDb;
  const worker = await loadGrowthWorker(db, {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    role: input.role,
  });

  if (!worker) {
    return emptyGrowthWorkerSnapshot();
  }

  const [account] = await db
    .select({ id: budgetAccounts.id, name: budgetAccounts.name })
    .from(budgetAccounts)
    .where(
      and(
        eq(budgetAccounts.tenantId, worker.tenantId),
        eq(budgetAccounts.target, "worker"),
        eq(budgetAccounts.targetId, worker.id),
        eq(budgetAccounts.active, true),
      ),
    )
    .orderBy(budgetAccounts.createdAt)
    .limit(1);
  const now = new Date();
  const [
    heldUnits,
    usageCount,
    pendingApprovalCount,
    viewCount,
    campaignRows,
    contentDraftRows,
    approvalRows,
    latestRun,
  ] = await Promise.all([
    account
      ? db
          .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
          .from(budgetReservations)
          .where(
            and(
              eq(budgetReservations.tenantId, worker.tenantId),
              eq(budgetReservations.accountId, account.id),
              eq(budgetReservations.state, "held"),
              sql`(${budgetReservations.expiresAt} is null or ${budgetReservations.expiresAt} > ${now})`,
            ),
          )
      : Promise.resolve([{ units: 0 }]),
    account
      ? db
          .select({ value: count(usageEvents.id), units: sql<number>`coalesce(sum(${usageEvents.units}), 0)` })
          .from(usageEvents)
          .where(
            and(
              eq(usageEvents.tenantId, worker.tenantId),
              eq(usageEvents.actorId, worker.id),
              eq(usageEvents.accountId, account.id),
            ),
          )
      : Promise.resolve([{ value: 0, units: 0 }]),
    db
      .select({ value: count(approvalRequests.id) })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, worker.tenantId),
          eq(approvalRequests.requesterType, "worker"),
          eq(approvalRequests.requesterId, worker.id),
          eq(approvalRequests.state, "pending"),
        ),
      ),
    db
      .select({ value: count(generatedViews.id) })
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'growth.%'`)),
    db
      .select({
        id: objects.id,
        name: objects.name,
        state: objects.state,
        data: objects.data,
      })
      .from(objects)
      .where(
        and(
          eq(objects.tenantId, worker.tenantId),
          eq(objects.type, "campaign"),
          eq(objects.source, growthSource),
          eq(objects.createdByWorkerId, worker.id),
        ),
      )
      .orderBy(desc(objects.createdAt))
      .limit(25),
    db
      .select({
        id: objects.id,
        name: objects.name,
        state: objects.state,
        data: objects.data,
      })
      .from(objects)
      .where(
        and(
          eq(objects.tenantId, worker.tenantId),
          eq(objects.type, "content_draft"),
          eq(objects.source, growthSource),
          eq(objects.createdByWorkerId, worker.id),
        ),
      )
      .orderBy(desc(objects.createdAt))
      .limit(25),
    db
      .select({
        id: approvalRequests.id,
        state: approvalRequests.state,
        kind: approvalRequests.kind,
        title: approvalRequests.title,
        priority: approvalRequests.priority,
      })
      .from(approvalRequests)
      .where(
        and(
          eq(approvalRequests.tenantId, worker.tenantId),
          eq(approvalRequests.requesterType, "worker"),
          eq(approvalRequests.requesterId, worker.id),
        ),
      )
      .orderBy(desc(approvalRequests.createdAt))
      .limit(25),
    db
      .select({
        id: workerRuns.id,
        eventId: workerRuns.eventId,
        idempotencyKey: workerRuns.idempotencyKey,
        state: workerRuns.state,
        mode: workerRuns.mode,
        data: workerRuns.data,
      })
      .from(workerRuns)
      .where(and(eq(workerRuns.tenantId, worker.tenantId), eq(workerRuns.workerId, worker.id)))
      .orderBy(desc(workerRuns.createdAt))
      .limit(1),
  ]);
  const [held] = heldUnits;
  const [usage] = usageCount;
  const [approvalCount] = pendingApprovalCount;
  const [viewRow] = viewCount;
  const [run] = latestRun;

  return {
    worker: {
      id: worker.id,
      name: worker.name,
      role: worker.role,
      state: worker.state,
      mission: worker.mission,
      autonomyLevel: worker.autonomyLevel,
      scope: worker.scope,
      policy: worker.policy,
      kpis: worker.kpis,
      managerName: worker.managerName,
      tenantName: worker.tenantName,
    },
    budget: {
      accountId: account?.id ?? null,
      name: account?.name ?? null,
      usedUnits: Number(usage?.units ?? 0),
      heldUnits: Number(held?.units ?? 0),
      events: Number(usage?.value ?? 0),
    },
    controls: {
      pendingApprovals: Number(approvalCount?.value ?? 0),
      generatedViews: Number(viewRow?.value ?? 0),
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: "blocked",
      adSpend: "blocked",
      trackingMutation: "blocked",
    },
    campaigns: campaignRows,
    contentDrafts: contentDraftRows,
    approvals: approvalRows,
    latestRun: run
      ? {
          id: run.id,
          workerRunId: run.id,
          eventId: run.eventId,
          idempotencyKey: run.idempotencyKey,
          state: run.state,
          mode: run.mode,
          output: outputData(run.data),
        }
      : null,
  };
}

function emptyGrowthWorkerSnapshot(): GrowthWorkerSnapshot {
  return {
    worker: null,
    budget: {
      accountId: null,
      name: null,
      usedUnits: 0,
      heldUnits: 0,
      events: 0,
    },
    controls: {
      pendingApprovals: 0,
      generatedViews: 0,
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: "blocked",
      adSpend: "blocked",
      trackingMutation: "blocked",
    },
    campaigns: [],
    contentDrafts: [],
    approvals: [],
    latestRun: null,
  };
}

export async function getGrowthWorkerSnapshotSafe(
  input: GrowthWorkerSelector & { operatorEmail?: string; db?: Database },
): Promise<{ ok: true; snapshot: GrowthWorkerSnapshot; error: null } | { ok: false; snapshot: GrowthWorkerSnapshot; error: string }> {
  try {
    if (input.operatorEmail) {
      const db = input.db ?? defaultDb;
      const context = await loadGrowthContext({
        db,
        selector: { role: growthWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
        operatorEmail: input.operatorEmail,
      });

      return {
        ok: true,
        snapshot: await getGrowthWorkerSnapshot({
          tenantSlug: context.worker.tenantSlug,
          workerId: context.worker.id,
          role: growthWorkerRole,
          db,
        }),
        error: null,
      };
    }

    return {
      ok: true,
      snapshot: await getGrowthWorkerSnapshot(input),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      snapshot: emptyGrowthWorkerSnapshot(),
      error: error instanceof Error ? error.message : "Failed to load Growth Worker snapshot.",
    };
  }
}

export async function listGrowthCampaigns(input: {
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<GrowthCampaignsView> {
  const db = input.db ?? defaultDb;
  const context = await loadGrowthContext({
    db,
    selector: { role: growthWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const config = input.config ?? {};
  const state = optionalString(config.state);
  const channel = optionalString(config.channel);
  const snapshot = await getGrowthWorkerSnapshot({
    tenantSlug: context.worker.tenantSlug,
    workerId: context.worker.id,
    role: growthWorkerRole,
    db,
  });
  const campaigns = snapshot.campaigns.filter((campaign) => {
    const data = objectValue(campaign.data);
    const campaignData = objectValue(data.campaign);

    return (
      (!state || campaign.state === state) &&
      (!channel || optionalString(campaignData.channel) === channel)
    );
  });
  const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
  const contentDrafts = snapshot.contentDrafts.filter((draft) => {
    const data = objectValue(draft.data);
    const campaignObjectId = optionalString(data.campaignObjectId);

    return !campaignObjectId || campaignIds.has(campaignObjectId);
  });

  return {
    worker: snapshot.worker,
    controls: snapshot.controls,
    filters: {
      state: state ?? null,
      channel: channel ?? null,
    },
    campaigns,
    contentDrafts,
    approvals: snapshot.approvals,
  };
}
