DO $$ BEGIN
 CREATE TYPE "public"."message_role" AS ENUM('system', 'user', 'assistant');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chats" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"is_bookmarked" boolean DEFAULT false NOT NULL,
	"email" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "chats_external_id_unique" UNIQUE("external_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"chat_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"external_id" text NOT NULL,
	"workspace_external_id" text NOT NULL,
	"chat_external_id" text NOT NULL,
	"message" text NOT NULL,
	"message_role" "message_role" NOT NULL,
	"modelId" text NOT NULL,
	"email" text NOT NULL,
	"sources" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "messages_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "messages_chat_external_id_unique" UNIQUE("chat_external_id")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "deleted_at" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "deleted_at" DROP NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chats" ADD CONSTRAINT "chats_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chats" ADD CONSTRAINT "chats_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "is_bookmarked_index" ON "chats" USING btree ("is_bookmarked");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_id_index" ON "messages" USING btree ("chat_id");