DO $$ BEGIN
 CREATE TYPE "public"."operation_status" AS ENUM('Success', 'Failure', 'Pending', 'Cancelled');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingestion_tracker_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"ingestion_run_id" text NOT NULL,
	"app_type" "app_type" NOT NULL,
	"auth_type" "auth_type" NOT NULL,
	"tracker_data" jsonb NOT NULL,
	"start_time" timestamp with time zone NOT NULL,
	"end_time" timestamp with time zone NOT NULL,
	"status" "operation_status" NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "ingestion_tracker_stats_ingestion_run_id_unique" UNIQUE("ingestion_run_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ingestion_run_id_idx" ON "ingestion_tracker_stats" USING btree ("ingestion_run_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ingestion_tracker_app_idx" ON "ingestion_tracker_stats" USING btree ("app_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ingestion_tracker_auth_type_idx" ON "ingestion_tracker_stats" USING btree ("auth_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ingestion_tracker_status_idx" ON "ingestion_tracker_stats" USING btree ("status");