import PgBoss from "pg-boss"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.ExecutionEngine)

const url = config.getDatabaseUrl()
export const executionBoss = new PgBoss({
  connectionString: url,
  monitorStateIntervalMinutes: 10,
})

// Single execution queue for all workflow execution tasks
export const ExecutionQueue = "execution"

// Execution packet interface
export interface ExecutionPacket {
  template_id: string
  workflow_id: string
  step_id: string
  tool_id: string
  input: Record<string, any> // JSON input data for tool execution
}

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
        Logger.info(`   Tool ID: ${packet.tool_id}`)
        Logger.info(`   Input: ${JSON.stringify(packet.input)}`)
        Logger.info(`   Job ID: ${job.id}`)
        
        // TODO: Call execution function with these IDs
        // await executeWorkflowStep(packet.template_id, packet.workflow_id, packet.step_id, packet.tool_id)
        
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
 */
export const sendExecutionPacket = async (packet: ExecutionPacket): Promise<string> => {
  try {
    const jobId = await executionBoss.send(ExecutionQueue, packet)
    if (!jobId) {
      throw new Error("Failed to get job ID from queue")
    }
    Logger.info(`📤 Sent execution packet to queue with job ID: ${jobId}`)
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

executionBoss.on("monitor-states", (states) => {
  Logger.debug(`Execution Queue States: ${JSON.stringify(states, null, 2)}`)
})