ALTER TABLE "workspaces" ADD COLUMN "created_by" text NOT NULL;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_unique" UNIQUE("created_by");