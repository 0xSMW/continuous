import { count, desc, eq, sql, type SQL } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";

import {
  adapterActions,
  adapterRuns,
  adapters,
  approvalRequests,
  auditEvents,
  budgetAccounts,
  budgetAllocations,
  budgetPolicies,
  budgetPools,
  budgetReservations,
  capabilities,
  capabilityGrants,
  connections,
  decisions,
  documents,
  events,
  evidence,
  evidencePackets,
  generatedViews,
  inferences,
  modelProviders,
  modelRoutes,
  objects,
  tasks,
  tenants,
  usageEvents,
  workflowDefinitions,
  workflowRuns,
  workflowSteps,
  workerRuns,
} from "../db/schema";

type Database = typeof import("../db/client")["db"];

export const coreLedgerCollectionNames = [
  "objects",
  "tasks",
  "events",
  "evidence",
  "documents",
  "evidencePackets",
  "decisions",
  "auditEvents",
  "approvals",
  "workerRuns",
  "workflowDefinitions",
  "workflowRuns",
  "workflowSteps",
  "capabilities",
  "capabilityGrants",
  "budgetPolicies",
  "budgetPools",
  "budgetAccounts",
  "budgetAllocations",
  "budgetReservations",
  "usageEvents",
  "modelProviders",
  "modelRoutes",
  "inferences",
  "adapters",
  "adapterRuns",
  "adapterActions",
  "generatedViews",
  "connections",
] as const;

export type CoreLedgerCollectionName = (typeof coreLedgerCollectionNames)[number];

export type CoreLedgerOptions = {
  tenantSlug?: string;
  collections?: CoreLedgerCollectionName[];
  limit?: number;
};

export type CoreLedger = {
  schemaVersion: "continuous.core_ledger.v1";
  tenantName: string | null;
  tenantSlug: string | null;
  limit: number;
  availableCollections: CoreLedgerCollectionName[];
  counts: Partial<Record<CoreLedgerCollectionName, number>>;
  collections: Partial<
    Record<
      CoreLedgerCollectionName,
      {
        count: number;
        items: Array<Record<string, unknown>>;
      }
    >
  >;
};

export type CoreLedgerHealth = {
  service: "Continuous Core Ledger";
  status: "ok" | "degraded";
  checkedAt: string;
  mode: string;
  version: string;
  summary: {
    collections: number;
    records: number;
    limit: number;
  };
  checks: Array<{
    id: string;
    state: "pass" | "warn" | "fail";
    detail: string;
  }>;
};

const coreLedgerCollectionSet = new Set<string>(coreLedgerCollectionNames);
const defaultLedgerLimit = 10;
const maxLedgerLimit = 50;

async function getDb(): Promise<Database> {
  const client = await import("../db/client");
  return client.db;
}

function toIso(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return value instanceof Date ? value.toISOString() : value;
}

function normalizeCollections(value: unknown): CoreLedgerCollectionName[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const raw =
    typeof value === "string"
      ? value
          .split(",")
          .map((item) => item.trim())
          .filter(Boolean)
      : Array.isArray(value)
        ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
        : null;

  if (!raw) {
    throw new Error("config.collections must be an array of collection names or a comma-separated string.");
  }

  const collections = Array.from(new Set(raw));
  if (collections.some((item) => !coreLedgerCollectionSet.has(item))) {
    throw new Error(
      `Unsupported Core ledger collection. Supported collections: ${coreLedgerCollectionNames.join(", ")}.`,
    );
  }

  return collections as CoreLedgerCollectionName[];
}

function normalizeLimit(value: unknown) {
  if (value === undefined || value === null) {
    return defaultLedgerLimit;
  }

  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    throw new Error("config.limit must be a positive integer.");
  }

  return Math.min(value, maxLedgerLimit);
}

export function coreLedgerOptionsFromConfig(
  tenantSlug: string | undefined,
  config: Record<string, unknown> = {},
): CoreLedgerOptions {
  return {
    tenantSlug,
    collections: normalizeCollections(config.collections) ?? [...coreLedgerCollectionNames],
    limit: normalizeLimit(config.limit),
  };
}

export function getCoreLedgerHealth(input: {
  ok: boolean;
  ledger: CoreLedger;
  error?: string | null;
}): CoreLedgerHealth {
  const records = Object.values(input.ledger.counts).reduce(
    (total, value) => total + (typeof value === "number" ? value : 0),
    0,
  );
  const collections = Object.keys(input.ledger.collections).length;

  return {
    service: "Continuous Core Ledger",
    status: input.ok ? "ok" : "degraded",
    checkedAt: new Date().toISOString(),
    mode: process.env.APP_ENV ?? "development",
    version: "0.1.0",
    summary: {
      collections,
      records,
      limit: input.ledger.limit,
    },
    checks: [
      {
        id: "database",
        state: input.ok ? "pass" : "fail",
        detail: input.ok ? "Postgres is reachable" : (input.error ?? "Core ledger is unavailable."),
      },
      {
        id: "core_ledger",
        state: collections > 0 ? "pass" : "warn",
        detail: `${collections} collections and ${records} records visible in this ledger window`,
      },
    ],
  };
}

function emptyLedger(options: CoreLedgerOptions = {}): CoreLedger {
  const collections = options.collections?.length ? options.collections : [...coreLedgerCollectionNames];
  const counts = Object.fromEntries(collections.map((name) => [name, 0])) as Partial<
    Record<CoreLedgerCollectionName, number>
  >;
  const collectionEntries = Object.fromEntries(
    collections.map((name) => [name, { count: 0, items: [] }]),
  ) as CoreLedger["collections"];

  return {
    schemaVersion: "continuous.core_ledger.v1",
    tenantName: null,
    tenantSlug: options.tenantSlug ?? null,
    limit: options.limit ?? defaultLedgerLimit,
    availableCollections: [...coreLedgerCollectionNames],
    counts,
    collections: collectionEntries,
  };
}

async function tableCount(db: Database, table: AnyPgTable) {
  const rows = await db.select({ value: count() }).from(table);
  return rows[0]?.value ?? 0;
}

async function tableCountWhere(db: Database, table: AnyPgTable, condition: SQL) {
  const rows = await db.select({ value: count() }).from(table).where(condition);
  return rows[0]?.value ?? 0;
}

function tenantCondition(table: AnyPgTable, tenantId: string) {
  return sql`${table}.tenant_id = ${tenantId}`;
}

async function tenantTableCount(db: Database, table: AnyPgTable, tenantId: string | null) {
  return tenantId ? tableCountWhere(db, table, tenantCondition(table, tenantId)) : tableCount(db, table);
}

function whereTenant(table: AnyPgTable, tenantId: string | null) {
  return tenantId ? tenantCondition(table, tenantId) : sql`true`;
}

function tenantOrGlobalCondition(table: AnyPgTable, tenantId: string) {
  return sql`(${table}.tenant_id = ${tenantId} or ${table}.tenant_id is null)`;
}

async function tenantOrGlobalTableCount(db: Database, table: AnyPgTable, tenantId: string | null) {
  return tenantId ? tableCountWhere(db, table, tenantOrGlobalCondition(table, tenantId)) : tableCount(db, table);
}

function whereTenantOrGlobal(table: AnyPgTable, tenantId: string | null) {
  return tenantId ? tenantOrGlobalCondition(table, tenantId) : sql`true`;
}

async function readCollection(
  db: Database,
  collection: CoreLedgerCollectionName,
  tenantId: string | null,
  limit: number,
): Promise<{ count: number; items: Array<Record<string, unknown>> }> {
  if (collection === "objects") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, objects, tenantId),
      db
        .select({
          id: objects.id,
          type: objects.type,
          name: objects.name,
          state: objects.state,
          source: objects.source,
          externalId: objects.externalId,
          effectiveAt: objects.effectiveAt,
          archivedAt: objects.archivedAt,
          createdAt: objects.createdAt,
          updatedAt: objects.updatedAt,
        })
        .from(objects)
        .where(whereTenant(objects, tenantId))
        .orderBy(desc(objects.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        effectiveAt: toIso(row.effectiveAt),
        archivedAt: toIso(row.archivedAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "tasks") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, tasks, tenantId),
      db
        .select({
          id: tasks.id,
          objectId: tasks.objectId,
          capabilityId: tasks.capabilityId,
          title: tasks.title,
          state: tasks.state,
          priority: tasks.priority,
          ownerRef: tasks.ownerRef,
          dueAt: tasks.dueAt,
          createdAt: tasks.createdAt,
          updatedAt: tasks.updatedAt,
          doneAt: tasks.doneAt,
          canceledAt: tasks.canceledAt,
        })
        .from(tasks)
        .where(whereTenant(tasks, tenantId))
        .orderBy(desc(tasks.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        dueAt: toIso(row.dueAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
        doneAt: toIso(row.doneAt),
        canceledAt: toIso(row.canceledAt),
      })),
    };
  }

  if (collection === "events") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, events, tenantId),
      db
        .select({
          id: events.id,
          type: events.type,
          source: events.source,
          actorRef: events.actorRef,
          objectId: events.objectId,
          taskId: events.taskId,
          capabilityId: events.capabilityId,
          adapterId: events.adapterId,
          connectionId: events.connectionId,
          idempotencyKey: events.idempotencyKey,
          occurredAt: events.occurredAt,
          createdAt: events.createdAt,
        })
        .from(events)
        .where(whereTenant(events, tenantId))
        .orderBy(desc(events.occurredAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        occurredAt: toIso(row.occurredAt),
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "evidence") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, evidence, tenantId),
      db
        .select({
          id: evidence.id,
          kind: evidence.kind,
          name: evidence.name,
          objectId: evidence.objectId,
          taskId: evidence.taskId,
          eventId: evidence.eventId,
          capabilityId: evidence.capabilityId,
          actorType: evidence.actorType,
          uri: evidence.uri,
          hash: evidence.hash,
          retainedUntil: evidence.retainedUntil,
          createdAt: evidence.createdAt,
        })
        .from(evidence)
        .where(whereTenant(evidence, tenantId))
        .orderBy(desc(evidence.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        name: row.name,
        objectId: row.objectId,
        taskId: row.taskId,
        eventId: row.eventId,
        capabilityId: row.capabilityId,
        actorType: row.actorType,
        hasUri: Boolean(row.uri),
        hasHash: Boolean(row.hash),
        retainedUntil: toIso(row.retainedUntil),
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "documents") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, documents, tenantId),
      db
        .select({
          id: documents.id,
          objectId: documents.objectId,
          workflowRunId: documents.workflowRunId,
          kind: documents.kind,
          name: documents.name,
          state: documents.state,
          sensitivity: documents.sensitivity,
          hash: documents.hash,
          retainedUntil: documents.retainedUntil,
          createdAt: documents.createdAt,
          updatedAt: documents.updatedAt,
        })
        .from(documents)
        .where(whereTenant(documents, tenantId))
        .orderBy(desc(documents.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map(({ hash, ...row }) => ({
        ...row,
        hasHash: Boolean(hash),
        retainedUntil: toIso(row.retainedUntil),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "evidencePackets") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, evidencePackets, tenantId),
      db
        .select({
          id: evidencePackets.id,
          documentId: evidencePackets.documentId,
          objectId: evidencePackets.objectId,
          taskId: evidencePackets.taskId,
          workflowRunId: evidencePackets.workflowRunId,
          eventId: evidencePackets.eventId,
          capabilityId: evidencePackets.capabilityId,
          kind: evidencePackets.kind,
          name: evidencePackets.name,
          state: evidencePackets.state,
          sensitivity: evidencePackets.sensitivity,
          hash: evidencePackets.hash,
          retainedUntil: evidencePackets.retainedUntil,
          createdAt: evidencePackets.createdAt,
          updatedAt: evidencePackets.updatedAt,
        })
        .from(evidencePackets)
        .where(whereTenant(evidencePackets, tenantId))
        .orderBy(desc(evidencePackets.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map(({ hash, ...row }) => ({
        ...row,
        hasHash: Boolean(hash),
        retainedUntil: toIso(row.retainedUntil),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "decisions") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, decisions, tenantId),
      db
        .select({
          id: decisions.id,
          taskId: decisions.taskId,
          eventId: decisions.eventId,
          workflowRunId: decisions.workflowRunId,
          capabilityId: decisions.capabilityId,
          actorType: decisions.actorType,
          actorId: decisions.actorId,
          kind: decisions.kind,
          state: decisions.state,
          decision: decisions.decision,
          createdAt: decisions.createdAt,
        })
        .from(decisions)
        .where(whereTenant(decisions, tenantId))
        .orderBy(desc(decisions.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "auditEvents") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, auditEvents, tenantId),
      db
        .select({
          id: auditEvents.id,
          type: auditEvents.type,
          source: auditEvents.source,
          actorType: auditEvents.actorType,
          actorRef: auditEvents.actorRef,
          targetType: auditEvents.targetType,
          targetId: auditEvents.targetId,
          taskId: auditEvents.taskId,
          workerRunId: auditEvents.workerRunId,
          approvalRequestId: auditEvents.approvalRequestId,
          eventId: auditEvents.eventId,
          objectId: auditEvents.objectId,
          capabilityId: auditEvents.capabilityId,
          risk: auditEvents.risk,
          idempotencyKey: auditEvents.idempotencyKey,
          createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(whereTenant(auditEvents, tenantId))
        .orderBy(desc(auditEvents.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "approvals") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, approvalRequests, tenantId),
      db
        .select({
          id: approvalRequests.id,
          taskId: approvalRequests.taskId,
          workerRunId: approvalRequests.workerRunId,
          workflowRunId: approvalRequests.workflowRunId,
          eventId: approvalRequests.eventId,
          objectId: approvalRequests.objectId,
          capabilityId: approvalRequests.capabilityId,
          requesterRef: approvalRequests.requesterRef,
          kind: approvalRequests.kind,
          state: approvalRequests.state,
          priority: approvalRequests.priority,
          risk: approvalRequests.risk,
          title: approvalRequests.title,
          dueAt: approvalRequests.dueAt,
          decidedAt: approvalRequests.decidedAt,
          createdAt: approvalRequests.createdAt,
          updatedAt: approvalRequests.updatedAt,
        })
        .from(approvalRequests)
        .where(whereTenant(approvalRequests, tenantId))
        .orderBy(desc(approvalRequests.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        dueAt: toIso(row.dueAt),
        decidedAt: toIso(row.decidedAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "workerRuns") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, workerRuns, tenantId),
      db
        .select({
          id: workerRuns.id,
          workerId: workerRuns.workerId,
          taskId: workerRuns.taskId,
          eventId: workerRuns.eventId,
          capabilityId: workerRuns.capabilityId,
          connectionId: workerRuns.connectionId,
          source: workerRuns.source,
          idempotencyKey: workerRuns.idempotencyKey,
          state: workerRuns.state,
          mode: workerRuns.mode,
          startedAt: workerRuns.startedAt,
          endedAt: workerRuns.endedAt,
          createdAt: workerRuns.createdAt,
          updatedAt: workerRuns.updatedAt,
        })
        .from(workerRuns)
        .where(whereTenant(workerRuns, tenantId))
        .orderBy(desc(workerRuns.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        startedAt: toIso(row.startedAt),
        endedAt: toIso(row.endedAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "workflowRuns") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, workflowRuns, tenantId),
      db
        .select({
          id: workflowRuns.id,
          definitionId: workflowRuns.definitionId,
          objectId: workflowRuns.objectId,
          workerId: workflowRuns.workerId,
          state: workflowRuns.state,
          idempotencyKey: workflowRuns.idempotencyKey,
          startedAt: workflowRuns.startedAt,
          updatedAt: workflowRuns.updatedAt,
          completedAt: workflowRuns.completedAt,
        })
        .from(workflowRuns)
        .where(whereTenant(workflowRuns, tenantId))
        .orderBy(desc(workflowRuns.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        startedAt: toIso(row.startedAt),
        updatedAt: toIso(row.updatedAt),
        completedAt: toIso(row.completedAt),
      })),
    };
  }

  if (collection === "workflowDefinitions") {
    const [total, rows] = await Promise.all([
      tableCount(db, workflowDefinitions),
      db
        .select({
          id: workflowDefinitions.id,
          key: workflowDefinitions.key,
          version: workflowDefinitions.version,
          name: workflowDefinitions.name,
          purpose: workflowDefinitions.purpose,
          domain: workflowDefinitions.domain,
          active: workflowDefinitions.active,
          createdAt: workflowDefinitions.createdAt,
          updatedAt: workflowDefinitions.updatedAt,
        })
        .from(workflowDefinitions)
        .orderBy(desc(workflowDefinitions.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "workflowSteps") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, workflowSteps, tenantId),
      db
        .select({
          id: workflowSteps.id,
          definitionId: workflowSteps.definitionId,
          workflowRunId: workflowSteps.workflowRunId,
          approvalRequestId: workflowSteps.approvalRequestId,
          taskId: workflowSteps.taskId,
          objectId: workflowSteps.objectId,
          workerId: workflowSteps.workerId,
          capabilityId: workflowSteps.capabilityId,
          kind: workflowSteps.kind,
          name: workflowSteps.name,
          state: workflowSteps.state,
          priority: workflowSteps.priority,
          risk: workflowSteps.risk,
          fromState: workflowSteps.fromState,
          toState: workflowSteps.toState,
          attempt: workflowSteps.attempt,
          maxAttempts: workflowSteps.maxAttempts,
          dueAt: workflowSteps.dueAt,
          nextAttemptAt: workflowSteps.nextAttemptAt,
          startedAt: workflowSteps.startedAt,
          completedAt: workflowSteps.completedAt,
          updatedAt: workflowSteps.updatedAt,
        })
        .from(workflowSteps)
        .where(whereTenant(workflowSteps, tenantId))
        .orderBy(desc(workflowSteps.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        dueAt: toIso(row.dueAt),
        nextAttemptAt: toIso(row.nextAttemptAt),
        startedAt: toIso(row.startedAt),
        completedAt: toIso(row.completedAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "capabilities") {
    const [total, rows] = await Promise.all([
      tableCount(db, capabilities),
      db
        .select({
          id: capabilities.id,
          key: capabilities.key,
          version: capabilities.version,
          name: capabilities.name,
          class: capabilities.class,
          risk: capabilities.risk,
          sideEffect: capabilities.sideEffect,
          active: capabilities.active,
          createdAt: capabilities.createdAt,
          updatedAt: capabilities.updatedAt,
        })
        .from(capabilities)
        .orderBy(desc(capabilities.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "capabilityGrants") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, capabilityGrants, tenantId),
      db
        .select({
          id: capabilityGrants.id,
          capabilityId: capabilityGrants.capabilityId,
          actorType: capabilityGrants.actorType,
          actorId: capabilityGrants.actorId,
          active: capabilityGrants.active,
          startsAt: capabilityGrants.startsAt,
          endsAt: capabilityGrants.endsAt,
          createdAt: capabilityGrants.createdAt,
          updatedAt: capabilityGrants.updatedAt,
        })
        .from(capabilityGrants)
        .where(whereTenant(capabilityGrants, tenantId))
        .orderBy(desc(capabilityGrants.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        startsAt: toIso(row.startsAt),
        endsAt: toIso(row.endsAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "budgetPolicies") {
    const [total, rows] = await Promise.all([
      tenantOrGlobalTableCount(db, budgetPolicies, tenantId),
      db
        .select({
          id: budgetPolicies.id,
          key: budgetPolicies.key,
          target: budgetPolicies.target,
          monthlyUnits: budgetPolicies.monthlyUnits,
          perTaskUnits: budgetPolicies.perTaskUnits,
          softLimit: budgetPolicies.softLimit,
          hardLimit: budgetPolicies.hardLimit,
          overage: budgetPolicies.overage,
          active: budgetPolicies.active,
          createdAt: budgetPolicies.createdAt,
          updatedAt: budgetPolicies.updatedAt,
        })
        .from(budgetPolicies)
        .where(whereTenantOrGlobal(budgetPolicies, tenantId))
        .orderBy(desc(budgetPolicies.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "budgetPools") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, budgetPools, tenantId),
      db
        .select({
          id: budgetPools.id,
          name: budgetPools.name,
          period: budgetPools.period,
          units: budgetPools.units,
          startsAt: budgetPools.startsAt,
          endsAt: budgetPools.endsAt,
          createdAt: budgetPools.createdAt,
          updatedAt: budgetPools.updatedAt,
        })
        .from(budgetPools)
        .where(whereTenant(budgetPools, tenantId))
        .orderBy(desc(budgetPools.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        startsAt: toIso(row.startsAt),
        endsAt: toIso(row.endsAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "budgetAccounts") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, budgetAccounts, tenantId),
      db
        .select({
          id: budgetAccounts.id,
          policyId: budgetAccounts.policyId,
          name: budgetAccounts.name,
          target: budgetAccounts.target,
          targetId: budgetAccounts.targetId,
          active: budgetAccounts.active,
          createdAt: budgetAccounts.createdAt,
          updatedAt: budgetAccounts.updatedAt,
        })
        .from(budgetAccounts)
        .where(whereTenant(budgetAccounts, tenantId))
        .orderBy(desc(budgetAccounts.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "budgetAllocations") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, budgetAllocations, tenantId),
      db
        .select({
          id: budgetAllocations.id,
          poolId: budgetAllocations.poolId,
          accountId: budgetAllocations.accountId,
          units: budgetAllocations.units,
          startsAt: budgetAllocations.startsAt,
          endsAt: budgetAllocations.endsAt,
          createdAt: budgetAllocations.createdAt,
        })
        .from(budgetAllocations)
        .where(whereTenant(budgetAllocations, tenantId))
        .orderBy(desc(budgetAllocations.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        startsAt: toIso(row.startsAt),
        endsAt: toIso(row.endsAt),
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "budgetReservations") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, budgetReservations, tenantId),
      db
        .select({
          id: budgetReservations.id,
          accountId: budgetReservations.accountId,
          taskId: budgetReservations.taskId,
          units: budgetReservations.units,
          state: budgetReservations.state,
          expiresAt: budgetReservations.expiresAt,
          createdAt: budgetReservations.createdAt,
          updatedAt: budgetReservations.updatedAt,
        })
        .from(budgetReservations)
        .where(whereTenant(budgetReservations, tenantId))
        .orderBy(desc(budgetReservations.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        expiresAt: toIso(row.expiresAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "usageEvents") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, usageEvents, tenantId),
      db
        .select({
          id: usageEvents.id,
          accountId: usageEvents.accountId,
          reservationId: usageEvents.reservationId,
          inferenceId: usageEvents.inferenceId,
          taskId: usageEvents.taskId,
          capabilityId: usageEvents.capabilityId,
          actorType: usageEvents.actorType,
          actorId: usageEvents.actorId,
          units: usageEvents.units,
          costUsd: usageEvents.costUsd,
          createdAt: usageEvents.createdAt,
        })
        .from(usageEvents)
        .where(whereTenant(usageEvents, tenantId))
        .orderBy(desc(usageEvents.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        costUsd: String(row.costUsd),
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "modelProviders") {
    const [total, rows] = await Promise.all([
      tableCount(db, modelProviders),
      db
        .select({
          id: modelProviders.id,
          key: modelProviders.key,
          name: modelProviders.name,
          kind: modelProviders.kind,
          active: modelProviders.active,
          createdAt: modelProviders.createdAt,
          updatedAt: modelProviders.updatedAt,
        })
        .from(modelProviders)
        .orderBy(desc(modelProviders.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "modelRoutes") {
    const [total, rows] = await Promise.all([
      tenantOrGlobalTableCount(db, modelRoutes, tenantId),
      db
        .select({
          id: modelRoutes.id,
          providerId: modelRoutes.providerId,
          key: modelRoutes.key,
          name: modelRoutes.name,
          model: modelRoutes.model,
          purpose: modelRoutes.purpose,
          active: modelRoutes.active,
          createdAt: modelRoutes.createdAt,
          updatedAt: modelRoutes.updatedAt,
        })
        .from(modelRoutes)
        .where(whereTenantOrGlobal(modelRoutes, tenantId))
        .orderBy(desc(modelRoutes.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "inferences") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, inferences, tenantId),
      db
        .select({
          id: inferences.id,
          providerId: inferences.providerId,
          routeId: inferences.routeId,
          budgetAccountId: inferences.budgetAccountId,
          taskId: inferences.taskId,
          capabilityId: inferences.capabilityId,
          actorType: inferences.actorType,
          actorId: inferences.actorId,
          promptHash: inferences.promptHash,
          promptTokens: inferences.promptTokens,
          completionTokens: inferences.completionTokens,
          units: inferences.units,
          costUsd: inferences.costUsd,
          latencyMs: inferences.latencyMs,
          createdAt: inferences.createdAt,
        })
        .from(inferences)
        .where(whereTenant(inferences, tenantId))
        .orderBy(desc(inferences.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        costUsd: String(row.costUsd),
        hasPromptHash: Boolean(row.promptHash),
        promptHash: undefined,
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "adapters") {
    const [total, rows] = await Promise.all([
      tableCount(db, adapters),
      db
        .select({
          id: adapters.id,
          key: adapters.key,
          name: adapters.name,
          kind: adapters.kind,
          auth: adapters.auth,
          active: adapters.active,
          createdAt: adapters.createdAt,
          updatedAt: adapters.updatedAt,
        })
        .from(adapters)
        .orderBy(desc(adapters.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "adapterRuns") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, adapterRuns, tenantId),
      db
        .select({
          id: adapterRuns.id,
          connectionId: adapterRuns.connectionId,
          workerRunId: adapterRuns.workerRunId,
          eventId: adapterRuns.eventId,
          mode: adapterRuns.mode,
          operation: adapterRuns.operation,
          state: adapterRuns.state,
          attempt: adapterRuns.attempt,
          maxAttempts: adapterRuns.maxAttempts,
          nextAttemptAt: adapterRuns.nextAttemptAt,
          reconciliationState: adapterRuns.reconciliationState,
          readCount: adapterRuns.readCount,
          writeCount: adapterRuns.writeCount,
          startedAt: adapterRuns.startedAt,
          endedAt: adapterRuns.endedAt,
          createdAt: adapterRuns.createdAt,
        })
        .from(adapterRuns)
        .where(whereTenant(adapterRuns, tenantId))
        .orderBy(desc(adapterRuns.createdAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        nextAttemptAt: toIso(row.nextAttemptAt),
        startedAt: toIso(row.startedAt),
        endedAt: toIso(row.endedAt),
        createdAt: toIso(row.createdAt),
      })),
    };
  }

  if (collection === "adapterActions") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, adapterActions, tenantId),
      db
        .select({
          id: adapterActions.id,
          connectionId: adapterActions.connectionId,
          adapterRunId: adapterActions.adapterRunId,
          capabilityId: adapterActions.capabilityId,
          taskId: adapterActions.taskId,
          eventId: adapterActions.eventId,
          state: adapterActions.state,
          mode: adapterActions.mode,
          operation: adapterActions.operation,
          attempt: adapterActions.attempt,
          maxAttempts: adapterActions.maxAttempts,
          nextAttemptAt: adapterActions.nextAttemptAt,
          reconciliationState: adapterActions.reconciliationState,
          createdAt: adapterActions.createdAt,
          updatedAt: adapterActions.updatedAt,
        })
        .from(adapterActions)
        .where(whereTenant(adapterActions, tenantId))
        .orderBy(desc(adapterActions.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        nextAttemptAt: toIso(row.nextAttemptAt),
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  if (collection === "generatedViews") {
    const [total, rows] = await Promise.all([
      tenantTableCount(db, generatedViews, tenantId),
      db
        .select({
          id: generatedViews.id,
          capabilityId: generatedViews.capabilityId,
          key: generatedViews.key,
          version: generatedViews.version,
          name: generatedViews.name,
          purpose: generatedViews.purpose,
          surface: generatedViews.surface,
          objectType: generatedViews.objectType,
          taskState: generatedViews.taskState,
          active: generatedViews.active,
          createdAt: generatedViews.createdAt,
          updatedAt: generatedViews.updatedAt,
        })
        .from(generatedViews)
        .where(whereTenant(generatedViews, tenantId))
        .orderBy(desc(generatedViews.updatedAt))
        .limit(limit),
    ]);

    return {
      count: total,
      items: rows.map((row) => ({
        ...row,
        createdAt: toIso(row.createdAt),
        updatedAt: toIso(row.updatedAt),
      })),
    };
  }

  const [total, rows] = await Promise.all([
    tenantTableCount(db, connections, tenantId),
    db
      .select({
        id: connections.id,
        adapterId: connections.adapterId,
        name: connections.name,
        state: connections.state,
        externalAccountId: connections.externalAccountId,
        lastSyncAt: connections.lastSyncAt,
        createdAt: connections.createdAt,
        updatedAt: connections.updatedAt,
      })
      .from(connections)
      .where(whereTenant(connections, tenantId))
      .orderBy(desc(connections.updatedAt))
      .limit(limit),
  ]);

  return {
    count: total,
    items: rows.map((row) => ({
      id: row.id,
      adapterId: row.adapterId,
      name: row.name,
      state: row.state,
      hasExternalAccountId: Boolean(row.externalAccountId),
      lastSyncAt: toIso(row.lastSyncAt),
      createdAt: toIso(row.createdAt),
      updatedAt: toIso(row.updatedAt),
    })),
  };
}

export async function getCoreLedger(options: CoreLedgerOptions = {}): Promise<CoreLedger> {
  const db = await getDb();
  const collections = options.collections?.length ? options.collections : [...coreLedgerCollectionNames];
  const limit = options.limit ?? defaultLedgerLimit;
  const tenantRows = options.tenantSlug
    ? await db
        .select({ id: tenants.id, name: tenants.name, slug: tenants.slug })
        .from(tenants)
        .where(eq(tenants.slug, options.tenantSlug))
        .limit(1)
    : await db.select({ id: tenants.id, name: tenants.name, slug: tenants.slug }).from(tenants).limit(1);

  if (options.tenantSlug && !tenantRows[0]) {
    throw new Error(`Tenant ${options.tenantSlug} was not found.`);
  }

  const tenantId = options.tenantSlug ? (tenantRows[0]?.id ?? null) : null;
  const collectionResults = await Promise.all(
    collections.map(async (collection) => [collection, await readCollection(db, collection, tenantId, limit)] as const),
  );
  const collectionMap = Object.fromEntries(collectionResults) as CoreLedger["collections"];
  const counts = Object.fromEntries(
    collectionResults.map(([collection, result]) => [collection, result.count]),
  ) as CoreLedger["counts"];

  return {
    schemaVersion: "continuous.core_ledger.v1",
    tenantName: tenantRows[0]?.name ?? null,
    tenantSlug: options.tenantSlug ?? tenantRows[0]?.slug ?? null,
    limit,
    availableCollections: [...coreLedgerCollectionNames],
    counts,
    collections: collectionMap,
  };
}

export async function getCoreLedgerSafe(options: CoreLedgerOptions = {}): Promise<
  | { ok: true; ledger: CoreLedger; error: null }
  | { ok: false; ledger: CoreLedger; error: string }
> {
  try {
    return { ok: true, ledger: await getCoreLedger(options), error: null };
  } catch (error) {
    return {
      ok: false,
      ledger: emptyLedger(options),
      error: error instanceof Error ? error.message : "Core ledger unavailable",
    };
  }
}
