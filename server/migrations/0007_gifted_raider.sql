DO $$ BEGIN
 CREATE TYPE "public"."message_mode" AS ENUM('ask', 'agentic');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "message_mode" "message_mode" DEFAULT 'ask' NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" DROP COLUMN IF EXISTS "agentic_mode";