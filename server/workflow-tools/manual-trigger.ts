import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Manual trigger configuration schema
export const manualTriggerConfigSchema = z.object({
  title: z.string().default("Manual Trigger"),
  description: z.string().optional(),
  requireConfirmation: z.boolean().default(true),
  confirmationMessage: z.string().optional(),
  allowedUsers: z.array(z.string()).optional(), // User IDs or emails
  allowedRoles: z.array(z.string()).optional(), // Role names
})

// Manual trigger input schema
export const manualTriggerInputSchema = z.object({
  triggeredBy: z.string(), // User ID or email who triggered
  triggerReason: z.string().optional(),
  metadata: z.record(z.string(), z.any()).optional(),
})

// Manual trigger output schema
export const manualTriggerOutputSchema = z.object({
  triggeredAt: z.string(),
  triggeredBy: z.string(),
  triggerReason: z.string(),
  title: z.string(),
  description: z.string(),
  metadata: z.record(z.string(), z.any()),
})

export type ManualTriggerConfig = z.infer<typeof manualTriggerConfigSchema>
export type ManualTriggerInput = z.infer<typeof manualTriggerInputSchema>
export type ManualTriggerOutput = z.infer<typeof manualTriggerOutputSchema>

export class ManualTriggerTool implements WorkflowTool<ManualTriggerConfig, ManualTriggerInput, ManualTriggerOutput> {
  type = ToolType.MANUAL_TRIGGER
  category = ToolCategory.TRIGGER

  async execute(
    input: ManualTriggerInput,
    config: ManualTriggerConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<ManualTriggerOutput>> {
    try {
      // Check if user is allowed to trigger (behavior to be implemented later)
      const isAllowed = this.checkUserPermissions(input.triggeredBy, config)
      
      if (!isAllowed) {
        return {
          status: "error",
          result: {
            triggeredAt: new Date().toISOString(),
            triggeredBy: input.triggeredBy,
            triggerReason: "Access denied",
            title: config.title,
            description: config.description || "",
            metadata: input.metadata || {},
          } as ManualTriggerOutput,
        }
      }

      const output: ManualTriggerOutput = {
        triggeredAt: new Date().toISOString(),
        triggeredBy: input.triggeredBy,
        triggerReason: input.triggerReason || "Manual trigger executed",
        title: config.title,
        description: config.description || "",
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
          triggeredBy: input.triggeredBy,
          triggerReason: `Manual trigger failed: ${error instanceof Error ? error.message : String(error)}`,
          title: config.title,
          description: config.description || "",
          metadata: input.metadata || {},
        } as ManualTriggerOutput,
      }
    }
  }

  private checkUserPermissions(triggeredBy: string, config: ManualTriggerConfig): boolean {
    // Basic permission check - behavior to be implemented later
    if (config.allowedUsers && config.allowedUsers.length > 0) {
      return config.allowedUsers.includes(triggeredBy)
    }
    
    // If no specific users defined, allow all for now
    return true
  }

  validateInput(input: unknown): input is ManualTriggerInput {
    return manualTriggerInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is ManualTriggerConfig {
    return manualTriggerConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return manualTriggerInputSchema
  }

  getConfigSchema() {
    return manualTriggerConfigSchema
  }

  getDefaultConfig(): ManualTriggerConfig {
    return {
      title: "Manual Trigger",
      description: "Manually trigger this workflow",
      requireConfirmation: true,
      confirmationMessage: "Are you sure you want to trigger this workflow?",
    }
  }
}