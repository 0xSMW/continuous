CREATE TABLE "workflow_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"definition_id" uuid NOT NULL,
	"workflow_run_id" uuid NOT NULL,
	"event_id" uuid,
	"approval_request_id" uuid,
	"task_id" uuid,
	"object_id" uuid,
	"worker_id" uuid,
	"capability_id" uuid,
	"kind" text DEFAULT 'transition' NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"priority" "task_priority" DEFAULT 'normal' NOT NULL,
	"risk" "risk_level" DEFAULT 'medium' NOT NULL,
	"from_state" text,
	"to_state" text NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"lease_owner" text,
	"leased_until" timestamp with time zone,
	"due_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"idempotency_key" text NOT NULL,
	"input" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"output" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "approval_requests" ADD COLUMN "workflow_run_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_approval_request_id_approval_requests_id_fk" FOREIGN KEY ("approval_request_id") REFERENCES "public"."approval_requests"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_steps" ADD CONSTRAINT "workflow_steps_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "workflow_steps_tenant_idx" ON "workflow_steps" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "workflow_steps_run_idx" ON "workflow_steps" USING btree ("workflow_run_id");--> statement-breakpoint
CREATE INDEX "workflow_steps_state_idx" ON "workflow_steps" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "workflow_steps_approval_idx" ON "workflow_steps" USING btree ("approval_request_id");--> statement-breakpoint
CREATE INDEX "workflow_steps_task_idx" ON "workflow_steps" USING btree ("task_id");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_steps_idempotency_idx" ON "workflow_steps" USING btree ("tenant_id","workflow_run_id","idempotency_key");--> statement-breakpoint
ALTER TABLE "approval_requests" ADD CONSTRAINT "approval_requests_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "approval_requests_workflow_run_idx" ON "approval_requests" USING btree ("workflow_run_id");