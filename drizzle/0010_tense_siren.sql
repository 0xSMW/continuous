CREATE TABLE "control_plane_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid,
	"last_auth_session_id" uuid,
	"credential_id" varchar(140) NOT NULL,
	"display_name" text NOT NULL,
	"operator_email" text NOT NULL,
	"state" varchar(32) DEFAULT 'active' NOT NULL,
	"token_fingerprint" varchar(64),
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"routes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"access" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"commands" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "control_plane_credentials" ADD CONSTRAINT "control_plane_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_credentials" ADD CONSTRAINT "control_plane_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "control_plane_credentials" ADD CONSTRAINT "control_plane_credentials_last_auth_session_id_control_plane_auth_sessions_id_fk" FOREIGN KEY ("last_auth_session_id") REFERENCES "public"."control_plane_auth_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "control_plane_credentials_tenant_idx" ON "control_plane_credentials" USING btree ("tenant_id","state");--> statement-breakpoint
CREATE INDEX "control_plane_credentials_user_idx" ON "control_plane_credentials" USING btree ("user_id","state");--> statement-breakpoint
CREATE INDEX "control_plane_credentials_last_auth_session_idx" ON "control_plane_credentials" USING btree ("last_auth_session_id");--> statement-breakpoint
CREATE UNIQUE INDEX "control_plane_credentials_tenant_credential_idx" ON "control_plane_credentials" USING btree ("tenant_id","credential_id");