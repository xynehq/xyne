DROP INDEX IF EXISTS "is_bookmarked_index";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "is_bookmarked_index" ON "chats" USING btree ("is_bookmarked");