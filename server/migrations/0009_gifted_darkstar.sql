ALTER TYPE "status" ADD VALUE 'not-connected';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "oauth_providers" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"client_id" text,
	"client_secret" text,
	"oauth_scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"container_id" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "oauth_providers_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "oauth_credentials" text;--> statement-breakpoint
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
