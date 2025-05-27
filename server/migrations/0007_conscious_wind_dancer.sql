DO $$ BEGIN
 CREATE TYPE "public"."message_feedback" AS ENUM('like', 'dislike');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "feedback" "message_feedback";