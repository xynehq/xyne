
import { db } from "@/db/client"
import { agents } from "@/db/schema"
import { and, eq, isNull, desc, count, sql } from "drizzle-orm"

export const countWorkflowAgents = async () => {
  console.log("🔍 Counting workflow agents...")

  const result = await db
    .select({ count: count() })
    .from(agents)
    .where(
      and(
        eq(agents.isPublic, false),
        eq(agents.appIntegrations, sql`'[]'::jsonb`),
        eq(agents.allowWebSearch, false),
        eq(agents.isRagOn, false),
        eq(agents.docIds, sql`'[]'::jsonb`),
        isNull(agents.deletedAt)
      )
    )

  console.log(`📊 Found ${result[0].count} workflow agents`)
  return result[0].count
}

// Run if this file is executed directly
if (require.main === module) {
  countWorkflowAgents()
    .then(() => {
      console.log("🎉 Script completed!")
      process.exit(0)
    })
    .catch((error) => {
      console.error("💥 Script failed:", error)
      process.exit(1)
    })
}