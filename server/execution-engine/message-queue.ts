import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { randomUUID } from "crypto"
import PgBoss from "pg-boss"
import config from "@/config"

const Logger = getLogger(Subsystem.WorkflowApi)

// Message types for communication
export interface ExecutionMessage {
  type: 'START_EXECUTION' | 'STOP_EXECUTION' | 'GET_STATUS' | 'MANUAL_TRIGGER'
  payload: any
  correlationId: string
  timestamp: Date
}

export interface ExecutionRequest {
  templateId: string
  userId: number
  workspaceId: number
  metadata?: Record<string, any>
}

export interface ExecutionResponse {
  success: boolean
  executionId?: string
  error?: string
  data?: any
}

// PgBoss-based message queue implementation
class MessageQueue {
  private boss: PgBoss
  private isInitialized = false

  // Queue names
  private readonly INCOMING_QUEUE = "incoming_queue"
  private readonly OUTGOING_QUEUE = "outgoing_queue"

  constructor() {
    this.boss = new PgBoss({
      connectionString: config.getDatabaseUrl(),
      schema: 'pgboss', // Explicitly set schema name
      migrate: true, // Enable automatic migrations
    })
  }

  // Initialize PgBoss connection and queues
  async initialize(): Promise<void> {
    if (this.isInitialized) return

    // Run migrations for PgBoss 11.x compatibility
    await this.boss.start()
    
    // Create queues after successful start
    await this.boss.createQueue(this.INCOMING_QUEUE)
    await this.boss.createQueue(this.OUTGOING_QUEUE)

    this.isInitialized = true
    Logger.info("PgBoss message queue initialized with v11 schema")
  }

  // Poll for response by correlation ID using direct SQL queries
  async pollForResponse(correlationId: string, timeoutMs: number = 30000): Promise<ExecutionResponse> {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }

    const startTime = Date.now()
    const pollInterval = 500 // Poll every 500ms

    return new Promise((resolve, reject) => {
      const poll = async () => {
        try {
          // Get the internal database connection from PgBoss
          const db = this.getDatabase()
          
          // Direct SQL query to find job by correlation ID
          // Using JSONB operator ->> for efficient correlation ID filtering
          const findJobSql = `
            SELECT id, data, state, created_on
            FROM pgboss.job 
            WHERE name = $1 
              AND state = 'created'
              AND data->>'correlationId' = $2
            ORDER BY created_on ASC
            LIMIT 1
          `
          
          const result = await db.executeSql(findJobSql, [this.OUTGOING_QUEUE, correlationId])
          
          if (result?.rows?.length > 0) {
            const job = result.rows[0]
            const jobData = job.data as ExecutionResponse
            
            // Extract response data
            const response: ExecutionResponse = {
              success: jobData.success,
              executionId: jobData.executionId,
              error: jobData.error,
              data: jobData.data
            }
            
            // Mark job as completed using direct SQL
            const completeJobSql = `
              UPDATE pgboss.job 
              SET state = 'completed', 
                  completed_on = now()
              WHERE id = $1
            `
            
            await db.executeSql(completeJobSql, [job.id])
            
            Logger.info(`Response found and processed for correlation ID: ${correlationId}`)
            resolve(response)
            return
          }
          
          // Check timeout
          if (Date.now() - startTime >= timeoutMs) {
            reject(new Error(`Response timeout for correlation ID: ${correlationId}`))
            return
          }
          
          // Continue polling
          setTimeout(poll, pollInterval)
          
        } catch (error) {
          Logger.error(error, `Error polling for response ${correlationId}`)
          reject(error)
        }
      }
      
      poll()
    })
  }

  // Wait for specific response using SQL polling
  async waitForSpecificResponse(correlationId: string, timeoutMs: number = 30000): Promise<ExecutionResponse> {
    return this.pollForResponse(correlationId, timeoutMs)
  }

  // Publish message to execution queue with optional scheduling
  async publishExecution(request: ExecutionRequest, start_at?: string, cron?: string): Promise<string> {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }
    
    const correlationId = this.generateCorrelationId()
    
    const message: ExecutionMessage = {
      type: 'START_EXECUTION',
      payload: request,
      correlationId,
      timestamp: new Date(),
    }

    // Handle different scheduling options
    if (cron) {
      // Use boss.schedule for cron expressions
      await this.boss.schedule(this.INCOMING_QUEUE, cron, message, {
        tz: 'UTC',
        key :  request.templateId
      })
      Logger.info(`Scheduled execution with cron '${cron}' and correlation ID: ${correlationId}`)
    } else if (start_at) {
      // Use boss.sendAfter for specific start time
      await this.boss.sendAfter(this.INCOMING_QUEUE, message, {}, start_at)
      Logger.info(`Scheduled execution for ${start_at} with correlation ID: ${correlationId}`)
    } else {
      // Use boss.send for immediate execution
      await this.boss.send(this.INCOMING_QUEUE, message)
      Logger.info(`Published immediate execution message with correlation ID: ${correlationId}`)
    }
    
    return correlationId
  }

  async schedule(request: ExecutionRequest, cron: string): Promise<string> {
    return this.publishExecution(request, undefined, cron)
  }

  async unschedule(templateId: string): Promise<void> {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }
    
    await this.boss.unschedule(this.INCOMING_QUEUE, templateId)
    Logger.info(`Unscheduled executions for template ID: ${templateId}`)
  }

  // Get PgBoss instance for worker setup (used by CommunicationService)
  getBoss(): PgBoss {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }
    return this.boss
  }

  // Get queue names for worker setup
  getQueueNames() {
    return {
      incoming: this.INCOMING_QUEUE,
      outgoing: this.OUTGOING_QUEUE
    }
  }

  // Get database connection for direct SQL operations
  private getDatabase() {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }
    // Access internal database connection via type assertion
    // PgBoss exposes this method but TypeScript definitions don't include it
    return (this.boss as any).getDb()
  }

  // Publish response back to main server via OUTGOING_QUEUE
  async publishResponse(correlationId: string, response: ExecutionResponse): Promise<void> {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }
    
    Logger.info(`Publishing response for correlation ID: ${correlationId}, success: ${response.success}`)
    
    // Send response to OUTGOING_QUEUE with correlation ID
    const responseWithCorrelation = {
      correlationId,
      ...response
    }
    
    await this.boss.send(this.OUTGOING_QUEUE, responseWithCorrelation)
    
    Logger.info(`Response published to ${this.OUTGOING_QUEUE} for correlation ID: ${correlationId}`)
  }


  // Check if queue is initialized
  private checkInitialized(): boolean {
    if (!this.isInitialized) {
      Logger.error("Message queue is not initialized. Call initialize() first.")
      return false
    }
    return true
  }

  // Generate unique correlation ID
  private generateCorrelationId(): string {
    return `exec_${randomUUID()}`
  }

  // Get queue status
  getQueueStatus() {
    return {
      isInitialized: this.isInitialized,
    }
  }

  // Get detailed queue statistics (PgBoss 11.x method)
  async getQueueStats() {
    if (!this.checkInitialized()) {
      throw new Error("Message queue not initialized")
    }
    
    try {
      const queues = await this.boss.getQueues()
      return queues.map(queue => ({
        name: queue.name,
        deferredCount: queue.deferredCount || 0,
        queuedCount: queue.queuedCount || 0,
        activeCount: queue.activeCount || 0,
        totalCount: queue.totalCount || 0,
      }))
    } catch (error) {
      Logger.error(error, "Failed to get queue statistics")
      return []
    }
  }

  // Cleanup
  async stop(): Promise<void> {
    await this.boss.stop()
    this.isInitialized = false
    Logger.info("PgBoss message queue stopped")
  }
}

// Singleton instance
export const messageQueue = new MessageQueue()