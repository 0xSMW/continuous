CREATE TABLE "payroll_liabilities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"statement_id" uuid,
	"kind" text NOT NULL,
	"payee" text,
	"jurisdiction" text,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"due_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"statement_id" uuid NOT NULL,
	"employment_id" uuid,
	"kind" text NOT NULL,
	"code" varchar(120),
	"description" text,
	"amount_cents" integer NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"taxable" boolean DEFAULT false NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_statements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"employment_id" uuid,
	"person_id" uuid,
	"object_id" uuid,
	"external_id" text,
	"state" text DEFAULT 'draft' NOT NULL,
	"gross_cents" integer DEFAULT 0 NOT NULL,
	"net_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"deduction_cents" integer DEFAULT 0 NOT NULL,
	"currency" varchar(3) DEFAULT 'USD' NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"check_date" timestamp with time zone,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payroll_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"payroll_run_id" uuid NOT NULL,
	"statement_id" uuid,
	"kind" text DEFAULT 'calculation' NOT NULL,
	"source_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outputs" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rules" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"hash" text,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "payroll_liabilities" ADD CONSTRAINT "payroll_liabilities_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_liabilities" ADD CONSTRAINT "payroll_liabilities_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_liabilities" ADD CONSTRAINT "payroll_liabilities_statement_id_payroll_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."payroll_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_statement_id_payroll_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."payroll_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_lines" ADD CONSTRAINT "payroll_lines_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_employment_id_employments_id_fk" FOREIGN KEY ("employment_id") REFERENCES "public"."employments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_person_id_people_id_fk" FOREIGN KEY ("person_id") REFERENCES "public"."people"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_statements" ADD CONSTRAINT "payroll_statements_object_id_objects_id_fk" FOREIGN KEY ("object_id") REFERENCES "public"."objects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_traces" ADD CONSTRAINT "payroll_traces_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_traces" ADD CONSTRAINT "payroll_traces_payroll_run_id_payroll_runs_id_fk" FOREIGN KEY ("payroll_run_id") REFERENCES "public"."payroll_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payroll_traces" ADD CONSTRAINT "payroll_traces_statement_id_payroll_statements_id_fk" FOREIGN KEY ("statement_id") REFERENCES "public"."payroll_statements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "payroll_liabilities_tenant_idx" ON "payroll_liabilities" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payroll_liabilities_run_idx" ON "payroll_liabilities" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "payroll_liabilities_statement_idx" ON "payroll_liabilities" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "payroll_liabilities_state_idx" ON "payroll_liabilities" USING btree ("state");--> statement-breakpoint
CREATE INDEX "payroll_liabilities_due_idx" ON "payroll_liabilities" USING btree ("due_at");--> statement-breakpoint
CREATE INDEX "payroll_lines_tenant_idx" ON "payroll_lines" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_run_idx" ON "payroll_lines" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_statement_idx" ON "payroll_lines" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "payroll_lines_kind_idx" ON "payroll_lines" USING btree ("kind");--> statement-breakpoint
CREATE INDEX "payroll_statements_tenant_idx" ON "payroll_statements" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payroll_statements_run_idx" ON "payroll_statements" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "payroll_statements_employment_idx" ON "payroll_statements" USING btree ("employment_id");--> statement-breakpoint
CREATE INDEX "payroll_statements_object_idx" ON "payroll_statements" USING btree ("object_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payroll_statements_external_idx" ON "payroll_statements" USING btree ("tenant_id","payroll_run_id","external_id");--> statement-breakpoint
CREATE INDEX "payroll_traces_tenant_idx" ON "payroll_traces" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "payroll_traces_run_idx" ON "payroll_traces" USING btree ("payroll_run_id");--> statement-breakpoint
CREATE INDEX "payroll_traces_statement_idx" ON "payroll_traces" USING btree ("statement_id");--> statement-breakpoint
CREATE INDEX "payroll_traces_hash_idx" ON "payroll_traces" USING btree ("hash");