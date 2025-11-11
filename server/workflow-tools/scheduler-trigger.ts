import { ToolType, ToolCategory, ToolExecutionStatus } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionResult, WorkflowContext, defaultToolConfig} from "./types"
import { optional, z } from "zod"
import { messageQueue, type ExecutionRequest } from "@/execution-engine/message-queue"  
import type { SelectWorkflowTemplate } from "@/db/schema/workflows"
export class SchedulerTriggerTool implements WorkflowTool {
  type = ToolType.SCHEDULER_TRIGGER
  category = ToolCategory.TRIGGER
  defaultConfig: defaultToolConfig = {
    inputCount : 0,
    outputCount : 1,
    options:{
      trigger_after_seconds: {
        type: "number",
        default: 60,
        optional: true,
      },
      trigger_at: {
        type: "string",
        default: new Date().toISOString(),
        optional: true,
      },
      cron_expression: {
        type: "string",
        default: "",
        optional: true,
      },
      timezone: {
        type: "string",
        default: "UTC",
        optional: true,
      },
    }
  }
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

      return {
        status: ToolExecutionStatus.COMPLETED,
        output: {
          triggeredAt: currentTime.toISOString(),
          count:30
        },
        metadata: scheduleMetadata
      }
    } catch (error) {
      return {
        status: ToolExecutionStatus.FAILED,
        output: {
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

  // Handler for active trigger - called when template is activated
  async handleActiveTrigger(config: Record<string, any>, template:SelectWorkflowTemplate): Promise<Record<string, string>> {
    try {
      // Create execution packet for starting workflow
      const executionPacket:ExecutionRequest = {
          templateId: template.id,
          userId: template.userId, // TODO: Get from context
          workspaceId: template.workspaceId // TODO: Get from context
      }

      // // Check if cron expression exists
      if (config.cron_expression && typeof config.cron_expression === 'string') {
        await messageQueue.publishExecution(executionPacket, undefined, config.cron_expression)
        console.log(`✅ Scheduled workflow ${template.id} with cron: ${config.cron_expression}`)
        return {"status":"success","message": `scheduled with cron ${config.cron_expression}`}
      }
      else {
        // No scheduling config found, send immediately
        await messageQueue.publishExecution(executionPacket)
        console.log(`✅ Started immediate execution for workflow ${template.id} (no cron config)`)
        return {"status":"success","message": `Started immediate execution for workflow ${template.id} (no cron config)`}
      }

    } catch (error) {
      console.error(`❌ Failed to handle active trigger for workflow ${template.id}:`, error)
      throw error
    }
  }

    async handleInactiveTrigger(_config: Record<string, any>, template:SelectWorkflowTemplate): Promise<Record<string, string>> {
      try {
        const boss = messageQueue.getBoss()
        const queues = messageQueue.getQueueNames()
        await boss.unschedule(queues.incoming,template.id)
        return {"status":"success","message": `Unschedule workflow ${template.id} from ${queues.incoming}` }
      } catch (error) {
        console.error(`❌ Failed to handle inactive trigger for workflow ${template.id}:`, error)
        throw error
      }
  }

}
