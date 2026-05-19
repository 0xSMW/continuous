CREATE TABLE "bank_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"name" text NOT NULL,
	"purpose" text DEFAULT 'operating' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "compensation_agreements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"employment_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"period" text DEFAULT 'hour' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "decisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid,
	"event_id" uuid,
	"workflow_run_id" uuid,
	"capability_id" uuid,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'proposed' NOT NULL,
	"decision" text NOT NULL,
	"rationale" text DEFAULT '' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid,
	"workflow_run_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"sensitivity" "risk_level" DEFAULT 'medium' NOT NULL,
	"hash" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"retained_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "employments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"person_id" uuid NOT NULL,
	"worker_id" uuid,
	"legal_entity_id" uuid,
	"kind" text DEFAULT 'employee' NOT NULL,
	"title" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"manager_ref" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_identifiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid NOT NULL,
	"kind" varchar(80) NOT NULL,
	"value" text NOT NULL,
	"issuer" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_id" uuid,
	"task_id" uuid,
	"event_id" uuid,
	"kind" text NOT NULL,
	"score" numeric(6, 3),
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filing_drafts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"requirement_id" uuid NOT NULL,
	"obligation_id" uuid,
	"state" text DEFAULT 'draft' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "filing_requirements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"rule_pack_id" uuid,
	"form" text NOT NULL,
	"cadence" text NOT NULL,
	"agency" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid,
	"legal_name" text NOT NULL,
	"entity_type" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effective_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "obligations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid,
	"rule_pack_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'open' NOT NULL,
	"name" text NOT NULL,
	"due_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pay_schedules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_entity_id" uuid,
	"name" text NOT NULL,
	"frequency" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payment_instructions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"bank_account_id" uuid NOT NULL,
	"object_id" uuid,
	"kind" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"amount_cents" integer,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"pay_schedule_id" uuid NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"period_start" timestamp with time zone NOT NULL,
	"period_end" timestamp with time zone NOT NULL,
	"check_date" timestamp with time zone NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "people" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid,
	"name" text NOT NULL,
	"role" text DEFAULT 'person' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rule_packs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(140) NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"jurisdiction" text DEFAULT 'US' NOT NULL,
	"version" varchar(40) DEFAULT '0.1.0' NOT NULL,
	"source_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"effective_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(140) NOT NULL,
	"version" varchar(40) DEFAULT '1.0.0' NOT NULL,
	"name" text NOT NULL,
	"purpose" text NOT NULL,
	"domain" text NOT NULL,
	"states" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"transitions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"objects" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"approvals" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tests" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"object_id" uuid,
	"worker_id" uuid,
	"state" text NOT NULL,
	"idempotency_key" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"blockers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bank_accounts" ADD CONSTRAINT "bank_accounts_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_agreements" ADD CONSTRAINT "compensation_agreements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "compensation_agreements" ADD CONSTRAINT "compensation_agreements_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "decisions" ADD CONSTRAINT "decisions_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "employments" ADD CONSTRAINT "employments_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identifiers" ADD CONSTRAINT "entity_identifiers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_identifiers" ADD CONSTRAINT "entity_identifiers_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evaluations" ADD CONSTRAINT "evaluations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_drafts" ADD CONSTRAINT "filing_drafts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_drafts" ADD CONSTRAINT "filing_drafts_requirement_id_filing_requirements_id_fk" FOREIGN KEY ("requirement_id") REFERENCES "public"."filing_requirements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_drafts" ADD CONSTRAINT "filing_drafts_obligation_id_obligations_id_fk" FOREIGN KEY ("obligation_id") REFERENCES "public"."obligations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_requirements" ADD CONSTRAINT "filing_requirements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_requirements" ADD CONSTRAINT "filing_requirements_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "filing_requirements" ADD CONSTRAINT "filing_requirements_rule_pack_id_rule_packs_id_fk" FOREIGN KEY ("rule_pack_id") REFERENCES "public"."rule_packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_entities" ADD CONSTRAINT "legal_entities_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "obligations" ADD CONSTRAINT "obligations_rule_pack_id_rule_packs_id_fk" FOREIGN KEY ("rule_pack_id") REFERENCES "public"."rule_packs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_schedules" ADD CONSTRAINT "pay_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pay_schedules" ADD CONSTRAINT "pay_schedules_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_bank_account_id_bank_accounts_id_fk" FOREIGN KEY ("bank_account_id") REFERENCES "public"."bank_accounts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_instructions" ADD CONSTRAINT "payment_instructions_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_pay_schedule_id_pay_schedules_id_fk" FOREIGN KEY ("pay_schedule_id") REFERENCES "public"."pay_schedules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "people" ADD CONSTRAINT "people_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bank_accounts_tenant_idx" ON "bank_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bank_accounts_name_idx" ON "bank_accounts" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "compensation_agreements_tenant_idx" ON "compensation_agreements" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "compensation_agreements_employment_idx" ON "compensation_agreements" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "decisions_tenant_idx" ON "decisions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "decisions_task_idx" ON "decisions" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "decisions_workflow_idx" ON "decisions" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "documents_tenant_idx" ON "documents" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "documents_workflow_idx" ON "documents" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "documents_object_idx" ON "documents" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "employments_tenant_idx" ON "employments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "employments_person_idx" ON "employments" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "employments_worker_idx" ON "employments" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "entity_identifiers_tenant_idx" ON "entity_identifiers" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "entity_identifiers_unique_idx" ON "entity_identifiers" USING btree ("tenant_id","legal_entity_id","kind","value");--> statement-breakpoint
CREATE INDEX "evaluations_tenant_idx" ON "evaluations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "evaluations_worker_idx" ON "evaluations" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "evaluations_task_idx" ON "evaluations" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "filing_drafts_tenant_idx" ON "filing_drafts" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "filing_drafts_requirement_idx" ON "filing_drafts" USING btree ("requirement_id");--> statement-breakpoint
CREATE INDEX "filing_requirements_tenant_idx" ON "filing_requirements" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "filing_requirements_unique_idx" ON "filing_requirements" USING btree ("tenant_id","form","agency");--> statement-breakpoint
CREATE INDEX "legal_entities_tenant_idx" ON "legal_entities" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_object_idx" ON "legal_entities" USING btree ("object_id");--> statement-breakpoint
CREATE INDEX "obligations_tenant_idx" ON "obligations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "obligations_due_idx" ON "obligations" USING btree ("tenant_id","state","due_at");--> statement-breakpoint
CREATE INDEX "pay_schedules_tenant_idx" ON "pay_schedules" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pay_schedules_name_idx" ON "pay_schedules" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "payment_instructions_tenant_idx" ON "payment_instructions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payment_instructions_bank_idx" ON "payment_instructions" USING btree ("bank_account_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_tenant_idx" ON "payroll_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payroll_runs_schedule_idx" ON "payroll_runs" USING btree ("pay_schedule_id");--> statement-breakpoint
CREATE INDEX "people_tenant_idx" ON "people" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "people_object_idx" ON "people" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "rule_packs_key_version_idx" ON "rule_packs" USING btree ("key","version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_definitions_key_version_idx" ON "workflow_definitions" USING btree ("key","version");--> statement-breakpoint
CREATE INDEX "workflow_runs_tenant_idx" ON "workflow_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_definition_idx" ON "workflow_runs" USING btree ("definition_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_state_idx" ON "workflow_runs" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_idempotency_idx" ON "workflow_runs" USING btree ("tenant_id","definition_id","idempotency_key");