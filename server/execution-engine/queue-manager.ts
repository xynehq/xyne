import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { ReadyQueueItem } from "./types"

const Logger = getLogger(Subsystem.WorkflowApi)

// In-memory queue implementation (can be replaced with Redis/DB later)
class QueueManager {
  private readyQueue: ReadyQueueItem[] = []
  private processingQueue: Set<string> = new Set()

  // Add step to ready queue
  async addToReadyQueue(item: ReadyQueueItem): Promise<void> {
    try {
      // Insert based on priority (higher priority first)
      const insertIndex = this.readyQueue.findIndex(
        queueItem => queueItem.priority < item.priority
      )
      
      if (insertIndex === -1) {
        this.readyQueue.push(item)
      } else {
        this.readyQueue.splice(insertIndex, 0, item)
      }

      Logger.info(
        `Added step ${item.stepExecutionId} to ready queue with priority ${item.priority}`
      )
    } catch (error) {
      Logger.error(error, `Failed to add step ${item.stepExecutionId} to ready queue`)
      throw error
    }
  }

  // Get next item from ready queue
  async getNextFromReadyQueue(): Promise<ReadyQueueItem | null> {
    try {
      const item = this.readyQueue.shift()
      
      if (item) {
        this.processingQueue.add(item.stepExecutionId)
        Logger.info(`Retrieved step ${item.stepExecutionId} from ready queue`)
      }
      
      return item || null
    } catch (error) {
      Logger.error(error, "Failed to get next item from ready queue")
      throw error
    }
  }

  // Mark step as completed and remove from processing
  async markStepCompleted(stepExecutionId: string): Promise<void> {
    try {
      this.processingQueue.delete(stepExecutionId)
      Logger.info(`Marked step ${stepExecutionId} as completed`)
    } catch (error) {
      Logger.error(error, `Failed to mark step ${stepExecutionId} as completed`)
      throw error
    }
  }

  // Mark step as failed and remove from processing
  async markStepFailed(stepExecutionId: string): Promise<void> {
    try {
      this.processingQueue.delete(stepExecutionId)
      Logger.info(`Marked step ${stepExecutionId} as failed`)
    } catch (error) {
      Logger.error(error, `Failed to mark step ${stepExecutionId} as failed`)
      throw error
    }
  }

  // Get queue status
  getQueueStatus() {
    return {
      readyQueueSize: this.readyQueue.length,
      processingQueueSize: this.processingQueue.size,
      readyItems: this.readyQueue.map(item => ({
        stepExecutionId: item.stepExecutionId,
        executionId: item.executionId,
        priority: item.priority,
        createdAt: item.createdAt,
      })),
      processingItems: Array.from(this.processingQueue),
    }
  }

  // Check if step is in queue or processing
  isStepInQueue(stepExecutionId: string): boolean {
    return (
      this.readyQueue.some(item => item.stepExecutionId === stepExecutionId) ||
      this.processingQueue.has(stepExecutionId)
    )
  }

  // Remove step from queue (if not yet processing)
  async removeFromQueue(stepExecutionId: string): Promise<boolean> {
    try {
      const index = this.readyQueue.findIndex(
        item => item.stepExecutionId === stepExecutionId
      )
      
      if (index !== -1) {
        this.readyQueue.splice(index, 1)
        Logger.info(`Removed step ${stepExecutionId} from ready queue`)
        return true
      }
      
      return false
    } catch (error) {
      Logger.error(error, `Failed to remove step ${stepExecutionId} from queue`)
      throw error
    }
  }
}

// Singleton instance
export const queueManager = new QueueManager()