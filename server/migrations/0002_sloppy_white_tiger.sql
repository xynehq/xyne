CREATE TABLE IF NOT EXISTS "groups" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"description" text NOT NULL,
	"directMembersCount" text NOT NULL,
	"memberEmails" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"deleted_at" timestamp with time zone
);
