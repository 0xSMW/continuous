CREATE TABLE "control_plane_auth_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"user_id" uuid,
	"operator_email" text,
	"credential_id" text,
	"token_fingerprint" varchar(64),
	"route" varchar(40) NOT NULL,
	"access" varchar(20) NOT NULL,
	"command" text,
	"tenant_slug" text,
	"worker_role" text,
	"outcome" varchar(24) NOT NULL,
	"reason_code" varchar(140) NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "control_plane_token_rotation_attestations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"auth_session_id" uuid,
	"event_id" uuid,
	"audit_event_id" uuid,
	"operator_email" text NOT NULL,
	"credential_id" text NOT NULL,
	"previous_credential_id" text,
	"previous_token_fingerprint" varchar(64),
	"next_token_fingerprint" varchar(64) NOT NULL,
	"state" varchar(40) DEFAULT 'attested' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"idempotency_key" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rotated_at" timestamp with time zone NOT NULL,
	"attested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_plane_auth_sessions" ADD CONSTRAINT "control_plane_auth_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_auth_sessions" ADD CONSTRAINT "control_plane_auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_token_rotation_attestations" ADD CONSTRAINT "control_plane_token_rotation_attestations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_token_rotation_attestations" ADD CONSTRAINT "control_plane_token_rotation_attestations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_token_rotation_attestations" ADD CONSTRAINT "control_plane_token_rotation_attestations_auth_session_id_control_plane_auth_sessions_id_fk" FOREIGN KEY ("auth_session_id") REFERENCES "public"."control_plane_auth_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_token_rotation_attestations" ADD CONSTRAINT "control_plane_token_rotation_attestations_event_id_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_token_rotation_attestations" ADD CONSTRAINT "control_plane_token_rotation_attestations_audit_event_id_audit_events_id_fk" FOREIGN KEY ("audit_event_id") REFERENCES "public"."audit_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_plane_auth_sessions_tenant_idx" ON "control_plane_auth_sessions" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_auth_sessions_user_idx" ON "control_plane_auth_sessions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_auth_sessions_credential_idx" ON "control_plane_auth_sessions" USING btree ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_auth_sessions_route_idx" ON "control_plane_auth_sessions" USING btree ("route","access","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_auth_sessions_outcome_idx" ON "control_plane_auth_sessions" USING btree ("outcome","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_token_rotations_tenant_idx" ON "control_plane_token_rotation_attestations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_token_rotations_user_idx" ON "control_plane_token_rotation_attestations" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_token_rotations_credential_idx" ON "control_plane_token_rotation_attestations" USING btree ("credential_id","created_at");--> statement-breakpoint
CREATE INDEX "control_plane_token_rotations_auth_session_idx" ON "control_plane_token_rotation_attestations" USING btree ("auth_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "control_plane_token_rotations_idempotency_idx" ON "control_plane_token_rotation_attestations" USING btree ("tenant_id","idempotency_key");