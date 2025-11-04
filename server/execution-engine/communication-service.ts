import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { messageQueue, ExecutionRequest, ExecutionResponse, ExecutionMessage } from "./message-queue"
import { workflowExecutor } from "./workflow-executor"

const Logger = getLogger(Subsystem.WorkflowApi)

export class CommunicationService {
  private isRunning = false

  // Start the execution engine service
  async startService(): Promise<void> {
    if (this.isRunning) {
      Logger.warn("Communication service is already running")
      return
    }

    this.isRunning = true
    Logger.info("Starting execution engine communication service")

    // Start message processing worker using PgBoss
    this.startMessageProcessingWorker()
  }

  // Stop the execution engine service  
  async stopService(): Promise<void> {
    this.isRunning = false
    Logger.info("Stopped execution engine communication service")
  }

  // Handle incoming messages
  private async handleMessage(message: ExecutionMessage): Promise<void> {
    try {
      Logger.info(`Processing message type: ${message.type}, correlation ID: ${message.correlationId}`)

      let response: ExecutionResponse

      switch (message.type) {
        case 'START_EXECUTION':
          response = await this.handleStartExecution(message.payload)
          break
        
        case 'STOP_EXECUTION':
          response = await this.handleStopExecution(message.payload)
          break
        
        case 'GET_STATUS':
          response = await this.handleGetStatus(message.payload)
          break
        
        default:
          response = {
            success: false,
            error: `Unknown message type: ${message.type}`
          }
      }

      // Send response back using correlation ID
      await messageQueue.publishResponse(message.correlationId, response)

    } catch (error) {
      Logger.error(error, `Error handling message ${message.correlationId}`)
      
      const errorResponse: ExecutionResponse = {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error"
      }
      
      await messageQueue.publishResponse(message.correlationId, errorResponse)
    }
  }

  // Handle start execution request
  private async handleStartExecution(request: ExecutionRequest): Promise<ExecutionResponse> {
    try {
      const executionId = await workflowExecutor.executeTemplate(
        request.templateId,
        request.userId,
        request.workspaceId
      )

      return {
        success: true,
        executionId,
        data: { templateId: request.templateId }
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error"
      
      // Handle specific error types gracefully
      if (errorMessage.includes("not found") || errorMessage.includes("access denied")) {
        Logger.warn(`Template access issue for user ${request.userId}: ${errorMessage}`)
        return {
          success: false,
          error: `Template ${request.templateId} not found or access denied`
        }
      }
      
      // Handle other validation errors
      if (errorMessage.includes("validation") || errorMessage.includes("invalid")) {
        Logger.warn(`Validation error for template ${request.templateId}: ${errorMessage}`)
        return {
          success: false,
          error: `Invalid template or request: ${errorMessage}`
        }
      }
      
      // Log unexpected errors for debugging
      Logger.error(error, `Unexpected error starting execution for template ${request.templateId}`)
      return {
        success: false,
        error: "Failed to start execution due to internal error"
      }
    }
  }

  // Handle stop execution request
  private async handleStopExecution(request: { executionId: string }): Promise<ExecutionResponse> {
    try {
      // TODO: Implement stop execution logic
      return {
        success: true,
        data: { message: "Stop execution not implemented yet" }
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to stop execution"
      }
    }
  }

  // Handle get status request
  private async handleGetStatus(request: { executionId: string }): Promise<ExecutionResponse> {
    try {
      const status = await workflowExecutor.getExecutionStatus(request.executionId)
      
      return {
        success: true,
        data: status
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get execution status"
      }
    }
  }

  // Message processing worker using PgBoss
  private async startMessageProcessingWorker(): Promise<void> {
    Logger.info("Starting message processing worker")

    const boss = messageQueue.getBoss()
    const queues = messageQueue.getQueueNames()

    // Setup worker for incoming messages (START_EXECUTION, STOP_EXECUTION, GET_STATUS)
    await boss.work(queues.incoming, async (jobs) => {
      for (const job of jobs) {
        if (!this.isRunning) continue
        
        const message = job.data as ExecutionMessage
        Logger.info(`Processing message type: ${message.type}, correlation ID: ${message.correlationId}`)
        
        try {
          await this.handleMessage(message)
        } catch (error) {
          Logger.error(error, `Error processing message ${message.correlationId}`)
          throw error // Let PgBoss handle retry logic
        }
      }
    })

    Logger.info("Message processing worker started")
  }

  // Get service status
  getServiceStatus() {
    return {
      isRunning: this.isRunning,
      queueStatus: messageQueue.getQueueStatus(),
    }
  }
}

// Export singleton instance
export const communicationService = new CommunicationService()