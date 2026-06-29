CREATE TABLE "docling_async_files" (
	"file_id" uuid PRIMARY KEY NOT NULL,
	"vespa_doc_id" text NOT NULL,
	"collection_id" uuid NOT NULL,
	"parent_id" uuid,
	"collection_name" text NOT NULL,
	"file_name" text NOT NULL,
	"original_name" text,
	"source_path" text NOT NULL,
	"source_storage_key" text,
	"stage_dir" text,
	"parts_dir" text,
	"results_dir" text,
	"manifest_path" text,
	"path" text DEFAULT '/' NOT NULL,
	"mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"base_mime_type" text DEFAULT 'application/pdf' NOT NULL,
	"file_size" integer DEFAULT 0 NOT NULL,
	"uploaded_by_email" text,
	"page_title" text DEFAULT '' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_kind" text DEFAULT 'ingestion' NOT NULL,
	"base_priority" integer DEFAULT 0 NOT NULL,
	"priority_override" integer,
	"effective_priority" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'pending_split' NOT NULL,
	"total_pages" integer DEFAULT 0 NOT NULL,
	"total_parts" integer DEFAULT 0 NOT NULL,
	"page_chunk_size" integer DEFAULT 0 NOT NULL,
	"ready_parts_count" integer DEFAULT 0 NOT NULL,
	"submitted_parts_count" integer DEFAULT 0 NOT NULL,
	"active_parts_count" integer DEFAULT 0 NOT NULL,
	"write_attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"lease_owner" text,
	"lease_token" text,
	"lease_until" timestamp with time zone,
	"ocr_activated_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "docling_async_parts" (
	"file_id" uuid NOT NULL,
	"part_index" integer NOT NULL,
	"doc_id" text NOT NULL,
	"current_job_id" text,
	"part_path" text NOT NULL,
	"result_path" text,
	"start_page" integer NOT NULL,
	"end_page" integer NOT NULL,
	"part_size_bytes" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"submitted_at" timestamp with time zone,
	"ready_at" timestamp with time zone,
	"written_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"submit_permit_id" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT NOW() NOT NULL,
	CONSTRAINT "docling_async_parts_pk" PRIMARY KEY("file_id","part_index")
);
--> statement-breakpoint
ALTER TABLE "docling_async_files" ADD CONSTRAINT "docling_async_files_file_id_collection_items_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."collection_items"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "docling_async_parts" ADD CONSTRAINT "docling_async_parts_file_id_docling_async_files_file_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."docling_async_files"("file_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "docling_async_files_status_priority_idx" ON "docling_async_files" USING btree ("status","available_at","effective_priority","created_at");
--> statement-breakpoint
CREATE INDEX "docling_async_files_active_status_idx" ON "docling_async_files" USING btree ("status","lease_until");
--> statement-breakpoint
CREATE INDEX "docling_async_files_collection_idx" ON "docling_async_files" USING btree ("collection_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "docling_async_parts_current_job_id_uidx" ON "docling_async_parts" USING btree ("current_job_id") WHERE "docling_async_parts"."current_job_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "docling_async_parts_status_available_idx" ON "docling_async_parts" USING btree ("status","available_at","created_at");
--> statement-breakpoint
CREATE INDEX "docling_async_parts_file_status_idx" ON "docling_async_parts" USING btree ("file_id","status");
--> statement-breakpoint
CREATE INDEX "docling_async_parts_submit_permit_idx" ON "docling_async_parts" USING btree ("submit_permit_id");
