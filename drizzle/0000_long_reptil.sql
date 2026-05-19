CREATE EXTENSION IF NOT EXISTS "pgcrypto";--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'worker', 'adapter', 'system');--> statement-breakpoint
CREATE TYPE "public"."adapter_state" AS ENUM('draft', 'active', 'paused', 'error', 'archived');--> statement-breakpoint
CREATE TYPE "public"."budget_target" AS ENUM('tenant', 'team', 'user', 'worker', 'workflow', 'customer', 'project', 'vertical', 'risk');--> statement-breakpoint
CREATE TYPE "public"."call_state" AS ENUM('queued', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."capability_class" AS ENUM('read', 'classify', 'draft', 'recommend', 'task', 'send', 'update', 'submit', 'money', 'reveal', 'policy');--> statement-breakpoint
CREATE TYPE "public"."evidence_kind" AS ENUM('snapshot', 'draft', 'approval', 'receipt', 'trace', 'export', 'note');--> statement-breakpoint
CREATE TYPE "public"."reservation_state" AS ENUM('held', 'used', 'released', 'expired');--> statement-breakpoint
CREATE TYPE "public"."risk_level" AS ENUM('low', 'medium', 'high', 'critical');--> statement-breakpoint
CREATE TYPE "public"."run_state" AS ENUM('queued', 'running', 'done', 'failed', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."side_effect" AS ENUM('none', 'internal', 'external', 'financial', 'regulated');--> statement-breakpoint
CREATE TYPE "public"."task_priority" AS ENUM('low', 'normal', 'high', 'urgent');--> statement-breakpoint
CREATE TYPE "public"."task_state" AS ENUM('draft', 'active', 'waiting', 'approval_required', 'blocked', 'done', 'canceled');--> statement-breakpoint
CREATE TYPE "public"."tenant_state" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TYPE "public"."user_state" AS ENUM('invited', 'active', 'suspended', 'left');--> statement-breakpoint
CREATE TYPE "public"."worker_kind" AS ENUM('agent', 'human', 'robot', 'service');--> statement-breakpoint
CREATE TYPE "public"."worker_state" AS ENUM('draft', 'training', 'active', 'paused', 'retired');--> statement-breakpoint
CREATE TABLE "adapter_actions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"capability_id" uuid,
	"task_id" uuid,
	"event_id" uuid,
	"idempotency_key" text NOT NULL,
	"state" "call_state" DEFAULT 'queued' NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"receipt" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adapter_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"cursor" text,
	"read_count" integer DEFAULT 0 NOT NULL,
	"write_count" integer DEFAULT 0 NOT NULL,
	"error" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "adapters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"auth" text NOT NULL,
	"config_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"event_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"capabilities" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"policy_id" uuid,
	"name" text NOT NULL,
	"target" "budget_target" NOT NULL,
	"target_id" uuid,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_allocations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pool_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"units" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_policies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"key" varchar(140) NOT NULL,
	"target" "budget_target" NOT NULL,
	"monthly_units" integer NOT NULL,
	"per_task_units" integer,
	"soft_limit" integer DEFAULT 80 NOT NULL,
	"hard_limit" integer DEFAULT 100 NOT NULL,
	"overage" text DEFAULT 'manager_approval' NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "budget_policies_limits_check" CHECK ("budget_policies"."soft_limit" >= 0 and "budget_policies"."hard_limit" >= "budget_policies"."soft_limit")
);
--> statement-breakpoint
CREATE TABLE "budget_pools" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"period" varchar(20) DEFAULT 'month' NOT NULL,
	"units" integer NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "budget_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"task_id" uuid,
	"units" integer NOT NULL,
	"state" "reservation_state" DEFAULT 'held' NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(140) NOT NULL,
	"version" varchar(40) DEFAULT '1.0.0' NOT NULL,
	"name" text NOT NULL,
	"class" "capability_class" NOT NULL,
	"risk" "risk_level" DEFAULT 'low' NOT NULL,
	"side_effect" "side_effect" DEFAULT 'none' NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"input_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output_schema" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "capability_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"capability_id" uuid NOT NULL,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"adapter_id" uuid NOT NULL,
	"name" text NOT NULL,
	"state" "adapter_state" DEFAULT 'draft' NOT NULL,
	"external_account_id" text,
	"scopes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"created_by_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" varchar(120) NOT NULL,
	"source" text DEFAULT 'continuous' NOT NULL,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"actor_ref" text DEFAULT 'system' NOT NULL,
	"object_id" uuid,
	"task_id" uuid,
	"capability_id" uuid,
	"adapter_id" uuid,
	"connection_id" uuid,
	"idempotency_key" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evidence" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" "evidence_kind" NOT NULL,
	"name" text NOT NULL,
	"object_id" uuid,
	"task_id" uuid,
	"event_id" uuid,
	"capability_id" uuid,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"uri" text,
	"hash" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"redaction" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retained_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ui_contracts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"capability_id" uuid,
	"key" varchar(140) NOT NULL,
	"version" varchar(40) DEFAULT '1.0.0' NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"surface" text DEFAULT 'web' NOT NULL,
	"object_type" varchar(80),
	"task_state" "task_state",
	"contract" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"mask" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "inferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider_id" uuid,
	"route_id" uuid,
	"budget_account_id" uuid,
	"task_id" uuid,
	"capability_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"prompt_hash" text,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"result" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"safety" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_tokens" integer DEFAULT 0 NOT NULL,
	"completion_tokens" integer DEFAULT 0 NOT NULL,
	"units" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'new' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_providers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'hosted' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "model_routes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"provider_id" uuid NOT NULL,
	"key" varchar(120) NOT NULL,
	"name" text NOT NULL,
	"model" text NOT NULL,
	"purpose" text DEFAULT 'default' NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"from_id" uuid NOT NULL,
	"to_id" uuid NOT NULL,
	"type" varchar(80) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "object_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"data" jsonb NOT NULL,
	"changed_by_type" "actor_type" DEFAULT 'system' NOT NULL,
	"changed_by_id" uuid,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "objects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"type" varchar(80) NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"source" text DEFAULT 'continuous' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by_user_id" uuid,
	"created_by_worker_id" uuid,
	"effective_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "offers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "quotes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid,
	"capability_id" uuid,
	"trigger_event_id" uuid,
	"title" text NOT NULL,
	"state" "task_state" DEFAULT 'draft' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"owner_type" "actor_type",
	"owner_id" uuid,
	"owner_ref" text DEFAULT 'unassigned' NOT NULL,
	"reviewer_user_id" uuid,
	"due_at" timestamp with time zone,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cost" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kpi" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"done_at" timestamp with time zone,
	"canceled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" varchar(80) NOT NULL,
	"state" "tenant_state" DEFAULT 'active' NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"reservation_id" uuid,
	"inference_id" uuid,
	"task_id" uuid,
	"capability_id" uuid,
	"actor_type" "actor_type" NOT NULL,
	"actor_id" uuid NOT NULL,
	"units" integer NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"state" "user_state" DEFAULT 'invited' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"manager_user_id" uuid,
	"kind" "worker_kind" DEFAULT 'agent' NOT NULL,
	"state" "worker_state" DEFAULT 'draft' NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"mission" text NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"memory" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"kpis" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"autonomy_level" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "workers_autonomy_level_check" CHECK ("workers"."autonomy_level" >= 0 and "workers"."autonomy_level" <= 7)
);
--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD CONSTRAINT "adapter_actions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD CONSTRAINT "adapter_actions_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD CONSTRAINT "adapter_actions_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD CONSTRAINT "adapter_actions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD CONSTRAINT "adapter_actions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD CONSTRAINT "adapter_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD CONSTRAINT "adapter_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_accounts" ADD CONSTRAINT "budget_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_accounts" ADD CONSTRAINT "budget_accounts_policy_id_budget_policies_id_fk" FOREIGN KEY ("policy_id") REFERENCES "public"."budget_policies"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_pool_id_budget_pools_id_fk" FOREIGN KEY ("pool_id") REFERENCES "public"."budget_pools"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_allocations" ADD CONSTRAINT "budget_allocations_account_id_budget_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_policies" ADD CONSTRAINT "budget_policies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_pools" ADD CONSTRAINT "budget_pools_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_account_id_budget_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "budget_reservations" ADD CONSTRAINT "budget_reservations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "capability_grants" ADD CONSTRAINT "capability_grants_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_adapter_id_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."adapters"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connections" ADD CONSTRAINT "connections_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_adapter_id_adapters_id_fk" FOREIGN KEY ("adapter_id") REFERENCES "public"."adapters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence" ADD CONSTRAINT "evidence_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ui_contracts" ADD CONSTRAINT "ui_contracts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ui_contracts" ADD CONSTRAINT "ui_contracts_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inferences" ADD CONSTRAINT "inferences_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inferences" ADD CONSTRAINT "inferences_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inferences" ADD CONSTRAINT "inferences_route_id_model_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."model_routes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inferences" ADD CONSTRAINT "inferences_budget_account_id_budget_accounts_id_fk" FOREIGN KEY ("budget_account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inferences" ADD CONSTRAINT "inferences_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inferences" ADD CONSTRAINT "inferences_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_routes" ADD CONSTRAINT "model_routes_provider_id_model_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."model_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_links" ADD CONSTRAINT "object_links_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_links" ADD CONSTRAINT "object_links_from_id_objects_id_fk" FOREIGN KEY ("from_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_links" ADD CONSTRAINT "object_links_to_id_objects_id_fk" FOREIGN KEY ("to_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "object_versions" ADD CONSTRAINT "object_versions_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "objects" ADD CONSTRAINT "objects_created_by_worker_id_workers_id_fk" FOREIGN KEY ("created_by_worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "offers" ADD CONSTRAINT "offers_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewer_user_id_users_id_fk" FOREIGN KEY ("reviewer_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_account_id_budget_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_reservation_id_budget_reservations_id_fk" FOREIGN KEY ("reservation_id") REFERENCES "public"."budget_reservations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_inference_id_inferences_id_fk" FOREIGN KEY ("inference_id") REFERENCES "public"."inferences"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workers" ADD CONSTRAINT "workers_manager_user_id_users_id_fk" FOREIGN KEY ("manager_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adapter_actions_tenant_idx" ON "adapter_actions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "adapter_actions_connection_idx" ON "adapter_actions" USING btree ("connection_id");--> statement-breakpoint
CREATE INDEX "adapter_actions_task_idx" ON "adapter_actions" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_actions_idempotency_idx" ON "adapter_actions" USING btree ("connection_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "adapter_runs_tenant_idx" ON "adapter_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "adapter_runs_connection_idx" ON "adapter_runs" USING btree ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "adapters_key_idx" ON "adapters" USING btree ("key");--> statement-breakpoint
CREATE INDEX "adapters_kind_idx" ON "adapters" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "budget_accounts_tenant_idx" ON "budget_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "budget_accounts_target_idx" ON "budget_accounts" USING btree ("target","target_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_tenant_idx" ON "budget_allocations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_pool_idx" ON "budget_allocations" USING btree ("pool_id");--> statement-breakpoint
CREATE INDEX "budget_allocations_account_idx" ON "budget_allocations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "budget_policies_tenant_idx" ON "budget_policies" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "budget_policies_key_tenant_idx" ON "budget_policies" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "budget_pools_tenant_idx" ON "budget_pools" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "budget_pools_period_idx" ON "budget_pools" USING btree ("starts_at","ends_at");--> statement-breakpoint
CREATE INDEX "budget_reservations_tenant_idx" ON "budget_reservations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_account_idx" ON "budget_reservations" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "budget_reservations_task_idx" ON "budget_reservations" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capabilities_key_version_idx" ON "capabilities" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "capabilities_class_idx" ON "capabilities" USING btree ("class");--> statement-breakpoint
CREATE INDEX "capabilities_risk_idx" ON "capabilities" USING btree ("risk");--> statement-breakpoint
CREATE INDEX "capability_grants_tenant_idx" ON "capability_grants" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "capability_grants_actor_idx" ON "capability_grants" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE UNIQUE INDEX "capability_grants_actor_capability_idx" ON "capability_grants" USING btree ("tenant_id","actor_type","actor_id","capability_id");--> statement-breakpoint
CREATE INDEX "connections_tenant_idx" ON "connections" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "connections_adapter_idx" ON "connections" USING btree ("adapter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "connections_external_account_idx" ON "connections" USING btree ("tenant_id","adapter_id","external_account_id");--> statement-breakpoint
CREATE INDEX "customers_tenant_idx" ON "customers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_object_idx" ON "customers" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_external_idx" ON "customers" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "events_tenant_idx" ON "events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "events_type_idx" ON "events" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE INDEX "events_object_idx" ON "events" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "events_task_idx" ON "events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "events_occurred_idx" ON "events" USING btree ("tenant_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "events_idempotency_idx" ON "events" USING btree ("tenant_id","source","idempotency_key");--> statement-breakpoint
CREATE INDEX "evidence_tenant_idx" ON "evidence" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "evidence_object_idx" ON "evidence" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "evidence_task_idx" ON "evidence" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "evidence_event_idx" ON "evidence" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "ui_contracts_tenant_idx" ON "ui_contracts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "ui_contracts_capability_idx" ON "ui_contracts" USING btree ("capability_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ui_contracts_key_version_idx" ON "ui_contracts" USING btree ("tenant_id","key","version");--> statement-breakpoint
CREATE INDEX "inferences_tenant_idx" ON "inferences" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "inferences_task_idx" ON "inferences" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "inferences_actor_idx" ON "inferences" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "inferences_budget_idx" ON "inferences" USING btree ("budget_account_id");--> statement-breakpoint
CREATE INDEX "invoices_tenant_idx" ON "invoices" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_object_idx" ON "invoices" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_external_idx" ON "invoices" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "jobs_tenant_idx" ON "jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_object_idx" ON "jobs" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_external_idx" ON "jobs" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "leads_tenant_idx" ON "leads" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_object_idx" ON "leads" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "leads_external_idx" ON "leads" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_providers_key_idx" ON "model_providers" USING btree ("key");--> statement-breakpoint
CREATE INDEX "model_providers_kind_idx" ON "model_providers" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "model_routes_tenant_idx" ON "model_routes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "model_routes_provider_idx" ON "model_routes" USING btree ("provider_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_routes_key_tenant_idx" ON "model_routes" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE INDEX "object_links_tenant_idx" ON "object_links" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "object_links_from_idx" ON "object_links" USING btree ("from_id");--> statement-breakpoint
CREATE INDEX "object_links_to_idx" ON "object_links" USING btree ("to_id");--> statement-breakpoint
CREATE UNIQUE INDEX "object_links_unique_idx" ON "object_links" USING btree ("tenant_id","from_id","to_id","type");--> statement-breakpoint
CREATE INDEX "object_versions_tenant_idx" ON "object_versions" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "object_versions_object_version_idx" ON "object_versions" USING btree ("object_id","version");--> statement-breakpoint
CREATE INDEX "objects_tenant_idx" ON "objects" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "objects_type_idx" ON "objects" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "objects_external_idx" ON "objects" USING btree ("tenant_id","source","external_id");--> statement-breakpoint
CREATE INDEX "offers_tenant_idx" ON "offers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_object_idx" ON "offers" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "offers_external_idx" ON "offers" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "payments_tenant_idx" ON "payments" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_object_idx" ON "payments" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_external_idx" ON "payments" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "quotes_tenant_idx" ON "quotes" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_object_idx" ON "quotes" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_external_idx" ON "quotes" USING btree ("tenant_id","external_id");--> statement-breakpoint
CREATE INDEX "tasks_tenant_idx" ON "tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tasks_object_idx" ON "tasks" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "tasks_capability_idx" ON "tasks" USING btree ("capability_id");--> statement-breakpoint
CREATE INDEX "tasks_owner_idx" ON "tasks" USING btree ("owner_type","owner_id");--> statement-breakpoint
CREATE INDEX "tasks_state_due_idx" ON "tasks" USING btree ("tenant_id","state","due_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_idx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE INDEX "usage_events_tenant_idx" ON "usage_events" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_events_account_idx" ON "usage_events" USING btree ("account_id");--> statement-breakpoint
CREATE INDEX "usage_events_task_idx" ON "usage_events" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "usage_events_actor_idx" ON "usage_events" USING btree ("actor_type","actor_id");--> statement-breakpoint
CREATE INDEX "users_tenant_idx" ON "users" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_tenant_email_idx" ON "users" USING btree ("tenant_id","email");--> statement-breakpoint
CREATE INDEX "workers_tenant_idx" ON "workers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workers_manager_idx" ON "workers" USING btree ("manager_user_id");
