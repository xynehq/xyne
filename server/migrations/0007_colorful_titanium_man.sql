ALTER TABLE "workspaces" ALTER COLUMN "deleted_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "deleted_at" DROP NOT NULL;