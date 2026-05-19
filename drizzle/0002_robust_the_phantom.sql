CREATE TABLE "worker_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"worker_id" uuid NOT NULL,
	"task_id" uuid,
	"event_id" uuid,
	"capability_id" uuid,
	"connection_id" uuid,
	"budget_account_id" uuid,
	"source" text DEFAULT 'continuous.worker' NOT NULL,
	"idempotency_key" text NOT NULL,
	"state" "run_state" DEFAULT 'queued' NOT NULL,
	"mode" text DEFAULT 'simulation' NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_worker_id_workers_id_fk" FOREIGN KEY ("worker_id") REFERENCES "public"."workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_connection_id_connections_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "worker_runs" ADD CONSTRAINT "worker_runs_budget_account_id_budget_accounts_id_fk" FOREIGN KEY ("budget_account_id") REFERENCES "public"."budget_accounts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "worker_runs_tenant_idx" ON "worker_runs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "worker_runs_worker_idx" ON "worker_runs" USING btree ("worker_id");--> statement-breakpoint
CREATE INDEX "worker_runs_task_idx" ON "worker_runs" USING btree ("task_id");--> statement-breakpoint
CREATE INDEX "worker_runs_event_idx" ON "worker_runs" USING btree ("event_id");--> statement-breakpoint
CREATE INDEX "worker_runs_state_idx" ON "worker_runs" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "worker_runs_idempotency_idx" ON "worker_runs" USING btree ("tenant_id","source","idempotency_key");