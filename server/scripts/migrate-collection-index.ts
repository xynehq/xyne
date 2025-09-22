#!/usr/bin/env bun
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

/**
 * Executable TypeScript migration script for collection unique index change
 *
 * This migration changes the collection unique constraint from:
 * - workspace_id + name (old)
 * - owner_id + name (new)
 *
 * Usage:
 *   bun run migrations/scripts/migrate-collection-index.ts migrate
 *   bun run migrations/scripts/migrate-collection-index.ts rollback
 *   bun run migrations/scripts/migrate-collection-index.ts status
 */

const Logger = getLogger(Subsystem.Db).child({ module: "migration" })

interface MigrationStatus {
  oldIndexExists: boolean
  newIndexExists: boolean
  canMigrate: boolean
  canRollback: boolean
  duplicateCollections: Array<{
    workspace_id: number
    name: string
    count: number
  }>
}

class CollectionIndexMigration {
  private client: postgres.Sql
  private db: ReturnType<typeof drizzle>

  constructor() {
    const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
    this.client = postgres(url, {
      idle_timeout: 0,
      max: 1, // Single connection for migration
    })
    this.db = drizzle(this.client)
  }

  async getStatus(): Promise<MigrationStatus> {
    Logger.info("Checking migration status...")

    // Check if old index exists
    const oldIndexResult = await this.client`
      SELECT indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
      AND indexname = 'unique_workspace_collection_name_not_deleted'
    `
    const oldIndexExists = oldIndexResult.length > 0

    // Check if new index exists
    const newIndexResult = await this.client`
      SELECT indexname 
      FROM pg_indexes 
      WHERE schemaname = 'public' 
      AND indexname = 'unique_owner_collection_name_not_deleted'
    `
    const newIndexExists = newIndexResult.length > 0

    // Check for duplicate collections per workspace (for rollback safety)
    const duplicateCollections = await this.client`
      SELECT workspace_id, name, COUNT(*) as count
      FROM collections 
      WHERE deleted_at IS NULL
      GROUP BY workspace_id, name
      HAVING COUNT(*) > 1
      ORDER BY workspace_id, name
    `

    const status: MigrationStatus = {
      oldIndexExists,
      newIndexExists,
      canMigrate: oldIndexExists && !newIndexExists,
      canRollback:
        !oldIndexExists && newIndexExists && duplicateCollections.length === 0,
      duplicateCollections: duplicateCollections.map((row) => ({
        workspace_id: row.workspace_id as number,
        name: row.name as string,
        count: row.count as number,
      })),
    }

    return status
  }

  async migrate(): Promise<void> {
    Logger.info("Starting collection index migration...")

    const status = await this.getStatus()

    if (!status.oldIndexExists && status.newIndexExists) {
      Logger.info(
        "✅ Migration already completed - new index exists, old index removed",
      )
      return
    }

    if (!status.canMigrate) {
      if (!status.oldIndexExists) {
        Logger.warn(
          "⚠️  Old index doesn't exist - migration may have been partially applied",
        )
      }
      if (status.newIndexExists) {
        Logger.warn("⚠️  New index already exists")
      }
    }

    try {
      // Start transaction
      await this.client.begin(async (tx) => {
        Logger.info("Starting migration transaction...")

        // Drop old index if it exists
        if (status.oldIndexExists) {
          Logger.info("Dropping old workspace-scoped unique index...")
          await tx`DROP INDEX IF EXISTS "unique_workspace_collection_name_not_deleted"`
          Logger.info("✅ Old index dropped")
        }

        // Create new index if it doesn't exist
        if (!status.newIndexExists) {
          Logger.info("Creating new owner-scoped unique index...")
          await tx`
            CREATE UNIQUE INDEX "unique_owner_collection_name_not_deleted"
            ON "collections" ("owner_id", "name")
            WHERE "deleted_at" IS NULL
          `
          Logger.info("✅ New index created")
        }

        Logger.info("Migration transaction completed successfully")
      })

      Logger.info("🎉 Collection index migration completed successfully!")
    } catch (error) {
      Logger.error("❌ Migration failed:", error)
      throw error
    }
  }

  async rollback(): Promise<void> {
    Logger.info("Starting collection index rollback...")

    const status = await this.getStatus()

    if (!status.canRollback) {
      if (status.duplicateCollections.length > 0) {
        Logger.error(
          "❌ Cannot rollback: Found duplicate collection names per workspace:",
        )
        console.table(status.duplicateCollections)
        throw new Error(
          "Rollback blocked: Duplicate collection names exist per workspace",
        )
      }

      if (status.oldIndexExists) {
        Logger.info("✅ Rollback already completed - old index exists")
        return
      }
    }

    try {
      // Start transaction
      await this.client.begin(async (tx) => {
        Logger.info("Starting rollback transaction...")

        // Drop new index
        if (status.newIndexExists) {
          Logger.info("Dropping new owner-scoped unique index...")
          await tx`DROP INDEX IF EXISTS "unique_owner_collection_name_not_deleted"`
          Logger.info("✅ New index dropped")
        }

        // Recreate old index
        if (!status.oldIndexExists) {
          Logger.info("Recreating old workspace-scoped unique index...")
          await tx`
            CREATE UNIQUE INDEX "unique_workspace_collection_name_not_deleted"
            ON "collections" ("workspace_id", "name")
            WHERE "deleted_at" IS NULL
          `
          Logger.info("✅ Old index recreated")
        }

        Logger.info("Rollback transaction completed successfully")
      })

      Logger.info("🎉 Collection index rollback completed successfully!")
    } catch (error) {
      Logger.error("❌ Rollback failed:", error)
      throw error
    }
  }

  async printStatus(): Promise<void> {
    const status = await this.getStatus()

    console.log("\n📊 Collection Index Migration Status")
    console.log("=====================================")
    console.log(`Old index exists: ${status.oldIndexExists ? "✅" : "❌"}`)
    console.log(`New index exists: ${status.newIndexExists ? "✅" : "❌"}`)
    console.log(`Can migrate: ${status.canMigrate ? "✅" : "❌"}`)
    console.log(`Can rollback: ${status.canRollback ? "✅" : "❌"}`)

    if (status.duplicateCollections.length > 0) {
      console.log(
        `\n⚠️  Duplicate collections per workspace: ${status.duplicateCollections.length}`,
      )
      console.table(status.duplicateCollections)
    } else {
      console.log("\n✅ No duplicate collections found")
    }

    // Migration recommendation
    if (status.oldIndexExists && !status.newIndexExists) {
      console.log("\n🔧 Recommendation: Run migration")
    } else if (!status.oldIndexExists && status.newIndexExists) {
      console.log("\n✅ Migration already completed")
    } else if (status.oldIndexExists && status.newIndexExists) {
      console.log("\n⚠️  Both indexes exist - manual intervention required")
    } else {
      console.log("\n❌ Neither index exists - check database state")
    }
    console.log("")
  }

  async close(): Promise<void> {
    await this.client.end()
  }
}

// CLI execution
async function main() {
  const action = process.argv[2]
  const migration = new CollectionIndexMigration()

  try {
    switch (action) {
      case "migrate":
        await migration.migrate()
        break

      case "rollback":
        await migration.rollback()
        break

      case "status":
        await migration.printStatus()
        break

      default:
        console.log("Collection Index Migration Tool")
        console.log("===============================")
        console.log("Usage:")
        console.log(
          "  bun run migrations/scripts/migrate-collection-index.ts migrate   # Apply migration",
        )
        console.log(
          "  bun run migrations/scripts/migrate-collection-index.ts rollback  # Rollback migration",
        )
        console.log(
          "  bun run migrations/scripts/migrate-collection-index.ts status    # Check status",
        )
        process.exit(1)
    }
  } catch (error) {
    Logger.error("Migration failed:", error)
    process.exit(1)
  } finally {
    await migration.close()
  }
}

// Only run if this file is executed directly
if (import.meta.main) {
  await main()
}

export { CollectionIndexMigration }
