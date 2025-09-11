DO $$ BEGIN
 CREATE TYPE "public"."step_type" AS ENUM('manual', 'automated');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."tool_execution_status" AS ENUM('pending', 'running', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."tool_type" AS ENUM('delay', 'python_script', 'slack', 'gmail', 'agent', 'merged_node', 'form', 'email', 'ai_agent');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."workflow_status" AS ENUM('draft', 'active', 'paused', 'completed', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_tool_id" uuid NOT NULL,
	"workflow_execution_id" uuid NOT NULL,
	"status" "tool_execution_status" DEFAULT 'pending' NOT NULL,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"root_workflow_step_exe_id" uuid,
	"created_by" text,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_step_execution" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_execution_id" uuid NOT NULL,
	"workflow_step_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" "step_type" DEFAULT 'automated' NOT NULL,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"parent_step_id" uuid,
	"prev_step_ids" uuid[] DEFAULT '{}',
	"next_step_ids" uuid[] DEFAULT '{}',
	"tool_exec_ids" uuid[] DEFAULT '{}',
	"time_estimate" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"completed_by" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"completed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_step_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_template_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"type" "step_type" DEFAULT 'automated' NOT NULL,
	"parent_step_id" uuid,
	"prev_step_ids" uuid[] DEFAULT '{}',
	"next_step_ids" uuid[] DEFAULT '{}',
	"tool_ids" uuid[] DEFAULT '{}',
	"time_estimate" integer DEFAULT 0,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_template" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"version" text DEFAULT '1.0.0' NOT NULL,
	"status" "workflow_status" DEFAULT 'draft' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_by" text,
	"root_workflow_step_template_id" uuid,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "workflow_tool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" "tool_type" NOT NULL,
	"value" jsonb,
	"config" jsonb DEFAULT '{}'::jsonb,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "tool_execution" ADD CONSTRAINT "tool_execution_workflow_tool_id_workflow_tool_id_fk" FOREIGN KEY ("workflow_tool_id") REFERENCES "public"."workflow_tool"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_execution" ADD CONSTRAINT "workflow_execution_workflow_template_id_workflow_template_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_template"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_step_execution" ADD CONSTRAINT "workflow_step_execution_workflow_execution_id_workflow_execution_id_fk" FOREIGN KEY ("workflow_execution_id") REFERENCES "public"."workflow_execution"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_step_execution" ADD CONSTRAINT "workflow_step_execution_workflow_step_template_id_workflow_step_template_id_fk" FOREIGN KEY ("workflow_step_template_id") REFERENCES "public"."workflow_step_template"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "workflow_step_template" ADD CONSTRAINT "workflow_step_template_workflow_template_id_workflow_template_id_fk" FOREIGN KEY ("workflow_template_id") REFERENCES "public"."workflow_template"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;