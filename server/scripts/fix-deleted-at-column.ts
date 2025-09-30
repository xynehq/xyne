import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import { sql } from "drizzle-orm"
import { config } from "dotenv"
import path from "path"

// Load environment variables from parent directory
const envPath = path.join(__dirname, "..", ".env")
config({ path: envPath })

// Database connection
const connectionString = process.env.DATABASE_URL
if (!connectionString) {
  throw new Error("DATABASE_URL environment variable is required")
}

const client = postgres(connectionString)
const db = drizzle(client)

async function fixDeletedAtColumn() {
  try {
    console.log("Starting to fix deleted_at column...")

    // First, let's check the current constraint
    const constraintCheck = await db.execute(sql`
      SELECT column_name, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'deleted_at'
    `)

    console.log("Current column info:", constraintCheck)

    // Step 1: Remove the default value
    console.log("Removing default value...")
    await db.execute(
      sql`ALTER TABLE users ALTER COLUMN deleted_at DROP DEFAULT`,
    )

    // Step 2: Remove the NOT NULL constraint
    console.log("Removing NOT NULL constraint...")
    await db.execute(
      sql`ALTER TABLE users ALTER COLUMN deleted_at DROP NOT NULL`,
    )

    // Step 3: Update all existing rows to set deleted_at to null
    console.log("Updating existing rows to null...")
    await db.execute(
      sql`UPDATE users SET deleted_at = NULL WHERE deleted_at IS NOT NULL`,
    )

    // Verify the changes
    const afterCheck = await db.execute(sql`
      SELECT column_name, is_nullable, column_default 
      FROM information_schema.columns 
      WHERE table_name = 'users' AND column_name = 'deleted_at'
    `)

    console.log("After changes:", afterCheck)

    // Count users with null deleted_at
    const nullCount = await db.execute(sql`
      SELECT COUNT(*) as count FROM users WHERE deleted_at IS NULL
    `)

    console.log(`Users with null deleted_at: ${nullCount[0]?.count}`)

    console.log("Successfully fixed deleted_at column!")
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
