DO $$ BEGIN
 CREATE TYPE "public"."message_feedback" AS ENUM('like', 'dislike');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
ALTER TABLE "messages"
ADD COLUMN IF NOT EXISTS "feedback" "message_feedback";