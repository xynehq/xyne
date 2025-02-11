ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "thinking" TEXT DEFAULT '';
UPDATE "messages" SET "thinking" = '' WHERE "thinking" IS NULL;
ALTER TABLE "messages" ALTER COLUMN "thinking" SET NOT NULL;