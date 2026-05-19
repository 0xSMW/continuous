CREATE TABLE "customer_signals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"object_id" uuid NOT NULL,
	"customer_id" uuid,
	"type" varchar(80) NOT NULL,
	"state" text DEFAULT 'captured' NOT NULL,
	"source" text DEFAULT 'continuous' NOT NULL,
	"external_id" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_signals" ADD CONSTRAINT "customer_signals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_signals" ADD CONSTRAINT "customer_signals_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_signals" ADD CONSTRAINT "customer_signals_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_signals_tenant_idx" ON "customer_signals" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "customer_signals_customer_idx" ON "customer_signals" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_signals_type_idx" ON "customer_signals" USING btree ("tenant_id","type");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_signals_object_idx" ON "customer_signals" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_signals_external_idx" ON "customer_signals" USING btree ("tenant_id","type","external_id");
