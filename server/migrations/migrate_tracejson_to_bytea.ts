import { sql, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { chatTrace } from "@/db/schema";
import { compressTraceJson } from "@/utils/compression";

async function checkMigrationStatus(): Promise<{ 
  alreadyMigrated: boolean; 
  hasOldColumn: boolean; 
  hasByteaColumn: boolean; 
  hasTraceJsonColumn: boolean;
  traceJsonDataType: string | null;
  tableExists: boolean;
}> {
  try {
    // First check if the table exists
    const tableCheck = await db.execute(
      sql`SELECT table_name FROM information_schema.tables 
          WHERE table_schema = 'public' AND table_name = 'chat_trace'`
    );
    const tableExists = tableCheck.length > 0;

    if (!tableExists) {
      console.log("❌ The chat_trace table does not exist!");
      return { 
        alreadyMigrated: false, 
        hasOldColumn: false, 
        hasByteaColumn: false, 
        hasTraceJsonColumn: false,
        traceJsonDataType: null,
        tableExists: false
      };
    }

    // Check if the old column exists
    const oldColumnCheck = await db.execute(
      sql`SELECT column_name FROM information_schema.columns 
          WHERE table_name = 'chat_trace' AND column_name = 'trace_json_old_jsonb'`
    );
    const hasOldColumn = oldColumnCheck.length > 0;

    // Check if the trace_json column exists and get its type
    const traceJsonColumnCheck = await db.execute(
      sql`SELECT column_name, data_type FROM information_schema.columns 
          WHERE table_name = 'chat_trace' AND column_name = 'trace_json'`
    );
    const hasTraceJsonColumn = traceJsonColumnCheck.length > 0;
    const traceJsonDataType = hasTraceJsonColumn ? traceJsonColumnCheck[0]?.data_type as string : null;
    const hasByteaColumn = hasTraceJsonColumn && traceJsonDataType === 'bytea';

    // Check if migration is already complete (no old column, has bytea column)
    const alreadyMigrated = !hasOldColumn && hasByteaColumn;

    console.log("🔍 Database state check:");
    console.log(`   - chat_trace table exists: ${tableExists}`);
    console.log(`   - trace_json column exists: ${hasTraceJsonColumn}`);
    console.log(`   - trace_json data type: ${traceJsonDataType || 'N/A'}`);
    console.log(`   - trace_json_old_jsonb exists: ${hasOldColumn}`);
    console.log(`   - Already migrated: ${alreadyMigrated}`);

    return { alreadyMigrated, hasOldColumn, hasByteaColumn, hasTraceJsonColumn, traceJsonDataType, tableExists };
  } catch (error) {
    console.error("Error checking migration status:", error);
    throw error;
  }
}

export async function up(): Promise<void> {
  console.log("✅ Starting migration check...");
  
  const migrationStatus = await checkMigrationStatus();
  
  // Case 0: Table doesn't exist
  if (!migrationStatus.tableExists) {
    console.log("❌ The chat_trace table does not exist. Please run the main database migrations first.");
    console.log("💡 Try running: bun run migrate");
    throw new Error("chat_trace table not found - please run main migrations first");
  }

  // Case 1: Migration already completed
  if (migrationStatus.alreadyMigrated) {
    console.log("✅ Migration already completed. The trace_json column is already in BYTEA format.");
    return;
  }

  // Case 2: Migration partially complete - resume data migration
  if (migrationStatus.hasOldColumn && migrationStatus.hasByteaColumn) {
    console.log("⚠️  Migration appears to be partially complete. Resuming data migration...");
  } 
  // Case 3: No trace_json column at all - error state
  else if (!migrationStatus.hasTraceJsonColumn) {
    console.log("❌ Unexpected state: trace_json column not found. Please check your database schema.");
    console.log("💡 The chat_trace table should have a trace_json column. Please verify your database setup.");
    
    // Let's list all columns in the table to help debug
    try {
      const allColumns = await db.execute(
        sql`SELECT column_name, data_type FROM information_schema.columns 
            WHERE table_name = 'chat_trace' ORDER BY ordinal_position`
      );
      console.log("📋 Current columns in chat_trace table:");
      for (const col of allColumns) {
        console.log(`   - ${col.column_name}: ${col.data_type}`);
      }
    } catch (err) {
      console.log("Could not list table columns:", err);
    }
    
    throw new Error("Invalid migration state: trace_json column not found");
  } 
  // Case 4: trace_json already bytea, no old column - already migrated
  else if (migrationStatus.hasByteaColumn && !migrationStatus.hasOldColumn) {
    console.log("✅ Migration already completed. The trace_json column is already in BYTEA format and no old column exists.");
    return;
  } 
  // Case 5: trace_json exists but not bytea, no old column - need fresh migration
  else if (migrationStatus.hasTraceJsonColumn && !migrationStatus.hasByteaColumn && !migrationStatus.hasOldColumn) {
    console.log(`✅ Starting fresh migration from ${migrationStatus.traceJsonDataType} to BYTEA...`);
    
    // Step 1: Schema Changes
    console.log("📝 Performing schema changes...");
    await db.execute(
      sql`ALTER TABLE "chat_trace" RENAME COLUMN "trace_json" TO "trace_json_old_jsonb"`
    );
    await db.execute(
      sql`ALTER TABLE "chat_trace" ADD COLUMN "trace_json" BYTEA`
    );
  } 
  // Case 6: Unexpected state - both columns exist but trace_json is not bytea
  else {
    console.log("⚠️  Unexpected database state detected. Both columns exist but trace_json is not BYTEA type.");
    console.log(`    trace_json type: ${migrationStatus.traceJsonDataType}`);
    console.log("    This might indicate a previous failed migration attempt.");
    throw new Error("Unexpected migration state: both columns exist but trace_json is not BYTEA");
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
  console.log("🔧 Performing final schema cleanup...");
  await db.execute(
    sql`ALTER TABLE "chat_trace" ALTER COLUMN "trace_json" SET NOT NULL`
  );
  await db.execute(
    sql`ALTER TABLE "chat_trace" DROP COLUMN "trace_json_old_jsonb"`
  );
  console.log("✅ Schema cleanup completed.");
 
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
