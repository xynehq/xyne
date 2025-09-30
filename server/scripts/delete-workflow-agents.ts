import { db } from "@/db/client"
import { agents } from "@/db/schema"
import { and, eq, isNull, desc, count, sql } from "drizzle-orm"


export const hardDeleteWorkflowAgents = async () => {
    console.log("⚠️ HARD deleting workflow agents...")

    const result = await db
        .delete(agents)
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

    console.log(`🔥 Hard deleted workflow agents`)
    return result
}


// Run if this file is executed directly
if (require.main === module) {
    hardDeleteWorkflowAgents()
        .then(() => {
            console.log("🎉 successfully deleted workflow agents")
            process.exit(0)
        })
        .catch((error) => {
            console.error("💥 Script failed:", error)
            process.exit(1)
        })
}
