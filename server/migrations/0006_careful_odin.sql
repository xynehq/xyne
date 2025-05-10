CREATE TABLE IF NOT EXISTS "user_personalization" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"email" text NOT NULL,
	"parameters" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "user_personalization_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "fileIds" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_personalization" ADD CONSTRAINT "user_personalization_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_personalization_user_idx" ON "user_personalization" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_personalization_email_idx" ON "user_personalization" USING btree ("email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "user_personalization_workspace_idx" ON "user_personalization" USING btree ("workspace_id");