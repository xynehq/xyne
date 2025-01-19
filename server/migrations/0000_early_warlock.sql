DO $$ BEGIN
 CREATE TYPE "public"."app_type" AS ENUM('google-workspace', 'google-drive', 'gmail', 'notion', 'google-calendar');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."auth_type" AS ENUM('oauth', 'service_account', 'custom', 'api_key');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."connector_type" AS ENUM('SaaS', 'Database', 'Api', 'File', 'Website');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."message_role" AS ENUM('system', 'user', 'assistant');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."status" AS ENUM('connected', 'connecting', 'failed', 'not-connected');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."type" AS ENUM('ChangeToken', 'Partial', 'FullSync');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."sync_status" AS ENUM('NotStarted', 'Started', 'Failed', 'Successful');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."role" AS ENUM('User', 'TeamLeader', 'Admin', 'SuperAdmin');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"is_bookmarked" boolean DEFAULT false NOT NULL,
	"email" text NOT NULL,
	"title" text NOT NULL,
	"attachments" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chats_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connectors" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"name" text NOT NULL,
	"type" "connector_type" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"app_type" "app_type" NOT NULL,
	"config" jsonb NOT NULL,
	"credentials" text,
	"subject" text,
	"oauth_credentials" text,
	"status" "status" DEFAULT 'connecting' NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "connectors_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "connectors_workspace_id_user_id_app_type_auth_type_unique" UNIQUE("workspace_id","user_id","app_type","auth_type")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"chat_external_id" text NOT NULL,
	"message" text NOT NULL,
	"message_role" "message_role" NOT NULL,
	"modelId" text NOT NULL,
	"email" text NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	"error_message" text DEFAULT '',
	CONSTRAINT "messages_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"container_id" integer NOT NULL,
	"client_id" text,
	"client_secret" text,
	"oauth_scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"app_type" "app_type" NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "oauth_providers_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"data_added" integer DEFAULT 0 NOT NULL,
	"data_updated" integer DEFAULT 0 NOT NULL,
	"data_deleted" integer DEFAULT 0 NOT NULL,
	"summary" jsonb NOT NULL,
	"error_message" text DEFAULT '',
	"type" "type" NOT NULL,
	"status" "sync_status" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"app_type" "app_type" NOT NULL,
	"config" jsonb NOT NULL,
	"last_ran_on" timestamp with time zone DEFAULT NOW(),
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sync_history_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sync_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"email" text NOT NULL,
	"connector_id" integer NOT NULL,
	"type" "type" NOT NULL,
	"status" "sync_status" DEFAULT 'NotStarted' NOT NULL,
	"app_type" "app_type" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"config" jsonb NOT NULL,
	"last_ran_on" timestamp with time zone DEFAULT NOW(),
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "sync_jobs_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"photoLink" text,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone DEFAULT '1970-01-01T00:00:00Z' NOT NULL,
	"last_login" timestamp with time zone,
	"role" "role" DEFAULT 'User' NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workspaces" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"created_by" text NOT NULL,
	"external_id" text NOT NULL,
	"photoLink" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "workspaces_domain_unique" UNIQUE("domain"),
	CONSTRAINT "workspaces_created_by_unique" UNIQUE("created_by"),
	CONSTRAINT "workspaces_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connectors" ADD CONSTRAINT "connectors_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connectors" ADD CONSTRAINT "connectors_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_container_id_connectors_id_fk" FOREIGN KEY ("container_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_history" ADD CONSTRAINT "sync_history_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "sync_jobs" ADD CONSTRAINT "sync_jobs_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "is_bookmarked_index" ON "chats" USING btree ("is_bookmarked");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_id_index" ON "messages" USING btree ("chat_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_unique_index" ON "users" USING btree (LOWER("email"));