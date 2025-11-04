import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { messageQueue, ExecutionRequest, ExecutionResponse } from "./message-queue"
import { randomUUID } from "crypto"

const Logger = getLogger(Subsystem.WorkflowApi)

export class ExecutionClient {
  
  // Start execution - publishes to message queue and waits for execution ID from worker
  async startExecution(templateId: string, userId: number, workspaceId: number): Promise<string> {
    try {
      const request: ExecutionRequest = {
        templateId,
        userId,
        workspaceId,
        metadata: { 
          startedAt: new Date().toISOString()
        }
      }

      // Publish execution request to message queue
      const correlationId = await messageQueue.publishExecution(request)
      Logger.info(`Published execution request with correlation ID: ${correlationId}`)

      // Wait for response from execution engine worker (contains execution ID)
      const response = await messageQueue.waitForSpecificResponse(correlationId)
      
      if (!response.success) {
        throw new Error(response.error || "Failed to start execution")
      }

      Logger.info(`Execution started with ID: ${response.executionId}`)
      return response.executionId!

    } catch (error) {
      Logger.error(error, `Failed to start execution for template ${templateId}`)
      throw error
    }
  }


  // Get execution status
  async getExecutionStatus(executionId: string): Promise<any> {
    try {
      const correlationId = await this.publishMessage('GET_STATUS', { executionId })
      const response = await messageQueue.waitForSpecificResponse(correlationId)
      
      if (!response.success) {
        throw new Error(response.error || "Failed to get status")
      }

      return response.data

    } catch (error) {
      Logger.error(error, `Failed to get execution status for ${executionId}`)
      throw error
    }
  }

  // Stop execution
  async stopExecution(executionId: string): Promise<void> {
    try {
      const correlationId = await this.publishMessage('STOP_EXECUTION', { executionId })
      const response = await messageQueue.waitForSpecificResponse(correlationId)
      
      if (!response.success) {
        throw new Error(response.error || "Failed to stop execution")
      }

      Logger.info(`Execution stopped successfully: ${executionId}`)

    } catch (error) {
      Logger.error(error, `Failed to stop execution ${executionId}`)
      throw error
    }
  }

  // Generic message publishing
  private async publishMessage(type: string, payload: any): Promise<string> {
    const boss = messageQueue.getBoss()
    const queues = messageQueue.getQueueNames()
    
    const correlationId = `${type.toLowerCase()}_${randomUUID()}`
    
    const message = {
      type,
      payload,
      correlationId,
      timestamp: new Date(),
    }

    // Publish message to incoming queue (same as publishExecution but for other message types)
    await boss.send(queues.incoming, message)
    
    return correlationId
  }

  // Health check
  async healthCheck(): Promise<boolean> {
    try {
      const queueStatus = messageQueue.getQueueStatus()
      Logger.info("Execution engine health check", queueStatus)
      return true
    } catch (error) {
      Logger.error(error, "Execution engine health check failed")
      return false
    }
  }
}

// Export singleton instance
export const executionClient = new ExecutionClient()