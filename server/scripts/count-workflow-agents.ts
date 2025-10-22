
import { db } from "@/db/client"
import { agents } from "@/db/schema"
import { and, eq, isNull, desc, count, sql } from "drizzle-orm"
import { AgentCreationSource } from "@/db/schema"

export const countWorkflowAgents = async () => {
  console.log("🔍 Counting workflow agents which is marked as direct...")

  const result = await db
    .select({ count: count() })
    .from(agents)
    .where(
      and(
        eq(agents.creation_source, AgentCreationSource.DIRECT),
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

export const previewAgentsToUpdate = async () => {
  console.log("👀 Previewing agents to update...")

  const agentsToUpdate = await db
    .select({
      id: agents.id,
      externalId: agents.externalId,
      name: agents.name,
      description: agents.description,
      creation_source: agents.creation_source,
      createdAt: agents.createdAt,
    })
    .from(agents)
    .where(
      and(
        eq(agents.creation_source, AgentCreationSource.DIRECT),
        eq(agents.isPublic, false),
        eq(agents.appIntegrations, sql`'[]'::jsonb`),
        eq(agents.allowWebSearch, false),
        eq(agents.isRagOn, false),
        eq(agents.docIds, sql`'[]'::jsonb`),
        isNull(agents.deletedAt)
      )
    )
    .orderBy(desc(agents.createdAt))


  console.log(`🎯 Found ${agentsToUpdate.length} agents to update:`) // ADD THIS LINE
  agentsToUpdate.forEach((agent, index) => {
    console.log(`${index + 1}. ${agent.name} (${agent.externalId}) - Current: ${agent.creation_source} - Created: ${agent.createdAt}`)
  })

  return agentsToUpdate
}

export const WorkflowAgentsMainPreview = async () => {
  try {
    // Step 1: Count
    const count = await countWorkflowAgents()

    if (count === 0) {
      console.log("✨ No agents found to update!")
      return
    }

    // Step 2: Preview
    await previewAgentsToUpdate()


  } catch (error) {
    console.error("❌ Error during running script:", error)
    throw error
  }
}

// Run if this file is executed directly
if (require.main === module) {
  WorkflowAgentsMainPreview()
    .then(() => {
      console.log("🎉 successfully previewed workflow agents")
      process.exit(0)
    })
    .catch((error) => {
      console.error("💥 Script failed:", error)
      process.exit(1)
    })
}