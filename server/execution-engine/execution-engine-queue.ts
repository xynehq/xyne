import PgBoss from "pg-boss"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { db } from "@/db/client"
import { workflowStepExecution, workflowStepTemplate, workflowExecution } from "@/db/schema/workflows"
import { WorkflowStatus } from "@/types/workflowTypes"
import { eq } from "drizzle-orm"
import { stepExecutor } from "./step-executor"
import type { StepExecutionResult, ExecutionPacket } from "./types"

const Logger = getLogger(Subsystem.ExecutionEngine)

const url = config.getDatabaseUrl()
export const executionBoss = new PgBoss({
  connectionString: url,
  monitorIntervalSeconds: 600,
})

// Single execution queue for all workflow execution tasks
export const ExecutionQueue = "execution"

/**
 * Initialize pg-boss for execution engine usage
 * - Starts pg-boss connection
 * - Creates single execution queue
 * - Initializes worker for all execution tasks
 */
export const initExecutionEngineQueue = async () => {
  Logger.info("Execution Engine Queue init - starting pg-boss")
  await executionBoss.start()
  
  Logger.info("Creating ExecutionQueue")
  await executionBoss.createQueue(ExecutionQueue)
  
  await initExecutionWorker()
  
  Logger.info("Execution Engine Queue initialization complete")
}

/**
 * Initialize single execution worker
 */
const initExecutionWorker = async () => {
  Logger.info("Initializing execution worker...")
  
  // Single execution worker - handles all execution tasks
  await executionBoss.work(ExecutionQueue, async (jobs) => {
    for (const job of jobs) {
      try {
        const packet = job.data as ExecutionPacket
        
        Logger.info(`🔄 EXECUTION WORKER PICKED UP PACKET:`)
        Logger.info(`   Template ID: ${packet.template_id}`)
        Logger.info(`   Workflow ID: ${packet.workflow_id}`)
        Logger.info(`   Step ID: ${packet.step_id}`)
        Logger.info(`   Template Tool ID: ${packet.tool_id}`)
        Logger.info(`   Previous Tool ID: ${packet.previous_tool_id}`)
        Logger.info(`   Input: ${JSON.stringify(packet.input)}`)
        Logger.info(`   Job ID: ${job.id}`)
        
        // Execute the step using StepExecutor
        const result = await stepExecutor.executeStep(packet)
        
        // Log execution result
        Logger.info(`📋 Step execution result: ${JSON.stringify(result)}`)

        // Queue next steps if execution should continue
        if (result.nextAction === 'continue') {
          await queueNextSteps(packet, result)
        } else if (result.nextAction === 'wait_for_input') {
          Logger.info(`⏳ Step is waiting for additional inputs, not queuing next steps`)
        }
        
        Logger.info(`✅ Packet processing completed for job ${job.id}`)
        
      } catch (error) {
        Logger.error(error, `❌ Error processing execution packet for job ${job.id}`)
      }
    }
  })
  
  Logger.info("Execution worker initialized successfully")
}

/**
 * Send execution packet to the queue
 * @param packet - Execution packet data
 * @param executeAt - Optional timestamp for scheduled execution (ISO string, Date, or seconds)
 */
export const sendExecutionPacket = async (packet: ExecutionPacket, executeAt?: string): Promise<string> => {
  try {
    let jobId: string | null
    
    if (executeAt) {
      // Use sendAfter for scheduled execution
      jobId = await executionBoss.sendAfter(ExecutionQueue, packet, {}, executeAt)
      Logger.info(`📅 Scheduled execution packet for ${executeAt} with job ID: ${jobId}`)
    } else {
      // Use regular send for immediate execution
      jobId = await executionBoss.send(ExecutionQueue, packet)
      Logger.info(`📤 Sent execution packet to queue with job ID: ${jobId}`)
    }
    
    if (!jobId) {
      throw new Error("Failed to get job ID from queue")
    }
    
    Logger.info(`   Template: ${packet.template_id}, Workflow: ${packet.workflow_id}, Step: ${packet.step_id}, Tool: ${packet.tool_id}`)
    Logger.info(`   Input: ${JSON.stringify(packet.input)}`)
    return jobId
  } catch (error) {
    Logger.error(error, `Failed to send execution packet to queue`)
    throw error
  }
}

// Error handling
executionBoss.on("error", (error) => {
  Logger.error(error, `Execution Engine Queue error: ${error.message}`)
})

// executionBoss.on("monitor-states", (states) => {
//   Logger.debug(`Execution Queue States: ${JSON.stringify(states, null, 2)}`)
// })

/**
 * Mark workflow as completed when no next steps are available
 */
const markWorkflowAsCompleted = async (workflowId: string): Promise<void> => {
  try {
    await db
      .update(workflowExecution)
      .set({
        status: WorkflowStatus.COMPLETED,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowExecution.id, workflowId))

    Logger.info(`🏁 Marked workflow ${workflowId} as COMPLETED`)
  } catch (error) {
    Logger.error(error, `Failed to mark workflow ${workflowId} as completed`)
  }
}

/**
 * Queue next steps for execution based on current step result
 */
export const queueNextSteps = async (currentPacket: ExecutionPacket, result: StepExecutionResult): Promise<void> => {
  // Get current step to find its next step IDs
  const [currentStep] = await db
    .select()
    .from(workflowStepExecution)
    .where(eq(workflowStepExecution.id, currentPacket.step_id))
    .limit(1)

  if (!currentStep || !currentStep.nextStepIds || currentStep.nextStepIds.length === 0) {
    Logger.info("No next steps to queue - marking workflow as completed")
    await markWorkflowAsCompleted(currentPacket.workflow_id)
    return
  }
  // let queueNextStepIds = currentStep.nextStepIds || []
  let queueNextStepIds:string[] = []

  if(result.toolResult.nextStepRoutes){
    const nextStepRoutes = result.toolResult.nextStepRoutes
    for(const branchKey of nextStepRoutes){
      const stepIds:string[] = currentStep.metadata ? (currentStep.metadata as any).outRoutes[branchKey] : null
      if(stepIds){
        queueNextStepIds.push(...stepIds)
      }
    }
  }else{
    for(const nextStepId of currentStep.nextStepIds){
      queueNextStepIds.push(nextStepId)
    }
  }

  // if(result.toolResult.output){
  //   for(const nextStepId of currentStep.nextStepIds){
  //     queueNextStepIds[nextStepId] = result.toolResult.output
  //   }
  // }else if(result.toolResult.nextStepRoutes){
  //   // queueNextStepIds = result.toolResult.nextStepRoutes
  //   const nextStepRoutes = result.toolResult.nextStepRoutes
  //   for(const [branchKey,output] of Object.entries(nextStepRoutes)){
  //     const stepId = currentStep.metadata ? (currentStep.metadata as any).outRoutes[branchKey] : null
  //     if(stepId){
  //       queueNextStepIds[stepId] = output
  //     }
  //   }
  // }

  // if(result.toolResult.metadata?.mode!=="all"){
  //   const metadata = result.toolResult.metadata || {}
  //   switch (metadata.mode){
  //     case "one":
  //       // Extract the matched branch and get only that step ID
  //       const matchedBranches = metadata.matchedBranches || []
  //       if (matchedBranches.length > 0) {
  //         const matchedBranch = matchedBranches[0] // Get first matched branch
  //         const outRoutes = (currentStep.metadata as any)?.outRoutes || {}
  //         const targetStepId = outRoutes[matchedBranch]
          
  //         if (targetStepId) {
  //           queueNextStepIds = [targetStepId]
  //           Logger.info(`🔗 Selected single route ${matchedBranch} to step ${targetStepId}`)
  //         } else {
  //           queueNextStepIds = []
  //           Logger.warn(`No outRoute found for matched branch ${matchedBranch}`)
  //         }
  //       } else {
  //         queueNextStepIds = []
  //         Logger.info("No branches matched condition, skipping queuing")
  //       }
  //       break

  //     case "multiple":
  //       // Extract all matched branches and get their step IDs
  //       const allMatchedBranches = metadata.matchedBranches || []
  //       const allOutRoutes = (currentStep.metadata as any)?.outRoutes || {}
        
  //       queueNextStepIds = allMatchedBranches
  //         .map((branch: string) => allOutRoutes[branch])
  //         .filter((stepId: any) => stepId) // Remove undefined values
        
  //       Logger.info(`🔗 Selected ${queueNextStepIds.length} routes for matched branches: ${allMatchedBranches.join(', ')}`)
  //       break

  //     default:
  //       Logger.warn(`Unknown switch mode: ${metadata.mode}, using all next steps`)
  //       break
  //   }
  // }

  if (queueNextStepIds.length === 0) {
    Logger.info("No next steps to queue marking workflow as completed")
    await markWorkflowAsCompleted(currentPacket.workflow_id)
    return
  }

  Logger.info(`🔗 Queueing from here ${queueNextStepIds.length} next steps`)

  for (const nextStepId of queueNextStepIds) {
    try {
        // Get next step details to find its tools
        const [nextStep] = await db
          .select()
          .from(workflowStepExecution)
          .where(eq(workflowStepExecution.id, nextStepId))
          .limit(1)

        if (!nextStep) {
          Logger.warn(`Next step ${nextStepId} not found, skipping`)
          continue
        }
        
        // Get template step to extract tool IDs
        const [templateStep] = await db
          .select()
          .from(workflowStepTemplate)
          .where(eq(workflowStepTemplate.id, nextStep.workflowStepTemplateId))
          .limit(1)

        if (!templateStep) {
          Logger.warn(`Template step for ${nextStepId} not found, skipping`)
          continue
        }

        // Queue each tool from the template step
        const toolIds = templateStep.toolIds || []
        for (const toolId of toolIds) {
          const nextPacket: ExecutionPacket = {
            template_id: currentPacket.template_id,
            workflow_id: currentPacket.workflow_id,
            step_id: nextStepId,
            tool_id: toolId,
            input: result.toolResult.output || {}, // Pass previous step output as input
            previous_tool_id: result.toolId,
            previous_step_id: currentPacket.step_id
          }

          // Queue next step (scheduled if next_execute_at is present)
          const jobId = await sendExecutionPacket(nextPacket, result.next_execute_at)
          
          if (result.next_execute_at) {
            Logger.info(`⏰ Scheduled next step '${nextStep.name}' for ${result.next_execute_at} with job ID: ${jobId}`)
          } else {
            Logger.info(`➡️ Queued next step '${nextStep.name}' with job ID: ${jobId}`)
          }
        }
      } catch (error) {
        Logger.error(error, `Failed to queue next step ${nextStepId}`)
      }
    }
    Logger.info(`✅ Finished queueing next steps`)
  }
