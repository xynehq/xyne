ALTER TABLE "sync_history" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ALTER COLUMN "status" SET DEFAULT 'NotStarted';--> statement-breakpoint
ALTER TABLE "sync_jobs" ALTER COLUMN "status" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sync_jobs" ADD COLUMN "email" text NOT NULL;