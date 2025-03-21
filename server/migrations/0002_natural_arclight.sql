ALTER TYPE "app_type" ADD VALUE 'slack';--> statement-breakpoint
ALTER TABLE "connectors" ADD COLUMN "api_key" text;