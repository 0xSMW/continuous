import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export type Json =
  | string
  | number
  | boolean
  | null
  | Json[]
  | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export const actorType = pgEnum("actor_type", [
  "user",
  "worker",
  "adapter",
  "system",
]);

export const adapterState = pgEnum("adapter_state", [
  "draft",
  "active",
  "paused",
  "error",
  "archived",
]);

export const budgetTarget = pgEnum("budget_target", [
  "tenant",
  "team",
  "user",
  "worker",
  "workflow",
  "customer",
  "project",
  "vertical",
  "risk",
]);

export const callState = pgEnum("call_state", [
  "queued",
  "running",
  "done",
  "failed",
  "canceled",
]);

export const capabilityClass = pgEnum("capability_class", [
  "read",
  "classify",
  "draft",
  "recommend",
  "task",
  "send",
  "update",
  "submit",
  "money",
  "reveal",
  "policy",
]);

export const evidenceKind = pgEnum("evidence_kind", [
  "snapshot",
  "draft",
  "approval",
  "receipt",
  "trace",
  "export",
  "note",
]);

export const reservationState = pgEnum("reservation_state", [
  "held",
  "used",
  "released",
  "expired",
]);

export const riskLevel = pgEnum("risk_level", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const runState = pgEnum("run_state", [
  "queued",
  "running",
  "done",
  "failed",
  "canceled",
]);

export const sideEffect = pgEnum("side_effect", [
  "none",
  "internal",
  "external",
  "financial",
  "regulated",
]);

export const taskPriority = pgEnum("task_priority", [
  "low",
  "normal",
  "high",
  "urgent",
]);

export const taskState = pgEnum("task_state", [
  "draft",
  "active",
  "waiting",
  "approval_required",
  "blocked",
  "done",
  "canceled",
]);

export const tenantState = pgEnum("tenant_state", [
  "active",
  "suspended",
  "archived",
]);

export const userState = pgEnum("user_state", [
  "invited",
  "active",
  "suspended",
  "left",
]);

export const workerKind = pgEnum("worker_kind", [
  "agent",
  "human",
  "robot",
  "service",
]);

export const workerState = pgEnum("worker_state", [
  "draft",
  "training",
  "active",
  "paused",
  "retired",
]);

export const tenants = pgTable(
  "tenants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    slug: varchar("slug", { length: 80 }).notNull(),
    state: tenantState("state").notNull().default("active"),
    timezone: text("timezone").notNull().default("UTC"),
    settings: jsonb("settings")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("tenants_slug_idx").on(table.slug)],
);

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    name: text("name").notNull(),
    role: text("role").notNull().default("member"),
    state: userState("state").notNull().default("invited"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("users_tenant_idx").on(table.tenantId),
    uniqueIndex("users_tenant_email_idx").on(table.tenantId, table.email),
  ],
);

export const workers = pgTable(
  "workers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    managerUserId: uuid("manager_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: workerKind("kind").notNull().default("agent"),
    state: workerState("state").notNull().default("draft"),
    name: text("name").notNull(),
    role: text("role").notNull(),
    mission: text("mission").notNull(),
    scope: jsonb("scope")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    memory: jsonb("memory")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    policy: jsonb("policy")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    kpis: jsonb("kpis")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    autonomyLevel: integer("autonomy_level").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    retiredAt: timestamp("retired_at", { withTimezone: true }),
  },
  (table) => [
    index("workers_tenant_idx").on(table.tenantId),
    index("workers_manager_idx").on(table.managerUserId),
    check(
      "workers_autonomy_level_check",
      sql`${table.autonomyLevel} >= 0 and ${table.autonomyLevel} <= 7`,
    ),
  ],
);

export const capabilities = pgTable(
  "capabilities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 140 }).notNull(),
    version: varchar("version", { length: 40 }).notNull().default("1.0.0"),
    name: text("name").notNull(),
    class: capabilityClass("class").notNull(),
    risk: riskLevel("risk").notNull().default("low"),
    sideEffect: sideEffect("side_effect").notNull().default("none"),
    description: text("description").notNull().default(""),
    inputSchema: jsonb("input_schema")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    outputSchema: jsonb("output_schema")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    rules: jsonb("rules")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidence: jsonb("evidence")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("capabilities_key_version_idx").on(table.key, table.version),
    index("capabilities_class_idx").on(table.class),
    index("capabilities_risk_idx").on(table.risk),
  ],
);

export const capabilityGrants = pgTable(
  "capability_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    capabilityId: uuid("capability_id")
      .notNull()
      .references(() => capabilities.id, { onDelete: "cascade" }),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    scope: jsonb("scope")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    policy: jsonb("policy")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("capability_grants_tenant_idx").on(table.tenantId),
    index("capability_grants_actor_idx").on(table.actorType, table.actorId),
    uniqueIndex("capability_grants_actor_capability_idx").on(
      table.tenantId,
      table.actorType,
      table.actorId,
      table.capabilityId,
    ),
  ],
);

export const adapters = pgTable(
  "adapters",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 120 }).notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    auth: text("auth").notNull(),
    configSchema: jsonb("config_schema")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    eventSchema: jsonb("event_schema")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    capabilities: jsonb("capabilities")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("adapters_key_idx").on(table.key),
    index("adapters_kind_idx").on(table.kind),
  ],
);

export const connections = pgTable(
  "connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    adapterId: uuid("adapter_id")
      .notNull()
      .references(() => adapters.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    state: adapterState("state").notNull().default("draft"),
    externalAccountId: text("external_account_id"),
    scopes: jsonb("scopes")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    config: jsonb("config")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("connections_tenant_idx").on(table.tenantId),
    index("connections_adapter_idx").on(table.adapterId),
    uniqueIndex("connections_external_account_idx").on(
      table.tenantId,
      table.adapterId,
      table.externalAccountId,
    ),
  ],
);

export const modelProviders = pgTable(
  "model_providers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 120 }).notNull(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("hosted"),
    config: jsonb("config")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("model_providers_key_idx").on(table.key),
    index("model_providers_kind_idx").on(table.kind),
  ],
);

export const modelRoutes = pgTable(
  "model_routes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    providerId: uuid("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "restrict" }),
    key: varchar("key", { length: 120 }).notNull(),
    name: text("name").notNull(),
    model: text("model").notNull(),
    purpose: text("purpose").notNull().default("default"),
    rules: jsonb("rules")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("model_routes_tenant_idx").on(table.tenantId),
    index("model_routes_provider_idx").on(table.providerId),
    uniqueIndex("model_routes_key_tenant_idx").on(table.tenantId, table.key),
  ],
);

export const budgetPolicies = pgTable(
  "budget_policies",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    key: varchar("key", { length: 140 }).notNull(),
    target: budgetTarget("target").notNull(),
    monthlyUnits: integer("monthly_units").notNull(),
    perTaskUnits: integer("per_task_units"),
    softLimit: integer("soft_limit").notNull().default(80),
    hardLimit: integer("hard_limit").notNull().default(100),
    overage: text("overage").notNull().default("manager_approval"),
    rules: jsonb("rules")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("budget_policies_tenant_idx").on(table.tenantId),
    uniqueIndex("budget_policies_key_tenant_idx").on(table.tenantId, table.key),
    check(
      "budget_policies_limits_check",
      sql`${table.softLimit} >= 0 and ${table.hardLimit} >= ${table.softLimit}`,
    ),
  ],
);

export const budgetPools = pgTable(
  "budget_pools",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    period: varchar("period", { length: 20 }).notNull().default("month"),
    units: integer("units").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("budget_pools_tenant_idx").on(table.tenantId),
    index("budget_pools_period_idx").on(table.startsAt, table.endsAt),
  ],
);

export const budgetAccounts = pgTable(
  "budget_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    policyId: uuid("policy_id").references(() => budgetPolicies.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    target: budgetTarget("target").notNull(),
    targetId: uuid("target_id"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("budget_accounts_tenant_idx").on(table.tenantId),
    index("budget_accounts_target_idx").on(table.target, table.targetId),
  ],
);

export const budgetAllocations = pgTable(
  "budget_allocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => budgetPools.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => budgetAccounts.id, { onDelete: "cascade" }),
    units: integer("units").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("budget_allocations_tenant_idx").on(table.tenantId),
    index("budget_allocations_pool_idx").on(table.poolId),
    index("budget_allocations_account_idx").on(table.accountId),
  ],
);

export const objects = pgTable(
  "objects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 80 }).notNull(),
    name: text("name").notNull(),
    state: text("state").notNull().default("active"),
    source: text("source").notNull().default("continuous"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    createdByWorkerId: uuid("created_by_worker_id").references(
      () => workers.id,
      { onDelete: "set null" },
    ),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("objects_tenant_idx").on(table.tenantId),
    index("objects_type_idx").on(table.tenantId, table.type),
    uniqueIndex("objects_external_idx").on(
      table.tenantId,
      table.source,
      table.externalId,
    ),
  ],
);

export const customers = pgTable(
  "customers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("active"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("customers_tenant_idx").on(table.tenantId),
    uniqueIndex("customers_object_idx").on(table.objectId),
    uniqueIndex("customers_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const leads = pgTable(
  "leads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("new"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("leads_tenant_idx").on(table.tenantId),
    uniqueIndex("leads_object_idx").on(table.objectId),
    uniqueIndex("leads_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const offers = pgTable(
  "offers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("active"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("offers_tenant_idx").on(table.tenantId),
    uniqueIndex("offers_object_idx").on(table.objectId),
    uniqueIndex("offers_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const quotes = pgTable(
  "quotes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("draft"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("quotes_tenant_idx").on(table.tenantId),
    uniqueIndex("quotes_object_idx").on(table.objectId),
    uniqueIndex("quotes_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("open"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("jobs_tenant_idx").on(table.tenantId),
    uniqueIndex("jobs_object_idx").on(table.objectId),
    uniqueIndex("jobs_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const invoices = pgTable(
  "invoices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("draft"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("invoices_tenant_idx").on(table.tenantId),
    uniqueIndex("invoices_object_idx").on(table.objectId),
    uniqueIndex("invoices_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const payments = pgTable(
  "payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("pending"),
    externalId: text("external_id"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payments_tenant_idx").on(table.tenantId),
    uniqueIndex("payments_object_idx").on(table.objectId),
    uniqueIndex("payments_external_idx").on(table.tenantId, table.externalId),
  ],
);

export const legalEntities = pgTable(
  "legal_entities",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    legalName: text("legal_name").notNull(),
    entityType: text("entity_type").notNull(),
    jurisdiction: text("jurisdiction").notNull(),
    state: text("state").notNull().default("active"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("legal_entities_tenant_idx").on(table.tenantId),
    uniqueIndex("legal_entities_object_idx").on(table.objectId),
  ],
);

export const entityIdentifiers = pgTable(
  "entity_identifiers",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    legalEntityId: uuid("legal_entity_id")
      .notNull()
      .references(() => legalEntities.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 80 }).notNull(),
    value: text("value").notNull(),
    issuer: text("issuer"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("entity_identifiers_tenant_idx").on(table.tenantId),
    uniqueIndex("entity_identifiers_unique_idx").on(
      table.tenantId,
      table.legalEntityId,
      table.kind,
      table.value,
    ),
  ],
);

export const people = pgTable(
  "people",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    role: text("role").notNull().default("person"),
    state: text("state").notNull().default("active"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("people_tenant_idx").on(table.tenantId),
    uniqueIndex("people_object_idx").on(table.objectId),
  ],
);

export const employments = pgTable(
  "employments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    personId: uuid("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("employee"),
    title: text("title").notNull(),
    state: text("state").notNull().default("draft"),
    managerRef: text("manager_ref"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("employments_tenant_idx").on(table.tenantId),
    index("employments_person_idx").on(table.personId),
    index("employments_worker_idx").on(table.workerId),
  ],
);

export const compensationAgreements = pgTable(
  "compensation_agreements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    employmentId: uuid("employment_id")
      .notNull()
      .references(() => employments.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    amountCents: integer("amount_cents").notNull(),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    period: text("period").notNull().default("hour"),
    state: text("state").notNull().default("draft"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("compensation_agreements_tenant_idx").on(table.tenantId),
    index("compensation_agreements_employment_idx").on(table.employmentId),
  ],
);

export const paySchedules = pgTable(
  "pay_schedules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    frequency: text("frequency").notNull(),
    timezone: text("timezone").notNull().default("UTC"),
    state: text("state").notNull().default("active"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("pay_schedules_tenant_idx").on(table.tenantId),
    uniqueIndex("pay_schedules_name_idx").on(table.tenantId, table.name),
  ],
);

export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    payScheduleId: uuid("pay_schedule_id")
      .notNull()
      .references(() => paySchedules.id, { onDelete: "cascade" }),
    state: text("state").notNull().default("draft"),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    periodEnd: timestamp("period_end", { withTimezone: true }).notNull(),
    checkDate: timestamp("check_date", { withTimezone: true }).notNull(),
    grossCents: integer("gross_cents").notNull().default(0),
    netCents: integer("net_cents").notNull().default(0),
    taxCents: integer("tax_cents").notNull().default(0),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payroll_runs_tenant_idx").on(table.tenantId),
    index("payroll_runs_schedule_idx").on(table.payScheduleId),
  ],
);

export const rulePacks = pgTable(
  "rule_packs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 140 }).notNull(),
    name: text("name").notNull(),
    domain: text("domain").notNull(),
    jurisdiction: text("jurisdiction").notNull().default("US"),
    version: varchar("version", { length: 40 }).notNull().default("0.1.0"),
    sourceRefs: jsonb("source_refs")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    rules: jsonb("rules")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    effectiveAt: timestamp("effective_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("rule_packs_key_version_idx").on(table.key, table.version)],
);

export const obligations = pgTable(
  "obligations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    rulePackId: uuid("rule_pack_id").references(() => rulePacks.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("open"),
    name: text("name").notNull(),
    dueAt: timestamp("due_at", { withTimezone: true }),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("obligations_tenant_idx").on(table.tenantId),
    index("obligations_due_idx").on(table.tenantId, table.state, table.dueAt),
  ],
);

export const filingRequirements = pgTable(
  "filing_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "set null",
    }),
    rulePackId: uuid("rule_pack_id").references(() => rulePacks.id, {
      onDelete: "set null",
    }),
    form: text("form").notNull(),
    cadence: text("cadence").notNull(),
    agency: text("agency").notNull(),
    state: text("state").notNull().default("active"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("filing_requirements_tenant_idx").on(table.tenantId),
    uniqueIndex("filing_requirements_unique_idx").on(
      table.tenantId,
      table.form,
      table.agency,
    ),
  ],
);

export const filingDrafts = pgTable(
  "filing_drafts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    requirementId: uuid("requirement_id")
      .notNull()
      .references(() => filingRequirements.id, { onDelete: "cascade" }),
    obligationId: uuid("obligation_id").references(() => obligations.id, {
      onDelete: "set null",
    }),
    state: text("state").notNull().default("draft"),
    periodStart: timestamp("period_start", { withTimezone: true }),
    periodEnd: timestamp("period_end", { withTimezone: true }),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("filing_drafts_tenant_idx").on(table.tenantId),
    index("filing_drafts_requirement_idx").on(table.requirementId),
  ],
);

export const bankAccounts = pgTable(
  "bank_accounts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    legalEntityId: uuid("legal_entity_id").references(() => legalEntities.id, {
      onDelete: "set null",
    }),
    name: text("name").notNull(),
    purpose: text("purpose").notNull().default("operating"),
    state: text("state").notNull().default("draft"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("bank_accounts_tenant_idx").on(table.tenantId),
    uniqueIndex("bank_accounts_name_idx").on(table.tenantId, table.name),
  ],
);

export const paymentInstructions = pgTable(
  "payment_instructions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    bankAccountId: uuid("bank_account_id")
      .notNull()
      .references(() => bankAccounts.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("draft"),
    amountCents: integer("amount_cents"),
    currency: varchar("currency", { length: 3 }).notNull().default("USD"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("payment_instructions_tenant_idx").on(table.tenantId),
    index("payment_instructions_bank_idx").on(table.bankAccountId),
  ],
);

export const objectLinks = pgTable(
  "object_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    fromId: uuid("from_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    toId: uuid("to_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 80 }).notNull(),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    effectiveAt: timestamp("effective_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("object_links_tenant_idx").on(table.tenantId),
    index("object_links_from_idx").on(table.fromId),
    index("object_links_to_idx").on(table.toId),
    uniqueIndex("object_links_unique_idx").on(
      table.tenantId,
      table.fromId,
      table.toId,
      table.type,
    ),
  ],
);

export const objectVersions = pgTable(
  "object_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id")
      .notNull()
      .references(() => objects.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    data: jsonb("data").$type<JsonObject>().notNull(),
    changedByType: actorType("changed_by_type").notNull().default("system"),
    changedById: uuid("changed_by_id"),
    reason: text("reason"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("object_versions_tenant_idx").on(table.tenantId),
    uniqueIndex("object_versions_object_version_idx").on(
      table.objectId,
      table.version,
    ),
  ],
);

export const tasks = pgTable(
  "tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    triggerEventId: uuid("trigger_event_id"),
    title: text("title").notNull(),
    state: taskState("state").notNull().default("draft"),
    priority: taskPriority("priority").notNull().default("normal"),
    ownerType: actorType("owner_type"),
    ownerId: uuid("owner_id"),
    ownerRef: text("owner_ref").notNull().default("unassigned"),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    evidence: jsonb("evidence")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    outcome: jsonb("outcome")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    cost: jsonb("cost")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    kpi: jsonb("kpi")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    doneAt: timestamp("done_at", { withTimezone: true }),
    canceledAt: timestamp("canceled_at", { withTimezone: true }),
  },
  (table) => [
    index("tasks_tenant_idx").on(table.tenantId),
    index("tasks_object_idx").on(table.objectId),
    index("tasks_capability_idx").on(table.capabilityId),
    index("tasks_owner_idx").on(table.ownerType, table.ownerId),
    index("tasks_state_due_idx").on(table.tenantId, table.state, table.dueAt),
  ],
);

export const budgetReservations = pgTable(
  "budget_reservations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => budgetAccounts.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    units: integer("units").notNull(),
    state: reservationState("state").notNull().default("held"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("budget_reservations_tenant_idx").on(table.tenantId),
    index("budget_reservations_account_idx").on(table.accountId),
    index("budget_reservations_task_idx").on(table.taskId),
  ],
);

export const events = pgTable(
  "events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 120 }).notNull(),
    source: text("source").notNull().default("continuous"),
    actorType: actorType("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    actorRef: text("actor_ref").notNull().default("system"),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    adapterId: uuid("adapter_id").references(() => adapters.id, {
      onDelete: "set null",
    }),
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    occurredAt: timestamp("occurred_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("events_tenant_idx").on(table.tenantId),
    index("events_type_idx").on(table.tenantId, table.type),
    index("events_object_idx").on(table.objectId),
    index("events_task_idx").on(table.taskId),
    index("events_occurred_idx").on(table.tenantId, table.occurredAt),
    uniqueIndex("events_idempotency_idx").on(
      table.tenantId,
      table.source,
      table.idempotencyKey,
    ),
  ],
);

export const workerRuns = pgTable(
  "worker_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id")
      .notNull()
      .references(() => workers.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    connectionId: uuid("connection_id").references(() => connections.id, {
      onDelete: "set null",
    }),
    budgetAccountId: uuid("budget_account_id").references(
      () => budgetAccounts.id,
      { onDelete: "set null" },
    ),
    source: text("source").notNull().default("continuous.worker"),
    idempotencyKey: text("idempotency_key").notNull(),
    state: runState("state").notNull().default("queued"),
    mode: text("mode").notNull().default("simulation"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("worker_runs_tenant_idx").on(table.tenantId),
    index("worker_runs_worker_idx").on(table.workerId),
    index("worker_runs_task_idx").on(table.taskId),
    index("worker_runs_event_idx").on(table.eventId),
    index("worker_runs_state_idx").on(table.tenantId, table.state),
    uniqueIndex("worker_runs_idempotency_idx").on(
      table.tenantId,
      table.source,
      table.idempotencyKey,
    ),
  ],
);

export const approvalRequests = pgTable(
  "approval_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    workerRunId: uuid("worker_run_id").references(() => workerRuns.id, {
      onDelete: "set null",
    }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    requesterType: actorType("requester_type").notNull().default("worker"),
    requesterId: uuid("requester_id"),
    requesterRef: text("requester_ref").notNull().default("system"),
    reviewerUserId: uuid("reviewer_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("pending"),
    priority: taskPriority("priority").notNull().default("normal"),
    risk: riskLevel("risk").notNull().default("medium"),
    title: text("title").notNull(),
    summary: text("summary").notNull().default(""),
    requestedAction: jsonb("requested_action")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidence: jsonb("evidence")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    policy: jsonb("policy")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    decision: jsonb("decision")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    decidedByUserId: uuid("decided_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("approval_requests_tenant_idx").on(table.tenantId),
    index("approval_requests_state_idx").on(table.tenantId, table.state),
    index("approval_requests_task_idx").on(table.taskId),
    index("approval_requests_worker_run_idx").on(table.workerRunId),
    index("approval_requests_workflow_run_idx").on(table.workflowRunId),
    index("approval_requests_event_idx").on(table.eventId),
    index("approval_requests_reviewer_idx").on(table.reviewerUserId),
  ],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    type: varchar("type", { length: 140 }).notNull(),
    source: text("source").notNull().default("continuous"),
    actorType: actorType("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    actorRef: text("actor_ref").notNull().default("system"),
    targetType: text("target_type").notNull(),
    targetId: uuid("target_id"),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    workerRunId: uuid("worker_run_id").references(() => workerRuns.id, {
      onDelete: "set null",
    }),
    approvalRequestId: uuid("approval_request_id").references(
      () => approvalRequests.id,
      { onDelete: "set null" },
    ),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    risk: riskLevel("risk").notNull().default("medium"),
    idempotencyKey: text("idempotency_key"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("audit_events_tenant_idx").on(table.tenantId),
    index("audit_events_type_idx").on(table.tenantId, table.type),
    index("audit_events_actor_idx").on(table.actorType, table.actorId),
    index("audit_events_target_idx").on(table.tenantId, table.targetType, table.targetId),
    index("audit_events_task_idx").on(table.taskId),
    index("audit_events_worker_run_idx").on(table.workerRunId),
    index("audit_events_approval_idx").on(table.approvalRequestId),
    index("audit_events_created_idx").on(table.tenantId, table.createdAt),
    uniqueIndex("audit_events_idempotency_idx").on(
      table.tenantId,
      table.source,
      table.idempotencyKey,
    ),
  ],
);

export const evidence = pgTable(
  "evidence",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    kind: evidenceKind("kind").notNull(),
    name: text("name").notNull(),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    uri: text("uri"),
    hash: text("hash"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    redaction: jsonb("redaction")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    retainedUntil: timestamp("retained_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("evidence_tenant_idx").on(table.tenantId),
    index("evidence_object_idx").on(table.objectId),
    index("evidence_task_idx").on(table.taskId),
    index("evidence_event_idx").on(table.eventId),
  ],
);

export const workflowDefinitions = pgTable(
  "workflow_definitions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    key: varchar("key", { length: 140 }).notNull(),
    version: varchar("version", { length: 40 }).notNull().default("1.0.0"),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    domain: text("domain").notNull(),
    states: jsonb("states")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    transitions: jsonb("transitions")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    objects: jsonb("objects")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    approvals: jsonb("approvals")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    evidence: jsonb("evidence")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    tests: jsonb("tests")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [uniqueIndex("workflow_definitions_key_version_idx").on(table.key, table.version)],
);

export const workflowRuns = pgTable(
  "workflow_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "restrict" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    workerId: uuid("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    state: text("state").notNull(),
    idempotencyKey: text("idempotency_key"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    blockers: jsonb("blockers")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    metrics: jsonb("metrics")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("workflow_runs_tenant_idx").on(table.tenantId),
    index("workflow_runs_definition_idx").on(table.definitionId),
    index("workflow_runs_state_idx").on(table.tenantId, table.state),
    uniqueIndex("workflow_runs_idempotency_idx").on(
      table.tenantId,
      table.definitionId,
      table.idempotencyKey,
    ),
  ],
);

export const workflowSteps = pgTable(
  "workflow_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    definitionId: uuid("definition_id")
      .notNull()
      .references(() => workflowDefinitions.id, { onDelete: "restrict" }),
    workflowRunId: uuid("workflow_run_id")
      .notNull()
      .references(() => workflowRuns.id, { onDelete: "cascade" }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    approvalRequestId: uuid("approval_request_id").references(
      () => approvalRequests.id,
      { onDelete: "set null" },
    ),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    workerId: uuid("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull().default("transition"),
    name: text("name").notNull().default(""),
    state: runState("state").notNull().default("queued"),
    priority: taskPriority("priority").notNull().default("normal"),
    risk: riskLevel("risk").notNull().default("medium"),
    fromState: text("from_state"),
    toState: text("to_state").notNull(),
    attempt: integer("attempt").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(3),
    leaseOwner: text("lease_owner"),
    leasedUntil: timestamp("leased_until", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true }),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    idempotencyKey: text("idempotency_key").notNull(),
    input: jsonb("input")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    output: jsonb("output")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: jsonb("error")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("workflow_steps_tenant_idx").on(table.tenantId),
    index("workflow_steps_run_idx").on(table.workflowRunId),
    index("workflow_steps_state_idx").on(table.tenantId, table.state),
    index("workflow_steps_approval_idx").on(table.approvalRequestId),
    index("workflow_steps_task_idx").on(table.taskId),
    uniqueIndex("workflow_steps_idempotency_idx").on(
      table.tenantId,
      table.workflowRunId,
      table.idempotencyKey,
    ),
  ],
);

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull().default("draft"),
    sensitivity: riskLevel("sensitivity").notNull().default("medium"),
    hash: text("hash"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    retainedUntil: timestamp("retained_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("documents_tenant_idx").on(table.tenantId),
    index("documents_workflow_idx").on(table.workflowRunId),
    index("documents_object_idx").on(table.objectId),
  ],
);

export const evidencePackets = pgTable(
  "evidence_packets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    objectId: uuid("object_id").references(() => objects.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    state: text("state").notNull().default("prepared"),
    sensitivity: riskLevel("sensitivity").notNull().default("medium"),
    evidenceIds: jsonb("evidence_ids")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    documentIds: jsonb("document_ids")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    hash: text("hash"),
    retainedUntil: timestamp("retained_until", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("evidence_packets_tenant_idx").on(table.tenantId),
    index("evidence_packets_document_idx").on(table.documentId),
    index("evidence_packets_object_idx").on(table.objectId),
    index("evidence_packets_task_idx").on(table.taskId),
    index("evidence_packets_workflow_idx").on(table.workflowRunId),
  ],
);

export const decisions = pgTable(
  "decisions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    workflowRunId: uuid("workflow_run_id").references(() => workflowRuns.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").notNull().default("system"),
    actorId: uuid("actor_id"),
    kind: text("kind").notNull(),
    state: text("state").notNull().default("proposed"),
    decision: text("decision").notNull(),
    rationale: text("rationale").notNull().default(""),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("decisions_tenant_idx").on(table.tenantId),
    index("decisions_task_idx").on(table.taskId),
    index("decisions_workflow_idx").on(table.workflowRunId),
  ],
);

export const evaluations = pgTable(
  "evaluations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    workerId: uuid("worker_id").references(() => workers.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    kind: text("kind").notNull(),
    score: numeric("score", { precision: 6, scale: 3 }),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("evaluations_tenant_idx").on(table.tenantId),
    index("evaluations_worker_idx").on(table.workerId),
    index("evaluations_task_idx").on(table.taskId),
  ],
);

export const adapterRuns = pgTable(
  "adapter_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    workerRunId: uuid("worker_run_id").references(() => workerRuns.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    mode: text("mode").notNull().default("read"),
    operation: text("operation").notNull().default("sync"),
    idempotencyKey: text("idempotency_key"),
    state: runState("state").notNull().default("queued"),
    attempt: integer("attempt").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    reconciliationState: text("reconciliation_state")
      .notNull()
      .default("not_required"),
    cursor: text("cursor"),
    readCount: integer("read_count").notNull().default(0),
    writeCount: integer("write_count").notNull().default(0),
    receipt: jsonb("receipt")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: jsonb("error")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    startedAt: timestamp("started_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("adapter_runs_tenant_idx").on(table.tenantId),
    index("adapter_runs_connection_idx").on(table.connectionId),
    index("adapter_runs_worker_run_idx").on(table.workerRunId),
    index("adapter_runs_state_idx").on(table.tenantId, table.state),
    uniqueIndex("adapter_runs_idempotency_idx").on(
      table.connectionId,
      table.idempotencyKey,
    ),
  ],
);

export const adapterActions = pgTable(
  "adapter_actions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    connectionId: uuid("connection_id")
      .notNull()
      .references(() => connections.id, { onDelete: "cascade" }),
    adapterRunId: uuid("adapter_run_id").references(() => adapterRuns.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    eventId: uuid("event_id").references(() => events.id, {
      onDelete: "set null",
    }),
    idempotencyKey: text("idempotency_key").notNull(),
    state: callState("state").notNull().default("queued"),
    mode: text("mode").notNull().default("dry_run"),
    operation: text("operation").notNull().default("action"),
    attempt: integer("attempt").notNull().default(1),
    maxAttempts: integer("max_attempts").notNull().default(1),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    reconciliationState: text("reconciliation_state")
      .notNull()
      .default("pending"),
    request: jsonb("request")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    response: jsonb("response")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    receipt: jsonb("receipt")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    error: jsonb("error")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("adapter_actions_tenant_idx").on(table.tenantId),
    index("adapter_actions_connection_idx").on(table.connectionId),
    index("adapter_actions_run_idx").on(table.adapterRunId),
    index("adapter_actions_task_idx").on(table.taskId),
    index("adapter_actions_state_idx").on(table.tenantId, table.state),
    uniqueIndex("adapter_actions_idempotency_idx").on(
      table.connectionId,
      table.idempotencyKey,
    ),
  ],
);

export const inferences = pgTable(
  "inferences",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id").references(() => modelProviders.id, {
      onDelete: "set null",
    }),
    routeId: uuid("route_id").references(() => modelRoutes.id, {
      onDelete: "set null",
    }),
    budgetAccountId: uuid("budget_account_id").references(
      () => budgetAccounts.id,
      { onDelete: "set null" },
    ),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    promptHash: text("prompt_hash"),
    request: jsonb("request")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    result: jsonb("result")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    safety: jsonb("safety")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    promptTokens: integer("prompt_tokens").notNull().default(0),
    completionTokens: integer("completion_tokens").notNull().default(0),
    units: integer("units").notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 })
      .notNull()
      .default("0"),
    latencyMs: integer("latency_ms"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("inferences_tenant_idx").on(table.tenantId),
    index("inferences_task_idx").on(table.taskId),
    index("inferences_actor_idx").on(table.actorType, table.actorId),
    index("inferences_budget_idx").on(table.budgetAccountId),
  ],
);

export const usageEvents = pgTable(
  "usage_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    accountId: uuid("account_id")
      .notNull()
      .references(() => budgetAccounts.id, { onDelete: "cascade" }),
    reservationId: uuid("reservation_id").references(
      () => budgetReservations.id,
      { onDelete: "set null" },
    ),
    inferenceId: uuid("inference_id").references(() => inferences.id, {
      onDelete: "set null",
    }),
    taskId: uuid("task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    actorType: actorType("actor_type").notNull(),
    actorId: uuid("actor_id").notNull(),
    units: integer("units").notNull(),
    costUsd: numeric("cost_usd", { precision: 14, scale: 6 })
      .notNull()
      .default("0"),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("usage_events_tenant_idx").on(table.tenantId),
    index("usage_events_account_idx").on(table.accountId),
    index("usage_events_task_idx").on(table.taskId),
    index("usage_events_actor_idx").on(table.actorType, table.actorId),
  ],
);

export const uiContracts = pgTable(
  "ui_contracts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: uuid("tenant_id").references(() => tenants.id, {
      onDelete: "cascade",
    }),
    capabilityId: uuid("capability_id").references(() => capabilities.id, {
      onDelete: "set null",
    }),
    key: varchar("key", { length: 140 }).notNull(),
    version: varchar("version", { length: 40 }).notNull().default("1.0.0"),
    name: text("name").notNull(),
    purpose: text("purpose").notNull(),
    surface: text("surface").notNull().default("web"),
    objectType: varchar("object_type", { length: 80 }),
    taskState: taskState("task_state"),
    contract: jsonb("contract")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    actions: jsonb("actions")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    data: jsonb("data")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    mask: jsonb("mask")
      .$type<JsonObject>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("ui_contracts_tenant_idx").on(table.tenantId),
    index("ui_contracts_capability_idx").on(table.capabilityId),
    uniqueIndex("ui_contracts_key_version_idx").on(
      table.tenantId,
      table.key,
      table.version,
    ),
  ],
);

export const generatedViews = uiContracts;

export const tenantsRelations = relations(tenants, ({ many }) => ({
  users: many(users),
  workers: many(workers),
  approvalRequests: many(approvalRequests),
  auditEvents: many(auditEvents),
  evidencePackets: many(evidencePackets),
  customers: many(customers),
  leads: many(leads),
  offers: many(offers),
  quotes: many(quotes),
  jobs: many(jobs),
  invoices: many(invoices),
  payments: many(payments),
  objects: many(objects),
  tasks: many(tasks),
  events: many(events),
  workerRuns: many(workerRuns),
  workflowRuns: many(workflowRuns),
  workflowSteps: many(workflowSteps),
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  managedWorkers: many(workers),
  reviewRequests: many(approvalRequests, { relationName: "reviewer" }),
  decidedRequests: many(approvalRequests, { relationName: "decider" }),
}));

export const workersRelations = relations(workers, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [workers.tenantId],
    references: [tenants.id],
  }),
  manager: one(users, {
    fields: [workers.managerUserId],
    references: [users.id],
  }),
  runs: many(workerRuns),
  workflowRuns: many(workflowRuns),
  workflowSteps: many(workflowSteps),
}));

export const capabilitiesRelations = relations(capabilities, ({ many }) => ({
  grants: many(capabilityGrants),
  tasks: many(tasks),
  events: many(events),
  workflowSteps: many(workflowSteps),
  uiContracts: many(uiContracts),
}));

export const capabilityGrantsRelations = relations(
  capabilityGrants,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [capabilityGrants.tenantId],
      references: [tenants.id],
    }),
    capability: one(capabilities, {
      fields: [capabilityGrants.capabilityId],
      references: [capabilities.id],
    }),
  }),
);

export const adaptersRelations = relations(adapters, ({ many }) => ({
  connections: many(connections),
  events: many(events),
}));

export const connectionsRelations = relations(connections, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [connections.tenantId],
    references: [tenants.id],
  }),
  adapter: one(adapters, {
    fields: [connections.adapterId],
    references: [adapters.id],
  }),
  runs: many(adapterRuns),
  actions: many(adapterActions),
}));

export const objectsRelations = relations(objects, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [objects.tenantId],
    references: [tenants.id],
  }),
  createdByUser: one(users, {
    fields: [objects.createdByUserId],
    references: [users.id],
  }),
  createdByWorker: one(workers, {
    fields: [objects.createdByWorkerId],
    references: [workers.id],
  }),
  versions: many(objectVersions),
  tasks: many(tasks),
  events: many(events),
  evidence: many(evidence),
  evidencePackets: many(evidencePackets),
}));

export const customersRelations = relations(customers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [customers.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [customers.objectId],
    references: [objects.id],
  }),
}));

export const leadsRelations = relations(leads, ({ one }) => ({
  tenant: one(tenants, {
    fields: [leads.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [leads.objectId],
    references: [objects.id],
  }),
}));

export const offersRelations = relations(offers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [offers.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [offers.objectId],
    references: [objects.id],
  }),
}));

export const quotesRelations = relations(quotes, ({ one }) => ({
  tenant: one(tenants, {
    fields: [quotes.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [quotes.objectId],
    references: [objects.id],
  }),
}));

export const jobsRelations = relations(jobs, ({ one }) => ({
  tenant: one(tenants, {
    fields: [jobs.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [jobs.objectId],
    references: [objects.id],
  }),
}));

export const invoicesRelations = relations(invoices, ({ one }) => ({
  tenant: one(tenants, {
    fields: [invoices.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [invoices.objectId],
    references: [objects.id],
  }),
}));

export const paymentsRelations = relations(payments, ({ one }) => ({
  tenant: one(tenants, {
    fields: [payments.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [payments.objectId],
    references: [objects.id],
  }),
}));

export const objectLinksRelations = relations(objectLinks, ({ one }) => ({
  tenant: one(tenants, {
    fields: [objectLinks.tenantId],
    references: [tenants.id],
  }),
  from: one(objects, {
    fields: [objectLinks.fromId],
    references: [objects.id],
    relationName: "from_object",
  }),
  to: one(objects, {
    fields: [objectLinks.toId],
    references: [objects.id],
    relationName: "to_object",
  }),
}));

export const objectVersionsRelations = relations(objectVersions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [objectVersions.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [objectVersions.objectId],
    references: [objects.id],
  }),
}));

export const tasksRelations = relations(tasks, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [tasks.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [tasks.objectId],
    references: [objects.id],
  }),
  capability: one(capabilities, {
    fields: [tasks.capabilityId],
    references: [capabilities.id],
  }),
  reviewer: one(users, {
    fields: [tasks.reviewerUserId],
    references: [users.id],
  }),
  events: many(events),
  evidence: many(evidence),
  evidencePackets: many(evidencePackets),
  usageEvents: many(usageEvents),
  workerRuns: many(workerRuns),
  workflowSteps: many(workflowSteps),
  approvalRequests: many(approvalRequests),
  auditEvents: many(auditEvents),
}));

export const eventsRelations = relations(events, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [events.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [events.objectId],
    references: [objects.id],
  }),
  task: one(tasks, {
    fields: [events.taskId],
    references: [tasks.id],
  }),
  capability: one(capabilities, {
    fields: [events.capabilityId],
    references: [capabilities.id],
  }),
  adapter: one(adapters, {
    fields: [events.adapterId],
    references: [adapters.id],
  }),
  connection: one(connections, {
    fields: [events.connectionId],
    references: [connections.id],
  }),
  evidence: many(evidence),
  evidencePackets: many(evidencePackets),
  workerRuns: many(workerRuns),
  workflowSteps: many(workflowSteps),
  approvalRequests: many(approvalRequests),
  auditEvents: many(auditEvents),
}));

export const workerRunsRelations = relations(workerRuns, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [workerRuns.tenantId],
    references: [tenants.id],
  }),
  worker: one(workers, {
    fields: [workerRuns.workerId],
    references: [workers.id],
  }),
  task: one(tasks, {
    fields: [workerRuns.taskId],
    references: [tasks.id],
  }),
  event: one(events, {
    fields: [workerRuns.eventId],
    references: [events.id],
  }),
  capability: one(capabilities, {
    fields: [workerRuns.capabilityId],
    references: [capabilities.id],
  }),
  connection: one(connections, {
    fields: [workerRuns.connectionId],
    references: [connections.id],
  }),
  budgetAccount: one(budgetAccounts, {
    fields: [workerRuns.budgetAccountId],
    references: [budgetAccounts.id],
  }),
  approvalRequests: many(approvalRequests),
  auditEvents: many(auditEvents),
}));

export const workflowDefinitionsRelations = relations(workflowDefinitions, ({ many }) => ({
  runs: many(workflowRuns),
  steps: many(workflowSteps),
}));

export const workflowRunsRelations = relations(workflowRuns, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [workflowRuns.tenantId],
    references: [tenants.id],
  }),
  definition: one(workflowDefinitions, {
    fields: [workflowRuns.definitionId],
    references: [workflowDefinitions.id],
  }),
  object: one(objects, {
    fields: [workflowRuns.objectId],
    references: [objects.id],
  }),
  worker: one(workers, {
    fields: [workflowRuns.workerId],
    references: [workers.id],
  }),
  steps: many(workflowSteps),
  approvalRequests: many(approvalRequests),
  evidencePackets: many(evidencePackets),
}));

export const workflowStepsRelations = relations(workflowSteps, ({ one }) => ({
  tenant: one(tenants, {
    fields: [workflowSteps.tenantId],
    references: [tenants.id],
  }),
  definition: one(workflowDefinitions, {
    fields: [workflowSteps.definitionId],
    references: [workflowDefinitions.id],
  }),
  workflowRun: one(workflowRuns, {
    fields: [workflowSteps.workflowRunId],
    references: [workflowRuns.id],
  }),
  event: one(events, {
    fields: [workflowSteps.eventId],
    references: [events.id],
  }),
  approvalRequest: one(approvalRequests, {
    fields: [workflowSteps.approvalRequestId],
    references: [approvalRequests.id],
  }),
  task: one(tasks, {
    fields: [workflowSteps.taskId],
    references: [tasks.id],
  }),
  object: one(objects, {
    fields: [workflowSteps.objectId],
    references: [objects.id],
  }),
  worker: one(workers, {
    fields: [workflowSteps.workerId],
    references: [workers.id],
  }),
  capability: one(capabilities, {
    fields: [workflowSteps.capabilityId],
    references: [capabilities.id],
  }),
}));

export const documentsRelations = relations(documents, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [documents.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [documents.objectId],
    references: [objects.id],
  }),
  workflowRun: one(workflowRuns, {
    fields: [documents.workflowRunId],
    references: [workflowRuns.id],
  }),
  evidencePackets: many(evidencePackets),
}));

export const evidencePacketsRelations = relations(evidencePackets, ({ one }) => ({
  tenant: one(tenants, {
    fields: [evidencePackets.tenantId],
    references: [tenants.id],
  }),
  document: one(documents, {
    fields: [evidencePackets.documentId],
    references: [documents.id],
  }),
  object: one(objects, {
    fields: [evidencePackets.objectId],
    references: [objects.id],
  }),
  task: one(tasks, {
    fields: [evidencePackets.taskId],
    references: [tasks.id],
  }),
  workflowRun: one(workflowRuns, {
    fields: [evidencePackets.workflowRunId],
    references: [workflowRuns.id],
  }),
  event: one(events, {
    fields: [evidencePackets.eventId],
    references: [events.id],
  }),
  capability: one(capabilities, {
    fields: [evidencePackets.capabilityId],
    references: [capabilities.id],
  }),
}));

export const approvalRequestsRelations = relations(
  approvalRequests,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [approvalRequests.tenantId],
      references: [tenants.id],
    }),
    task: one(tasks, {
      fields: [approvalRequests.taskId],
      references: [tasks.id],
    }),
    workerRun: one(workerRuns, {
      fields: [approvalRequests.workerRunId],
      references: [workerRuns.id],
    }),
    workflowRun: one(workflowRuns, {
      fields: [approvalRequests.workflowRunId],
      references: [workflowRuns.id],
    }),
    event: one(events, {
      fields: [approvalRequests.eventId],
      references: [events.id],
    }),
    object: one(objects, {
      fields: [approvalRequests.objectId],
      references: [objects.id],
    }),
    capability: one(capabilities, {
      fields: [approvalRequests.capabilityId],
      references: [capabilities.id],
    }),
    reviewer: one(users, {
      fields: [approvalRequests.reviewerUserId],
      references: [users.id],
      relationName: "reviewer",
    }),
    decider: one(users, {
      fields: [approvalRequests.decidedByUserId],
      references: [users.id],
      relationName: "decider",
    }),
    auditEvents: many(auditEvents),
    workflowSteps: many(workflowSteps),
  }),
);

export const auditEventsRelations = relations(auditEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [auditEvents.tenantId],
    references: [tenants.id],
  }),
  task: one(tasks, {
    fields: [auditEvents.taskId],
    references: [tasks.id],
  }),
  workerRun: one(workerRuns, {
    fields: [auditEvents.workerRunId],
    references: [workerRuns.id],
  }),
  approvalRequest: one(approvalRequests, {
    fields: [auditEvents.approvalRequestId],
    references: [approvalRequests.id],
  }),
  event: one(events, {
    fields: [auditEvents.eventId],
    references: [events.id],
  }),
  object: one(objects, {
    fields: [auditEvents.objectId],
    references: [objects.id],
  }),
  capability: one(capabilities, {
    fields: [auditEvents.capabilityId],
    references: [capabilities.id],
  }),
}));

export const evidenceRelations = relations(evidence, ({ one }) => ({
  tenant: one(tenants, {
    fields: [evidence.tenantId],
    references: [tenants.id],
  }),
  object: one(objects, {
    fields: [evidence.objectId],
    references: [objects.id],
  }),
  task: one(tasks, {
    fields: [evidence.taskId],
    references: [tasks.id],
  }),
  event: one(events, {
    fields: [evidence.eventId],
    references: [events.id],
  }),
  capability: one(capabilities, {
    fields: [evidence.capabilityId],
    references: [capabilities.id],
  }),
}));

export const budgetPoliciesRelations = relations(
  budgetPolicies,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [budgetPolicies.tenantId],
      references: [tenants.id],
    }),
    accounts: many(budgetAccounts),
  }),
);

export const budgetPoolsRelations = relations(
  budgetPools,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [budgetPools.tenantId],
      references: [tenants.id],
    }),
    allocations: many(budgetAllocations),
  }),
);

export const budgetAccountsRelations = relations(
  budgetAccounts,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [budgetAccounts.tenantId],
      references: [tenants.id],
    }),
    policy: one(budgetPolicies, {
      fields: [budgetAccounts.policyId],
      references: [budgetPolicies.id],
    }),
    allocations: many(budgetAllocations),
    reservations: many(budgetReservations),
    usageEvents: many(usageEvents),
  }),
);

export const budgetAllocationsRelations = relations(
  budgetAllocations,
  ({ one }) => ({
    tenant: one(tenants, {
      fields: [budgetAllocations.tenantId],
      references: [tenants.id],
    }),
    pool: one(budgetPools, {
      fields: [budgetAllocations.poolId],
      references: [budgetPools.id],
    }),
    account: one(budgetAccounts, {
      fields: [budgetAllocations.accountId],
      references: [budgetAccounts.id],
    }),
  }),
);

export const budgetReservationsRelations = relations(
  budgetReservations,
  ({ one, many }) => ({
    tenant: one(tenants, {
      fields: [budgetReservations.tenantId],
      references: [tenants.id],
    }),
    account: one(budgetAccounts, {
      fields: [budgetReservations.accountId],
      references: [budgetAccounts.id],
    }),
    task: one(tasks, {
      fields: [budgetReservations.taskId],
      references: [tasks.id],
    }),
    usageEvents: many(usageEvents),
  }),
);

export const modelProvidersRelations = relations(
  modelProviders,
  ({ many }) => ({
    routes: many(modelRoutes),
    inferences: many(inferences),
  }),
);

export const modelRoutesRelations = relations(modelRoutes, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [modelRoutes.tenantId],
    references: [tenants.id],
  }),
  provider: one(modelProviders, {
    fields: [modelRoutes.providerId],
    references: [modelProviders.id],
  }),
  inferences: many(inferences),
}));

export const adapterRunsRelations = relations(adapterRuns, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [adapterRuns.tenantId],
    references: [tenants.id],
  }),
  connection: one(connections, {
    fields: [adapterRuns.connectionId],
    references: [connections.id],
  }),
  workerRun: one(workerRuns, {
    fields: [adapterRuns.workerRunId],
    references: [workerRuns.id],
  }),
  event: one(events, {
    fields: [adapterRuns.eventId],
    references: [events.id],
  }),
  actions: many(adapterActions),
}));

export const adapterActionsRelations = relations(adapterActions, ({ one }) => ({
  tenant: one(tenants, {
    fields: [adapterActions.tenantId],
    references: [tenants.id],
  }),
  connection: one(connections, {
    fields: [adapterActions.connectionId],
    references: [connections.id],
  }),
  adapterRun: one(adapterRuns, {
    fields: [adapterActions.adapterRunId],
    references: [adapterRuns.id],
  }),
  capability: one(capabilities, {
    fields: [adapterActions.capabilityId],
    references: [capabilities.id],
  }),
  task: one(tasks, {
    fields: [adapterActions.taskId],
    references: [tasks.id],
  }),
  event: one(events, {
    fields: [adapterActions.eventId],
    references: [events.id],
  }),
}));

export const inferencesRelations = relations(inferences, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [inferences.tenantId],
    references: [tenants.id],
  }),
  provider: one(modelProviders, {
    fields: [inferences.providerId],
    references: [modelProviders.id],
  }),
  route: one(modelRoutes, {
    fields: [inferences.routeId],
    references: [modelRoutes.id],
  }),
  budgetAccount: one(budgetAccounts, {
    fields: [inferences.budgetAccountId],
    references: [budgetAccounts.id],
  }),
  task: one(tasks, {
    fields: [inferences.taskId],
    references: [tasks.id],
  }),
  capability: one(capabilities, {
    fields: [inferences.capabilityId],
    references: [capabilities.id],
  }),
  usageEvents: many(usageEvents),
}));

export const usageEventsRelations = relations(usageEvents, ({ one }) => ({
  tenant: one(tenants, {
    fields: [usageEvents.tenantId],
    references: [tenants.id],
  }),
  account: one(budgetAccounts, {
    fields: [usageEvents.accountId],
    references: [budgetAccounts.id],
  }),
  reservation: one(budgetReservations, {
    fields: [usageEvents.reservationId],
    references: [budgetReservations.id],
  }),
  inference: one(inferences, {
    fields: [usageEvents.inferenceId],
    references: [inferences.id],
  }),
  task: one(tasks, {
    fields: [usageEvents.taskId],
    references: [tasks.id],
  }),
  capability: one(capabilities, {
    fields: [usageEvents.capabilityId],
    references: [capabilities.id],
  }),
}));

export const uiContractsRelations = relations(uiContracts, ({ one }) => ({
  tenant: one(tenants, {
    fields: [uiContracts.tenantId],
    references: [tenants.id],
  }),
  capability: one(capabilities, {
    fields: [uiContracts.capabilityId],
    references: [capabilities.id],
  }),
}));
