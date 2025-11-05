import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext } from "./types"
import { z } from "zod"
import { messageQueue, type ExecutionRequest } from "@/execution-engine/message-queue"  
export class SchedulerTriggerTool implements WorkflowTool {
  type = ToolType.SCHEDULER_TRIGGER
  category = ToolCategory.TRIGGER
  triggerIfActive = true

  inputSchema = z.object({})
  
  outputSchema = z.object({
    triggeredAt: z.string(),
    scheduleType: z.string().optional(),
    nextExecutionAt: z.string().optional(),
    cronExpression: z.string().optional()
  })
  
  configSchema = z.object({
    trigger_after_seconds: z.number().positive().optional(),
    trigger_at: z.string().optional(),
    cron_expression: z.string().optional(),
    timezone: z.string().default("UTC"),
    maxExecutions: z.number().positive().optional()
  })

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      const currentTime = new Date()
      
      // Process scheduling configuration keys (if-else chain, first match wins)
      const scheduleMetadata: Record<string, any> = {}
      
      // Handle trigger_after_seconds - convert to timestamp
      if (config.trigger_after_seconds && typeof config.trigger_after_seconds === 'number') {
        const triggerTime = new Date(currentTime.getTime() + config.trigger_after_seconds * 1000)
        scheduleMetadata.trigger_after = triggerTime.toISOString()
      } 
      // Handle trigger_at - parse as timestamp  
      else if (config.trigger_at) {
        try {
          const triggerAtDate = new Date(config.trigger_at)
          if (!isNaN(triggerAtDate.getTime())) {
            scheduleMetadata.trigger_after = triggerAtDate.toISOString()
          }
        } catch (error) {
          // Invalid trigger_at, continue to next option
        }
      }
      // Handle cron_expression - parse standard cron format
      else if (config.cron_expression && typeof config.cron_expression === 'string') {
        // For cron expressions, we don't need to calculate next execution time here
        // The scheduling is handled by PgBoss when the template is activated
        scheduleMetadata.cron_expression = config.cron_expression
        scheduleMetadata.timezone = config.timezone || 'UTC'
        scheduleMetadata.recurring = true
      }
      
      // Check if max executions reached
      // const isLastExecution = config.maxExecutions 
      //   ? executionCount >= config.maxExecutions 
      //   : (config.scheduleType || "once") === "once"

      // // Calculate next execution time (behavior to be implemented later)
      // const nextExecutionAt = isLastExecution 
      //   ? undefined 
      //   : this.calculateNextExecution(config, currentTime)

      return {
        status: "success",
        result: {
          triggeredAt: currentTime.toISOString()
        },
        metadata: scheduleMetadata
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          triggeredAt: new Date().toISOString(),
          scheduleType: config.scheduleType || "once",
          executionCount: input.executionCount || 0,
          isLastExecution: true,
          timezone: config.timezone || "UTC",
          metadata: { error: error instanceof Error ? error.message : String(error) },
        },
      }
    }
  }

  // Parse cron expression and calculate next execution time
  private getNextCronExecution(cronExpression: string, currentTime: Date): Date | null {
    try {
      // Basic cron format validation (5 or 6 fields)
      const cronParts = cronExpression.trim().split(/\s+/)
      if (cronParts.length !== 5 && cronParts.length !== 6) {
        return null
      }

      // For 5-field cron: minute hour day month dayOfWeek
      // For 6-field cron: second minute hour day month dayOfWeek
      const isSecondsField = cronParts.length === 6
      const [seconds, minute, hour, day, month, dayOfWeek] = isSecondsField 
        ? cronParts 
        : ['0', ...cronParts]

      const nextExecution = new Date(currentTime)
      nextExecution.setSeconds(parseInt(seconds === '*' ? '0' : seconds), 0)

      // Handle minute field
      if (minute !== '*') {
        const targetMinute = parseInt(minute)
        if (targetMinute >= 0 && targetMinute <= 59) {
          nextExecution.setMinutes(targetMinute)
        }
      }

      // Handle hour field  
      if (hour !== '*') {
        const targetHour = parseInt(hour)
        if (targetHour >= 0 && targetHour <= 23) {
          nextExecution.setHours(targetHour)
        }
      }

      // Simple logic: if calculated time is in the past, add 1 day
      if (nextExecution <= currentTime) {
        nextExecution.setDate(nextExecution.getDate() + 1)
      }

      // TODO: Implement full cron parsing for day, month, dayOfWeek fields
      // This is a simplified implementation focusing on time-based scheduling
      
      return nextExecution
    } catch (error) {
      return null
    }
  }

  // Handler for active trigger - called when template is activated
  async handleActiveTrigger(config: Record<string, any>, templateId:string): Promise<Record<string, string>> {
    
    
    try {
      // Create execution packet for starting workflow
      const executionPacket:ExecutionRequest = {
          templateId: templateId,
          userId: 1, // TODO: Get from context
          workspaceId: 1 // TODO: Get from context
      }

      // const messageBoss = messageQueue.getBoss()
      // const queueName = 'incoming-queue'

      // // Check if cron expression exists
      if (config.cron_expression && typeof config.cron_expression === 'string') {
      //   // Schedule recurring execution with PgBoss
      //   // const scheduleKey = `workflow-${templateId}-cron`
      //   await messageBoss.schedule(
      //     queueName,
      //     config.cron_expression,
      //     executionPacket,
      //     {
      //       tz: config.timezone || 'UTC'
      //     }
      //   )
        await messageQueue.publishExecution(executionPacket, undefined, config.cron_expression)
        console.log(`✅ Scheduled workflow ${templateId} with cron: ${config.cron_expression}`)
        return {"status":"success","message": `scheduled with cron ${config.cron_expression}`}
      }
      else {
        // No scheduling config found, send immediately
        await messageQueue.publishExecution(executionPacket)
        console.log(`✅ Started immediate execution for workflow ${templateId} (no cron config)`)
        return {"status":"success","message": `Started immediate execution for workflow ${templateId} (no cron config)`}
      }

    } catch (error) {
      console.error(`❌ Failed to handle active trigger for workflow ${templateId}:`, error)
      throw error
    }
  }
}