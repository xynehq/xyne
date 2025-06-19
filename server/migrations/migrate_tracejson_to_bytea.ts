import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { chatTrace } from "@/db/schema";
import { compressTraceJson } from "@/utils/compression";

async function checkMigrationStatus(): Promise<{ alreadyMigrated: boolean; hasOldColumn: boolean; hasByteaColumn: boolean }> {
  try {
    // Check if the old column exists
    const oldColumnCheck = await db.execute(
      sql`SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'chat_trace' AND column_name = 'trace_json_old_jsonb'`
    );
    const hasOldColumn = oldColumnCheck.length > 0;

    // Check if the new bytea column exists
    const byteaColumnCheck = await db.execute(
      sql`SELECT column_name, data_type FROM information_schema.columns 
          WHERE table_name = 'chat_trace' AND column_name = 'trace_json'`
    );
    const hasByteaColumn = byteaColumnCheck.length > 0 && byteaColumnCheck[0]?.data_type === 'bytea';

    // Check if migration is already complete (no old column, has bytea column)
    const alreadyMigrated = !hasOldColumn && hasByteaColumn;

    return { alreadyMigrated, hasOldColumn, hasByteaColumn };
  } catch (error) {
    console.error("Error checking migration status:", error);
    throw error;
  }
}

export async function up(): Promise<void> {
  console.log("✅ Starting migration check...");
  
  const migrationStatus = await checkMigrationStatus();
  
  if (migrationStatus.alreadyMigrated) {
    console.log("✅ Migration already completed. The trace_json column is already in BYTEA format.");
    return;
  }

  if (migrationStatus.hasOldColumn && migrationStatus.hasByteaColumn) {
    console.log("⚠️  Migration appears to be partially complete. Resuming data migration...");
  } else if (!migrationStatus.hasOldColumn && !migrationStatus.hasByteaColumn) {
    console.log("❌ Unexpected state: trace_json column not found. Please check your database schema.");
    throw new Error("Invalid migration state: trace_json column not found");
  } else {
    console.log("✅ Starting fresh migration...");
    
    // Step 1: Schema Changes
    console.log("📝 Performing schema changes...");
    await db.execute(
      sql`ALTER TABLE "chat_trace" RENAME COLUMN "trace_json" TO "trace_json_old_jsonb"`
    );
    await db.execute(
      sql`ALTER TABLE "chat_trace" ADD COLUMN "trace_json" BYTEA`
    );
  }

  // Step 2: Data Migration
  console.log("🔄 Starting data migration...");
  const batchSize = 100;
  let updated = 0;
  let failed = 0;

  // Check how many records need migration
  const totalRecordsResult = await db.execute(
    sql`SELECT COUNT(*) as count FROM chat_trace WHERE trace_json IS NULL AND trace_json_old_jsonb IS NOT NULL`
  );
  const totalRecords = Number(totalRecordsResult[0]?.count) || 0;
  
  if (totalRecords === 0) {
    console.log("✅ No records need migration. All data is already migrated.");
  } else {
    console.log(`📊 Found ${totalRecords} records to migrate...`);
  }

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
  if (migrationStatus.hasOldColumn && (totalRecords > 0 || updated > 0)) {
    console.log("🔧 Performing final schema cleanup...");
    await db.execute(
      sql`ALTER TABLE "chat_trace" ALTER COLUMN "trace_json" SET NOT NULL`
    );
    await db.execute(
      sql`ALTER TABLE "chat_trace" DROP COLUMN "trace_json_old_jsonb"`
    );
    console.log("✅ Schema cleanup completed.");
  } else {
    console.log("⏭️  Skipping schema cleanup as no data was migrated or old column doesn't exist.");
  }
}

async function main() {
  try {
    await up();
    console.log("Migration script 'migrate_tracejson_to_bytea.ts' finished successfully.");
    process.exit(0);
  } catch (error) {
    console.error("Migration script 'migrate_tracejson_to_bytea.ts' failed:", error);
    process.exit(1);
  }
}

main();
