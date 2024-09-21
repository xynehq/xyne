ALTER TABLE "users" ADD COLUMN "workspace_external_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_workspace_external_id_unique" UNIQUE("workspace_external_id");