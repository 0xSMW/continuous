ALTER TABLE "adapter_actions" ADD COLUMN "adapter_run_id" uuid;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD COLUMN "mode" text DEFAULT 'dry_run' NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD COLUMN "operation" text DEFAULT 'action' NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD COLUMN "reconciliation_state" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "worker_run_id" uuid;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "event_id" uuid;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "mode" text DEFAULT 'read' NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "operation" text DEFAULT 'sync' NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "attempt" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "max_attempts" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "next_attempt_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "reconciliation_state" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "receipt" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD COLUMN "data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "adapter_actions" ADD CONSTRAINT "adapter_actions_adapter_run_id_adapter_runs_id_fk" FOREIGN KEY ("adapter_run_id") REFERENCES "public"."adapter_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD CONSTRAINT "adapter_runs_worker_run_id_worker_runs_id_fk" FOREIGN KEY ("worker_run_id") REFERENCES "public"."worker_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "adapter_runs" ADD CONSTRAINT "adapter_runs_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adapter_actions_run_idx" ON "adapter_actions" USING btree ("adapter_run_id");--> statement-breakpoint
CREATE INDEX "adapter_actions_state_idx" ON "adapter_actions" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "adapter_runs_worker_run_idx" ON "adapter_runs" USING btree ("worker_run_id");--> statement-breakpoint
CREATE INDEX "adapter_runs_state_idx" ON "adapter_runs" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "adapter_runs_idempotency_idx" ON "adapter_runs" USING btree ("connection_id","idempotency_key");