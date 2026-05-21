import { createHash } from "node:crypto";

import { and, count, desc, eq, sql } from "drizzle-orm";

import { PlatformUnavailableError } from "../core/errors";
import { loadOperatorContext } from "../core/operators";
import { completeCoreWorkerRun, startCoreWorkerRun } from "../core/worker-runs";
import { db as defaultDb } from "../db/client";
import {
  adapterActions,
  adapterRuns,
  adapters,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  capabilities,
  capabilityGrants,
  connections,
  documents,
  evidence,
  evidencePackets,
  events,
  generatedViews,
  tasks,
  tenants,
  users,
  workerRuns,
  workers,
  type JsonObject,
} from "../db/schema";

type Database = typeof defaultDb;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const systemsWorkerRole = "systems_operations";

const systemsSource = "continuous.worker";
const coreWorkerRunSource = "continuous.core.worker_runs";
const documentPacketCapabilityKey = "document_packet.prepare";
const workerReadCapabilityKey = "worker.read";
const approvalRequestCapabilityKey = "approval.request";
const systemsCommandUnits = 1600;
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type SystemsWorkerSelector = {
  tenantSlug?: string;
  workerId?: string;
  role?: string;
};

type SystemsCommand =
  | "connector.health.scan"
  | "sync.repair.plan"
  | "data_quality.remediate"
  | "permission.review"
  | "automation.plan";

type SystemsContext = {
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
  approvalCapabilityId: string | null;
  budgetAccountId: string;
};

export type SystemsWorkerSnapshot = {
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
  controls: {
    pendingApprovals: number;
    generatedViews: number;
    externalExecution: "blocked";
    repairExecution: "dry_run";
    liveMutation: "blocked";
  };
  connections: Array<{
    id: string;
    name: string;
    state: string;
    adapterKey: string;
    adapterName: string;
    lastSyncAt: string | null;
    scopes: JsonObject;
  }>;
  repairs: Array<{
    id: string;
    state: string;
    operation: string;
    connectionId: string;
    receipt: JsonObject;
    data: JsonObject;
    createdAt: string;
  }>;
  permissions: Array<{
    id: string;
    actorType: string;
    actorId: string;
    active: boolean;
    scope: JsonObject;
    policy: JsonObject;
  }>;
  permissionReviews: Array<{
    id: string;
    state: string | null;
    data: JsonObject;
    updatedAt: string;
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

export type SystemsCommandResult = {
  created: boolean;
  idempotencyKey: string;
  workerRunId: string;
  taskId: string | null;
  eventId: string | null;
  adapterRunId: string | null;
  adapterActionId: string | null;
  evidenceId: string | null;
  receiptEvidenceId: string | null;
  documentId: string | null;
  packetId: string | null;
  approvalRequestId: string | null;
  generatedViewId: string | null;
  viewId: string | null;
  repairPlanId: string | null;
  permissionReviewId: string | null;
  summary: string;
  externalExecution: "blocked" | "dry_run";
  output: JsonObject;
  snapshot: SystemsWorkerSnapshot;
};

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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

function outputData(value: unknown) {
  const data = objectValue(value);
  const output = objectValue(data.output);

  if (Object.keys(output).length > 0) {
    return output;
  }

  return objectValue(objectValue(data.pendingCompletion).output);
}

function systemsWorkerWhere(selector: SystemsWorkerSelector) {
  const conditions = [
    eq(workers.role, systemsWorkerRole),
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

function assertSingleWorker<T>(rows: T[], selector: SystemsWorkerSelector) {
  if (rows.length === 0) {
    return null;
  }

  if (rows.length > 1 && !selector.workerId) {
    throw new PlatformUnavailableError(
      "worker_selector_ambiguous",
      "Multiple Systems Operations Workers match this selector. Provide a worker.id.",
      409,
    );
  }

  return rows[0] ?? null;
}

async function loadSystemsWorker(db: Database, selector: SystemsWorkerSelector) {
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
    .where(systemsWorkerWhere(selector))
    .orderBy(workers.createdAt)
    .limit(selector.workerId ? 1 : 2);

  return assertSingleWorker(rows, selector);
}

function capabilityForCommand(command: SystemsCommand) {
  if (command === "connector.health.scan") {
    return workerReadCapabilityKey;
  }

  if (command === "permission.review") {
    return "permission.review";
  }

  return documentPacketCapabilityKey;
}

async function loadSystemsContext(input: {
  db: Database;
  selector: SystemsWorkerSelector;
  operatorEmail: string;
  command: SystemsCommand;
}): Promise<SystemsContext> {
  const operator = await loadOperatorContext({
    db: input.db,
    operatorEmail: input.operatorEmail,
    tenantSlug: input.selector.tenantSlug,
  });
  const worker = await loadSystemsWorker(input.db, {
    ...input.selector,
    tenantSlug: input.selector.tenantSlug ?? operator.tenantSlug,
  });

  if (!worker) {
    throw new PlatformUnavailableError(
      "worker_not_found",
      "No active Systems Operations Worker matches this selector.",
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

  const capabilityKey = capabilityForCommand(input.command);
  const [capability] = await input.db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, capabilityKey), eq(capabilities.active, true)))
    .limit(1);

  if (!capability) {
    throw new PlatformUnavailableError(
      "worker_capability_missing",
      `Systems Operations Worker requires the ${capabilityKey} capability.`,
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
      `Systems Operations Worker is not actively granted ${capabilityKey}.`,
      409,
    );
  }

  const [approvalCapability] = await input.db
    .select({ id: capabilities.id })
    .from(capabilities)
    .where(and(eq(capabilities.key, approvalRequestCapabilityKey), eq(capabilities.active, true)))
    .limit(1);

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
      "Systems Operations Worker has no active budget account.",
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
      managerUserId: worker.managerUserId,
      managerName: worker.managerName,
    },
    operator: {
      id: operator.userId,
      email: operator.email,
      name: operator.name,
      actorRef: operator.actorRef,
    },
    capabilityId: capability.id,
    approvalCapabilityId: approvalCapability?.id ?? null,
    budgetAccountId: budgetAccount.id,
  };
}

async function loadConnection(db: Database | Transaction, tenantId: string, connectionId?: string) {
  if (!connectionId || !uuidPattern.test(connectionId)) {
    return null;
  }

  const [connection] = await db
    .select({
      id: connections.id,
      tenantId: connections.tenantId,
      name: connections.name,
      state: connections.state,
      externalAccountId: connections.externalAccountId,
      scopes: connections.scopes,
      config: connections.config,
      lastSyncAt: connections.lastSyncAt,
      adapterId: adapters.id,
      adapterKey: adapters.key,
      adapterName: adapters.name,
      adapterKind: adapters.kind,
      adapterCapabilities: adapters.capabilities,
    })
    .from(connections)
    .innerJoin(adapters, eq(connections.adapterId, adapters.id))
    .where(and(eq(connections.tenantId, tenantId), eq(connections.id, connectionId)))
    .limit(1);

  return connection ?? null;
}

async function loadGrant(db: Database | Transaction, tenantId: string, grantId?: string) {
  if (!grantId || !uuidPattern.test(grantId)) {
    return null;
  }

  const [grant] = await db
    .select({
      id: capabilityGrants.id,
      actorType: capabilityGrants.actorType,
      actorId: capabilityGrants.actorId,
      scope: capabilityGrants.scope,
      policy: capabilityGrants.policy,
      active: capabilityGrants.active,
      capabilityId: capabilityGrants.capabilityId,
      capabilityKey: capabilities.key,
      capabilityName: capabilities.name,
    })
    .from(capabilityGrants)
    .innerJoin(capabilities, eq(capabilityGrants.capabilityId, capabilities.id))
    .where(and(eq(capabilityGrants.tenantId, tenantId), eq(capabilityGrants.id, grantId)))
    .limit(1);

  return grant ?? null;
}

function commandSummary(command: SystemsCommand, config: JsonObject) {
  if (command === "connector.health.scan") {
    return {
      title: "Scan connector health",
      approvalKind: "systems_connector_health_review",
      viewKey: "systems.connector.health",
      viewName: "Connector health review",
      taskTitle: "Review connector health findings",
      risk: "medium" as const,
      externalExecution: "blocked" as const,
    };
  }

  if (command === "sync.repair.plan") {
    return {
      title: "Plan sync repair",
      approvalKind: "systems_sync_repair_review",
      viewKey: "systems.sync.repair.review",
      viewName: "Sync repair review",
      taskTitle: "Review dry-run sync repair plan",
      risk: "high" as const,
      externalExecution: "dry_run" as const,
    };
  }

  if (command === "data_quality.remediate") {
    return {
      title: "Prepare data quality remediation",
      approvalKind: "systems_data_quality_review",
      viewKey: "systems.data_quality.review",
      viewName: "Data quality remediation review",
      taskTitle: "Review data quality remediation plan",
      risk: "high" as const,
      externalExecution: "dry_run" as const,
    };
  }

  if (command === "permission.review") {
    return {
      title: "Review permission scope",
      approvalKind: "systems_permission_review",
      viewKey: "systems.permission.review",
      viewName: "Permission review",
      taskTitle: "Review permission scope evidence",
      risk: "critical" as const,
      externalExecution: "blocked" as const,
    };
  }

  return {
    title: "Prepare automation plan",
    approvalKind: "systems_automation_review",
    viewKey: "systems.automation.review",
    viewName: "Automation plan review",
    taskTitle: `Review automation plan for ${optionalString(config.workflowKey) ?? "workflow"}`,
    risk: "high" as const,
    externalExecution: "blocked" as const,
  };
}

function rollbackPlan(command: SystemsCommand, config: JsonObject) {
  return {
    required: command !== "connector.health.scan",
    externalMutation: false,
    restorePoint: optionalString(config.restorePoint) ?? null,
    steps: [
      "retain preflight snapshot",
      "execute first change only after approval",
      "record adapter receipt",
      "reconcile changed rows before next step",
    ],
  } satisfies JsonObject;
}

function outputForCommand(input: {
  command: SystemsCommand;
  config: JsonObject;
  connection: Awaited<ReturnType<typeof loadConnection>>;
  grant: Awaited<ReturnType<typeof loadGrant>>;
  now: Date;
}) {
  const checks = stringList(input.config.checks);
  const requestedScopes = stringList(input.config.requestedScopes);
  const expectedScopes = stringList(input.config.expectedScopes);
  const scopePolicy = objectValue(input.config.scopePolicy);
  const configDesiredScopes = stringList(input.config.desiredScopes);
  const configBlockedScopes = stringList(input.config.blockedScopes);
  const desiredScopes = configDesiredScopes.length > 0
    ? configDesiredScopes
    : stringList(scopePolicy.desiredScopes);
  const blockedScopes = configBlockedScopes.length > 0
    ? configBlockedScopes
    : stringList(scopePolicy.blockedScopes);
  const rollback = {
    ...rollbackPlan(input.command, input.config),
    externalExecution: "blocked" as const,
  };

  return {
    command: input.command,
    issueId: optionalString(input.config.issueId) ?? null,
    workflowKey: optionalString(input.config.workflowKey) ?? null,
    connectionId: input.connection?.id ?? optionalString(input.config.connectionId) ?? null,
    grantId: input.grant?.id ?? optionalString(input.config.grantId) ?? null,
    connection: input.connection
      ? {
          id: input.connection.id,
          name: input.connection.name,
          state: input.connection.state,
          adapterKey: input.connection.adapterKey,
          adapterKind: input.connection.adapterKind,
          scopes: input.connection.scopes,
          lastSyncAt: input.connection.lastSyncAt?.toISOString() ?? null,
        }
      : null,
    grant: input.grant
      ? {
          id: input.grant.id,
          actorType: input.grant.actorType,
          actorId: input.grant.actorId,
          capabilityKey: input.grant.capabilityKey,
          active: input.grant.active,
          scope: input.grant.scope,
          policy: input.grant.policy,
        }
      : null,
    checks,
    requestedScopes,
    expectedScopes,
    desiredScopes,
    blockedScopes,
    policy: objectValue(input.config.policy),
    scopePolicy,
    sourceRefs: objectValue(input.config.sourceRefs),
    rollbackPlan: rollback,
    repairPlan: {
      issueId: optionalString(input.config.issueId) ?? null,
      strategy: optionalString(input.config.strategy) ?? "dry_run_then_approval",
      checks: checks.length > 0 ? checks : ["snapshot", "receipt", "rollback"],
      rollback,
      liveMutation: false,
    },
    externalExecution:
      input.command === "sync.repair.plan" || input.command === "data_quality.remediate"
        ? "dry_run"
        : "blocked",
    externalMutation: false,
    preparedAt: input.now.toISOString(),
  } satisfies JsonObject;
}

async function writeGeneratedView(input: {
  tx: Transaction;
  tenantId: string;
  capabilityId: string;
  key: string;
  name: string;
  taskState: "draft" | "active" | "waiting" | "approval_required" | "blocked" | "done" | "canceled";
  data: JsonObject;
  actions: JsonObject;
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
        purpose: "Review Systems Operations worker evidence before external mutation.",
        objectType: "systems_review",
        taskState: input.taskState,
        contract: {
          route: "/worker",
          worker: { role: systemsWorkerRole },
          envelope: ["view", "worker", "config"],
        },
        actions: input.actions,
        data: input.data,
        mask: { secrets: "redacted", rawCredentials: false },
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
      purpose: "Review Systems Operations worker evidence before external mutation.",
      surface: "web",
      objectType: "systems_review",
      taskState: input.taskState,
      contract: {
        route: "/worker",
        worker: { role: systemsWorkerRole },
        envelope: ["view", "worker", "config"],
      },
      actions: input.actions,
      data: input.data,
      mask: { secrets: "redacted", rawCredentials: false },
      active: true,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .returning({ id: generatedViews.id });

  return view.id;
}

async function snapshotForWorker(db: Database, worker: Awaited<ReturnType<typeof loadSystemsWorker>>): Promise<SystemsWorkerSnapshot> {
  if (!worker) {
    return emptySnapshot();
  }

  const [pendingApprovals, viewCount, connectionRows, repairRows, permissionRows, permissionReviewRows, latestRun] =
    await Promise.all([
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
        .where(and(eq(generatedViews.tenantId, worker.tenantId), sql`${generatedViews.key} like 'systems.%'`)),
      db
        .select({
          id: connections.id,
          name: connections.name,
          state: connections.state,
          scopes: connections.scopes,
          lastSyncAt: connections.lastSyncAt,
          adapterKey: adapters.key,
          adapterName: adapters.name,
        })
        .from(connections)
        .innerJoin(adapters, eq(connections.adapterId, adapters.id))
        .where(eq(connections.tenantId, worker.tenantId))
        .orderBy(desc(connections.updatedAt))
        .limit(20),
      db
        .select({
          id: adapterRuns.id,
          state: adapterRuns.state,
          operation: adapterRuns.operation,
          connectionId: adapterRuns.connectionId,
          receipt: adapterRuns.receipt,
          data: adapterRuns.data,
          createdAt: adapterRuns.createdAt,
        })
        .from(adapterRuns)
        .where(and(eq(adapterRuns.tenantId, worker.tenantId), eq(adapterRuns.mode, "dry_run")))
        .orderBy(desc(adapterRuns.createdAt))
        .limit(10),
      db
        .select({
          id: capabilityGrants.id,
          actorType: capabilityGrants.actorType,
          actorId: capabilityGrants.actorId,
          active: capabilityGrants.active,
          scope: capabilityGrants.scope,
          policy: capabilityGrants.policy,
        })
        .from(capabilityGrants)
        .where(eq(capabilityGrants.tenantId, worker.tenantId))
        .orderBy(desc(capabilityGrants.updatedAt))
        .limit(20),
      db
        .select({
          id: generatedViews.id,
          state: generatedViews.taskState,
          data: generatedViews.data,
          updatedAt: generatedViews.updatedAt,
        })
        .from(generatedViews)
        .where(
          and(
            eq(generatedViews.tenantId, worker.tenantId),
            eq(generatedViews.key, "systems.permission.review"),
            eq(generatedViews.active, true),
          ),
        )
        .orderBy(desc(generatedViews.updatedAt))
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

  const [approvalRow] = pendingApprovals;
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
    controls: {
      pendingApprovals: Number(approvalRow?.value ?? 0),
      generatedViews: Number(viewRow?.value ?? 0),
      externalExecution: "blocked",
      repairExecution: "dry_run",
      liveMutation: "blocked",
    },
    connections: connectionRows.map((connection) => ({
      id: connection.id,
      name: connection.name,
      state: connection.state,
      adapterKey: connection.adapterKey,
      adapterName: connection.adapterName,
      lastSyncAt: connection.lastSyncAt?.toISOString() ?? null,
      scopes: connection.scopes,
    })),
    repairs: repairRows.map((repair) => ({
      ...repair,
      createdAt: repair.createdAt.toISOString(),
    })),
    permissions: permissionRows,
    permissionReviews: permissionReviewRows.map((review) => ({
      id: review.id,
      state: review.state,
      data: review.data,
      updatedAt: review.updatedAt.toISOString(),
    })),
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

function emptySnapshot(): SystemsWorkerSnapshot {
  return {
    worker: null,
    controls: {
      pendingApprovals: 0,
      generatedViews: 0,
      externalExecution: "blocked",
      repairExecution: "dry_run",
      liveMutation: "blocked",
    },
    connections: [],
    repairs: [],
    permissions: [],
    permissionReviews: [],
    latestRun: null,
  };
}

async function resultFromReplay(input: {
  db: Database;
  workerId: string;
  workerRun: typeof workerRuns.$inferSelect;
  created: false;
}): Promise<SystemsCommandResult> {
  const output = outputData(input.workerRun.data);
  const worker = await loadSystemsWorker(input.db, { workerId: input.workerId });
  const snapshot = await snapshotForWorker(input.db, worker);

  return {
    created: input.created,
    idempotencyKey: input.workerRun.idempotencyKey,
    workerRunId: input.workerRun.id,
    taskId: input.workerRun.taskId,
    eventId: optionalString(output.eventId) ?? input.workerRun.eventId,
    adapterRunId: optionalString(output.adapterRunId) ?? null,
    adapterActionId: optionalString(output.adapterActionId) ?? null,
    evidenceId: optionalString(output.evidenceId) ?? null,
    receiptEvidenceId: optionalString(output.receiptEvidenceId) ?? null,
    documentId: optionalString(output.documentId) ?? null,
    packetId: optionalString(output.packetId) ?? null,
    approvalRequestId: optionalString(output.approvalRequestId) ?? null,
    generatedViewId: optionalString(output.generatedViewId) ?? null,
    viewId: optionalString(output.viewId) ?? optionalString(output.generatedViewId) ?? null,
    repairPlanId: optionalString(output.repairPlanId) ?? null,
    permissionReviewId: optionalString(output.permissionReviewId) ?? null,
    summary: optionalString(output.summary) ?? "Systems Operations run replayed.",
    externalExecution: output.externalExecution === "dry_run" ? "dry_run" : "blocked",
    output,
    snapshot,
  };
}

async function prepareSystemsCommand(input: {
  command: SystemsCommand;
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}): Promise<SystemsCommandResult> {
  const db = input.db ?? defaultDb;
  const config = input.config ?? {};
  const context = await loadSystemsContext({
    db,
    selector: { role: systemsWorkerRole, tenantSlug: input.tenantSlug, workerId: input.workerId },
    operatorEmail: input.operatorEmail,
    command: input.command,
  });
  const connection = await loadConnection(db, context.worker.tenantId, optionalString(config.connectionId));
  const grant = await loadGrant(db, context.worker.tenantId, optionalString(config.grantId));

  if (optionalString(config.connectionId) && !connection) {
    throw new PlatformUnavailableError(
      "systems_connection_not_found",
      "config.connectionId does not match a connection in this tenant.",
      404,
    );
  }

  if (optionalString(config.grantId) && !grant) {
    throw new PlatformUnavailableError(
      "systems_grant_not_found",
      "config.grantId does not match a capability grant in this tenant.",
      404,
    );
  }

  const summary = commandSummary(input.command, config);
  const now = new Date();
  const commandOutput = outputForCommand({
    command: input.command,
    config,
    connection,
    grant,
    now,
  });
  const inputHash = hashObject({
    schemaVersion: "systems.command.v1",
    tenantId: context.worker.tenantId,
    workerId: context.worker.id,
    command: input.command,
    idempotencyKey: input.idempotencyKey,
    config,
    connectionId: connection?.id ?? null,
    grantId: grant?.id ?? null,
  });
  const coreRun = await startCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: systemsWorkerRole,
    },
    command: input.command,
    mode: summary.externalExecution === "dry_run" ? "dry_run" : "simulation",
    connectionId: connection?.id,
    capabilityId: context.capabilityId,
    budgetAccountId: context.budgetAccountId,
    units: systemsCommandUnits,
    input: {
      inputHash,
      config,
      connectionId: connection?.id ?? null,
      grantId: grant?.id ?? null,
    },
    policy: {
      ...objectValue(config.policy),
      externalExecution: summary.externalExecution,
      liveMutation: "blocked",
      externalMutation: false,
    },
    evidence: {
      command: input.command,
      connectionId: connection?.id ?? null,
      grantId: grant?.id ?? null,
      externalExecution: summary.externalExecution,
      externalMutation: false,
      approvalRequired: input.command !== "connector.health.scan",
    },
    db,
  });
  const coreBudget = objectValue(coreRun.budget);
  const coreReservationId = optionalString(coreBudget.reservationId);

  if (!coreReservationId) {
    throw new PlatformUnavailableError(
      "worker_run_budget_reservation_missing",
      "Core worker.run.start did not return a Systems Operations budget reservation.",
      409,
    );
  }

  const result = await db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtext(${context.worker.tenantId}), hashtext(${`${coreWorkerRunSource}:systems:${input.command}:${input.idempotencyKey}`}))`,
    );

    const [existingRun] = await tx
      .select()
      .from(workerRuns)
      .where(
        and(
          eq(workerRuns.tenantId, context.worker.tenantId),
          eq(workerRuns.id, coreRun.workerRunId),
        ),
      )
      .limit(1);

    if (!existingRun) {
      throw new PlatformUnavailableError(
        "worker_run_missing",
        "Core worker.run.start did not return a persisted Systems Operations worker run.",
        409,
      );
    }

    const existingInput = objectValue(objectValue(existingRun.data).input);
    const existingRequest = objectValue(existingInput.request);
    const existingHash = optionalString(existingRequest.inputHash) ?? optionalString(existingInput.inputHash);

    if (existingHash && existingHash !== inputHash) {
      throw new PlatformUnavailableError(
        "worker_idempotency_conflict",
        "A Systems Operations run already exists for this idempotency key with different input.",
        409,
      );
    }

    if (optionalString(outputData(existingRun.data).workerRunId)) {
      return { replay: existingRun };
    }

    const approvalRequired = input.command !== "connector.health.scan";
    const [task] = await tx
      .insert(tasks)
      .values({
        tenantId: context.worker.tenantId,
        capabilityId: context.capabilityId,
        title: summary.taskTitle,
        state: approvalRequired ? "approval_required" : "done",
        priority: summary.risk === "critical" || summary.risk === "high" ? "high" : "normal",
        ownerType: "worker",
        ownerId: context.worker.id,
        ownerRef: `worker:${context.worker.id}`,
        reviewerUserId: context.worker.managerUserId,
        evidence: {
          command: input.command,
          connectionId: connection?.id ?? null,
          grantId: grant?.id ?? null,
          issueId: optionalString(config.issueId) ?? null,
        },
        outcome: {
          externalExecution: summary.externalExecution,
          externalMutation: false,
        },
        createdAt: now,
        updatedAt: now,
        ...(approvalRequired ? {} : { doneAt: now }),
      })
      .returning({ id: tasks.id });

    const [event] = await tx
      .insert(events)
      .values({
        tenantId: context.worker.tenantId,
        type: `worker.systems_operations.${input.command.replaceAll(".", "_")}.completed`,
        source: systemsSource,
        actorType: "worker",
        actorId: context.worker.id,
        actorRef: `worker:${context.worker.id}`,
        taskId: task.id,
        capabilityId: context.capabilityId,
        connectionId: connection?.id ?? null,
        idempotencyKey: `${input.idempotencyKey}:${input.command}:event`,
        data: commandOutput,
        occurredAt: now,
        createdAt: now,
      })
      .returning({ id: events.id });

    let adapterRunId: string | null = null;
    let adapterActionId: string | null = null;

    if (connection) {
      const receipt = {
        command: input.command,
        dryRun: true,
        externalMutation: false,
        connectionId: connection.id,
        adapterKey: connection.adapterKey,
        preparedAt: now.toISOString(),
      };
      const [adapterRun] = await tx
        .insert(adapterRuns)
        .values({
          tenantId: context.worker.tenantId,
          connectionId: connection.id,
          workerRunId: coreRun.workerRunId,
          eventId: event.id,
          mode: summary.externalExecution === "dry_run" ? "dry_run" : "read",
          operation: input.command,
          idempotencyKey: `${input.idempotencyKey}:${input.command}:adapter_run`,
          state: "done",
          reconciliationState: "matched",
          readCount: input.command === "connector.health.scan" || input.command === "permission.review" ? 1 : 0,
          writeCount: 0,
          receipt,
          data: commandOutput,
          startedAt: now,
          endedAt: now,
          createdAt: now,
        })
        .returning({ id: adapterRuns.id });

      adapterRunId = adapterRun.id;

      const [adapterAction] = await tx
        .insert(adapterActions)
        .values({
          tenantId: context.worker.tenantId,
          connectionId: connection.id,
          adapterRunId: adapterRun.id,
          capabilityId: context.capabilityId,
          taskId: task.id,
          eventId: event.id,
          idempotencyKey: `${input.idempotencyKey}:${input.command}:adapter_action`,
          state: "done",
          mode: "dry_run",
          operation: input.command,
          reconciliationState: "matched",
          request: {
            command: input.command,
            config,
            externalMutation: false,
          },
          response: {
            planned: true,
            externalMutation: false,
          },
          receipt,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: adapterActions.id });

      adapterActionId = adapterAction.id;
    }

    const [traceEvidence] = await tx
      .insert(evidence)
      .values({
        tenantId: context.worker.tenantId,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        actorType: "worker",
        actorId: context.worker.id,
        kind: input.command === "connector.health.scan" ? "snapshot" : "trace",
        name: `${summary.title} trace`,
        hash: `${systemsSource}:${input.command}:${input.idempotencyKey}:trace`,
        data: {
          inputHash,
          output: commandOutput,
          adapterRunId,
          adapterActionId,
        },
        redaction: {
          secrets: "redacted",
          rawCredentials: false,
        },
        createdAt: now,
      })
      .returning({ id: evidence.id });

    let receiptEvidenceId: string | null = null;
    if (adapterRunId) {
      const [receiptEvidence] = await tx
        .insert(evidence)
        .values({
          tenantId: context.worker.tenantId,
          taskId: task.id,
          eventId: event.id,
          capabilityId: context.capabilityId,
          actorType: "adapter",
          actorId: connection?.adapterId ?? null,
          kind: "receipt",
          name: `${summary.title} dry-run receipt`,
          hash: `${systemsSource}:${input.command}:${input.idempotencyKey}:receipt`,
          data: {
            adapterRunId,
            adapterActionId,
            externalMutation: false,
            receiptType: "dry_run",
          },
          redaction: {
            secrets: "redacted",
            rawCredentials: false,
          },
          createdAt: now,
        })
        .returning({ id: evidence.id });

      receiptEvidenceId = receiptEvidence.id;
    }

    const [document] = await tx
      .insert(documents)
      .values({
        tenantId: context.worker.tenantId,
        kind: "systems_packet",
        name: `${summary.title} packet`,
        state: approvalRequired ? "review_ready" : "prepared",
        sensitivity: summary.risk,
        hash: `${systemsSource}:${input.command}:${input.idempotencyKey}:document`,
        data: commandOutput,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: documents.id });

    const evidenceIds = receiptEvidenceId
      ? [traceEvidence.id, receiptEvidenceId]
      : [traceEvidence.id];
    const [packet] = await tx
      .insert(evidencePackets)
      .values({
        tenantId: context.worker.tenantId,
        documentId: document.id,
        taskId: task.id,
        eventId: event.id,
        capabilityId: context.capabilityId,
        kind: "systems_packet",
        name: `${summary.title} packet`,
        state: approvalRequired ? "prepared" : "done",
        sensitivity: summary.risk,
        evidenceIds: { ids: evidenceIds },
        documentIds: { ids: [document.id] },
        data: commandOutput,
        hash: `${systemsSource}:${input.command}:${input.idempotencyKey}:packet`,
        createdAt: now,
        updatedAt: now,
      })
      .returning({ id: evidencePackets.id });

    let approvalRequestId: string | null = null;
    if (approvalRequired) {
      const [approval] = await tx
        .insert(approvalRequests)
        .values({
          tenantId: context.worker.tenantId,
          taskId: task.id,
          workerRunId: coreRun.workerRunId,
          eventId: event.id,
          capabilityId: context.approvalCapabilityId ?? context.capabilityId,
          requesterType: "worker",
          requesterId: context.worker.id,
          requesterRef: `worker:${context.worker.id}`,
          reviewerUserId: context.worker.managerUserId,
          kind: summary.approvalKind,
          state: "pending",
          priority: summary.risk === "critical" || summary.risk === "high" ? "high" : "normal",
          risk: summary.risk,
          title: summary.taskTitle,
          summary: `${summary.title} is ready for review; live external mutation is blocked.`,
          requestedAction: {
            command: input.command,
            externalExecution: summary.externalExecution,
            externalMutation: false,
          },
          evidence: {
            packetId: packet.id,
            evidenceIds,
            documentId: document.id,
          },
          policy: {
            requireApproval: true,
            liveMutation: "blocked",
            rollbackRequired: true,
          },
          data: commandOutput,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: approvalRequests.id });

      approvalRequestId = approval.id;
    }

    const generatedViewId = await writeGeneratedView({
      tx,
      tenantId: context.worker.tenantId,
      capabilityId: context.capabilityId,
      key: summary.viewKey,
      name: summary.viewName,
      taskState: approvalRequired ? "approval_required" : "done",
      actions: {
        primary: approvalRequestId
          ? {
              route: "/approval",
              command: "approval.decide",
              approvalId: approvalRequestId,
            }
          : null,
        workerCommand: {
          route: "/worker",
          worker: { role: systemsWorkerRole, tenantSlug: context.worker.tenantSlug },
          command: input.command,
        },
      },
      data: {
        ...commandOutput,
        workerRunId: coreRun.workerRunId,
        taskId: task.id,
        eventId: event.id,
        packetId: packet.id,
        approvalRequestId,
        adapterRunId,
        adapterActionId,
      },
      now,
    });

    const summaryText = `${summary.title} is ready for review; live external mutation is blocked.`;
    const repairPlanId = input.command === "sync.repair.plan" ? adapterRunId : null;
    const permissionReviewId = input.command === "permission.review" ? generatedViewId : null;
    const output = {
      ...commandOutput,
      workerRunId: coreRun.workerRunId,
      taskId: task.id,
      eventId: event.id,
      adapterRunId,
      adapterActionId,
      evidenceId: traceEvidence.id,
      receiptEvidenceId,
      documentId: document.id,
      packetId: packet.id,
      approvalRequestId,
      generatedViewId,
      viewId: generatedViewId,
      repairPlanId,
      permissionReviewId,
      budgetReservationId: coreReservationId,
      summary: summaryText,
    } satisfies JsonObject;

    await tx
      .update(workerRuns)
      .set({
        eventId: event.id,
        taskId: task.id,
        connectionId: connection?.id ?? null,
        data: {
          ...objectValue(existingRun.data),
          businessEventId: event.id,
          taskId: task.id,
          adapterRunId,
          adapterActionId,
          evidenceId: traceEvidence.id,
          receiptEvidenceId,
          documentId: document.id,
          packetId: packet.id,
          approvalRequestId,
          generatedViewId,
          viewId: generatedViewId,
          repairPlanId,
          permissionReviewId,
          output,
        },
        updatedAt: now,
      })
      .where(eq(workerRuns.id, coreRun.workerRunId));

    await tx.insert(auditEvents).values({
      tenantId: context.worker.tenantId,
      type: `worker.systems_operations.${input.command.replaceAll(".", "_")}.completed`,
      source: systemsSource,
      actorType: "worker",
      actorId: context.worker.id,
      actorRef: `worker:${context.worker.id}`,
      targetType: "worker_run",
      targetId: coreRun.workerRunId,
      taskId: task.id,
      workerRunId: coreRun.workerRunId,
      approvalRequestId,
      eventId: event.id,
      capabilityId: context.capabilityId,
      risk: summary.risk,
      idempotencyKey: `${input.idempotencyKey}:${input.command}:audit`,
      data: output,
      createdAt: now,
    });

    return {
      created: true as const,
      workerRunId: coreRun.workerRunId,
      taskId: task.id,
      eventId: event.id,
      adapterRunId,
      adapterActionId,
      evidenceId: traceEvidence.id,
      receiptEvidenceId,
      documentId: document.id,
      packetId: packet.id,
      approvalRequestId,
      generatedViewId,
      viewId: generatedViewId,
      repairPlanId,
      permissionReviewId,
      summary: summaryText,
      externalExecution: summary.externalExecution,
      output,
    };
  });

  if ("replay" in result && result.replay) {
    const replayOutput = outputData(result.replay.data);

    if (result.replay.state === "running" && optionalString(replayOutput.workerRunId)) {
      const completion = await completeCoreWorkerRun({
        operatorEmail: input.operatorEmail,
        tenantSlug: context.worker.tenantSlug,
        idempotencyKey: input.idempotencyKey,
        worker: {
          id: context.worker.id,
          role: systemsWorkerRole,
        },
        workerRunId: coreRun.workerRunId,
        state: "done",
        reason: "Systems Operations Worker prepared connector, permission, repair, or automation proof with live external mutation blocked.",
        output: replayOutput,
        costUsd: 0,
        evidence: {
          command: input.command,
          eventId: optionalString(replayOutput.eventId) ?? null,
          evidenceId: optionalString(replayOutput.evidenceId) ?? null,
          receiptEvidenceId: optionalString(replayOutput.receiptEvidenceId) ?? null,
          packetId: optionalString(replayOutput.packetId) ?? null,
          documentId: optionalString(replayOutput.documentId) ?? null,
          approvalRequestId: optionalString(replayOutput.approvalRequestId) ?? null,
          generatedViewId: optionalString(replayOutput.generatedViewId) ?? null,
          adapterRunId: optionalString(replayOutput.adapterRunId) ?? null,
          adapterActionId: optionalString(replayOutput.adapterActionId) ?? null,
          externalExecution: summary.externalExecution,
          externalMutation: false,
        },
        db,
      });
      const settledReservationId =
        optionalString(objectValue(completion.budget).reservationId) ??
        optionalString(replayOutput.budgetReservationId) ??
        null;
      const settledUsageEventId =
        optionalString(objectValue(completion.budget).usageEventId) ??
        optionalString(replayOutput.usageEventId) ??
        null;
      const settledOutput = {
        ...replayOutput,
        budgetReservationId: settledReservationId,
        usageEventId: settledUsageEventId,
      } satisfies JsonObject;
      const [completedReplay] = await db
        .select({ data: workerRuns.data })
        .from(workerRuns)
        .where(eq(workerRuns.id, coreRun.workerRunId))
        .limit(1);

      await db
        .update(workerRuns)
        .set({
          data: {
            ...objectValue(completedReplay?.data),
            output: settledOutput,
            budgetReservationId: optionalString(settledOutput.budgetReservationId) ?? null,
            usageEventId: optionalString(settledOutput.usageEventId) ?? null,
          },
          updatedAt: new Date(),
        })
        .where(eq(workerRuns.id, coreRun.workerRunId));

      return resultFromReplay({
        db,
        workerId: context.worker.id,
        workerRun: {
          ...result.replay,
          data: {
            ...objectValue(result.replay.data),
            output: settledOutput,
          },
        },
        created: false,
      });
    }

    return resultFromReplay({
      db,
      workerId: context.worker.id,
      workerRun: result.replay,
      created: false,
    });
  }

  const completion = await completeCoreWorkerRun({
    operatorEmail: input.operatorEmail,
    tenantSlug: context.worker.tenantSlug,
    idempotencyKey: input.idempotencyKey,
    worker: {
      id: context.worker.id,
      role: systemsWorkerRole,
    },
    workerRunId: coreRun.workerRunId,
    state: "done",
    reason: "Systems Operations Worker prepared connector, permission, repair, or automation proof with live external mutation blocked.",
    output: result.output,
    costUsd: 0,
    evidence: {
      command: input.command,
      eventId: result.eventId,
      evidenceId: result.evidenceId,
      receiptEvidenceId: result.receiptEvidenceId,
      packetId: result.packetId,
      documentId: result.documentId,
      approvalRequestId: result.approvalRequestId,
      generatedViewId: result.generatedViewId,
      adapterRunId: result.adapterRunId,
      adapterActionId: result.adapterActionId,
      externalExecution: summary.externalExecution,
      externalMutation: false,
    },
    db,
  });
  const settledReservationId =
    optionalString(objectValue(completion.budget).reservationId) ??
    optionalString(result.output.budgetReservationId) ??
    null;
  const settledUsageEventId =
    optionalString(objectValue(completion.budget).usageEventId) ??
    optionalString(result.output.usageEventId) ??
    null;
  const settledOutput = {
    ...result.output,
    budgetReservationId: settledReservationId,
    usageEventId: settledUsageEventId,
  } satisfies JsonObject;
  const [completedRun] = await db
    .select({ data: workerRuns.data })
    .from(workerRuns)
    .where(eq(workerRuns.id, coreRun.workerRunId))
    .limit(1);

  await db
    .update(workerRuns)
    .set({
      data: {
        ...objectValue(completedRun?.data),
        output: settledOutput,
        budgetReservationId: optionalString(settledOutput.budgetReservationId) ?? null,
        usageEventId: optionalString(settledOutput.usageEventId) ?? null,
      },
      updatedAt: new Date(),
    })
    .where(eq(workerRuns.id, coreRun.workerRunId));

  const snapshot = await snapshotForWorker(db, await loadSystemsWorker(db, { workerId: context.worker.id }));

  return {
    created: true,
    idempotencyKey: input.idempotencyKey,
    workerRunId: result.workerRunId,
    taskId: result.taskId,
    eventId: result.eventId,
    adapterRunId: result.adapterRunId,
    adapterActionId: result.adapterActionId,
    evidenceId: result.evidenceId,
    receiptEvidenceId: result.receiptEvidenceId,
    documentId: result.documentId,
    packetId: result.packetId,
    approvalRequestId: result.approvalRequestId,
    generatedViewId: result.generatedViewId,
    viewId: result.viewId,
    repairPlanId: result.repairPlanId,
    permissionReviewId: result.permissionReviewId,
    summary: result.summary,
    externalExecution: result.externalExecution,
    output: settledOutput,
    snapshot,
  };
}

export async function scanSystemsConnectorHealth(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  return prepareSystemsCommand({ ...input, command: "connector.health.scan" });
}

export async function planSystemsSyncRepair(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  return prepareSystemsCommand({ ...input, command: "sync.repair.plan" });
}

export async function remediateSystemsDataQuality(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  return prepareSystemsCommand({ ...input, command: "data_quality.remediate" });
}

export async function reviewSystemsPermission(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  return prepareSystemsCommand({ ...input, command: "permission.review" });
}

export async function planSystemsAutomation(input: {
  idempotencyKey: string;
  tenantSlug?: string;
  workerId?: string;
  operatorEmail: string;
  config?: JsonObject;
  db?: Database;
}) {
  return prepareSystemsCommand({ ...input, command: "automation.plan" });
}

export async function getSystemsWorkerSnapshotSafe(input: SystemsWorkerSelector = {}): Promise<
  | { ok: true; snapshot: SystemsWorkerSnapshot; error: null }
  | { ok: false; snapshot: SystemsWorkerSnapshot; error: string }
> {
  try {
    const worker = await loadSystemsWorker(defaultDb, input);
    const snapshot = await snapshotForWorker(defaultDb, worker);

    return { ok: true, snapshot, error: null };
  } catch (error) {
    return {
      ok: false,
      snapshot: emptySnapshot(),
      error: error instanceof Error ? error.message : "Unknown Systems Operations Worker error",
    };
  }
}

export async function getSystemsRepairs(input: SystemsWorkerSelector = {}) {
  const result = await getSystemsWorkerSnapshotSafe(input);

  return {
    worker: result.snapshot.worker,
    controls: result.snapshot.controls,
    repairs: result.snapshot.repairs,
    items: result.snapshot.repairs,
    permissionReviews: result.snapshot.permissionReviews,
    error: result.error,
  };
}
