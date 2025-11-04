// Main execution engine exports
export { workflowExecutor } from "./workflow-executor"
export { stepExecutor } from "./step-executor"
export { toolExecutor } from "./tool-executor"
export { queueManager } from "./queue-manager"
export { executionClient } from "./execution-client"
export { communicationService } from "./communication-service"
export { messageQueue } from "./message-queue"

// Export types
export * from "./types"
export * from "./message-queue"

// Main execution engine interface
export class ExecutionEngine {
  
  // Start execution via message queue (recommended for production)
  static async startExecution(templateId: string, userId: number, workspaceId: number): Promise<string> {
    const { executionClient } = await import("./execution-client")
    return executionClient.startExecution(templateId, userId, workspaceId)
  }

  // Start execution directly (for development/testing)
  static async startExecutionDirect(templateId: string, userId: number, workspaceId: number): Promise<string> {
    const { workflowExecutor } = await import("./workflow-executor")
    return workflowExecutor.executeTemplate(templateId, userId, workspaceId)
  }

  // Get execution status
  static async getExecutionStatus(executionId: string): Promise<any> {
    const { executionClient } = await import("./execution-client")
    return executionClient.getExecutionStatus(executionId)
  }

  // Stop execution
  static async stopExecution(executionId: string): Promise<void> {
    const { executionClient } = await import("./execution-client")
    return executionClient.stopExecution(executionId)
  }

  // Start the execution engine service
  static async startService(): Promise<void> {
    const { communicationService } = await import("./communication-service")
    return communicationService.startService()
  }

  // Stop the execution engine service
  static async stopService(): Promise<void> {
    const { communicationService } = await import("./communication-service")
    return communicationService.stopService()
  }

  // Get overall status
  static async getEngineStatus() {
    const { communicationService } = await import("./communication-service")
    const { queueManager } = await import("./queue-manager")
    
    return {
      service: communicationService.getServiceStatus(),
      queue: queueManager.getQueueStatus(),
    }
  }

  // Health check
  static async healthCheck(): Promise<boolean> {
    const { executionClient } = await import("./execution-client")
    return executionClient.healthCheck()
  }
}

// Named and default export
// export { ExecutionEngine }
// export default ExecutionEngine