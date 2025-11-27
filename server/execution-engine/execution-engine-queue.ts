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
      const packet = job.data as ExecutionPacket
      try {
        
        Logger.info(`🔄 EXECUTION WORKER PICKED UP PACKET:`)
        Logger.info(`   Template ID: ${packet.template_id}`)
        Logger.info(`   Workflow ID: ${packet.workflow_id}`)
        Logger.info(`   Step ID: ${packet.step_id}`)
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
        markWorkflowStatus(packet.workflow_id,false).catch((err) => {
          Logger.error(err, `Failed to mark workflow ${packet.workflow_id} as FAILED after execution error`)
        })
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
    
    Logger.info(`   Template: ${packet.template_id}, Workflow: ${packet.workflow_id}, Step: ${packet.step_id}`)
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


/**
 * Mark workflow as completed when no next steps are available
 */
const markWorkflowStatus = async (workflowId: string, success: boolean): Promise<void> => {
  try {
    await db
      .update(workflowExecution)
      .set({
        status: success?WorkflowStatus.COMPLETED:WorkflowStatus.FAILED,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(workflowExecution.id, workflowId))

    Logger.info(`🏁 Marked workflow ${workflowId} as ${success ? 'COMPLETED' : 'FAILED'}`)
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
    await markWorkflowStatus(currentPacket.workflow_id,true)
    return
  }
  // let queueNextStepIds = currentStep.nextStepIds || []
  let queueNextStepIds:string[] = []

  if(result.toolResult.nextStepRoutes){
    const nextStepRoutes = result.toolResult.nextStepRoutes
    Logger.info(`Queueing next steps based on tool result routes: ${nextStepRoutes.join(", ")}`)
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

  if (queueNextStepIds.length === 0) {
    Logger.info("No next steps to queue marking workflow as completed")
    await markWorkflowStatus(currentPacket.workflow_id,true)
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

        if (!nextStep.toolType){
          Logger.warn(`Next step ${nextStepId} has no toolType defined, skipping`)
          continue
        }

        const nextPacket: ExecutionPacket = {
          template_id: currentPacket.template_id,
          workflow_id: currentPacket.workflow_id,
          step_id: nextStepId,
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

      } catch (error) {
        Logger.error(error, `Failed to queue next step ${nextStepId}`)
      }
    }
    Logger.info(`✅ Finished queueing next steps`)
  }
