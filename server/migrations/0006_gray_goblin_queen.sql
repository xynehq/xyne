CREATE TABLE IF NOT EXISTS "chat_trace" (
	"id" serial PRIMARY KEY NOT NULL,
	"workspace_id" integer NOT NULL,
	"user_id" integer NOT NULL,
	"chat_id" integer NOT NULL,
	"message_id" integer NOT NULL,
	"chat_external_id" text NOT NULL,
	"message_external_id" text NOT NULL,
	"email" text NOT NULL,
	"trace_json" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_chat_id_chats_id_fk" FOREIGN KEY ("chat_id") REFERENCES "public"."chats"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_trace" ADD CONSTRAINT "chat_trace_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_trace_workspace_id_index" ON "chat_trace" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_trace_user_id_index" ON "chat_trace" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_trace_chat_external_id_index" ON "chat_trace" USING btree ("chat_external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chat_trace_message_external_id_index" ON "chat_trace" USING btree ("message_external_id");