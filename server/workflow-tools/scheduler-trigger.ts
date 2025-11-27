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

  async execute(
    input: Record<string, any>,
    config: Record<string, any>,
    workflowContext: WorkflowContext
  ): Promise<ToolExecutionResult> {
    try {
      const currentTime = new Date()
      
      // Process scheduling configuration keys (if-else chain, first match wins)
      let nextExecuteAfter: number | undefined
      
      // Handle trigger_after_seconds - convert to timestamp
      if (config.trigger_after_seconds && typeof config.trigger_after_seconds === 'number') {
        nextExecuteAfter = config.trigger_after_seconds
      } 
      // Handle trigger_at - parse as timestamp  
      else if (config.trigger_at) {
        try {
          const triggerAtDate = new Date(config.trigger_at)
          if (!isNaN(triggerAtDate.getTime())) {
            nextExecuteAfter = Math.max(0, Math.floor((triggerAtDate.getTime() - currentTime.getTime()) / 1000))
          }
        } catch (error) {
          // Invalid trigger_at, continue to next option
        }
      }
      // Handle cron_expression - calculate next execution time
      else if (config.cron_expression && typeof config.cron_expression === 'string') {
        nextExecuteAfter = 0
      }

      return {
        status: ToolExecutionStatus.COMPLETED,
        output: {
          triggeredAt: currentTime.toISOString(),
          scheduleType: config.cron_expression ? "cron" : config.trigger_at ? "timestamp" : "interval",
          nextExecutionAt: nextExecuteAfter ? new Date(currentTime.getTime() + nextExecuteAfter * 1000).toISOString() : undefined,
          cronExpression: config.cron_expression || undefined
        },
        nextExecuteAfter
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
        await messageQueue.schedule(executionPacket, config.cron_expression)
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
        await messageQueue.unschedule(template.id)
        return {"status":"success","message": `Unschedule workflow ${template.id}` }
      } catch (error) {
        console.error(`❌ Failed to handle inactive trigger for workflow ${template.id}:`, error)
        throw error
      }
  }

}
