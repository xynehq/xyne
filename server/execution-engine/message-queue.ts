import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { randomUUID } from "crypto"
import PgBoss from "pg-boss"
import config from "@/config"

const Logger = getLogger(Subsystem.WorkflowApi)

// Message types for communication
export interface ExecutionMessage {
  type: 'START_EXECUTION' | 'STOP_EXECUTION' | 'GET_STATUS'
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
      monitorStateIntervalMinutes: 10,
    })
  }

  // Initialize PgBoss connection and queues
  async initialize(): Promise<void> {
    if (this.isInitialized) return

    await this.boss.start()
    await this.boss.createQueue(this.INCOMING_QUEUE)
    await this.boss.createQueue(this.OUTGOING_QUEUE)

    this.isInitialized = true
    Logger.info("PgBoss message queue initialized")
  }

  // Poll for response by correlation ID using direct SQL queries
  // Benefits of this approach:
  // - No job bouncing between states (fetch/fail cycle eliminated)
  // - More efficient with single SQL query vs PgBoss method overhead  
  // - Atomic operations directly on pgboss.job table
  // - Scalable with potential for correlation ID indexing
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

  // Publish message to execution queue
  async publishExecution(request: ExecutionRequest): Promise<string> {
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

    await this.boss.send(this.INCOMING_QUEUE, message)
    Logger.info(`Published execution message with correlation ID: ${correlationId}`)
    
    return correlationId
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

  // Cleanup
  async stop(): Promise<void> {
    await this.boss.stop()
    this.isInitialized = false
    Logger.info("PgBoss message queue stopped")
  }
}

// Singleton instance
export const messageQueue = new MessageQueue()