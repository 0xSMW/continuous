import { createHash } from "node:crypto";

import { and, count, desc, eq, or, sql } from "drizzle-orm";

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
  employments,
  evidence,
  evidencePackets,
  events,
  generatedViews,
  objectLinks,
  objects,
  objectVersions,
  payrollRuns,
  people,
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
type QueryClient = Pick<Database, "select">;

export const workforceWorkerRole = "workforce_operations";

const workforceSource = "continuous.worker";
const documentPacketCapabilityKey = "document_packet.prepare";
const payrollPreviewCapabilityKey = "payroll_preview.prepare";
const hireWorkflowKey = "hire_employee";
const payrollWorkflowKey = "payroll_preview";
const hirePacketUnits = 3200;
const payrollInputUnits = 2800;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type WorkforceWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type WorkforceContext = {
  worker: {
    id: string;
    tenantId: string;
    tenantSlug: string;
    tenantName: string;
    name: string;
    state: string;
    mission: string;
    autonomyLevel: number;
    scope: JsonObject;
    policy: JsonObject;
    kpis: JsonObject;
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

export type WorkforceWorkerSnapshot = {
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
    payrollExecution: "dry_run";
    restrictedDocuments: "redacted";
  };
  hirePackets: Array<{
    id: string;
    name: string;
    state: string;
    data: JsonObject;
  }>;
  payrollInputs: Array<{
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

export type WorkforceReadinessView = {
  worker: WorkforceWorkerSnapshot["worker"];
  documentBlockers: Array<{
    objectId: string | null;
    name: string;
    state: string;
    blockers: string[];
    restrictedDocuments: JsonObject;
  }>;
  payrollBlockers: Array<{
    objectId: string | null;
    name: string;
    state: string;
    blockers: string[];
    period: string | null;
  }>;
  approvals: WorkforceWorkerSnapshot["approvals"];
};

export type WorkforceCommandResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  objectId: string | null;
  personId?: string | null;
  personObjectId?: string | null;
  employmentId?: string | null;
  employmentObjectId?: string | null;
  payrollRunId?: string | null;
  approvalRequestId: string | null;
  evidenceId: string | null;
  packetId: string | null;
  documentId: string | null;
  workflowRunId: string | null;
  workflowStepIds: string[];
  generatedViewId: string | null;
  externalExecution: "blocked" | "dry_run";
  output: JsonObject;
  snapshot: WorkforceWorkerSnapshot;
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function stringValue(value: unknown, fallback = "") {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function numberValue(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringList(value: unknown) {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
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

function getWorkflowStepIds(data: JsonObject) {
  const output = outputData(data);
  const fromData = stringList(data.workflowStepIds);
  const fromOutput = stringList(output.workflowStepIds);

  return fromOutput.length > 0 ? fromOutput : fromData;
}

function workerWhere(selector: WorkforceWorkerSelector) {
  const conditions = [
    eq(workers.role, workforceWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: WorkforceWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Workforce Operations Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadWorkforceWorker(db: Database, selector: WorkforceWorkerSelector) {
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

async function loadWorkforceContext(input: {
  db: Database;
  selector: WorkforceWorkerSelector;
  operatorEmail: string;
  capabilityKey: string;
  capabilityLabel: string;
}): Promise<WorkforceContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadWorkforceWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Workforce Operations Worker matches this selector.",
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
      `Workforce Operations Worker requires the ${input.capabilityLabel} capability.`,
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
      `Workforce Operations Worker is not actively granted ${input.capabilityLabel}.`,
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
      "Workforce Operations Worker has no active budget account.",
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
      state: worker.state,
      mission: worker.mission,
      autonomyLevel: worker.autonomyLevel,
      scope: worker.scope,
      policy: worker.policy,
      kpis: worker.kpis,
      managerName: worker.managerName,
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
  };
}

async function getObjectById(db: Database, tenantId: string, id?: string) {
  if (!id || !uuidPattern.test(id)) {
    return null;
  }

  const [object] = await db
    .select()
    .from(objects)
    .where(and(eq(objects.tenantId, tenantId), eq(objects.id, id)))
    .limit(1);

  return object ?? null;
}

async function resolvePerson(db: Database, tenantId: string, personId: string) {
  if (!uuidPattern.test(personId)) {
    return { person: null, object: null };
  }

  const [person] = await db
    .select()
    .from(people)
    .where(and(eq(people.tenantId, tenantId), or(eq(people.id, personId), eq(people.objectId, personId))))
    .limit(1);
  const object = await getObjectById(db, tenantId, person?.objectId ?? personId);

  return { person: person ?? null, object };
}

async function resolveEmployment(db: Database, tenantId: string, input: {
  employmentId?: string;
  personId?: string | null;
}) {
  if (input.employmentId && uuidPattern.test(input.employmentId)) {
    const [employment] = await db
      .select()
      .from(employments)
      .where(and(eq(employments.tenantId, tenantId), eq(employments.id, input.employmentId)))
      .limit(1);

    if (employment) {
      return employment;
    }
  }

  if (!input.personId) {
    return null;
  }

  const [employment] = await db
    .select()
    .from(employments)
    .where(and(eq(employments.tenantId, tenantId), eq(employments.personId, input.personId)))
    .orderBy(desc(employments.createdAt))
    .limit(1);

  return employment ?? null;
}

async function resolveEmploymentObject(db: Database, tenantId: string, input: {
  employment: typeof employments.$inferSelect | null;
  employmentObjectId?: string;
  sourceRefs?: JsonObject;
  fallbackRef?: string;
}) {
  const explicitRef =
    optionalString(input.employmentObjectId) ??
    optionalString(input.sourceRefs?.employmentObjectId) ??
    optionalString(input.sourceRefs?.objectId);
  const explicitObject = await getObjectById(db, tenantId, explicitRef ?? input.fallbackRef);

  if (explicitObject?.type === "employment") {
    return explicitObject;
  }

  if (!input.employment?.personId) {
    return null;
  }

  const [person] = await db
    .select({ objectId: people.objectId })
    .from(people)
    .where(and(eq(people.tenantId, tenantId), eq(people.id, input.employment.personId)))
    .limit(1);

  if (!person?.objectId) {
    return null;
  }

  const [linked] = await db
    .select({ object: objects })
    .from(objectLinks)
    .innerJoin(objects, eq(objectLinks.fromId, objects.id))
    .where(
      and(
        eq(objectLinks.tenantId, tenantId),
        eq(objectLinks.toId, person.objectId),
        eq(objectLinks.type, "held_by"),
        eq(objects.tenantId, tenantId),
        eq(objects.type, "employment"),
      ),
    )
    .orderBy(desc(objects.updatedAt))
    .limit(1);

  return linked?.object ?? null;
}

function normalizeDocuments(config: JsonObject) {
  const defaults = [
    "identity_verification",
    "employment_eligibility",
    "tax_withholding",
    "direct_deposit",
    "policy_acknowledgement",
  ];
  const provided = new Map<string, JsonObject>();

  for (const item of Array.isArray(config.documents) ? config.documents : []) {
    if (typeof item === "string" && item.trim()) {
      provided.set(item.trim(), { type: item.trim(), state: "provided" });
    } else if (item && typeof item === "object" && !Array.isArray(item)) {
      const document = item as JsonObject;
      const type = optionalString(document.type) ?? optionalString(document.documentType);

      if (type) {
        provided.set(type, document);
      }
    }
  }

  const required = stringList(config.requiredDocuments);
  const requiredTypes = required.length > 0 ? required : defaults;

  return requiredTypes.map((type) => {
    const document = provided.get(type);
    const state = optionalString(document?.state) ?? (document ? "provided" : "missing");
    const complete = ["provided", "verified", "complete", "signed"].includes(state);

    return {
      type,
      state,
      complete,
      sensitivity: optionalString(document?.sensitivity) ?? (type === "direct_deposit" ? "high" : "medium"),
    };
  });
}

function restrictedDocumentProof(config: JsonObject, checklist: ReturnType<typeof normalizeDocuments>) {
  const configured = Array.isArray(config.restrictedDocuments)
    ? config.restrictedDocuments
    : ["employment_eligibility", "tax_withholding", "direct_deposit"];
  const restricted = configured
    .map((item) => {
      if (typeof item === "string" && item.trim()) {
        return { type: item.trim(), rawContentStored: false, state: "redacted" };
      }

      if (item && typeof item === "object" && !Array.isArray(item)) {
        const record = item as JsonObject;
        const type = optionalString(record.type) ?? optionalString(record.documentType);

        if (type) {
          return {
            type,
            rawContentStored: false,
            state: optionalString(record.state) ?? "redacted",
          };
        }
      }

      return null;
    })
    .filter((item): item is { type: string; rawContentStored: false; state: string } => Boolean(item));
  const missingRestricted = restricted
    .filter((item) => checklist.some((document) => document.type === item.type && !document.complete))
    .map((item) => item.type);

  return {
    mode: "redacted",
    rawContentStored: false,
    restricted,
    missingRestricted,
  } satisfies JsonObject;
}

function blockerList(values: unknown[]) {
  return Array.from(
    new Set(
      values
        .flatMap((value) => (Array.isArray(value) ? value : [value]))
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .map((value) => value.trim()),
    ),
  );
}

async function nextObjectVersion(tx: QueryClient, objectId: string) {
  const [nextVersion] = await tx
    .select({
      value: sql<number>`coalesce(max(${objectVersions.version}), 0) + 1`,
    })
    .from(objectVersions)
    .where(eq(objectVersions.objectId, objectId));

  return Number(nextVersion?.value ?? 1);
}

async function writeGeneratedView(input: {
  tx: Transaction;
  tenantId: string;
  capabilityId: string;
  key: string;
  name: string;
  purpose: string;
  objectType: string;
  taskState: "draft" | "active" | "waiting" | "approval_required" | "blocked" | "done" | "canceled";
  contract: JsonObject;
  actions: JsonObject;
  data: JsonObject;
  mask: JsonObject;
  now: Date;
}) {
  const [existing] = await input.tx
    .select({ id: generatedViews.id })
    .from(generatedViews)
    .where(
      and(
        eq(generatedViews.tenantId, input.tenantId),
        eq(generatedViews.key, input.key),
        eq(generatedViews.version, "1.0.0"),
      ),
    )
    .limit(1);

  if (existing) {
    const [view] = await input.tx
      .update(generatedViews)
      .set({
        capabilityId: input.capabilityId,
        name: input.name,
        purpose: input.purpose,
        objectType: input.objectType,
        taskState: input.taskState,
        contract: input.contract,
        actions: input.actions,
        data: input.data,
        mask: input.mask,
        active: true,
        updatedAt: input.now,
      })
      .where(eq(generatedViews.id, existing.id))
      .returning({ id: generatedViews.id });

    return view.id;
  }

  const [view] = await input.tx
    .insert(generatedViews)
    .values({
      tenantId: input.tenantId,
      capabilityId: input.capabilityId,
      key: input.key,
      version: "1.0.0",
      name: input.name,
      purpose: input.purpose,
      surface: "web",
      objectType: input.objectType,
      taskState: input.taskState,
      contract: input.contract,
      actions: input.actions,
      data: input.data,
      mask: input.mask,
      active: true,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: generatedViews.id });

  return view.id;
}

async function snapshotForWorker(db: Database, worker: Awaited<ReturnType<typeof loadWorkforceWorker>>): Promise<WorkforceWorkerSnapshot> {
  if (!worker) {
    return emptySnapshot();
  }

  const [
    budgetAccount,
    used,
    held,
    pendingApprovals,
    generatedViewCount,
    hirePackets,
    payrollInputs,
    approvals,
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
      .where(and(eq(usageEvents.tenantId, worker.tenantId), eq(usageEvents.actorType, "worker"), eq(usageEvents.actorId, worker.id))),
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
      .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'workforce.%'`)),
    db
      .select({ id: objects.id, name: objects.name, state: objects.state, data: objects.data })
      .from(objects)
      .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.source, workforceSource), eq(objects.type, "employment")))
      .orderBy(desc(objects.updatedAt))
      .limit(10),
    db
      .select({ id: objects.id, name: objects.name, state: objects.state, data: objects.data })
      .from(objects)
      .where(and(eq(objects.tenantId, worker.tenantId), eq(objects.source, workforceSource), eq(objects.type, "payroll_input")))
      .orderBy(desc(objects.updatedAt))
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

  const [account] = budgetAccount;
  const [usedRow] = used;
  const [heldRow] = held;
  const [approvalRow] = pendingApprovals;
  const [viewRow] = generatedViewCount;
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
      usedUnits: Number(usedRow?.units ?? 0),
      heldUnits: Number(heldRow?.units ?? 0),
      events: Number(usedRow?.events ?? 0),
    },
    controls: {
      pendingApprovals: Number(approvalRow?.value ?? 0),
      generatedViews: Number(viewRow?.value ?? 0),
      externalExecution: "blocked",
      payrollExecution: "dry_run",
      restrictedDocuments: "redacted",
    },
    hirePackets,
    payrollInputs,
    approvals,
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

function emptySnapshot(): WorkforceWorkerSnapshot {
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
      payrollExecution: "dry_run",
      restrictedDocuments: "redacted",
    },
    hirePackets: [],
    payrollInputs: [],
    approvals: [],
    latestRun: null,
  };
}

async function resultFromReplay(input: {
  db: Database;
  workerId: string;
  workerRun: typeof workerRuns.$inferSelect;
  created: false;
}): Promise<WorkforceCommandResult> {
  const output = outputData(objectValue(input.workerRun.data));
  const worker = await loadWorkforceWorker(input.db, { workerId: input.workerId });
  const snapshot = await snapshotForWorker(input.db, worker);

  return {
    created: input.created,
    idempotencyKey: input.workerRun.idempotencyKey,
    workerRunId: input.workerRun.id,
    taskId: input.workerRun.taskId,
    eventId: input.workerRun.eventId,
    objectId: optionalString(output.objectId) ?? null,
    personId: optionalString(output.personId) ?? null,
    personObjectId: optionalString(output.personObjectId) ?? null,
    employmentId: optionalString(output.employmentId) ?? null,
    employmentObjectId: optionalString(output.employmentObjectId) ?? null,
    payrollRunId: optionalString(output.payrollRunId) ?? null,
    approvalRequestId: optionalString(output.approvalRequestId) ?? null,
    evidenceId: optionalString(output.evidenceId) ?? null,
    packetId: optionalString(output.packetId) ?? null,
    documentId: optionalString(output.documentId) ?? null,
    workflowRunId: optionalString(output.workflowRunId) ?? null,
    workflowStepIds: getWorkflowStepIds(objectValue(input.workerRun.data)),
    generatedViewId: optionalString(output.generatedViewId) ?? null,
    externalExecution: output.externalExecution === "dry_run" ? "dry_run" : "blocked",
    output,
    snapshot,
  };
}

export async function prepareWorkforceHirePacket(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<WorkforceCommandResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const personRef = stringValue(config.personId);
  const positionRef = stringValue(config.positionId);
  const workLocationRef = stringValue(config.workLocationId);
  const context = await loadWorkforceContext({
    db,
    selector: { role: workforceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: documentPacketCapabilityKey,
    capabilityLabel: "document_packet.prepare",
  });
  const [{ person, object: personObject }, workLocationObject, positionObject] = await Promise.all([
    resolvePerson(db, context.worker.tenantId, personRef),
    getObjectById(db, context.worker.tenantId, workLocationRef),
    getObjectById(db, context.worker.tenantId, positionRef),
  ]);
  const employment = await resolveEmployment(db, context.worker.tenantId, {
    employmentId: optionalString(config.employmentId),
    personId: person?.id ?? null,
  });
  const existingEmploymentObject = await resolveEmploymentObject(db, context.worker.tenantId, {
    employment,
    employmentObjectId: optionalString(config.employmentObjectId),
    sourceRefs: objectValue(config.sourceRefs),
  });
  const checklist = normalizeDocuments(config);
  const restrictedProof = restrictedDocumentProof(config, checklist);
  const blockers = blockerList([
    stringList(config.blockers),
    person || personObject ? [] : ["person_not_found"],
    positionRef ? [] : ["position_required"],
    workLocationObject ? [] : ["work_location_not_found"],
    checklist.filter((document) => !document.complete).map((document) => `missing_${document.type}`),
    stringList(restrictedProof.missingRestricted).map((type) => `restricted_${type}_pending`),
  ]);
  const packetState = blockers.length > 0 ? "blocked" : "approval_required";
  const inputHash = hashObject({
    schemaVersion: "workforce.hire.packet.prepare.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    personObjectId: personObject?.id ?? null,
    employmentObjectId: existingEmploymentObject?.id ?? null,
    workLocationObjectId: workLocationObject?.id ?? null,
    positionObjectId: positionObject?.id ?? null,
    checklist,
    blockers,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${workforceSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, workforceSource),
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
          "A Workforce hire packet already exists for this idempotency key with different input.",
          409,
        );
      }

      return { replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, hireWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Workforce Operations Worker requires the hire_employee workflow definition.",
        409,
      );
    }

    const packetData = {
      command: "hire.packet.prepare",
      personId: person?.id ?? null,
      personObjectId: personObject?.id ?? null,
      positionId: positionRef,
      positionObjectId: positionObject?.id ?? null,
      workLocationId: workLocationRef,
      workLocationObjectId: workLocationObject?.id ?? null,
      employmentId: employment?.id ?? null,
      employmentObjectId: existingEmploymentObject?.id ?? null,
      startDate: optionalString(config.startDate) ?? null,
      documentChecklist: checklist,
      restrictedDocuments: restrictedProof,
      payrollBlockers: blockers,
      sourceRefs: objectValue(config.sourceRefs),
      policy: {
        externalExecution: "blocked",
        documentSubmission: "blocked",
        payrollSubmission: "blocked",
        restrictedData: "redacted",
        ...objectValue(config.policy),
      },
      externalExecution: "blocked",
      blockers,
      preparedAt: now.toISOString(),
    } satisfies JsonObject;

    const objectValues = {
      tenantId: context.worker.tenantId,
      type: "employment",
      name: `Workforce hire packet for ${person?.name ?? personObject?.name ?? personRef}`,
      state: packetState,
      source: workforceSource,
      externalId: existingEmploymentObject ? existingEmploymentObject.externalId : `workforce-hire:${input.idempotencyKey}`,
      data: packetData,
      createdByUserId: context.operator.id,
      createdByWorkerId: context.worker.id,
      updatedAt: now,
    };
    const [employmentObject] = existingEmploymentObject
      ? await tx
          .update(objects)
          .set({
            state: packetState,
            data: {
              ...objectValue(existingEmploymentObject.data),
              workforcePacket: packetData,
            },
            updatedAt: now,
          })
          .where(eq(objects.id, existingEmploymentObject.id))
          .returning({ id: objects.id, name: objects.name })
      : await tx
          .insert(objects)
          .values({
            ...objectValues,
            externalId: `workforce-hire:${input.idempotencyKey}`,
            createdAt: now,
          })
          .returning({ id: objects.id, name: objects.name });

    const version = await nextObjectVersion(tx, employmentObject.id);
    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: employmentObject.id,
      version,
      data: packetData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "workforce hire packet prepared",
      createdAt: now,
    });

    const hireLinks: Array<typeof objectLinks.$inferInsert> = [];
    if (personObject) {
      hireLinks.push({
        tenantId: context.worker.tenantId,
        fromId: employmentObject.id,
        toId: personObject.id,
        type: "held_by",
        data: { source: workforceSource },
        effectiveAt: now,
      });
    }
    if (workLocationObject) {
      hireLinks.push({
        tenantId: context.worker.tenantId,
        fromId: employmentObject.id,
        toId: workLocationObject.id,
        type: "assigned_location",
        data: { source: workforceSource },
        effectiveAt: now,
      });
    }
    if (hireLinks.length > 0) {
      await tx.insert(objectLinks).values(hireLinks).onConflictDoNothing();
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: employmentObject.id,
        capabilityId: context.capabilityId,
        title: "Review workforce hire packet",
        state: packetState === "blocked" ? "blocked" : "approval_required",
        priority: blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          command: "hire.packet.prepare",
          sourceRefs: objectValue(config.sourceRefs),
          blockers,
        },
        outcome: {
          externalExecution: "blocked",
          restrictedDocuments: "redacted",
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
        source: workforceSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "simulation",
        data: {
          input: {
            command: "hire.packet.prepare",
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
        objectId: employmentObject.id,
        workerId: context.worker.id,
        state: packetState === "blocked" ? "blocked" : "onboarding_packet_prepared",
        idempotencyKey: input.idempotencyKey,
        data: packetData,
        blockers: { items: blockers },
        metrics: { checklistItems: checklist.length, missingDocuments: blockers.length },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.workforce_operations.hire_packet.prepared",
        source: workforceSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: employmentObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:hire_packet_prepared`,
        data: packetData,
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        objectId: employmentObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "trace",
        name: "Workforce hire packet trace",
        hash: `${workforceSource}:hire:${employmentObject.id}:${input.idempotencyKey}`,
        data: {
          inputHash,
          documentChecklist: checklist,
          restrictedDocuments: restrictedProof,
          blockers,
          externalExecution: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: employmentObject.id,
        workflowRunId: workflowRun.id,
        kind: "new_hire_packet",
        name: "New-hire packet",
        state: packetState === "blocked" ? "blocked" : "review_ready",
        sensitivity: "high",
        hash: `${workforceSource}:hire:${employmentObject.id}:${input.idempotencyKey}:document`,
        data: {
          documentChecklist: checklist,
          restrictedDocuments: restrictedProof,
          payrollBlockers: blockers,
          externalExecution: "blocked",
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
        objectId: employmentObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "workforce_packet",
        name: "Workforce hire packet",
        state: packetState === "blocked" ? "blocked" : "prepared",
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id] },
        documentIds: { ids: [document.id] },
        data: packetData,
        hash: `${workforceSource}:hire:${employmentObject.id}:${input.idempotencyKey}:packet`,
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
        objectId: employmentObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "workforce_hire_packet_approval",
        state: "pending",
        priority: blockers.length > 0 ? "high" : "normal",
        risk: "high",
        title: "Review new-hire packet",
        summary: "Review document checklist, restricted-document proof, and payroll blockers before onboarding proceeds.",
        requestedAction: {
          action: blockers.length > 0 ? "resolve_blockers" : "approve_packet",
          externalExecution: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds: [traceEvidence.id],
          blockers,
        },
        policy: packetData.policy,
        data: packetData,
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
          objectId: employmentObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "document_packet_prepare",
          name: "Prepare new-hire packet",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: "high",
          fromState: "classification_review",
          toState: packetState === "blocked" ? "blocked" : "onboarding_packet_prepared",
          idempotencyKey: `${input.idempotencyKey}:document_packet_prepare`,
          input: { command: "hire.packet.prepare", config },
          output: { packetId: packet.id, documentId: document.id, evidenceId: traceEvidence.id },
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
          objectId: employmentObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Request workforce packet review",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: "high",
          fromState: packetState === "blocked" ? "blocked" : "onboarding_packet_prepared",
          toState: packetState === "blocked" ? "blocked" : "approval_pending",
          idempotencyKey: `${input.idempotencyKey}:approval_request`,
          input: { packetId: packet.id },
          output: { approvalRequestId: approval.id },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);

    const generatedViewId = await writeGeneratedView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      key: "workforce.hire.review",
      name: "Workforce hire review",
      purpose: "Review new-hire documents, restricted-data proof, and payroll blockers.",
      objectType: "employment",
      taskState: packetState === "blocked" ? "blocked" : "approval_required",
      contract: {
        version: "1.0.0",
        role: workforceWorkerRole,
        actions: ["approve_packet", "request_document", "block_start"],
      },
      actions: {
        primary: blockers.length > 0 ? "request_document" : "approve_packet",
        secondary: ["block_start"],
      },
      data: {
        latest: {
          objectId: employmentObject.id,
          approvalRequestId: approval.id,
          packetId: packet.id,
          documentId: document.id,
          blockers,
          documentChecklist: checklist,
          restrictedDocuments: restrictedProof,
        },
      },
      mask: {
        restrictedDocuments: "metadata_only",
        rawDocumentContent: "never",
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
      units: hirePacketUnits,
      data: {
        command: "hire.packet.prepare",
        mode: "simulation",
      },
      createdAt: now,
    });

    const output = {
      command: "hire.packet.prepare",
      objectId: employmentObject.id,
      personId: person?.id ?? null,
      personObjectId: personObject?.id ?? null,
      employmentId: employment?.id ?? null,
      employmentObjectId: employmentObject.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      generatedViewId,
      blockers,
      documentChecklist: checklist,
      restrictedDocuments: restrictedProof,
      externalExecution: "blocked",
      payrollSubmission: "blocked",
    } satisfies JsonObject;

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "worker.workforce_operations.hire_packet.prepared",
      source: workforceSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "object",
      targetId: employmentObject.id,
      taskId: task.id,
      eventId: event.id,
      capabilityId: context.capabilityId,
      risk: "high",
      idempotencyKey: `${input.idempotencyKey}:hire_packet_prepared`,
      data: output,
      createdAt: now,
    });

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        state: "done",
        data: {
          input: {
            command: "hire.packet.prepare",
            inputHash,
            config,
          },
          output,
          workflowStepIds,
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, run.id));

    return {
      runId: run.id,
      taskId: task.id,
      eventId: event.id,
      objectId: employmentObject.id,
      personId: person?.id ?? null,
      personObjectId: personObject?.id ?? null,
      employmentId: employment?.id ?? null,
      employmentObjectId: employmentObject.id,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      generatedViewId,
      output,
    };
  });

  if ("replay" in result && result.replay) {
    return resultFromReplay({
      db,
      workerId: context.worker.id,
      workerRun: result.replay,
      created: false,
    });
  }

  const snapshot = await snapshotForWorker(db, await loadWorkforceWorker(db, { workerId: context.worker.id }));

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.runId,
    taskId: result.taskId,
    eventId: result.eventId,
    objectId: result.objectId,
    personId: result.personId,
    personObjectId: result.personObjectId,
    employmentId: result.employmentId,
    employmentObjectId: result.employmentObjectId,
    approvalRequestId: result.approvalRequestId,
    evidenceId: result.evidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    generatedViewId: result.generatedViewId,
    externalExecution: "blocked",
    output: result.output,
    snapshot,
  };
}

export async function prepareWorkforcePayrollInput(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<WorkforceCommandResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const employmentRef = stringValue(config.employmentId);
  const period = stringValue(config.period);
  const context = await loadWorkforceContext({
    db,
    selector: { role: workforceWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    capabilityKey: payrollPreviewCapabilityKey,
    capabilityLabel: "payroll_preview.prepare",
  });
  const employment = await resolveEmployment(db, context.worker.tenantId, { employmentId: employmentRef });
  const employmentObject = await resolveEmploymentObject(db, context.worker.tenantId, {
    employment,
    sourceRefs: objectValue(config.sourceRefs),
    fallbackRef: employmentRef,
  });
  const payrollRunId = optionalString(config.payrollRunId);
  const [payrollRun] = payrollRunId && uuidPattern.test(payrollRunId)
    ? await db
        .select({ id: payrollRuns.id, state: payrollRuns.state, data: payrollRuns.data })
        .from(payrollRuns)
        .where(and(eq(payrollRuns.tenantId, context.worker.tenantId), eq(payrollRuns.id, payrollRunId)))
        .limit(1)
    : [null];
  const hours = numberValue(config.hours);
  const earnings = Array.isArray(config.earnings) ? config.earnings : [];
  const deductions = Array.isArray(config.deductions) ? config.deductions : [];
  const blockers = blockerList([
    stringList(config.blockers),
    employment ? [] : ["employment_not_found"],
    period ? [] : ["period_required"],
    hours > 0 || earnings.length > 0 ? [] : ["missing_hours_or_earnings"],
    payrollRunId && !payrollRun ? ["payroll_run_not_found"] : [],
  ]);
  const objectState = blockers.length > 0 ? "blocked" : "review_ready";
  const inputHash = hashObject({
    schemaVersion: "workforce.payroll_input.prepare.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    idempotencyKey: input.idempotencyKey,
    config,
    employmentId: employment?.id ?? null,
    employmentObjectId: employmentObject?.id ?? null,
    payrollRunId: payrollRun?.id ?? null,
    blockers,
  });
  const now = new Date();

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${workforceSource}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.source, workforceSource),
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
          "A Workforce payroll input packet already exists for this idempotency key with different input.",
          409,
        );
      }

      return { replay: existingRun };
    }

    const [definition] = await tx
      .select({ id: workflowDefinitions.id })
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.key, payrollWorkflowKey), eq(workflowDefinitions.active, true)))
      .orderBy(desc(workflowDefinitions.createdAt))
      .limit(1);

    if (!definition) {
      throw new PlatformUnavailableError(
        "worker_workflow_definition_missing",
        "Workforce Operations Worker requires the payroll_preview workflow definition.",
        409,
      );
    }

    const payrollInputData = {
      command: "payroll_input.prepare",
      employmentId: employment?.id ?? employmentRef,
      employmentObjectId: employmentObject?.id ?? null,
      period,
      hours,
      earnings,
      deductions,
      payrollRunId: payrollRun?.id ?? null,
      payrollPreviewState: payrollRun?.state ?? null,
      blockers,
      sourceRefs: objectValue(config.sourceRefs),
      policy: {
        externalExecution: "dry_run",
        payrollSubmission: "blocked",
        moneyMovement: "blocked",
        taxFiling: "blocked",
        ...objectValue(config.policy),
      },
      externalExecution: "dry_run",
      preparedAt: now.toISOString(),
    } satisfies JsonObject;

    const [payrollInputObject] = await tx
      .insert(objects)
      .values({
        tenantId: context.worker.tenantId,
        type: "payroll_input",
        name: `Payroll input ${period || input.idempotencyKey}`,
        state: objectState,
        source: workforceSource,
        externalId: `workforce-payroll-input:${input.idempotencyKey}`,
        data: payrollInputData,
        createdByUserId: context.operator.id,
        createdByWorkerId: context.worker.id,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: objects.id, name: objects.name });

    await tx.insert(objectVersions).values({
      tenantId: context.worker.tenantId,
      objectId: payrollInputObject.id,
      version: 1,
      data: payrollInputData,
      changedByType: "worker",
      changedById: context.worker.id,
      reason: "workforce payroll input prepared",
      createdAt: now,
    });

    if (employmentObject) {
      await tx
        .insert(objectLinks)
        .values({
          tenantId: context.worker.tenantId,
          fromId: payrollInputObject.id,
          toId: employmentObject.id,
          type: "supports_payroll",
          data: { source: workforceSource },
          effectiveAt: now,
        })
        .onConflictDoNothing();
    }

    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        objectId: payrollInputObject.id,
        capabilityId: context.capabilityId,
        title: "Review payroll input readiness",
        state: objectState === "blocked" ? "blocked" : "approval_required",
        priority: blockers.length > 0 ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        evidence: {
          command: "payroll_input.prepare",
          payrollRunId: payrollRun?.id ?? null,
          blockers,
        },
        outcome: {
          externalExecution: "dry_run",
          payrollSubmission: "blocked",
          moneyMovement: "blocked",
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
        source: workforceSource,
        idempotencyKey: input.idempotencyKey,
        state: "running",
        mode: "dry_run",
        data: {
          input: {
            command: "payroll_input.prepare",
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
        objectId: payrollInputObject.id,
        workerId: context.worker.id,
        state: objectState === "blocked" ? "blocked" : "awaiting_approval",
        idempotencyKey: input.idempotencyKey,
        data: payrollInputData,
        blockers: { items: blockers },
        metrics: { hours, earningsCount: earnings.length, deductionsCount: deductions.length },
        startedAt: now,
        updatedAt: now,
      })
      .returning({ id: workflowRuns.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: "worker.workforce_operations.payroll_input.prepared",
        source: workforceSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        objectId: payrollInputObject.id,
        taskId: task.id,
        capabilityId: context.capabilityId,
        idempotencyKey: `${input.idempotencyKey}:payroll_input_prepared`,
        data: payrollInputData,
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        objectId: payrollInputObject.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "trace",
        name: "Payroll input readiness trace",
        hash: `${workforceSource}:payroll_input:${payrollInputObject.id}:${input.idempotencyKey}`,
        data: {
          inputHash,
          blockers,
          externalExecution: "dry_run",
          payrollSubmission: "blocked",
          moneyMovement: "blocked",
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        objectId: payrollInputObject.id,
        workflowRunId: workflowRun.id,
        kind: "payroll_input_packet",
        name: "Payroll input packet",
        state: objectState,
        sensitivity: "high",
        hash: `${workforceSource}:payroll_input:${payrollInputObject.id}:${input.idempotencyKey}:document`,
        data: payrollInputData,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        objectId: payrollInputObject.id,
        taskId: task.id,
        workflowRunId: workflowRun.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "workforce_packet",
        name: "Workforce payroll input packet",
        state: objectState,
        sensitivity: "high",
        evidenceIds: { ids: [traceEvidence.id] },
        documentIds: { ids: [document.id] },
        data: payrollInputData,
        hash: `${workforceSource}:payroll_input:${payrollInputObject.id}:${input.idempotencyKey}:packet`,
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
        objectId: payrollInputObject.id,
        capabilityId: context.capabilityId,
        requesterType: "worker",
        requesterId: context.worker.id,
        requesterRef: `worker:${context.worker.id}`,
        reviewerUserId: context.reviewerUserId,
        kind: "workforce_payroll_input_approval",
        state: "pending",
        priority: blockers.length > 0 ? "high" : "normal",
        risk: "high",
        title: "Review payroll input readiness",
        summary: "Review payroll source inputs and blockers before any payroll preview, submission, tax filing, or money movement.",
        requestedAction: {
          action: blockers.length > 0 ? "request_fix" : "approve_preview",
          externalExecution: "dry_run",
          payrollSubmission: "blocked",
          moneyMovement: "blocked",
        },
        evidence: {
          packetId: packet.id,
          documentId: document.id,
          evidenceIds: [traceEvidence.id],
          payrollRunId: payrollRun?.id ?? null,
          blockers,
        },
        policy: payrollInputData.policy,
        data: payrollInputData,
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
          objectId: payrollInputObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "packet_prepare",
          name: "Prepare payroll input packet",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: "high",
          fromState: "source_data_locked",
          toState: objectState === "blocked" ? "blocked" : "preview_ready",
          idempotencyKey: `${input.idempotencyKey}:packet_prepare`,
          input: { command: "payroll_input.prepare", config },
          output: { packetId: packet.id, documentId: document.id, evidenceId: traceEvidence.id },
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
          objectId: payrollInputObject.id,
          workerId: context.worker.id,
          capabilityId: context.capabilityId,
          kind: "approval_request",
          name: "Request payroll input review",
          state: "done",
          priority: blockers.length > 0 ? "high" : "normal",
          risk: "high",
          fromState: objectState === "blocked" ? "blocked" : "preview_ready",
          toState: objectState === "blocked" ? "blocked" : "awaiting_approval",
          idempotencyKey: `${input.idempotencyKey}:approval_request`,
          input: { packetId: packet.id },
          output: { approvalRequestId: approval.id },
          startedAt: now,
          completedAt: now,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .returning({ id: workflowSteps.id });
    const workflowStepIds = workflowStepRows.map((step) => step.id);

    const generatedViewId = await writeGeneratedView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      key: "workforce.payroll_input.review",
      name: "Workforce payroll input review",
      purpose: "Review payroll source inputs, blockers, and preview readiness before payroll execution.",
      objectType: "payroll_input",
      taskState: objectState === "blocked" ? "blocked" : "approval_required",
      contract: {
        version: "1.0.0",
        role: workforceWorkerRole,
        actions: ["approve_preview", "request_fix", "block_payroll"],
      },
      actions: {
        primary: blockers.length > 0 ? "request_fix" : "approve_preview",
        secondary: ["block_payroll"],
      },
      data: {
        latest: {
          objectId: payrollInputObject.id,
          approvalRequestId: approval.id,
          packetId: packet.id,
          documentId: document.id,
          payrollRunId: payrollRun?.id ?? null,
          blockers,
          period,
        },
      },
      mask: {
        payrollDetails: "summary_only",
        bankFields: "never",
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
      units: payrollInputUnits,
      data: {
        command: "payroll_input.prepare",
        mode: "dry_run",
      },
      createdAt: now,
    });

    const output = {
      command: "payroll_input.prepare",
      objectId: payrollInputObject.id,
      employmentId: employment?.id ?? null,
      employmentObjectId: employmentObject?.id ?? null,
      payrollRunId: payrollRun?.id ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      generatedViewId,
      blockers,
      period,
      externalExecution: "dry_run",
      payrollSubmission: "blocked",
      moneyMovement: "blocked",
    } satisfies JsonObject;

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: "worker.workforce_operations.payroll_input.prepared",
      source: workforceSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "object",
      targetId: payrollInputObject.id,
      taskId: task.id,
      eventId: event.id,
      capabilityId: context.capabilityId,
      risk: "high",
      idempotencyKey: `${input.idempotencyKey}:payroll_input_prepared`,
      data: output,
      createdAt: now,
    });

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        state: "done",
        data: {
          input: {
            command: "payroll_input.prepare",
            inputHash,
            config,
          },
          output,
          workflowStepIds,
        },
        endedAt: now,
        updatedAt: now,
      })
      .where(eq(workerRuns.id, run.id));

    return {
      runId: run.id,
      taskId: task.id,
      eventId: event.id,
      objectId: payrollInputObject.id,
      employmentId: employment?.id ?? null,
      employmentObjectId: employmentObject?.id ?? null,
      payrollRunId: payrollRun?.id ?? null,
      approvalRequestId: approval.id,
      evidenceId: traceEvidence.id,
      packetId: packet.id,
      documentId: document.id,
      workflowRunId: workflowRun.id,
      workflowStepIds,
      generatedViewId,
      output,
    };
  });

  if ("replay" in result && result.replay) {
    return resultFromReplay({
      db,
      workerId: context.worker.id,
      workerRun: result.replay,
      created: false,
    });
  }

  const snapshot = await snapshotForWorker(db, await loadWorkforceWorker(db, { workerId: context.worker.id }));

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.runId,
    taskId: result.taskId,
    eventId: result.eventId,
    objectId: result.objectId,
    employmentId: result.employmentId,
    employmentObjectId: result.employmentObjectId,
    payrollRunId: result.payrollRunId,
    approvalRequestId: result.approvalRequestId,
    evidenceId: result.evidenceId,
    packetId: result.packetId,
    documentId: result.documentId,
    workflowRunId: result.workflowRunId,
    workflowStepIds: result.workflowStepIds,
    generatedViewId: result.generatedViewId,
    externalExecution: "dry_run",
    output: result.output,
    snapshot,
  };
}

export async function getWorkforceWorkerSnapshot(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}) {
  const db = input.db ?? defaultDb;
  const worker = await loadWorkforceWorker(db, {
    role: input.role ?? workforceWorkerRole,
    tenantSlug: input.tenantSlug,
    workerId: input.workerId,
  });

  return snapshotForWorker(db, worker);
}

export async function getWorkforceWorkerSnapshotSafe(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}): Promise<{ ok: boolean; snapshot: WorkforceWorkerSnapshot; error: string | null }> {
  try {
    return {
      ok: true,
      snapshot: await getWorkforceWorkerSnapshot(input),
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      snapshot: emptySnapshot(),
      error: error instanceof Error ? error.message : "Unknown workforce worker snapshot error.",
    };
  }
}

export async function getWorkforceReadiness(input: {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
  db?: Database;
}): Promise<WorkforceReadinessView> {
  const snapshot = await getWorkforceWorkerSnapshot(input);

  return {
    worker: snapshot.worker,
    documentBlockers: snapshot.hirePackets.map((packet) => {
      const data = objectValue(packet.data);

      return {
        objectId: packet.id,
        name: packet.name,
        state: packet.state,
        blockers: stringList(data.blockers),
        restrictedDocuments: objectValue(data.restrictedDocuments),
      };
    }),
    payrollBlockers: snapshot.payrollInputs.map((packet) => {
      const data = objectValue(packet.data);

      return {
        objectId: packet.id,
        name: packet.name,
        state: packet.state,
        blockers: stringList(data.blockers),
        period: optionalString(data.period) ?? null,
      };
    }),
    approvals: snapshot.approvals,
  };
}
