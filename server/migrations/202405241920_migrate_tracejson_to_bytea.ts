import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { chatTrace } from "@/db/schema";
import { compressTraceJson } from "@/utils/compression";

export async function up(): Promise<void> {
  // Step 1: Schema Changes
  console.log("✅ up() is running...");
  await db.execute(
    sql`ALTER TABLE "chat_trace" RENAME COLUMN "trace_json" TO "trace_json_old_jsonb"`
  );
  await db.execute(
    sql`ALTER TABLE "chat_trace" ADD COLUMN "trace_json" BYTEA`
  );

  // Step 2: Data Migration
  const batchSize = 100;
  let updated = 0;
  let failed = 0;

  while (true) {
    const records = await db.execute(
      sql`SELECT id, trace_json_old_jsonb FROM chat_trace WHERE trace_json IS NULL AND trace_json_old_jsonb IS NOT NULL LIMIT ${batchSize}`
    );

    if (records.length === 0) break;

    try {
      await db.transaction(async (tx) => {
        for (const record of records) {
          const { id, trace_json_old_jsonb } = record;

          if (!trace_json_old_jsonb) {
            failed++;
            continue;
          }

          try {
            const jsonString = JSON.stringify(trace_json_old_jsonb);
            const compressed = compressTraceJson(jsonString);

            await tx
              .update(chatTrace)
              .set({ traceJson: compressed })
              .where(eq(chatTrace.id, id as number));

            updated++;
          } catch (err) {
            console.error(`Failed to process record ${id}`, err);
            failed++;
          }
        }
      });
    } catch (err) {
      console.error("Transaction failed for batch, rolling back", err);
      failed += records.length;
    }
  }

  console.log(`✅ Data migration completed. Updated: ${updated}, Failed: ${failed}`);

  // Step 3: Final Schema Cleanup
  await db.execute(
    sql`ALTER TABLE "chat_trace" ALTER COLUMN "trace_json" SET NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "chat_trace" DROP COLUMN "trace_json_old_jsonb"`
  );
}

async function main() {
  try {
    await up();
    console.log("Migration script '202405241920_migrate_tracejson_to_bytea.ts' finished successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Migration script '202405241920_migrate_tracejson_to_bytea.ts' failed:", error);
    process.exit(1);
  }
}

main();
