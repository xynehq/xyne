ALTER TABLE "chats" ADD COLUMN "hasAttachments" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL;