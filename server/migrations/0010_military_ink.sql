DO $$ BEGIN
 CREATE TYPE "public"."user_agent_role" AS ENUM('owner', 'editor', 'viewer', 'shared');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_agent_permissions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"agent_id" integer NOT NULL,
	"role" "user_agent_role" DEFAULT 'shared' NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_agent_permissions" ADD CONSTRAINT "user_agent_permissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_agent_permissions" ADD CONSTRAINT "user_agent_permissions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "user_agent_permission_unique_index" ON "user_agent_permissions" USING btree ("user_id","agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_agent_permissions_user_id_index" ON "user_agent_permissions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_agent_permissions_agent_id_index" ON "user_agent_permissions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_agent_permissions_role_index" ON "user_agent_permissions" USING btree ("role");