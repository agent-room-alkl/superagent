CREATE TABLE IF NOT EXISTS "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"object_type" text NOT NULL,
	"object_id" text NOT NULL,
	"version_ref" text,
	"result" text NOT NULL,
	"detail" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"plugin_id" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"credential_ref" text,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"cursor" text,
	"confirmed_by" uuid,
	"confirmed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "employees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"duty" text NOT NULL,
	"prompt_version_id" uuid,
	"model_tier" text DEFAULT 'default' NOT NULL,
	"knowledge_scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"runtime_kind" text DEFAULT 'managed' NOT NULL,
	"status" text DEFAULT 'unconnected' NOT NULL,
	"owner_user_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "human_work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"renderer" text NOT NULL,
	"task_id" uuid,
	"target" jsonb NOT NULL,
	"payload_version" integer DEFAULT 1 NOT NULL,
	"assignee" uuid,
	"due_at" timestamp with time zone,
	"waiting_on" text,
	"status" text DEFAULT 'open' NOT NULL,
	"decision" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_budget" (
	"tenant_id" uuid NOT NULL,
	"month" text NOT NULL,
	"cap_micro_usd" bigint NOT NULL,
	"reserved_micro_usd" bigint DEFAULT 0 NOT NULL,
	"spent_micro_usd" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_config" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"provider" text,
	"endpoint" text,
	"key_vault_secret" text,
	"key_vault_version" text,
	"key_last4" text,
	"primary_model" text,
	"economy_model" text,
	"retrieval" text DEFAULT 'keyword' NOT NULL,
	"status" text DEFAULT 'unconfigured' NOT NULL,
	"monthly_cap_micro_usd" bigint,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "llm_usage" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"task_id" uuid,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"reserved_micro_usd" bigint NOT NULL,
	"cost_micro_usd" bigint,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "model_capabilities" (
	"provider" text NOT NULL,
	"model_id" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"status" text NOT NULL,
	"tested_at" timestamp with time zone,
	"platform_version" text
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"connection_id" uuid NOT NULL,
	"external_id" text NOT NULL,
	"version" text NOT NULL,
	"title" text NOT NULL,
	"locator" text NOT NULL,
	"acl" jsonb,
	"acl_status" text DEFAULT 'unknown' NOT NULL,
	"content_hash" text,
	"status" text DEFAULT 'new' NOT NULL,
	"fetched_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"instance_id" uuid,
	"room_message_id" uuid,
	"employee_id" uuid,
	"status" text DEFAULT 'assigned' NOT NULL,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"attempt" integer DEFAULT 0 NOT NULL,
	"identity_snapshot" jsonb,
	"dead_letter" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"timezone" text DEFAULT 'Pacific/Auckland' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tools" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contract" jsonb NOT NULL,
	"stage" text DEFAULT 'placeholder' NOT NULL,
	"maintainer" uuid,
	"reviewer" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"entra_oid" text NOT NULL,
	"display_name" text NOT NULL,
	"roles" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"project_scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_object" ON "audit_log" USING btree ("tenant_id","object_type","object_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "llm_budget_pk" ON "llm_budget" USING btree ("tenant_id","month");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "model_cap_pk" ON "model_capabilities" USING btree ("provider","model_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "source_item_ext" ON "source_items" USING btree ("connection_id","external_id","version");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "tasks_claim" ON "tasks" USING btree ("status","lease_until");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_tenant_oid" ON "users" USING btree ("tenant_id","entra_oid");