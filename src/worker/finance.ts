import { createHash } from "node:crypto";

import { and, count, desc, eq, inArray, sql } from "drizzle-orm";

import { PlatformUnavailableError } from "../core/errors";
import { loadOperatorContext } from "../core/operators";
import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  adapters,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  documents,
  evidence,
  evidencePackets,
  events,
  generatedViews,
  inferences,
  invoices,
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

export const financeWorkerRole = "finance_operations";

const financeSource = "continuous.finance_worker";
const invoicePrepareCapabilityKey = "invoice.prepare";
const arFollowupDraftCapabilityKey = "payment_link.prepare";
const invoiceDraftWorkflowKey = "invoice_draft";
const arFollowupWorkflowKey = "ar_followup";
const invoicePrepareUnits = 3600;
const arFollowupDraftUnits = 2600;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type FinanceWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type FinanceContext = {
  worker: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    name: string;
    kpis: JsonObject;
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
  accountingConnectionId: string;
};

export type FinanceInvoicePrepareResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  invoiceObjectId: string | null;
  invoiceId: string | null;
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
  financeInvoiceViewId: string | null;
  output: JsonObject;
  snapshot: FinanceWorkerSnapshot;
};

export type FinanceArFollowupDraftResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  arFollowupObjectId: string | null;
  invoiceObjectId: string | null;
  invoiceId: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  draftEvidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  financeArFollowupViewId: string | null;
  output: JsonObject;
  snapshot: FinanceWorkerSnapshot;
};

export type FinanceWorkerSnapshot = {
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
    externalExecution: "dry_run";
    moneyMovement: "blocked";
  };
  invoices: Array<{
    id: string;
    name: string;
    state: string;
    data: JsonObject;
  }>;
  arFollowups: Array<{
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

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false) {
  return typeof value === "boolean" ? value : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }

  const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
    left.localeCompare(right),
  );

  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
}

function hashObject(value: unknown) {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

function traceHash(...parts: string[]) {
  return createHash("sha256").update(parts.join(":")).digest("hex");
}

function outputData(data: JsonObject) {
  return objectValue(data.output);
}

function getWorkflowStepIds(data: JsonObject) {
  const output = outputData(data);
  const fromData = stringList(data.workflowStepIds);
  const fromOutput = stringList(output.workflowStepIds);

  return fromOutput.length > 0 ? fromOutput : fromData;
}

function workerWhere(selector: FinanceWorkerSelector) {
  const conditions = [
    eq(workers.role, financeWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: FinanceWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Finance Operations Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function getObjectById(db: Database, tenantId: string, id: string) {
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

async function loadEvidenceRefs(db: Database, tenantId: string, ids: string[], fieldName: string) {
  if (ids.length === 0) {
    return [];
  }

  if (ids.some((id) => !uuidPattern.test(id))) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      `${fieldName} must contain tenant-scoped evidence ids.`,
      400,
    );
  }

  const rows = await db
    .select({ id: evidence.id })
    .from(evidence)
    .where(and(eq(evidence.tenantId, tenantId), inArray(evidence.id, ids)));

  if (rows.length !== ids.length) {
    throw new PlatformUnavailableError(
      "finance_evidence_not_found",
      `${fieldName} references evidence outside the selected tenant.`,
      404,
    );
  }

  return rows;
}

async function loadFinanceWorker(db: Database, selector: FinanceWorkerSelector) {
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

async function loadFinanceContext(input: {
  db: Database;
  selector: FinanceWorkerSelector;
  operatorEmail: string;
  capabilityKey: string;
  capabilityLabel: string;
}): Promise<FinanceContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadFinanceWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "finance_worker_not_found",
      "No active Finance Operations Worker matches this selector.",
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
    .where(and(eq(capabilities.key, input.capabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      `Finance Operations Worker requires the ${input.capabilityLabel} capability.`,
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
      "worker_capability_missing",
      `Finance Operations Worker is not actively granted ${input.capabilityLabel}.`,
      409,
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
      "Finance Operations Worker has no active budget account.",
      409,
    );
  }

  const [connection] = await input.db
    .select({ id: connections.id })
    .from(connections)
    .innerJoin(adapters, eq(connections.adapterId, adapters.id))
    .where(
      and(
        eq(connections.tenantId, worker.tenantId),
        eq(connections.state, "active"),
        eq(adapters.kind, "accounting"),
      ),
    )
    .orderBy(connections.createdAt)
    .limit(1);

  if (!connection) {
    throw new PlatformUnavailableError(
      "worker_connection_missing",
      "Finance Operations Worker has no active accounting connection.",
      409,
    );
  }

  return {
    worker: {
      id: worker.id,
      tenantId: worker.tenantId,
      tenantSlug: worker.tenantSlug,
      tenantName: worker.tenantName,
      name: worker.name,
      kpis: worker.kpis,
    },
    operator: {
      id: operator.userId,
      email: operator.email,
      name: operator.name,
      actorRef: operator.actorRef,
    },
    reviewerUserId: worker.managerUserId,
    capabilityId: capability.id,
    budgetAccountId: budgetAccount.id,
    accountingConnectionId: connection.id,
  };
}

function normalizeInvoiceLines(config: JsonObject, closeoutData: JsonObject) {
  const sourceLines = Array.isArray(config.billableLines)
    ? config.billableLines
    : Array.isArray(config.lines)
      ? config.lines
      : Array.isArray(closeoutData.billableLines)
        ? closeoutData.billableLines
        : [];

  return sourceLines
    .filter((line): line is JsonObject => Boolean(line && typeof line === "object" && !Array.isArray(line)))
    .map((line) => ({
      description: optionalString(line.description) ?? "Service line",
      amountCents: numberValue(line.amountCents, numberValue(line.amount_cents)),
      currency: optionalString(line.currency) ?? optionalString(config.currency) ?? "USD",
    }))
    .filter((line) => line.amountCents >= 0);
}

async function loadInvoiceRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const closeoutRef =
    optionalString(config.closeoutId) ??
    optionalString(config.closeoutObjectId) ??
    optionalString(sourceRefs.closeoutId) ??
    optionalString(sourceRefs.closeoutObjectId);
  const closeoutObject = closeoutRef ? await getObjectById(db, tenantId, closeoutRef) : null;

  if (closeoutRef && closeoutObject?.type !== "closeout") {
    throw new PlatformUnavailableError(
      "finance_closeout_not_found",
      "Finance invoice prepare requires a tenant-scoped closeout object when config.closeoutId is provided.",
      404,
    );
  }

  const closeoutData = objectValue(closeoutObject?.data);
  const jobRef =
    optionalString(config.jobId) ??
    optionalString(config.jobObjectId) ??
    optionalString(sourceRefs.jobId) ??
    optionalString(sourceRefs.jobObjectId) ??
    optionalString(closeoutData.jobObjectId);

  if (!jobRef) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.jobId, closeoutId, or sourceRefs.jobObjectId is required for invoice.prepare.",
      400,
    );
  }

  const jobObject = await getObjectById(db, tenantId, jobRef);

  if (!jobObject || jobObject.type !== "job") {
    throw new PlatformUnavailableError(
      "finance_job_not_found",
      "Finance invoice prepare requires a tenant-scoped job object.",
      404,
    );
  }

  const jobData = objectValue(jobObject.data);
  const customerRef =
    optionalString(config.customerObjectId) ??
    optionalString(sourceRefs.customerObjectId) ??
    optionalString(closeoutData.customerObjectId) ??
    optionalString(jobData.customerObjectId) ??
    optionalString(jobData.customerId);
  const customerObject = customerRef ? await getObjectById(db, tenantId, customerRef) : null;

  if (customerRef && customerObject?.type !== "customer") {
    throw new PlatformUnavailableError(
      "finance_customer_not_found",
      "Finance invoice prepare requires a tenant-scoped customer object when customerObjectId is provided.",
      404,
    );
  }

  const sourceEvidenceIds = Array.from(
    new Set([
      ...stringList(config.evidenceIds),
      ...stringList(sourceRefs.evidenceIds),
      ...stringList(config.sourceEvidenceIds),
      ...stringList(sourceRefs.sourceEvidenceIds),
      ...stringList(closeoutData.sourceEvidenceIds),
    ]),
  );
  const sourceEvidence = await loadEvidenceRefs(db, tenantId, sourceEvidenceIds, "config.sourceRefs.evidenceIds");
  const invoiceLines = normalizeInvoiceLines(config, closeoutData);
  const subtotalCents = invoiceLines.reduce((total, line) => total + line.amountCents, 0);
  const taxCents = numberValue(config.taxCents, 0);
  const totalCents = subtotalCents + taxCents;
  const currency =
    optionalString(config.currency) ??
    optionalString(invoiceLines[0]?.currency) ??
    optionalString(closeoutData.currency) ??
    "USD";
  const blockers = [
    ...(closeoutObject && !booleanValue(closeoutData.invoiceReady, false) ? ["closeout_not_invoice_ready"] : []),
    ...(invoiceLines.length === 0 ? ["missing_billable_lines"] : []),
    ...(totalCents <= 0 ? ["invoice_total_not_positive"] : []),
  ];
  const dueAt =
    optionalString(config.dueAt) ??
    new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString();

  return {
    sourceRefs,
    closeoutObject,
    closeoutData,
    jobObject,
    customerObject,
    sourceEvidenceIds: sourceEvidence.map((row) => row.id),
    invoiceLines,
    subtotalCents,
    taxCents,
    totalCents,
    currency,
    dueAt,
    blockers,
    policy: objectValue(config.policy),
  };
}

async function loadArFollowupRefs(db: Database, tenantId: string, config: JsonObject) {
  const sourceRefs = objectValue(config.sourceRefs);
  const invoiceRef =
    optionalString(config.invoiceId) ??
    optionalString(config.invoiceObjectId) ??
    optionalString(sourceRefs.invoiceId) ??
    optionalString(sourceRefs.invoiceObjectId);
  const tonePolicy = optionalString(config.tonePolicy);

  if (!invoiceRef) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.invoiceId or sourceRefs.invoiceId is required for ar_followup.draft.",
      400,
    );
  }

  if (!tonePolicy) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.tonePolicy is required for ar_followup.draft.",
      400,
    );
  }

  if (!uuidPattern.test(invoiceRef)) {
    throw new PlatformUnavailableError(
      "invalid_worker_command_config",
      "config.invoiceId must be a tenant-scoped invoice row id or invoice object id.",
      400,
    );
  }

  const [invoiceRowById] = await db
    .select()
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.id, invoiceRef)))
    .limit(1);
  const invoiceObjectById = invoiceRowById ? null : await getObjectById(db, tenantId, invoiceRef);

  if (invoiceObjectById && invoiceObjectById.type !== "invoice") {
    throw new PlatformUnavailableError(
      "finance_invoice_not_found",
      "Finance AR follow-up requires a tenant-scoped invoice object.",
      404,
    );
  }

  const [invoiceRowByObjectId] =
    invoiceObjectById && invoiceObjectById.type === "invoice"
      ? await db
          .select()
          .from(invoices)
          .where(and(eq(invoices.tenantId, tenantId), eq(invoices.objectId, invoiceObjectById.id)))
          .limit(1)
      : [null];
  const invoiceRow = invoiceRowById ?? invoiceRowByObjectId;
  const invoiceObject =
    invoiceObjectById ??
    (invoiceRow?.objectId ? await getObjectById(db, tenantId, invoiceRow.objectId) : null);

  if (!invoiceRow || !invoiceObject || invoiceObject.type !== "invoice") {
    throw new PlatformUnavailableError(
      "finance_invoice_not_found",
      "Finance AR follow-up requires a tenant-scoped invoice row or invoice object.",
      404,
    );
  }

  const invoiceData = objectValue(invoiceObject.data);
  const messageContext = objectValue(config.messageContext);
  const policy = objectValue(config.policy);
  const customerRef =
    optionalString(config.customerObjectId) ??
    optionalString(sourceRefs.customerObjectId) ??
    optionalString(invoiceData.customerObjectId) ??
    optionalString(invoiceData.customerId);
  const jobRef =
    optionalString(config.jobObjectId) ??
    optionalString(sourceRefs.jobObjectId) ??
    optionalString(invoiceData.jobObjectId) ??
    optionalString(invoiceData.jobId);
  const customerObject = customerRef ? await getObjectById(db, tenantId, customerRef) : null;
  const jobObject = jobRef ? await getObjectById(db, tenantId, jobRef) : null;

  if (customerRef && customerObject?.type !== "customer") {
    throw new PlatformUnavailableError(
      "finance_customer_not_found",
      "Finance AR follow-up requires a tenant-scoped customer object when customerObjectId is provided.",
      404,
    );
  }

  if (jobRef && jobObject?.type !== "job") {
    throw new PlatformUnavailableError(
      "finance_job_not_found",
      "Finance AR follow-up requires a tenant-scoped job object when jobObjectId is provided.",
      404,
    );
  }

  const sourceEvidenceIds = Array.from(
    new Set([
      ...stringList(config.evidenceIds),
      ...stringList(sourceRefs.evidenceIds),
      ...stringList(config.sourceEvidenceIds),
      ...stringList(sourceRefs.sourceEvidenceIds),
      ...stringList(invoiceData.sourceEvidenceIds),
    ]),
  );
  const sourceEvidence = await loadEvidenceRefs(db, tenantId, sourceEvidenceIds, "config.sourceRefs.evidenceIds");
  const dueAt = optionalString(config.dueAt) ?? optionalString(invoiceData.dueAt);
  const dueTime = dueAt ? Date.parse(dueAt) : Number.NaN;
  const daysPastDue = Number.isFinite(dueTime)
    ? Math.max(0, Math.ceil((Date.now() - dueTime) / (24 * 60 * 60 * 1000)))
    : numberValue(config.daysPastDue, 0);
  const amountCents = numberValue(invoiceData.totalCents, numberValue(config.amountCents));
  const currency = optionalString(config.currency) ?? optionalString(invoiceData.currency) ?? "USD";
  const channel = optionalString(config.channel) ?? optionalString(messageContext.channel) ?? "email";
  const customerName =
    optionalString(customerObject?.name) ??
    optionalString(messageContext.customerName) ??
    optionalString(invoiceData.customerName) ??
    "customer";
  const invoiceLabel = optionalString(config.invoiceNumber) ?? optionalString(invoiceData.invoiceNumber) ?? invoiceRow.id;
  const blockers = [
    ...(invoiceObject.state === "paid" || invoiceRow.state === "paid" ? ["invoice_already_paid"] : []),
    ...(booleanValue(config.disputed) || booleanValue(policy.disputed) ? ["invoice_disputed"] : []),
    ...(amountCents <= 0 ? ["invoice_total_not_positive"] : []),
    ...(channel !== "email" && channel !== "sms" && channel !== "phone" ? ["unsupported_channel"] : []),
  ];
  const draft =
    optionalString(config.draft) ??
    `Hi ${customerName}, this is a ${tonePolicy} follow-up on invoice ${invoiceLabel} for ${currency} ${(amountCents / 100).toFixed(2)}${dueAt ? ` due ${dueAt.slice(0, 10)}` : ""}. Please review when convenient; no payment link or external send has been executed by Continuous.`;

  return {
    sourceRefs,
    invoiceRow,
    invoiceObject,
    invoiceData,
    customerObject,
    jobObject,
    sourceEvidenceIds: sourceEvidence.map((row) => row.id),
    tonePolicy,
    channel,
    messageContext,
    policy,
    draft,
    amountCents,
    currency,
    dueAt,
    daysPastDue,
    blockers,
  };
}

async function replayedInvoicePrepare(
  db: Database,
  context: FinanceContext,
  run: typeof workerRuns.$inferSelect,
): Promise<FinanceInvoicePrepareResult> {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    taskId: run.taskId,
    eventId: run.eventId ?? optionalString(data.eventId) ?? null,
    invoiceObjectId: optionalString(data.invoiceObjectId) ?? optionalString(output.invoiceObjectId) ?? null,
    invoiceId: optionalString(data.invoiceId) ?? optionalString(output.invoiceId) ?? null,
    approvalRequestId: optionalString(data.approvalRequestId) ?? optionalString(output.approvalRequestId) ?? null,
    adapterRunId: optionalString(data.adapterRunId) ?? optionalString(output.adapterRunId) ?? null,
    adapterActionId: optionalString(data.adapterActionId) ?? optionalString(output.adapterActionId) ?? null,
    adapterReceiptEvidenceId:
      optionalString(data.adapterReceiptEvidenceId) ?? optionalString(output.adapterReceiptEvidenceId) ?? null,
    evidenceId: optionalString(data.evidenceId) ?? optionalString(output.evidenceId) ?? null,
    draftEvidenceId: optionalString(data.draftEvidenceId) ?? optionalString(output.draftEvidenceId) ?? null,
    packetId: optionalString(data.packetId) ?? optionalString(output.packetId) ?? null,
    documentId: optionalString(data.documentId) ?? optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(data.workflowRunId) ?? optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(data),
    financeInvoiceViewId:
      optionalString(data.financeInvoiceViewId) ?? optionalString(output.financeInvoiceViewId) ?? null,
    output,
    snapshot: await getFinanceWorkerSnapshot(db, {
      role: financeWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

async function replayedArFollowupDraft(
  db: Database,
  context: FinanceContext,
  run: typeof workerRuns.$inferSelect,
): Promise<FinanceArFollowupDraftResult> {
  const data = objectValue(run.data);
  const output = outputData(data);

  return {
    created: false,
    idempotencyKey: run.idempotencyKey,
    workerRunId: run.id,
    taskId: run.taskId,
    eventId: run.eventId ?? optionalString(data.eventId) ?? null,
    arFollowupObjectId:
      optionalString(data.arFollowupObjectId) ?? optionalString(output.arFollowupObjectId) ?? null,
    invoiceObjectId: optionalString(data.invoiceObjectId) ?? optionalString(output.invoiceObjectId) ?? null,
    invoiceId: optionalString(data.invoiceId) ?? optionalString(output.invoiceId) ?? null,
    approvalRequestId: optionalString(data.approvalRequestId) ?? optionalString(output.approvalRequestId) ?? null,
    evidenceId: optionalString(data.evidenceId) ?? optionalString(output.evidenceId) ?? null,
    draftEvidenceId: optionalString(data.draftEvidenceId) ?? optionalString(output.draftEvidenceId) ?? null,
    packetId: optionalString(data.packetId) ?? optionalString(output.packetId) ?? null,
    documentId: optionalString(data.documentId) ?? optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(data.workflowRunId) ?? optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(data),
    financeArFollowupViewId:
      optionalString(data.financeArFollowupViewId) ?? optionalString(output.financeArFollowupViewId) ?? null,
    output,
    snapshot: await getFinanceWorkerSnapshot(db, {
      role: financeWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function prepareFinanceInvoice(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<FinanceInvoicePrepareResult> {
  const db = input.db ?? defaultDb;
  const context = await loadFinanceContext({
    db,
    selector: { role: financeWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: invoicePrepareCapabilityKey,
    capabilityLabel: "invoice.prepare",
  });
  const config = input.config ?? {};
  const refs = await loadInvoiceRefs(db, context.worker.tenantId, config);
  const invoiceState = refs.blockers.length === 0 ? "approval_required" : "draft";
  const taskState = refs.blockers.length === 0 ? "approval_required" : "blocked";
  const workflowState = refs.blockers.length === 0 ? "approval_pending" : "blocked";
  const inputHash = hashObject({
    schemaVersion: "finance.invoice.prepare.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    closeoutObjectId: refs.closeoutObject?.id ?? null,
    jobObjectId: refs.jobObject.id,
    customerObjectId: refs.customerObject?.id ?? null,
    sourceEvidenceIds: refs.sourceEvidenceIds,
    invoiceLines: refs.invoiceLines,
    totalCents: refs.totalCents,
    currency: refs.currency,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${financeSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, financeSource),
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
          "A Finance invoice draft already exists for this idempotency key with different input.",
          409,
        );
      }

      return { replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, invoiceDraftWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Finance Operations Worker requires the invoice_draft workflow definition.",
        409,
      );
    }

    const invoiceData = {
      jobObjectId: refs.jobObject.id,
      closeoutObjectId: refs.closeoutObject?.id ?? null,
      customerObjectId: refs.customerObject?.id ?? null,
      sourceRefs: refs.sourceRefs,
      sourceEvidenceIds: refs.sourceEvidenceIds,
      lines: refs.invoiceLines,
      subtotalCents: refs.subtotalCents,
      taxCents: refs.taxCents,
      totalCents: refs.totalCents,
      currency: refs.currency,
      dueAt: refs.dueAt,
      blockers: refs.blockers,
      policy: refs.policy,
      externalExecution: "dry_run",
      externalMutation: false,
      externalSend: false,
      moneyMovement: "blocked",
    } satisfies JsonObject;

    const [invoiceObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "invoice",
        name: `Invoice draft for ${refs.jobObject.name}`,
        state: invoiceState,
        source: financeSource,
        externalId: `finance-invoice:${input.idempotencyKey}`,
        data: invoiceData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: invoiceObject.id,
      version: 1,
      data: invoiceData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "finance invoice draft",
      createdAt: now,
    });

    const [invoice] = await tx
      .insert(invoices)
      .values({
        tenantId: context.worker.tenantId,
        objectId: invoiceObject.id,
        state: invoiceState,
        externalId: `finance-invoice:${input.idempotencyKey}`,
        data: invoiceData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: invoices.id });

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: invoiceObject.id,
          toId: refs.jobObject.id,
          type: "prepared_from",
          data: { source: financeSource },
          effectiveAt: now,
        },
        ...(refs.customerObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: invoiceObject.id,
                toId: refs.customerObject.id,
                type: "bills_customer",
                data: { source: financeSource },
                effectiveAt: now,
              },
            ]
          : []),
        ...(refs.closeoutObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: invoiceObject.id,
                toId: refs.closeoutObject.id,
                type: "prepared_from_closeout",
                data: { source: financeSource },
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
        objectId: invoiceObject.id,
        capabilityId: context.capabilityId,
        title: `Review invoice draft for ${refs.jobObject.name}`,
        state: taskState,
        priority: refs.blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          required: ["job_closeout", "invoice_draft", "cash_packet"],
          blockers: refs.blockers,
          sourceEvidenceIds: refs.sourceEvidenceIds,
        },
        outcome: {
          status: refs.blockers.length > 0 ? "invoice_blocked" : "invoice_approval_needed",
          financeHandoff: "finance.invoice_to_owner_review",
        },
        cost: { units: invoicePrepareUnits },
        kpi: { invoices_prepared: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const runInput = {
      command: "invoice.prepare",
      inputHash,
      config,
      invoiceObjectId: invoiceObject.id,
      invoiceId: invoice.id,
      jobObjectId: refs.jobObject.id,
      closeoutObjectId: refs.closeoutObject?.id ?? null,
      customerObjectId: refs.customerObject?.id ?? null,
      sourceEvidenceIds: refs.sourceEvidenceIds,
      totalCents: refs.totalCents,
      currency: refs.currency,
    } satisfies JsonObject;

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        connectionId: context.accountingConnectionId,
        budgetAccountId: context.budgetAccountId,
        source: financeSource,
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

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: invoiceObject.id,
        workerId: context.worker.id,
        state: workflowState,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          inputHash,
          externalExecution: "dry_run",
          moneyMovement: "blocked",
        },
        blockers: { open: refs.blockers },
        metrics: {
          budgetUnits: invoicePrepareUnits,
          invoicesPrepared: 1,
          totalCents: refs.totalCents,
          blockerCount: refs.blockers.length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [adapterRun] = await tx
      .insert(adapterRuns)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.accountingConnectionId,
        workerRunId: workerRun.id,
        mode: "dry_run",
        operation: "invoice.prepare",
        idempotencyKey: `${input.idempotencyKey}:adapter_run`,
        state: "done",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "matched",
        readCount: 1,
        writeCount: 0,
        receipt: {
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
          reconciliationState: "matched",
        },
        data: {
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          totalCents: refs.totalCents,
          currency: refs.currency,
        },
        startedAt: now,
        endedAt: now,
      })
      .returning({ id: adapterRuns.id });

    const [adapterAction] = await tx
      .insert(adapterActions)
      .values({
        tenantId: context.worker.tenantId,
        connectionId: context.accountingConnectionId,
        adapterRunId: adapterRun.id,
        capabilityId: context.capabilityId,
        taskId: task.id,
        idempotencyKey: `${input.idempotencyKey}:invoice_draft`,
        state: "done",
        mode: "dry_run",
        operation: "invoice.prepare",
        attempt: 1,
        maxAttempts: 3,
        reconciliationState: "matched",
        request: {
          invoiceObjectId: invoiceObject.id,
          lines: refs.invoiceLines,
          totalCents: refs.totalCents,
          currency: refs.currency,
        },
        response: {
          status: "prepared",
          draftExternalId: `dry-run:${invoiceObject.id}`,
          validationWarnings: refs.blockers,
        },
        receipt: {
          receiptId: traceHash(input.idempotencyKey, "accounting_receipt"),
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
          reconciliationState: "matched",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: adapterActions.id });

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task.id,
        units: invoicePrepareUnits,
        state: "used",
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: budgetReservations.id });

    const [inference] = await tx
      .insert(inferences)
      .values({
        tenantId: context.worker.tenantId,
        budgetAccountId: context.budgetAccountId,
        taskId: task.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        promptHash: traceHash(input.idempotencyKey, "finance-invoice"),
        request: {
          mode: "deterministic",
          objective: "Prepare an invoice draft from tenant-scoped closeout and job evidence.",
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          inputHash,
        },
        result: {
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          totalCents: refs.totalCents,
          currency: refs.currency,
          blockers: refs.blockers,
          externalExecution: "dry_run",
        },
        safety: {
          externalExecution: "dry_run",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
        },
        promptTokens: 240,
        completionTokens: 110,
        units: invoicePrepareUnits,
        costUsd: "0.000000",
        latencyMs: 80,
        createdAt: now,
      })
      .returning({ id: inferences.id });

    const [usage] = await tx
      .insert(usageEvents)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        reservationId: reservation.id,
        inferenceId: inference.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        units: invoicePrepareUnits,
        costUsd: "0.000000",
        data: {
          mode: "deterministic",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          invoiceObjectId: invoiceObject.id,
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "finance_worker.invoice_prepare.completed",
        source: financeSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: invoiceObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        connectionId: context.accountingConnectionId,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          totalCents: refs.totalCents,
          currency: refs.currency,
          externalExecution: "dry_run",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
          inputHash,
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    await tx.update(workerRuns).set({ eventId: event.id, updatedAt: now }).where(eq(workerRuns.id, workerRun.id));
    await tx.update(adapterRuns).set({ eventId: event.id }).where(eq(adapterRuns.id, adapterRun.id));
    await tx.update(adapterActions).set({ eventId: event.id, updatedAt: now }).where(eq(adapterActions.id, adapterAction.id));

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Finance invoice prepare trace",
        objectId: invoiceObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          inputHash,
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          sourceEvidenceIds: refs.sourceEvidenceIds,
          externalExecution: "dry_run",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [draftEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "draft",
        name: "Invoice draft",
        objectId: invoiceObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "invoice_draft"),
        data: invoiceData,
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [receiptEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "receipt",
        name: "Accounting dry-run receipt",
        objectId: invoiceObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "adapter",
        actorId: context.accountingConnectionId,
        hash: traceHash(input.idempotencyKey, "accounting_receipt"),
        data: {
          adapterRunId: adapterRun.id,
          adapterActionId: adapterAction.id,
          invoiceObjectId: invoiceObject.id,
          draftExternalId: `dry-run:${invoiceObject.id}`,
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
          reconciliationState: "matched",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: invoiceObject.id,
        workflowRunId: workflowRun.id,
        kind: "finance_invoice_draft",
        name: `Invoice draft for ${refs.jobObject.name}`,
        state: invoiceState,
        sensitivity: "medium",
        hash: traceHash(input.idempotencyKey, "document"),
        data: invoiceData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        objectId: invoiceObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "cash_packet",
        name: "Finance invoice evidence packet",
        state: refs.blockers.length > 0 ? "blocked" : "review_ready",
        sensitivity: "medium",
        evidenceIds: { ids: [traceEvidence.id, draftEvidence.id, receiptEvidence.id, ...refs.sourceEvidenceIds] },
        documentIds: { ids: [document.id] },
        data: {
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          totalCents: refs.totalCents,
          currency: refs.currency,
          workflowRunId: workflowRun.id,
          financeHandoff: "finance.invoice_to_owner_review",
          externalExecution: "dry_run",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
        },
        hash: traceHash(input.idempotencyKey, "cash_packet"),
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
        objectId: invoiceObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "finance_invoice_approval",
        state: "pending",
        priority: refs.blockers.length > 0 ? "high" : "normal",
        risk: "medium",
        title: `Approve invoice draft for ${refs.jobObject.name}`,
        summary:
          "Finance Operations Worker prepared an invoice draft and accounting dry-run receipt; sends and money movement remain blocked.",
        requestedAction: {
          action: refs.blockers.length > 0 ? "request_revision" : "approve_invoice",
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          totalCents: refs.totalCents,
          currency: refs.currency,
          blockers: refs.blockers,
          externalExecution: "dry_run",
          moneyMovement: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          sourceEvidenceIds: refs.sourceEvidenceIds,
        },
        policy: {
          invoiceSend: "approval_required",
          paymentLink: "blocked",
          moneyMovement: "blocked",
          externalExecution: "dry_run",
        },
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          invoiceObjectId: invoiceObject.id,
          financeHandoff: "finance.invoice_to_owner_review",
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });

    const stepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: invoiceObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "handoff",
          name: "Finance source context accepted",
          state: "done",
          toState: "source_review",
          idempotencyKey: `${input.idempotencyKey}:source_context`,
          input: { sourceRefs: refs.sourceRefs },
          output: {
            jobObjectId: refs.jobObject.id,
            closeoutObjectId: refs.closeoutObject?.id ?? null,
          },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: invoiceObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "Invoice draft prepared",
          state: "done",
          fromState: "source_review",
          toState: refs.blockers.length > 0 ? "blocked" : "invoice_ready",
          idempotencyKey: `${input.idempotencyKey}:invoice_ready`,
          input: { invoiceObjectId: invoiceObject.id },
          output: { invoiceId: invoice.id, draftEvidenceId: draftEvidence.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          objectId: invoiceObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Invoice approval requested",
          state: "done",
          fromState: refs.blockers.length > 0 ? "blocked" : "invoice_ready",
          toState: workflowState,
          idempotencyKey: `${input.idempotencyKey}:approval_requested`,
          input: { approvalRequestId: approval.id },
          output: { packetId: packet.id, documentId: document.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });

    const workflowStepIds = stepRows.map((step) => step.id);
    const viewKey = "finance.invoice.review";
    const viewVersion = "1.0.0";
    const viewValues = {
      capabilityId: context.capabilityId,
      key: viewKey,
      version: viewVersion,
      name: "Finance invoice review",
      purpose: "Let an operator review an invoice draft, source closeout proof, and accounting dry-run receipt.",
      surface: "web",
      objectType: "invoice",
      taskState: taskState as "approval_required" | "blocked",
      contract: {
        sections: ["InvoiceSummary", "SourceCloseout", "AccountingReceipt", "EvidenceTimeline", "ActionBar"],
        externalExecution: "dry_run",
        moneyMovement: "blocked",
      } as JsonObject,
      actions: {
        decisionSurface: "/approval",
        decisionCommand: "approval.decide",
        valid: ["approved", "revision_requested", "rejected"],
        invoiceActions: ["approve_invoice", "request_revision", "void_draft"],
        externalExecution: "dry_run",
        moneyMovement: "blocked",
      } as JsonObject,
      data: {
        latest: {
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          taskId: task.id,
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
          jobObjectId: refs.jobObject.id,
          closeoutObjectId: refs.closeoutObject?.id ?? null,
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          adapterReceiptEvidenceId: receiptEvidence.id,
          totalCents: refs.totalCents,
          currency: refs.currency,
          blockers: refs.blockers,
          financeHandoff: "finance.invoice_to_owner_review",
          externalExecution: "dry_run",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
        },
      } as JsonObject,
      mask: {
        customer_contact: "redacted_by_default",
        payment_fields: "blocked",
        moneyMovement: "blocked",
      } as JsonObject,
      active: true,
      updatedAt: now,
    };
    const [existingView] = await tx
      .select({ id: generatedViews.id })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, context.worker.tenantId),
          eq(generatedViews.key, viewKey),
          eq(generatedViews.version, viewVersion),
        ),
      )
      .limit(1);
    const [view] = existingView
      ? await tx
          .update(generatedViews)
          .set(viewValues)
          .where(eq(generatedViews.id, existingView.id))
          .returning({ id: generatedViews.id })
      : await tx
          .insert(generatedViews)
          .values({
            tenantId: context.worker.tenantId,
            ...viewValues,
            createdAt: now,
          })
          .returning({ id: generatedViews.id });

    await tx.insert(events).values({
      tenantId: context.worker.tenantId,
      type: existingView ? "view.updated" : "view.published",
      source: financeSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      objectId: invoiceObject.id,
      taskId: task.id,
      capabilityId: context.capabilityId,
      idempotencyKey: `${input.idempotencyKey}:finance_invoice_view`,
      data: {
        key: viewKey,
        version: viewVersion,
        viewId: view.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
      },
      occurredAt: now,
      createdAt: now,
    });

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "finance_worker.invoice_prepare.completed",
      source: financeSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: workerRun.id,
      taskId: task.id,
      workerRunId: workerRun.id,
      approvalRequestId: approval.id,
      eventId: event.id,
      objectId: invoiceObject.id,
      capabilityId: context.capabilityId,
      risk: "medium",
      idempotencyKey: `${input.idempotencyKey}:audit`,
      data: {
        operatorEmail: context.operator.email,
        inputHash,
        totalCents: refs.totalCents,
        currency: refs.currency,
        externalExecution: "dry_run",
        externalMutation: false,
        externalSend: false,
        moneyMovement: "blocked",
      },
      createdAt: now,
    });

    const output = {
      invoiceObjectId: invoiceObject.id,
      invoiceId: invoice.id,
      jobObjectId: refs.jobObject.id,
      closeoutObjectId: refs.closeoutObject?.id ?? null,
      customerObjectId: refs.customerObject?.id ?? null,
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
      financeInvoiceViewId: view.id,
      state: invoiceState,
      lines: refs.invoiceLines,
      subtotalCents: refs.subtotalCents,
      taxCents: refs.taxCents,
      totalCents: refs.totalCents,
      currency: refs.currency,
      dueAt: refs.dueAt,
      blockers: refs.blockers,
      financeHandoff: {
        name: "finance.invoice_to_owner_review",
        status: refs.blockers.length > 0 ? "blocked_for_revision" : "ready_for_owner_review",
        externalExecution: "blocked",
        moneyMovement: "blocked",
      },
      externalExecution: "dry_run",
      externalMutation: false,
      externalSend: false,
      moneyMovement: "blocked",
      requiresApproval: true,
    } satisfies JsonObject;

    await tx
      .update(workerRuns)
      .set({
        state: "done",
        eventId: event.id,
        data: {
          input: runInput,
          output,
          eventId: event.id,
          taskId: task.id,
          invoiceObjectId: invoiceObject.id,
          invoiceId: invoice.id,
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
          financeInvoiceViewId: view.id,
          reservationId: reservation.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, workerRun.id));

    await tx
      .update(workers)
      .set({
        kpis: {
          ...context.worker.kpis,
          invoices_prepared: numberValue(context.worker.kpis.invoices_prepared) + 1,
          owner_review_packets: numberValue(context.worker.kpis.owner_review_packets) + 1,
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      replay: null,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      invoiceObjectId: invoiceObject.id,
      invoiceId: invoice.id,
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
      financeInvoiceViewId: view.id,
      output,
    };
  });

  if (result.replay) {
    return replayedInvoicePrepare(db, context, result.replay);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    invoiceObjectId: result.invoiceObjectId,
    invoiceId: result.invoiceId,
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
    financeInvoiceViewId: result.financeInvoiceViewId,
    output: result.output,
    snapshot: await getFinanceWorkerSnapshot(db, {
      role: financeWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function draftFinanceArFollowup(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<FinanceArFollowupDraftResult> {
  const db = input.db ?? defaultDb;
  const context = await loadFinanceContext({
    db,
    selector: { role: financeWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: arFollowupDraftCapabilityKey,
    capabilityLabel: "payment_link.prepare",
  });
  const config = input.config ?? {};
  const refs = await loadArFollowupRefs(db, context.worker.tenantId, config);
  const followupState = refs.blockers.length === 0 ? "approval_required" : "blocked";
  const workflowState = refs.blockers.length === 0 ? "approval_pending" : "blocked";
  const inputHash = hashObject({
    schemaVersion: "finance.ar_followup.draft.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    invoiceObjectId: refs.invoiceObject.id,
    invoiceId: refs.invoiceRow.id,
    customerObjectId: refs.customerObject?.id ?? null,
    jobObjectId: refs.jobObject?.id ?? null,
    sourceEvidenceIds: refs.sourceEvidenceIds,
    draft: refs.draft,
    tonePolicy: refs.tonePolicy,
    channel: refs.channel,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${financeSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, financeSource),
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
          "A Finance AR follow-up draft already exists for this idempotency key with different input.",
          409,
        );
      }

      return { replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, arFollowupWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Finance Operations Worker requires the ar_followup workflow definition.",
        409,
      );
    }

    const followupData = {
      invoiceObjectId: refs.invoiceObject.id,
      invoiceId: refs.invoiceRow.id,
      customerObjectId: refs.customerObject?.id ?? null,
      jobObjectId: refs.jobObject?.id ?? null,
      sourceRefs: refs.sourceRefs,
      sourceEvidenceIds: refs.sourceEvidenceIds,
      tonePolicy: refs.tonePolicy,
      channel: refs.channel,
      draft: refs.draft,
      amountCents: refs.amountCents,
      currency: refs.currency,
      dueAt: refs.dueAt ?? null,
      daysPastDue: refs.daysPastDue,
      blockers: refs.blockers,
      policy: refs.policy,
      paymentLink: {
        prepared: false,
        status: "blocked",
        reason: "payment_link_execution_blocked",
      },
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
      moneyMovement: "blocked",
    } satisfies JsonObject;

    const [arFollowup] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "ar_followup",
        name: `AR follow-up draft for ${refs.invoiceObject.name}`,
        state: followupState,
        source: financeSource,
        externalId: `finance-ar-followup:${input.idempotencyKey}`,
        data: followupData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: arFollowup.id,
      version: 1,
      data: followupData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "finance AR follow-up draft",
      createdAt: now,
    });

    await tx
      .insert(objectLinks)
      .values([
        {
          tenantId: context.worker.tenantId,
          fromId: arFollowup.id,
          toId: refs.invoiceObject.id,
          type: "follows_up_invoice",
          data: { source: financeSource },
          effectiveAt: now,
        },
        ...(refs.customerObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: arFollowup.id,
                toId: refs.customerObject.id,
                type: "for_customer",
                data: { source: financeSource },
                effectiveAt: now,
              },
            ]
          : []),
        ...(refs.jobObject
          ? [
              {
                tenantId: context.worker.tenantId,
                fromId: arFollowup.id,
                toId: refs.jobObject.id,
                type: "about_job",
                data: { source: financeSource },
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
        objectId: arFollowup.id,
        capabilityId: context.capabilityId,
        title: `Review AR follow-up draft for ${refs.invoiceObject.name}`,
        state: followupState,
        priority: refs.blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          required: ["invoice_snapshot", "ar_followup_draft", "cash_packet"],
          blockers: refs.blockers,
          sourceEvidenceIds: refs.sourceEvidenceIds,
        },
        outcome: {
          status: refs.blockers.length > 0 ? "ar_followup_blocked" : "ar_followup_approval_needed",
          externalSend: false,
        },
        cost: { units: arFollowupDraftUnits },
        kpi: { ar_followups_drafted: 1 },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: tasks.id });

    const runInput = {
      command: "ar_followup.draft",
      inputHash,
      config,
      arFollowupObjectId: arFollowup.id,
      invoiceObjectId: refs.invoiceObject.id,
      invoiceId: refs.invoiceRow.id,
      customerObjectId: refs.customerObject?.id ?? null,
      jobObjectId: refs.jobObject?.id ?? null,
      sourceEvidenceIds: refs.sourceEvidenceIds,
      tonePolicy: refs.tonePolicy,
      channel: refs.channel,
    } satisfies JsonObject;

    const [workerRun] = await tx
      .insert(workerRuns)
      .values({
        tenantId: context.worker.tenantId,
        workerId: context.worker.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        budgetAccountId: context.budgetAccountId,
        source: financeSource,
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

    const [workflowRun] = await tx
      .insert(workflowRuns)
      .values({
        tenantId: context.worker.tenantId,
        definitionId: definition.id,
        objectId: arFollowup.id,
        workerId: context.worker.id,
        state: workflowState,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          inputHash,
          externalExecution: "blocked",
          externalSend: false,
          moneyMovement: "blocked",
        },
        blockers: { open: ["external_send_blocked", "payment_link_blocked", ...refs.blockers] },
        metrics: {
          budgetUnits: arFollowupDraftUnits,
          arFollowupsDrafted: 1,
          amountCents: refs.amountCents,
          blockerCount: refs.blockers.length,
        },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [reservation] = await tx
      .insert(budgetReservations)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        taskId: task.id,
        units: arFollowupDraftUnits,
        state: "used",
        expiresAt: new Date(now.getTime() + 15 * 60 * 1000),
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: budgetReservations.id });

    const [inference] = await tx
      .insert(inferences)
      .values({
        tenantId: context.worker.tenantId,
        budgetAccountId: context.budgetAccountId,
        taskId: task.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        promptHash: traceHash(input.idempotencyKey, "finance-ar-followup"),
        request: {
          mode: "deterministic",
          objective: "Draft an AR follow-up from tenant-scoped invoice evidence without sending it.",
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          tonePolicy: refs.tonePolicy,
          inputHash,
        },
        result: {
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          draft: refs.draft,
          requiresApproval: true,
          externalSend: false,
        },
        safety: {
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          paymentLink: "blocked",
          moneyMovement: "blocked",
        },
        promptTokens: 220,
        completionTokens: 100,
        units: arFollowupDraftUnits,
        costUsd: "0.000000",
        latencyMs: 70,
        createdAt: now,
      })
      .returning({ id: inferences.id });

    const [usage] = await tx
      .insert(usageEvents)
      .values({
        tenantId: context.worker.tenantId,
        accountId: context.budgetAccountId,
        reservationId: reservation.id,
        inferenceId: inference.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        units: arFollowupDraftUnits,
        costUsd: "0.000000",
        data: {
          mode: "deterministic",
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          arFollowupObjectId: arFollowup.id,
        },
        createdAt: now,
      })
      .returning({ id: usageEvents.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "finance_worker.ar_followup_draft.completed",
        source: financeSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: arFollowup.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: input.idempotencyKey,
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          tonePolicy: refs.tonePolicy,
          channel: refs.channel,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
          inputHash,
        },
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    await tx.update(workerRuns).set({ eventId: event.id, updatedAt: now }).where(eq(workerRuns.id, workerRun.id));

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "trace",
        name: "Finance AR follow-up trace",
        objectId: arFollowup.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: inputHash,
        data: {
          inputHash,
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          sourceEvidenceIds: refs.sourceEvidenceIds,
          externalExecution: "blocked",
          externalSend: false,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [draftEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        kind: "draft",
        name: "AR follow-up draft",
        objectId: arFollowup.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        hash: traceHash(input.idempotencyKey, "ar_followup_draft"),
        data: followupData,
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: arFollowup.id,
        workflowRunId: workflowRun.id,
        kind: "finance_ar_followup_draft",
        name: `AR follow-up draft for ${refs.invoiceObject.name}`,
        state: followupState,
        sensitivity: "medium",
        hash: traceHash(input.idempotencyKey, "document"),
        data: followupData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        objectId: arFollowup.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "cash_packet",
        name: "Finance AR follow-up evidence packet",
        state: refs.blockers.length > 0 ? "blocked" : "review_ready",
        sensitivity: "medium",
        evidenceIds: { ids: [traceEvidence.id, draftEvidence.id, ...refs.sourceEvidenceIds] },
        documentIds: { ids: [document.id] },
        data: {
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          amountCents: refs.amountCents,
          currency: refs.currency,
          workflowRunId: workflowRun.id,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
        },
        hash: traceHash(input.idempotencyKey, "ar_followup_packet"),
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
        objectId: arFollowup.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "finance_ar_followup_approval",
        state: "pending",
        priority: refs.blockers.length > 0 ? "high" : "normal",
        risk: refs.blockers.length > 0 ? "high" : "medium",
        title: `Approve AR follow-up for ${refs.invoiceObject.name}`,
        summary:
          "Finance Operations Worker drafted an AR follow-up and payment-link preparation packet; external sends and money movement remain blocked.",
        requestedAction: {
          action: refs.blockers.length > 0 ? "request_revision" : "approve_ar_followup",
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          channel: refs.channel,
          tonePolicy: refs.tonePolicy,
          blockers: refs.blockers,
          externalSend: false,
          paymentLink: "blocked",
          moneyMovement: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          sourceEvidenceIds: refs.sourceEvidenceIds,
        },
        policy: {
          customerSend: "blocked",
          paymentLink: "blocked",
          moneyMovement: "blocked",
          externalExecution: "blocked",
        },
        data: {
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: approvalRequests.id });

    const stepRows = await tx
      .insert(workflowSteps)
      .values([
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: arFollowup.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "handoff",
          name: "Finance AR invoice context accepted",
          state: "done",
          toState: "policy_review",
          idempotencyKey: `${input.idempotencyKey}:invoice_context`,
          input: { invoiceObjectId: refs.invoiceObject.id, invoiceId: refs.invoiceRow.id },
          output: { daysPastDue: refs.daysPastDue, amountCents: refs.amountCents },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          objectId: arFollowup.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "worker_action",
          name: "AR follow-up draft prepared",
          state: "done",
          fromState: "policy_review",
          toState: refs.blockers.length > 0 ? "blocked" : "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:draft_prepared`,
          input: { tonePolicy: refs.tonePolicy, channel: refs.channel },
          output: { arFollowupObjectId: arFollowup.id, draftEvidenceId: draftEvidence.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
        {
          tenantId: context.worker.tenantId,
          definitionId: definition.id,
          workflowRunId: workflowRun.id,
          eventId: event.id,
          approvalRequestId: approval.id,
          objectId: arFollowup.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "AR follow-up approval requested",
          state: "done",
          fromState: refs.blockers.length > 0 ? "blocked" : "approval_pending",
          toState: workflowState,
          idempotencyKey: `${input.idempotencyKey}:approval_requested`,
          input: { approvalRequestId: approval.id },
          output: { packetId: packet.id, documentId: document.id },
          startedAt: now,
          completedAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });

    const workflowStepIds = stepRows.map((step) => step.id);
    const viewKey = "finance.ar_followup.review";
    const viewVersion = "1.0.0";
    const viewValues = {
      capabilityId: context.capabilityId,
      key: viewKey,
      version: viewVersion,
      name: "Finance AR follow-up review",
      purpose: "Let an operator review an AR follow-up draft while external sends and payment links remain blocked.",
      surface: "web",
      objectType: "ar_followup",
      taskState: followupState as "approval_required" | "blocked",
      contract: {
        sections: ["InvoiceSummary", "DraftMessage", "PolicyReview", "EvidenceTimeline", "ActionBar"],
        externalExecution: "blocked",
        externalSend: false,
        moneyMovement: "blocked",
      } as JsonObject,
      actions: {
        decisionSurface: "/approval",
        decisionCommand: "approval.decide",
        valid: ["approved", "revision_requested", "rejected"],
        arActions: ["approve_ar_followup", "request_revision", "void_draft"],
        externalExecution: "blocked",
        paymentLink: "blocked",
        moneyMovement: "blocked",
      } as JsonObject,
      data: {
        latest: {
          approvalRequestId: approval.id,
          workerRunId: workerRun.id,
          workflowRunId: workflowRun.id,
          taskId: task.id,
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          packetId: packet.id,
          documentId: document.id,
          traceEvidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          amountCents: refs.amountCents,
          currency: refs.currency,
          tonePolicy: refs.tonePolicy,
          channel: refs.channel,
          blockers: refs.blockers,
          externalExecution: "blocked",
          externalMutation: false,
          externalSend: false,
          moneyMovement: "blocked",
        },
      } as JsonObject,
      mask: {
        customer_contact: "redacted_by_default",
        payment_fields: "blocked",
        moneyMovement: "blocked",
      } as JsonObject,
      active: true,
      updatedAt: now,
    };
    const [existingView] = await tx
      .select({ id: generatedViews.id })
      .from(generatedViews)
      .where(
        and(
          eq(generatedViews.tenantId, context.worker.tenantId),
          eq(generatedViews.key, viewKey),
          eq(generatedViews.version, viewVersion),
        ),
      )
      .limit(1);
    const [view] = existingView
      ? await tx
          .update(generatedViews)
          .set(viewValues)
          .where(eq(generatedViews.id, existingView.id))
          .returning({ id: generatedViews.id })
      : await tx
          .insert(generatedViews)
          .values({
            tenantId: context.worker.tenantId,
            ...viewValues,
            createdAt: now,
          })
          .returning({ id: generatedViews.id });

    await tx.insert(events).values({
      tenantId: context.worker.tenantId,
      type: existingView ? "view.updated" : "view.published",
      source: financeSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      objectId: arFollowup.id,
      taskId: task.id,
      capabilityId: context.capabilityId,
      idempotencyKey: `${input.idempotencyKey}:finance_ar_followup_view`,
      data: {
        key: viewKey,
        version: viewVersion,
        viewId: view.id,
        workerRunId: workerRun.id,
        workflowRunId: workflowRun.id,
      },
      occurredAt: now,
      createdAt: now,
    });

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "finance_worker.ar_followup_draft.completed",
      source: financeSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: workerRun.id,
      taskId: task.id,
      workerRunId: workerRun.id,
      approvalRequestId: approval.id,
      eventId: event.id,
      objectId: arFollowup.id,
      capabilityId: context.capabilityId,
      risk: refs.blockers.length > 0 ? "high" : "medium",
      idempotencyKey: `${input.idempotencyKey}:audit`,
      data: {
        operatorEmail: context.operator.email,
        inputHash,
        invoiceObjectId: refs.invoiceObject.id,
        invoiceId: refs.invoiceRow.id,
        externalExecution: "blocked",
        externalMutation: false,
        externalSend: false,
        moneyMovement: "blocked",
      },
      createdAt: now,
    });

    const output = {
      arFollowupObjectId: arFollowup.id,
      invoiceObjectId: refs.invoiceObject.id,
      invoiceId: refs.invoiceRow.id,
      customerObjectId: refs.customerObject?.id ?? null,
      jobObjectId: refs.jobObject?.id ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      draftEvidenceId: draftEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      financeArFollowupViewId: view.id,
      tonePolicy: refs.tonePolicy,
      channel: refs.channel,
      draft: refs.draft,
      amountCents: refs.amountCents,
      currency: refs.currency,
      dueAt: refs.dueAt ?? null,
      daysPastDue: refs.daysPastDue,
      blockers: refs.blockers,
      externalExecution: "blocked",
      externalMutation: false,
      externalSend: false,
      paymentLink: "blocked",
      moneyMovement: "blocked",
      requiresApproval: true,
    } satisfies JsonObject;

    await tx
      .update(workerRuns)
      .set({
        state: "done",
        eventId: event.id,
        data: {
          input: runInput,
          output,
          eventId: event.id,
          taskId: task.id,
          arFollowupObjectId: arFollowup.id,
          invoiceObjectId: refs.invoiceObject.id,
          invoiceId: refs.invoiceRow.id,
          approvalRequestId: approval.id,
          evidenceId: traceEvidence.id,
          draftEvidenceId: draftEvidence.id,
          packetId: packet.id,
          documentId: document.id,
          workflowRunId: workflowRun.id,
          workflowStepIds,
          financeArFollowupViewId: view.id,
          reservationId: reservation.id,
          inferenceId: inference.id,
          usageEventId: usage.id,
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, workerRun.id));

    await tx
      .update(workers)
      .set({
        kpis: {
          ...context.worker.kpis,
          ar_followups_drafted: numberValue(context.worker.kpis.ar_followups_drafted) + 1,
          owner_review_packets: numberValue(context.worker.kpis.owner_review_packets) + 1,
        },
        updatedAt: now,
      })
      .where(eq(workers.id, context.worker.id));

    return {
      replay: null,
      workerRunId: workerRun.id,
      taskId: task.id,
      eventId: event.id,
      arFollowupObjectId: arFollowup.id,
      invoiceObjectId: refs.invoiceObject.id,
      invoiceId: refs.invoiceRow.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      draftEvidenceId: draftEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      financeArFollowupViewId: view.id,
      output,
    };
  });

  if (result.replay) {
    return replayedArFollowupDraft(db, context, result.replay);
  }

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    arFollowupObjectId: result.arFollowupObjectId,
    invoiceObjectId: result.invoiceObjectId,
    invoiceId: result.invoiceId,
    approvalRequestId: result.approvalRequestId,
    evidenceId: result.evidenceId,
    draftEvidenceId: result.draftEvidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    financeArFollowupViewId: result.financeArFollowupViewId,
    output: result.output,
    snapshot: await getFinanceWorkerSnapshot(db, {
      role: financeWorkerRole,
      tenantSlug: context.worker.tenantSlug,
      workerId: context.worker.id,
    }),
  };
}

export async function getFinanceWorkerSnapshot(
  db: Database = defaultDb,
  selector: FinanceWorkerSelector = {},
): Promise<FinanceWorkerSnapshot> {
  const worker = await loadFinanceWorker(db, selector);

  if (!worker) {
    throw new PlatformUnavailableError(
      "finance_worker_not_found",
      "No active Finance Operations Worker matches this selector.",
      404,
    );
  }

  const [budgetAccount] = await db
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

  const [usedBudget] = budgetAccount
    ? await db
        .select({ units: sql<number>`coalesce(sum(${usageEvents.units}), 0)::int` })
        .from(usageEvents)
        .where(eq(usageEvents.accountId, budgetAccount.id))
    : [{ units: 0 }];
  const [heldBudget] = budgetAccount
    ? await db
        .select({ units: sql<number>`coalesce(sum(${budgetReservations.units}), 0)::int` })
        .from(budgetReservations)
        .where(and(eq(budgetReservations.accountId, budgetAccount.id), eq(budgetReservations.state, "held")))
    : [{ units: 0 }];
  const [usageCount] = budgetAccount
    ? await db
        .select({ total: count() })
        .from(usageEvents)
        .where(eq(usageEvents.accountId, budgetAccount.id))
    : [{ total: 0 }];

  const [pendingApprovals] = await db
    .select({ total: count() })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, worker.tenantId),
        eq(approvalRequests.requesterType, "worker"),
        eq(approvalRequests.requesterId, worker.id),
        eq(approvalRequests.state, "pending"),
      ),
    );
  const [viewCount] = await db
    .select({ total: count() })
    .from(generatedViews)
    .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'finance.%'`));
  const invoiceRows = await db
    .select({
      id: objects.id,
      name: objects.name,
      state: objects.state,
      data: objects.data,
    })
    .from(objects)
    .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.type, "invoice")))
    .orderBy(desc(objects.updatedAt))
    .limit(10);
  const arFollowupRows = await db
    .select({
      id: objects.id,
      name: objects.name,
      state: objects.state,
      data: objects.data,
    })
    .from(objects)
    .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.type, "ar_followup")))
    .orderBy(desc(objects.updatedAt))
    .limit(10);
  const approvalRows = await db
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
    .limit(10);
  const [latestRun] = await db
    .select()
    .from(workerRuns)
    .where(and(eq(workerRuns.tenantId, worker.tenantId), eq(workerRuns.workerId, worker.id)))
    .orderBy(desc(workerRuns.createdAt))
    .limit(1);

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
      accountId: budgetAccount?.id ?? null,
      name: budgetAccount?.name ?? null,
      usedUnits: numberValue(usedBudget?.units),
      heldUnits: numberValue(heldBudget?.units),
      events: numberValue(usageCount?.total),
    },
    controls: {
      pendingApprovals: numberValue(pendingApprovals?.total),
      generatedViews: numberValue(viewCount?.total),
      externalExecution: "dry_run",
      moneyMovement: "blocked",
    },
    invoices: invoiceRows.map((invoice) => ({
      id: invoice.id,
      name: invoice.name,
      state: invoice.state,
      data: invoice.data,
    })),
    arFollowups: arFollowupRows.map((followup) => ({
      id: followup.id,
      name: followup.name,
      state: followup.state,
      data: followup.data,
    })),
    approvals: approvalRows,
    latestRun: latestRun
      ? {
          id: latestRun.id,
          workerRunId: latestRun.id,
          eventId: latestRun.eventId,
          idempotencyKey: latestRun.idempotencyKey,
          state: latestRun.state,
          mode: latestRun.mode,
          output: outputData(objectValue(latestRun.data)),
        }
      : null,
  };
}

export async function getFinanceWorkerSnapshotSafe(selector: FinanceWorkerSelector = {}): Promise<
  | { ok: true; snapshot: FinanceWorkerSnapshot; error: null }
  | { ok: false; snapshot: FinanceWorkerSnapshot; error: string }
> {
  try {
    return {
      ok: true,
      snapshot: await getFinanceWorkerSnapshot(defaultDb, selector),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      snapshot: {
        worker: null,
        budget: { accountId: null, name: null, usedUnits: 0, heldUnits: 0, events: 0 },
        controls: {
          pendingApprovals: 0,
          generatedViews: 0,
          externalExecution: "dry_run",
          moneyMovement: "blocked",
        },
        invoices: [],
        arFollowups: [],
        approvals: [],
        latestRun: null,
      },
      error: error instanceof Error ? error.message : "Finance Operations Worker is unavailable.",
    };
  }
}
