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

export const offerPricingWorkerRole = "offer_pricing_operations";

const source = "continuous.worker";
const marginReviewCapabilityKey = "margin.review.prepare";
const marginReviewWorkflowKey = "pricing_margin_review";
const marginReviewUnits = 2400;
const pricePolicyViewKey = "pricing.price_policy";
const pricePolicyViewVersion = "1.0.0";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type OfferPricingWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type OfferPricingContext = {
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
  capabilityId: string;
  budgetAccountId: string;
};

type QuoteLine = {
  index: number;
  lineId: string;
  offerObjectId: string | null;
  description: string;
  quantity: number;
  unitPriceCents: number;
  totalCents: number;
  costBasisCents: number;
  marginPercent: number;
  discountPercent: number;
  marginState: "pass" | "exception";
  discountState: "pass" | "exception";
};

type PricingHandoff = {
  quote: {
    id: string;
    name: string;
    state: string;
    data: JsonObject;
  };
  lead: {
    id: string;
    name: string;
  } | null;
  customer: {
    id: string;
    name: string;
  } | null;
  evidencePacket: {
    id: string;
    kind: string;
    state: string;
    data: JsonObject;
  };
  marginRule: {
    id: string;
    name: string;
    data: JsonObject;
  };
  discountPolicy: {
    id: string;
    name: string;
    data: JsonObject;
  };
  priceBook: {
    id: string;
    name: string;
    data: JsonObject;
  } | null;
  sourceRefs: JsonObject;
  policyRefs: JsonObject;
  quoteLines: QuoteLine[];
  marginRuleMinPercent: number;
  discountApprovalThresholdPercent: number;
  marginExceptions: QuoteLine[];
  discountExceptions: QuoteLine[];
  approvalRequired: boolean;
  verdict: "pass" | "review_required";
};

export type OfferPricingMarginReviewPrepareResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  pricingReviewObjectId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  pricePolicyViewId: string | null;
  externalExecution: "blocked";
  externalPublish: "blocked";
  externalSend: false;
  output: JsonObject;
  snapshot: OfferPricingWorkerSnapshot;
};

export type OfferPricingWorkerSnapshot = {
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
  };
  pricingReviews: Array<{
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
  generatedViews: Array<{
    id: string;
    key: string;
    name: string;
    active: boolean;
    data: JsonObject;
  }>;
  latestRun: {
    id: string;
    eventId: string | null;
    idempotencyKey: string;
    state: string;
    mode: string;
    output: JsonObject;
  } | null;
};

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function nullishString(value: unknown) {
  return optionalString(value) ?? null;
}

function uuidValue(value: unknown) {
  const text = optionalString(value);

  return text && uuidPattern.test(text) ? text : undefined;
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function jsonObjectList(value: unknown) {
  return Array.isArray(value)
    ? value.map(objectValue).filter((item) => Object.keys(item).length > 0)
    : [];
}

function booleanValue(value: unknown) {
  return value === true || value === "true";
}

function numberValue(value: unknown, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : fallback;
}

function rounded(value: number) {
  return Math.round(value * 100) / 100;
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

function firstString(...values: unknown[]) {
  for (const value of values) {
    const text = optionalString(value);

    if (text) {
      return text;
    }
  }

  return "";
}

function workerWhere(selector: OfferPricingWorkerSelector) {
  const conditions = [
    eq(workers.role, offerPricingWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: OfferPricingWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Offer and Pricing Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadOfferPricingWorker(db: Database, selector: OfferPricingWorkerSelector) {
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

async function loadOfferPricingContext(input: {
  db: Database;
  selector: OfferPricingWorkerSelector;
  operatorEmail: string;
}): Promise<OfferPricingContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadOfferPricingWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Offer and Pricing Worker matches this selector.",
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
    .where(and(eq(capabilities.key, marginReviewCapabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      "Offer and Pricing Worker requires the margin.review.prepare capability.",
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
      "Offer and Pricing Worker does not have an active margin.review.prepare grant.",
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
      "Offer and Pricing Worker requires an active worker budget account.",
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

function requiredUuid(value: unknown, field: string, code = "invalid_worker_command_config") {
  const id = uuidValue(value);

  if (!id) {
    throw new PlatformUnavailableError(code, `${field} must be a valid Core object id.`, 400);
  }

  return id;
}

async function getObject(input: {
  db: Database;
  tenantId: string;
  objectId: string;
  type?: string;
  missingCode: string;
  missingMessage: string;
}) {
  const conditions = [
    eq(objects.tenantId, input.tenantId),
    eq(objects.id, input.objectId),
  ];

  if (input.type) {
    conditions.push(eq(objects.type, input.type));
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
    .where(and(...conditions))
    .limit(1);

  if (!object) {
    throw new PlatformUnavailableError(input.missingCode, input.missingMessage, 404);
  }

  return object;
}

async function getOptionalObject(input: {
  db: Database;
  tenantId: string;
  objectId?: string;
  type?: string;
  missingCode: string;
  missingMessage: string;
}) {
  if (!input.objectId) {
    return null;
  }

  return getObject({
    db: input.db,
    tenantId: input.tenantId,
    objectId: input.objectId,
    type: input.type,
    missingCode: input.missingCode,
    missingMessage: input.missingMessage,
  });
}

async function getEvidencePacket(input: {
  db: Database;
  tenantId: string;
  evidencePacketId: string;
}) {
  const [packet] = await input.db
    .select({
      id: evidencePackets.id,
      kind: evidencePackets.kind,
      state: evidencePackets.state,
      data: evidencePackets.data,
    })
    .from(evidencePackets)
    .where(
      and(
        eq(evidencePackets.tenantId, input.tenantId),
        eq(evidencePackets.id, input.evidencePacketId),
      ),
    )
    .limit(1);

  if (!packet) {
    throw new PlatformUnavailableError(
      "handoff.evidence_packet_missing",
      "config.sourceRefs.evidencePacketId does not match an evidence packet in this tenant.",
      404,
    );
  }

  return packet;
}

function quoteLinesFrom(quoteData: JsonObject) {
  const nestedQuote = objectValue(quoteData.quote);
  const candidates = [
    quoteData.quoteLines,
    quoteData.lines,
    quoteData.lineItems,
    nestedQuote.quoteLines,
    nestedQuote.lines,
    nestedQuote.lineItems,
  ];

  for (const candidate of candidates) {
    const lines = jsonObjectList(candidate);

    if (lines.length > 0) {
      return lines;
    }
  }

  return [];
}

function normalizeQuoteLine(input: {
  line: JsonObject;
  index: number;
  fallbackMarginRuleId: string;
  fallbackDiscountPolicyId: string;
  minMarginPercent: number;
  discountThresholdPercent: number;
  quoteDiscountPercent: number;
}) {
  const line = input.line;
  const quantity = Math.max(numberValue(line.quantity, 1), 1);
  const unitPriceCents = numberValue(
    line.unitPriceCents ?? line.unit_price_cents ?? line.priceCents ?? line.price_cents,
  );
  const totalCents = numberValue(
    line.totalCents ?? line.total_cents ?? line.amountCents ?? line.amount_cents,
    unitPriceCents * quantity,
  );
  const costBasisCents = numberValue(
    line.costBasisCents ?? line.cost_basis_cents ?? line.costCents ?? line.cost_cents,
  );
  const explicitMarginPercent = numberValue(line.marginPercent ?? line.margin_percent, NaN);
  const marginPercent = Number.isFinite(explicitMarginPercent)
    ? explicitMarginPercent
    : totalCents > 0
      ? ((totalCents - costBasisCents) / totalCents) * 100
      : 0;
  const discountPercent = numberValue(
    line.discountPercent ?? line.discount_percent,
    input.quoteDiscountPercent,
  );
  const marginState = marginPercent < input.minMarginPercent ? "exception" : "pass";
  const discountState = discountPercent > input.discountThresholdPercent ? "exception" : "pass";

  return {
    index: input.index,
    lineId: firstString(line.id, line.lineId, line.quoteLineId, `line-${input.index + 1}`),
    offerObjectId: nullishString(line.offerObjectId ?? line.offerId ?? line.offer_object_id),
    description: firstString(line.description, line.name, `Quote line ${input.index + 1}`),
    quantity,
    unitPriceCents,
    totalCents,
    costBasisCents,
    marginPercent: rounded(marginPercent),
    discountPercent: rounded(discountPercent),
    marginState,
    discountState,
    marginRuleId: firstString(line.marginRuleId, input.fallbackMarginRuleId),
    discountPolicyId: firstString(line.discountPolicyId, input.fallbackDiscountPolicyId),
  } as QuoteLine & { marginRuleId: string; discountPolicyId: string };
}

function assertNoExternalSend(quoteData: JsonObject) {
  const nestedQuote = objectValue(quoteData.quote);

  if (
    booleanValue(quoteData.externalSend) ||
    booleanValue(quoteData.external_send) ||
    booleanValue(quoteData.sentExternally) ||
    booleanValue(nestedQuote.externalSend) ||
    booleanValue(nestedQuote.external_send)
  ) {
    throw new PlatformUnavailableError(
      "handoff.external_send_already_true",
      "Offer and Pricing can only consume unsent Revenue quote handoffs.",
      409,
    );
  }
}

async function loadPricingHandoff(input: {
  db: Database;
  tenantId: string;
  config: JsonObject;
}): Promise<PricingHandoff> {
  const sourceRefs = objectValue(input.config.sourceRefs);
  const policy = objectValue(input.config.policy);
  const quoteObjectId = requiredUuid(
    sourceRefs.quoteObjectId,
    "config.sourceRefs.quoteObjectId",
    "handoff.quote_missing",
  );
  const evidencePacketId = requiredUuid(
    sourceRefs.evidencePacketId,
    "config.sourceRefs.evidencePacketId",
    "handoff.evidence_packet_missing",
  );
  const marginRuleId = requiredUuid(
    policy.marginRuleId,
    "config.policy.marginRuleId",
    "handoff.margin_policy_missing",
  );
  const discountPolicyId = requiredUuid(
    policy.discountPolicyId,
    "config.policy.discountPolicyId",
    "handoff.discount_policy_missing",
  );
  const priceBookId = uuidValue(policy.priceBookId ?? sourceRefs.priceBookId);
  const quote = await getObject({
    db: input.db,
    tenantId: input.tenantId,
    objectId: quoteObjectId,
    type: "quote",
    missingCode: "handoff.quote_missing",
    missingMessage: "config.sourceRefs.quoteObjectId does not match a quote object in this tenant.",
  });

  assertNoExternalSend(quote.data);

  const [lead, customer, packet, marginRule, discountPolicy, priceBook] = await Promise.all([
    getOptionalObject({
      db: input.db,
      tenantId: input.tenantId,
      objectId: uuidValue(sourceRefs.leadObjectId),
      type: "lead",
      missingCode: "handoff.lead_missing",
      missingMessage: "config.sourceRefs.leadObjectId does not match a lead object in this tenant.",
    }),
    getOptionalObject({
      db: input.db,
      tenantId: input.tenantId,
      objectId: uuidValue(sourceRefs.customerObjectId),
      type: "customer",
      missingCode: "handoff.customer_missing",
      missingMessage: "config.sourceRefs.customerObjectId does not match a customer object in this tenant.",
    }),
    getEvidencePacket({
      db: input.db,
      tenantId: input.tenantId,
      evidencePacketId,
    }),
    getObject({
      db: input.db,
      tenantId: input.tenantId,
      objectId: marginRuleId,
      type: "margin_rule",
      missingCode: "handoff.margin_policy_missing",
      missingMessage: "config.policy.marginRuleId does not match an active margin rule object.",
    }),
    getObject({
      db: input.db,
      tenantId: input.tenantId,
      objectId: discountPolicyId,
      type: "discount_policy",
      missingCode: "handoff.discount_policy_missing",
      missingMessage: "config.policy.discountPolicyId does not match an active discount policy object.",
    }),
    getOptionalObject({
      db: input.db,
      tenantId: input.tenantId,
      objectId: priceBookId,
      type: "price_book",
      missingCode: "handoff.price_book_missing",
      missingMessage: "config.policy.priceBookId does not match an active price book object.",
    }),
  ]);
  const marginRuleData = objectValue(marginRule.data);
  const discountPolicyData = objectValue(discountPolicy.data);
  const marginRuleMinPercent = numberValue(
    marginRuleData.minMarginPercent ?? marginRuleData.min_margin_percent,
    35,
  );
  const discountApprovalThresholdPercent = numberValue(
    discountPolicyData.approvalThresholdPercent ?? discountPolicyData.approval_threshold_percent,
    numberValue(discountPolicyData.maxDiscountPercent ?? discountPolicyData.max_discount_percent, 0),
  );
  const quoteDiscountPercent = numberValue(
    quote.data.discountPercent ?? quote.data.discount_percent ?? objectValue(quote.data.quote).discountPercent,
  );
  const quoteLines = quoteLinesFrom(quote.data).map((line, index) =>
    normalizeQuoteLine({
      line,
      index,
      fallbackMarginRuleId: marginRule.id,
      fallbackDiscountPolicyId: discountPolicy.id,
      minMarginPercent: marginRuleMinPercent,
      discountThresholdPercent: discountApprovalThresholdPercent,
      quoteDiscountPercent,
    }),
  );

  if (quoteLines.length === 0) {
    throw new PlatformUnavailableError(
      "handoff.quote_missing_lines",
      "Revenue quote handoff must include quote lines before pricing review.",
      409,
    );
  }

  const marginExceptions = quoteLines.filter((line) => line.marginState === "exception");
  const discountExceptions = quoteLines.filter((line) => line.discountState === "exception");
  const approvalRequired =
    policy.requireOwnerApproval !== false ||
    marginExceptions.length > 0 ||
    discountExceptions.length > 0;
  const verdict = marginExceptions.length > 0 || discountExceptions.length > 0
    ? "review_required"
    : "pass";

  return {
    quote,
    lead: lead ? { id: lead.id, name: lead.name } : null,
    customer: customer ? { id: customer.id, name: customer.name } : null,
    evidencePacket: packet,
    marginRule: {
      id: marginRule.id,
      name: marginRule.name,
      data: marginRule.data,
    },
    discountPolicy: {
      id: discountPolicy.id,
      name: discountPolicy.name,
      data: discountPolicy.data,
    },
    priceBook: priceBook ? { id: priceBook.id, name: priceBook.name, data: priceBook.data } : null,
    sourceRefs: {
      quoteObjectId: quote.id,
      leadObjectId: lead?.id ?? null,
      customerObjectId: customer?.id ?? null,
      evidencePacketId: packet.id,
      approvalRequestId: nullishString(sourceRefs.approvalRequestId),
      workflowRunId: nullishString(sourceRefs.workflowRunId),
    },
    policyRefs: {
      marginRuleId: marginRule.id,
      discountPolicyId: discountPolicy.id,
      priceBookId: priceBook?.id ?? null,
      requireOwnerApproval: approvalRequired,
    },
    quoteLines,
    marginRuleMinPercent,
    discountApprovalThresholdPercent,
    marginExceptions,
    discountExceptions,
    approvalRequired,
    verdict,
  };
}

async function writePricePolicyView(input: {
  tx: Transaction;
  tenantId: string;
  capabilityId: string;
  taskState: "approval_required" | "done";
  data: JsonObject;
  now: Date;
}) {
  const [existing] = await input.tx
    .select({ id: generatedViews.id })
    .from(generatedViews)
    .where(
      and(
        eq(generatedViews.tenantId, input.tenantId),
        eq(generatedViews.key, pricePolicyViewKey),
        eq(generatedViews.version, pricePolicyViewVersion),
      ),
    )
    .limit(1);

  const values = {
    tenantId: input.tenantId,
    capabilityId: input.capabilityId,
    key: pricePolicyViewKey,
    version: pricePolicyViewVersion,
    name: "Price policy review",
    purpose: "Review quote-line margin, discount policy, and price-book evidence before any publish or send.",
    surface: "web",
    objectType: "quote",
    taskState: input.taskState,
    contract: {
      schemaVersion: "continuous.ui.price_policy.v1",
      role: offerPricingWorkerRole,
      view: "price_policy",
      sections: ["MarginReview", "PriceBook", "DiscountPolicy", "EvidenceTimeline", "ActionBar"],
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: "blocked",
    } as JsonObject,
    actions: {
      decisionSurface: "/approval",
      decisionCommand: "approval.decide",
      valid: ["approved", "revision_requested", "rejected"],
      postDecisionSurface: "/worker",
      postDecisionCommand: "approval.decide",
      externalExecution: "blocked",
    } as JsonObject,
    data: input.data,
    mask: {
      customerContact: "redacted_by_default",
      rawCostBasis: "summarized",
      secretPricingFormula: "never",
      externalExecution: "blocked",
    } as JsonObject,
    active: true,
    updatedAt: input.now,
  };

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

export async function prepareOfferPricingMarginReview(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<OfferPricingMarginReviewPrepareResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const context = await loadOfferPricingContext({
    db,
    selector: { role: offerPricingWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
  });
  const handoff = await loadPricingHandoff({
    db,
    tenantId: context.worker.tenantId,
    config,
  });
  const inputHash = hashObject({
    schemaVersion: "offer_pricing.margin_review.prepare.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    quoteObjectId: handoff.quote.id,
    evidencePacketId: handoff.evidencePacket.id,
    policyRefs: handoff.policyRefs,
    quoteLines: handoff.quoteLines,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${source}:offer_pricing:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
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

    if (existingRun) {
      const existingInput = objectValue(objectValue(existingRun.data).input);
      const existingHash = optionalString(existingInput.inputHash);

      if (existingHash && existingHash !== inputHash) {
        throw new PlatformUnavailableError(
          "worker_idempotency_conflict",
          "An Offer and Pricing margin review already exists for this idempotency key with different input.",
          409,
        );
      }

      return { status: "replay" as const, replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, marginReviewWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Offer and Pricing Worker requires the pricing_margin_review workflow definition.",
        409,
      );
    }

    const reviewState = handoff.approvalRequired ? "approval_required" : "done";
    const reviewData = {
      command: "margin.review.prepare",
      handoff: {
        name: "revenue.quote_to_pricing",
        sourceWorkerRole: "revenue_operations",
        consumerWorkerRole: offerPricingWorkerRole,
        sourceRefs: handoff.sourceRefs,
      },
      quote: {
        objectId: handoff.quote.id,
        name: handoff.quote.name,
        state: handoff.quote.state,
      },
      lead: handoff.lead,
      customer: handoff.customer,
      quoteLines: handoff.quoteLines,
      margin: {
        ruleId: handoff.marginRule.id,
        ruleName: handoff.marginRule.name,
        minMarginPercent: handoff.marginRuleMinPercent,
        exceptions: handoff.marginExceptions.map((line) => line.lineId),
      },
      discount: {
        policyId: handoff.discountPolicy.id,
        policyName: handoff.discountPolicy.name,
        approvalThresholdPercent: handoff.discountApprovalThresholdPercent,
        exceptions: handoff.discountExceptions.map((line) => line.lineId),
      },
      priceBook: handoff.priceBook
        ? {
            id: handoff.priceBook.id,
            name: handoff.priceBook.name,
          }
        : null,
      verdict: handoff.verdict,
      approvalRequired: handoff.approvalRequired,
      evidencePacketId: handoff.evidencePacket.id,
      policyRefs: handoff.policyRefs,
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: false,
      preparedAt: now.toISOString(),
    } as JsonObject;

    const [reviewObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "pricing_review",
        name: `Pricing review for ${handoff.quote.name}`,
        state: reviewState,
        source,
        externalId: `offer-pricing-margin-review:${input.idempotencyKey}`,
        data: reviewData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id, name: objects.name });

    const objectVersion = await nextObjectVersion(tx, reviewObject.id);
    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: reviewObject.id,
      version: objectVersion,
      data: reviewData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "pricing margin review prepared",
      createdAt: now,
    });

    const reviewLinks: Array<typeof objectLinks.$inferInsert | null> = [
      {
        tenantId: context.worker.tenantId,
        fromId: handoff.quote.id,
        toId: reviewObject.id,
        type: "pricing_review",
        data: { source, command: "margin.review.prepare" },
        effectiveAt: now,
      },
      handoff.lead
        ? {
            tenantId: context.worker.tenantId,
            fromId: handoff.lead.id,
            toId: reviewObject.id,
            type: "pricing_review_source",
            data: { source, command: "margin.review.prepare" },
            effectiveAt: now,
          }
        : null,
      handoff.customer
        ? {
            tenantId: context.worker.tenantId,
            fromId: handoff.customer.id,
            toId: reviewObject.id,
            type: "pricing_review_customer",
            data: { source, command: "margin.review.prepare" },
            effectiveAt: now,
          }
        : null,
    ];

    await tx
      .insert(objectLinks)
      .values(
        reviewLinks.filter((link): link is typeof objectLinks.$inferInsert => link !== null),
      )
      .onConflictDoNothing();

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: reviewObject.id,
        capabilityId: context.capabilityId,
        title: `Review price policy for ${handoff.quote.name}`,
        state: reviewState,
        priority: handoff.verdict === "review_required" ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.worker.managerUserId,
        evidence: {
          handoff: "revenue.quote_to_pricing",
          quoteObjectId: handoff.quote.id,
          evidencePacketId: handoff.evidencePacket.id,
          marginRuleId: handoff.marginRule.id,
          discountPolicyId: handoff.discountPolicy.id,
        },
        outcome: {
          verdict: handoff.verdict,
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: false,
        },
        cost: { units: marginReviewUnits },
        kpi: {
          quoteLinesReviewed: handoff.quoteLines.length,
          marginExceptions: handoff.marginExceptions.length,
          discountExceptions: handoff.discountExceptions.length,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const [run] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: {
            command: "margin.review.prepare",
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
        objectId: reviewObject.id,
        workerId: context.worker.id,
        state: reviewState === "done" ? "review_ready" : "approval_pending",
        idempotencyKey: input.idempotencyKey,
        data: {
          ...reviewData,
          workerRunId: run.id,
        },
        blockers: {
          open: reviewState === "done" ? [] : ["owner_pricing_review_required"],
        },
        metrics: {
          quoteLines: handoff.quoteLines.length,
          marginExceptions: handoff.marginExceptions.length,
          discountExceptions: handoff.discountExceptions.length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.offer_pricing_operations.margin_review_prepared",
        source,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: reviewObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:margin_review_prepared`,
        data: {
          ...reviewData,
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
        objectId: reviewObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "trace",
        name: "Offer and Pricing margin review trace",
        actorType: "worker",
        actorId: context.worker.id,
        hash: `${source}:offer-pricing:${reviewObject.id}:${input.idempotencyKey}`,
        data: {
          inputHash,
          workerRunId: run.id,
          workflowRunId: workflowRun.id,
          reviewObjectId: reviewObject.id,
          sourceRefs: handoff.sourceRefs,
          policyRefs: handoff.policyRefs,
          quoteLines: handoff.quoteLines,
          marginExceptions: handoff.marginExceptions.map((line) => line.lineId),
          discountExceptions: handoff.discountExceptions.map((line) => line.lineId),
          verdict: handoff.verdict,
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: reviewObject.id,
        workflowRunId: workflowRun.id,
        kind: "pricing_review_packet",
        name: `Pricing review packet for ${handoff.quote.name}`,
        state: reviewState === "done" ? "review_ready" : "approval_required",
        sensitivity: "high",
        hash: `${source}:offer-pricing:${reviewObject.id}:${input.idempotencyKey}:document`,
        data: {
          ...reviewData,
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
        objectId: reviewObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "pricing_review_packet",
        name: `Pricing review packet for ${handoff.quote.name}`,
        state: reviewState === "done" ? "review_ready" : "prepared",
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id, handoff.evidencePacket.id] },
        documentIds: { ids: [document.id] },
        data: {
          ...reviewData,
          documentId: document.id,
          sourceEvidencePacketId: handoff.evidencePacket.id,
        },
        hash: `${source}:offer-pricing:${reviewObject.id}:${input.idempotencyKey}:packet`,
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
        objectId: reviewObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.worker.managerUserId,
        kind: "pricing_margin_review_approval",
        state: "pending",
        priority: handoff.verdict === "review_required" ? "high" : "normal",
        risk: handoff.verdict === "review_required" ? "high" : "medium",
        title: `Review pricing policy for ${handoff.quote.name}`,
        summary:
          "Review quote-line margin, discount policy, and price-book evidence. External price publish and customer send remain blocked.",
        requestedAction: {
          action: "review_pricing_packet",
          quoteObjectId: handoff.quote.id,
          pricingReviewObjectId: reviewObject.id,
          packetId: packet.id,
          verdict: handoff.verdict,
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: false,
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds: [traceEvidence.id],
          sourceEvidencePacketId: handoff.evidencePacket.id,
        },
        policy: {
          marginRuleId: handoff.marginRule.id,
          discountPolicyId: handoff.discountPolicy.id,
          requireOwnerApproval: handoff.approvalRequired,
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: "blocked",
        },
        data: {
          ...reviewData,
          packetId: packet.id,
          documentId: document.id,
          evidenceId: traceEvidence.id,
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
          objectId: reviewObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "source_review",
          name: "Resolve Revenue quote handoff",
          state: "done",
          priority: handoff.verdict === "review_required" ? "high" : "normal",
          risk: "medium",
          fromState: "draft",
          toState: "source_review",
          idempotencyKey: `${input.idempotencyKey}:source_review`,
          input: { sourceRefs: handoff.sourceRefs },
          output: {
            quoteObjectId: handoff.quote.id,
            evidencePacketId: handoff.evidencePacket.id,
            quoteLines: handoff.quoteLines.length,
            externalSend: false,
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
          objectId: reviewObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "policy_check",
          name: "Check margin and discount policy",
          state: "done",
          priority: handoff.verdict === "review_required" ? "high" : "normal",
          risk: handoff.verdict === "review_required" ? "high" : "medium",
          fromState: "source_review",
          toState: "policy_check",
          idempotencyKey: `${input.idempotencyKey}:policy_check`,
          input: { policyRefs: handoff.policyRefs, quoteLines: handoff.quoteLines },
          output: {
            verdict: handoff.verdict,
            marginExceptions: handoff.marginExceptions.map((line) => line.lineId),
            discountExceptions: handoff.discountExceptions.map((line) => line.lineId),
            externalExecution: "blocked",
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
          objectId: reviewObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Request pricing review",
          state: "done",
          priority: handoff.verdict === "review_required" ? "high" : "normal",
          risk: handoff.verdict === "review_required" ? "high" : "medium",
          fromState: "policy_check",
          toState: reviewState === "done" ? "review_ready" : "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:approval_request`,
          input: { packetId: packet.id },
          output: {
            approvalRequestId: approval.id,
            packetId: packet.id,
            externalPublish: "blocked",
            externalSend: false,
          },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);

    const pricePolicyViewId = await writePricePolicyView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      taskState: reviewState,
      data: {
        latest: {
          quoteObjectId: handoff.quote.id,
          pricingReviewObjectId: reviewObject.id,
          approvalRequestId: approval.id,
          packetId: packet.id,
          documentId: document.id,
          evidenceId: traceEvidence.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          quoteLines: handoff.quoteLines,
          marginRule: {
            id: handoff.marginRule.id,
            name: handoff.marginRule.name,
            minMarginPercent: handoff.marginRuleMinPercent,
          },
          discountPolicy: {
            id: handoff.discountPolicy.id,
            name: handoff.discountPolicy.name,
            approvalThresholdPercent: handoff.discountApprovalThresholdPercent,
          },
          priceBook: handoff.priceBook
            ? { id: handoff.priceBook.id, name: handoff.priceBook.name }
            : null,
          verdict: handoff.verdict,
          externalExecution: "blocked",
          externalPublish: "blocked",
          externalSend: false,
        },
      },
      now,
    });

    await tx.insert(usageEvents).values({
      tenantId: context.worker.tenantId,
      accountId: context.budgetAccountId,
      taskId: task.id,
      capabilityId: context.capabilityId,
      actorType: "worker",
      actorId: context.worker.id,
      units: marginReviewUnits,
      data: {
        command: "margin.review.prepare",
        mode: "simulation",
        workerRunId: run.id,
        workflowRunId: workflowRun.id,
      },
      createdAt: now,
    });

    const output = {
      command: "margin.review.prepare",
      workerRunId: run.id,
      taskId: task.id,
      eventId: event.id,
      pricingReviewObjectId: reviewObject.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      pricePolicyViewId,
      quoteObjectId: handoff.quote.id,
      quoteLines: handoff.quoteLines,
      marginVerdict: {
        state: handoff.verdict,
        minMarginPercent: handoff.marginRuleMinPercent,
        exceptionLineIds: handoff.marginExceptions.map((line) => line.lineId),
      },
      discountVerdict: {
        state: handoff.discountExceptions.length > 0 ? "review_required" : "pass",
        approvalThresholdPercent: handoff.discountApprovalThresholdPercent,
        exceptionLineIds: handoff.discountExceptions.map((line) => line.lineId),
      },
      handoff: {
        name: "revenue.quote_to_pricing",
        sourceRefs: handoff.sourceRefs,
        pricingReviewObjectId: reviewObject.id,
        approvalRequestId: approval.id,
        packetId: packet.id,
        documentId: document.id,
        workflowRunId: workflowRun.id,
        pricePolicyViewId,
        externalExecution: "blocked",
        externalPublish: "blocked",
        externalSend: false,
      },
      sourceRefs: handoff.sourceRefs,
      policyRefs: handoff.policyRefs,
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: false,
    } as JsonObject;

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        state: "done",
        endedAt: now,
        updatedAt: now,
        data: {
          input: {
            command: "margin.review.prepare",
            inputHash,
            config,
          },
          output,
        },
      })
      .where(eq(workerRuns.id, run.id));

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "worker.offer_pricing_operations.margin_review_prepared",
      source,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: run.id,
      taskId: task.id,
      workerRunId: run.id,
      approvalRequestId: approval.id,
      eventId: event.id,
      objectId: reviewObject.id,
      capabilityId: context.capabilityId,
      risk: handoff.verdict === "review_required" ? "high" : "medium",
      idempotencyKey: `${input.idempotencyKey}:margin_review_prepared`,
      data: output,
      createdAt: now,
    });

    return {
      created: true,
      workerRunId: run.id,
      taskId: task.id,
      eventId: event.id,
      pricingReviewObjectId: reviewObject.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      pricePolicyViewId,
      output,
    };
  });

  if (result.status === "replay") {
    const replay = result.replay;
    const output = outputData(objectValue(replay.data));
    const snapshot = await getOfferPricingWorkerSnapshot({
      tenantSlug: input.tenantSlug,
      workerId: input.workerId,
      db,
    });

    return {
      created: false,
      idempotencyKey: input.idempotencyKey,
      workerRunId: replay.id,
      taskId: replay.taskId,
      eventId: replay.eventId,
      pricingReviewObjectId: nullishString(output.pricingReviewObjectId),
      approvalRequestId: nullishString(output.approvalRequestId),
      evidenceId: nullishString(output.evidenceId),
      packetId: nullishString(output.packetId),
      documentId: nullishString(output.documentId),
      workflowRunId: nullishString(output.workflowRunId),
      workflowStepIds: stringList(output.workflowStepIds),
      pricePolicyViewId: nullishString(output.pricePolicyViewId),
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: false,
      output,
      snapshot,
    };
  }

  const snapshot = await getOfferPricingWorkerSnapshot({
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    db,
  });

  return {
    ...result,
    idempotencyKey: input.idempotencyKey,
    externalExecution: "blocked",
    externalPublish: "blocked",
    externalSend: false,
    snapshot,
  };
}

export async function getOfferPricingWorkerSnapshot(
  input: OfferPricingWorkerSelector & { db?: Database } = {},
) {
  const db = input.db ?? defaultDb;
  const worker = await loadOfferPricingWorker(db, input);

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Offer and Pricing Worker matches this selector.",
      404,
    );
  }

  const [
    budgetAccount,
    used,
    held,
    pendingApprovals,
    generatedViewCount,
    reviewRows,
    approvalRows,
    viewRows,
    latestRun,
  ] = await Promise.all([
    db
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
      .limit(1),
    db
      .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)`, events: count() })
      .from(usageEvents)
      .where(
        and(
          eq(usageEvents.tenantId, worker.tenantId),
          eq(usageEvents.actorType, "worker"),
          eq(usageEvents.actorId, worker.id),
        ),
      ),
    db
      .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)` })
      .from(budgetReservations)
      .where(and(eq(budgetReservations.tenantId, worker.tenantId), eq(budgetReservations.state, "held"))),
    db
      .select({ value: count() })
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
      .select({ value: count() })
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'pricing.%'`)),
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
          eq(objects.type, "pricing_review"),
          eq(objects.source, source),
        ),
      )
      .orderBy(desc(objects.createdAt))
      .limit(10),
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
      .limit(10),
    db
      .select({
        id: generatedViews.id,
        key: generatedViews.key,
        name: generatedViews.name,
        active: generatedViews.active,
        data: generatedViews.data,
      })
      .from(generatedViews)
      .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'pricing.%'`))
      .orderBy(desc(generatedViews.updatedAt))
      .limit(5),
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

  const run = latestRun[0];

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
      accountId: budgetAccount[0]?.id ?? null,
      name: budgetAccount[0]?.name ?? null,
      usedUnits: Number(used[0]?.units ?? 0),
      heldUnits: Number(held[0]?.units ?? 0),
      events: Number(used[0]?.events ?? 0),
    },
    controls: {
      pendingApprovals: Number(pendingApprovals[0]?.value ?? 0),
      generatedViews: Number(generatedViewCount[0]?.value ?? 0),
      externalExecution: "blocked",
      externalPublish: "blocked",
      externalSend: "blocked",
    },
    pricingReviews: reviewRows,
    approvals: approvalRows,
    generatedViews: viewRows,
    latestRun: run
      ? {
          id: run.id,
          eventId: run.eventId,
          idempotencyKey: run.idempotencyKey,
          state: run.state,
          mode: run.mode,
          output: outputData(run.data),
        }
      : null,
  } satisfies OfferPricingWorkerSnapshot;
}

export async function getOfferPricingWorkerSnapshotSafe(
  input: OfferPricingWorkerSelector & { db?: Database } = {},
) {
  try {
    return {
      ok: true as const,
      snapshot: await getOfferPricingWorkerSnapshot(input),
      error: null,
    };
  } catch (error) {
    return {
      ok: false as const,
      snapshot: emptySnapshot(),
      error: error instanceof Error ? error.message : "Unknown Offer and Pricing Worker error.",
    };
  }
}

export async function getOfferPricingPricePolicy(input: {
  tenantSlug?: string;
  workerId?: string;
  config?: JsonObject;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const worker = await loadOfferPricingWorker(db, {
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
    role: offerPricingWorkerRole,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Offer and Pricing Worker matches this selector.",
      404,
    );
  }

  const config = input.config ?? {};
  const quoteObjectId = optionalString(config.quoteObjectId);
  const priceBookId = optionalString(config.priceBookId);
  const conditions = [
    eq(generatedViews.tenantId, worker.tenantId),
    eq(generatedViews.key, pricePolicyViewKey),
    eq(generatedViews.version, pricePolicyViewVersion),
    eq(generatedViews.active, true),
  ];

  if (quoteObjectId) {
    conditions.push(sql`${generatedViews.data}->'latest'->>'quoteObjectId' = ${quoteObjectId}`);
  }

  if (priceBookId) {
    conditions.push(sql`${generatedViews.data}->'latest'->'priceBook'->>'id' = ${priceBookId}`);
  }

  const rows = await db
    .select({
      id: generatedViews.id,
      key: generatedViews.key,
      version: generatedViews.version,
      name: generatedViews.name,
      purpose: generatedViews.purpose,
      data: generatedViews.data,
      actions: generatedViews.actions,
      mask: generatedViews.mask,
      updatedAt: generatedViews.updatedAt,
    })
    .from(generatedViews)
    .where(and(...conditions))
    .orderBy(desc(generatedViews.updatedAt))
    .limit(5);

  return {
    worker: {
      id: worker.id,
      role: worker.role,
      tenantSlug: worker.tenantSlug,
    },
    view: "price_policy",
    filters: {
      quoteObjectId: quoteObjectId ?? null,
      priceBookId: priceBookId ?? null,
    },
    generatedViews: rows.map((row) => ({
      ...row,
      updatedAt: row.updatedAt.toISOString(),
    })),
    latest: objectValue(rows[0]?.data).latest ?? null,
    externalExecution: "blocked",
    externalPublish: "blocked",
    externalSend: "blocked",
  } as JsonObject;
}

function emptySnapshot(): OfferPricingWorkerSnapshot {
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
    },
    pricingReviews: [],
    approvals: [],
    generatedViews: [],
    latestRun: null,
  };
}
