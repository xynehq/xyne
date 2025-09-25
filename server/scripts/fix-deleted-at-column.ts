import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { sql } from "drizzle-orm"

// Database connection
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required")
}

const client = postgres(connectionString)
const db = drizzle(client)

async function fixDeletedAtColumn() {
  try {
    console.log("Updating existing rows to null...")
    await db.execute(sql`UPDATE users SET deleted_at = NULL WHERE deleted_at IS NOT NULL`)
  } catch (error) {
    console.error("Error fixing deleted_at column:", error)
    throw error
  } finally {
    await client.end()
  }
}

// Run the script
fixDeletedAtColumn()
  .then(() => {
    console.log("Script completed successfully")
    process.exit(0)
  })
  .catch((error) => {
    console.error("Script failed:", error)
    process.exit(1)
  })
