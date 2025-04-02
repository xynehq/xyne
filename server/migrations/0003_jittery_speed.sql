ALTER TABLE "oauth_providers" DROP CONSTRAINT "oauth_providers_container_id_connectors_id_fk";
--> statement-breakpoint
ALTER TABLE "oauth_providers" ADD COLUMN "connector_id" integer NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "oauth_providers" ADD CONSTRAINT "oauth_providers_connector_id_connectors_id_fk" FOREIGN KEY ("connector_id") REFERENCES "public"."connectors"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TABLE "oauth_providers" DROP COLUMN IF EXISTS "container_id";