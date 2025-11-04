import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Scheduler trigger configuration schema
export const schedulerTriggerConfigSchema = z.object({
  scheduleType: z.enum(["cron", "interval", "once"]).default("once"),
  cronExpression: z.string().optional(), // For cron-based scheduling
  intervalMinutes: z.number().min(1).optional(), // For interval-based scheduling
  scheduledAt: z.string().optional(), // ISO datetime for one-time scheduling
  timezone: z.string().default("UTC"),
  enabled: z.boolean().default(true),
  maxExecutions: z.number().optional(), // Max number of executions (for interval/cron)
  description: z.string().optional(),
})

// Scheduler trigger input schema
export const schedulerTriggerInputSchema = z.object({
  triggeredAt: z.string().optional(), // ISO datetime when trigger was activated
  executionCount: z.number().default(0),
  lastExecutionAt: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

// Scheduler trigger output schema
export const schedulerTriggerOutputSchema = z.object({
  triggeredAt: z.string(),
  scheduleType: z.string(),
  nextExecutionAt: z.string().optional(),
  executionCount: z.number(),
  maxExecutions: z.number().optional(),
  isLastExecution: z.boolean(),
  timezone: z.string(),
  metadata: z.record(z.string(), z.any()),
})

export type SchedulerTriggerConfig = z.infer<typeof schedulerTriggerConfigSchema>
export type SchedulerTriggerInput = z.infer<typeof schedulerTriggerInputSchema>
export type SchedulerTriggerOutput = z.infer<typeof schedulerTriggerOutputSchema>

export class SchedulerTriggerTool implements WorkflowTool<SchedulerTriggerConfig, SchedulerTriggerInput, SchedulerTriggerOutput> {
  type = ToolType.SCHEDULER_TRIGGER
  category = ToolCategory.TRIGGER

  async execute(
    input: SchedulerTriggerInput,
    config: SchedulerTriggerConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<SchedulerTriggerOutput>> {
    try {
      if (!config.enabled) {
        return {
          status: "error",
          result: {
            triggeredAt: new Date().toISOString(),
            scheduleType: config.scheduleType,
            executionCount: input.executionCount,
            isLastExecution: true,
            timezone: config.timezone,
            metadata: input.metadata || {},
          } as SchedulerTriggerOutput,
        }
      }

      const currentTime = new Date()
      const executionCount = input.executionCount + 1
      
      // Check if max executions reached
      const isLastExecution = config.maxExecutions 
        ? executionCount >= config.maxExecutions 
        : config.scheduleType === "once"

      // Calculate next execution time (behavior to be implemented later)
      const nextExecutionAt = isLastExecution 
        ? undefined 
        : this.calculateNextExecution(config, currentTime)

      const output: SchedulerTriggerOutput = {
        triggeredAt: currentTime.toISOString(),
        scheduleType: config.scheduleType,
        nextExecutionAt,
        executionCount,
        maxExecutions: config.maxExecutions,
        isLastExecution,
        timezone: config.timezone,
        metadata: input.metadata || {},
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          triggeredAt: new Date().toISOString(),
          scheduleType: config.scheduleType,
          executionCount: input.executionCount,
          isLastExecution: true,
          timezone: config.timezone,
          metadata: { error: error instanceof Error ? error.message : String(error) },
        } as SchedulerTriggerOutput,
      }
    }
  }

  private calculateNextExecution(config: SchedulerTriggerConfig, currentTime: Date): string | undefined {
    // Basic implementation - behavior to be enhanced later
    switch (config.scheduleType) {
      case "interval":
        if (config.intervalMinutes) {
          const nextTime = new Date(currentTime.getTime() + config.intervalMinutes * 60 * 1000)
          return nextTime.toISOString()
        }
        break
      case "cron":
        // Cron parsing to be implemented later
        return new Date(currentTime.getTime() + 24 * 60 * 60 * 1000).toISOString() // Default to 24 hours
      case "once":
        return undefined
    }
    return undefined
  }

  validateInput(input: unknown): input is SchedulerTriggerInput {
    return schedulerTriggerInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is SchedulerTriggerConfig {
    return schedulerTriggerConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return schedulerTriggerInputSchema
  }

  getConfigSchema() {
    return schedulerTriggerConfigSchema
  }

  getDefaultConfig(): SchedulerTriggerConfig {
    return {
      scheduleType: "once",
      timezone: "UTC",
      enabled: true,
      description: "Schedule workflow execution",
    }
  }
}