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
    state: runState("state").notNull().default("queued"),
    cursor: text("cursor"),
    readCount: integer("read_count").notNull().default(0),
    writeCount: integer("write_count").notNull().default(0),
    error: jsonb("error")
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
    index("adapter_actions_task_idx").on(table.taskId),
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
}));

export const usersRelations = relations(users, ({ one, many }) => ({
  tenant: one(tenants, {
    fields: [users.tenantId],
    references: [tenants.id],
  }),
  managedWorkers: many(workers),
}));

export const workersRelations = relations(workers, ({ one }) => ({
  tenant: one(tenants, {
    fields: [workers.tenantId],
    references: [tenants.id],
  }),
  manager: one(users, {
    fields: [workers.managerUserId],
    references: [users.id],
  }),
}));

export const capabilitiesRelations = relations(capabilities, ({ many }) => ({
  grants: many(capabilityGrants),
  tasks: many(tasks),
  events: many(events),
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
  usageEvents: many(usageEvents),
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

export const adapterRunsRelations = relations(adapterRuns, ({ one }) => ({
  tenant: one(tenants, {
    fields: [adapterRuns.tenantId],
    references: [tenants.id],
  }),
  connection: one(connections, {
    fields: [adapterRuns.connectionId],
    references: [connections.id],
  }),
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
