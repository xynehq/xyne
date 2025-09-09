import { db } from "./db/client.ts"
import { workflowTemplate, workflowStepTemplate } from "./db/schema.ts"
import { eq } from "drizzle-orm"

async function fixAgenticWorkflowConnections() {
  try {
    console.log("Fixing Agentic AI workflow step connections...")

    const templateId = "234cfdde-90c1-423e-9db8-458e05f25a66"
    const step1Id = "5a13b2ab-bc90-4cb8-8bbe-506712602f17" // Document Upload
    const step2Id = "1455fdcf-d9a7-40b5-951c-56ca09706f6a" // Agentic AI Analysis
    const step3Id = "020bc988-114c-4690-a761-34d837af0281" // Email Results

    // 1. Update step 1 (Document Upload) -> step 2 (Agentic AI Analysis)
    await db
      .update(workflowStepTemplate)
      .set({ nextStepIds: [step2Id] })
      .where(eq(workflowStepTemplate.id, step1Id))
    console.log("✅ Updated step 1 -> step 2 connection")

    // 2. Update step 2 (Agentic AI Analysis) connections
    await db
      .update(workflowStepTemplate)
      .set({
        prevStepIds: [step1Id],
        nextStepIds: [step3Id],
      })
      .where(eq(workflowStepTemplate.id, step2Id))
    console.log("✅ Updated step 2 connections (1 -> 2 -> 3)")

    // 3. Update step 3 (Email Results) <- step 2 (Agentic AI Analysis)
    await db
      .update(workflowStepTemplate)
      .set({ prevStepIds: [step2Id] })
      .where(eq(workflowStepTemplate.id, step3Id))
    console.log("✅ Updated step 2 -> step 3 connection")

    // 4. Set root step in workflow template
    await db
      .update(workflowTemplate)
      .set({
        rootWorkflowStepTemplateId: step1Id,
        status: "active",
      })
      .where(eq(workflowTemplate.id, templateId))
    console.log("✅ Set root step and activated workflow")

    console.log("🎉 Successfully fixed Agentic AI workflow connections!")

    // Verify the connections
    const steps = await db
      .select()
      .from(workflowStepTemplate)
      .where(eq(workflowStepTemplate.workflowTemplateId, templateId))

    console.log("\n📊 Final step connections:")
    steps.forEach((step) => {
      console.log(`- ${step.name}:`)
      console.log(`  Previous: ${step.prevStepIds?.length || 0} steps`)
      console.log(`  Next: ${step.nextStepIds?.length || 0} steps`)
    })

    return { success: true, templateId, steps: steps.length }
  } catch (error) {
    console.error("❌ Error fixing workflow connections:", error)
    throw error
  }
}

fixAgenticWorkflowConnections()
  .then((result) => {
    console.log("Workflow connection fix completed:", result)
    process.exit(0)
  })
  .catch((error) => {
    console.error("Failed to fix workflow connections:", error)
    process.exit(1)
  })
