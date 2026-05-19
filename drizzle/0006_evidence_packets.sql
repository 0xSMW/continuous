CREATE TABLE "evidence_packets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"document_id" uuid,
	"object_id" uuid,
	"task_id" uuid,
	"workflow_run_id" uuid,
	"event_id" uuid,
	"capability_id" uuid,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"state" text DEFAULT 'prepared' NOT NULL,
	"sensitivity" "risk_level" DEFAULT 'medium' NOT NULL,
	"evidence_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"document_ids" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text,
	"retained_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_workflow_run_id_workflow_runs_id_fk" FOREIGN KEY ("workflow_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evidence_packets" ADD CONSTRAINT "evidence_packets_capability_id_capabilities_id_fk" FOREIGN KEY ("capability_id") REFERENCES "public"."capabilities"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "evidence_packets_tenant_idx" ON "evidence_packets" USING btree ("tenant_id");
--> statement-breakpoint
CREATE INDEX "evidence_packets_document_idx" ON "evidence_packets" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX "evidence_packets_object_idx" ON "evidence_packets" USING btree ("object_id");
--> statement-breakpoint
CREATE INDEX "evidence_packets_task_idx" ON "evidence_packets" USING btree ("task_id");
--> statement-breakpoint
CREATE INDEX "evidence_packets_workflow_idx" ON "evidence_packets" USING btree ("workflow_run_id");
