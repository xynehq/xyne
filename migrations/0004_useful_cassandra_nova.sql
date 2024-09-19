DO $$ BEGIN
 CREATE TYPE "public"."status" AS ENUM('connected', 'connecting', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "status" "status" DEFAULT 'connecting' NOT NULL;