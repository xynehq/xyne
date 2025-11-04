import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// Agent tool configuration schema (legacy - similar to AI_AGENT but simpler)
export const agentConfigSchema = z.object({
  agentName: z.string().default("Generic Agent"),
  model: z.string().default("gpt-4o"),
  systemPrompt: z.string().default("You are a helpful assistant"),
  temperature: z.number().min(0).max(2).default(0.7),
  maxTokens: z.number().optional(),
  inputSource: z.enum(["direct", "previous_step"]).default("previous_step"),
})

// Agent tool input schema
export const agentInputSchema = z.object({
  query: z.string().optional(),
  systemPromptOverride: z.string().optional(),
  temperatureOverride: z.number().min(0).max(2).optional(),
  context: z.record(z.string(), z.any()).optional(),
})

// Agent tool output schema
export const agentOutputSchema = z.object({
  response: z.string(),
  model: z.string(),
  tokensUsed: z.number().optional(),
  processingTime: z.number(), // in milliseconds
  agentName: z.string(),
  completedAt: z.string(),
})

export type AgentConfig = z.infer<typeof agentConfigSchema>
export type AgentInput = z.infer<typeof agentInputSchema>
export type AgentOutput = z.infer<typeof agentOutputSchema>

export class AgentTool implements WorkflowTool<AgentConfig, AgentInput, AgentOutput> {
  type = ToolType.AGENT
  category = ToolCategory.ACTION

  async execute(
    input: AgentInput,
    config: AgentConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<AgentOutput>> {
    const startTime = Date.now()

    try {
      // Determine the query to process
      let queryText = input.query || ""

      if (!queryText && config.inputSource === "previous_step") {
        // Extract content from previous step
        const stepKeys = Object.keys(context.previousStepResults || {})
        if (stepKeys.length > 0) {
          const latestStepKey = stepKeys[stepKeys.length - 1]
          const latestStepResult = context.previousStepResults![latestStepKey]
          
          queryText = latestStepResult?.result?.content ||
            latestStepResult?.result?.output ||
            latestStepResult?.result?.aiOutput ||
            JSON.stringify(latestStepResult?.result || {})
        }
      }

      if (!queryText) {
        queryText = "No input provided"
      }

      // Use system prompt (with possible override)
      const systemPrompt = input.systemPromptOverride || config.systemPrompt
      const temperature = input.temperatureOverride ?? config.temperature

      // Simulate AI processing (in real implementation, this would call an AI service)
      // For now, we'll create a mock response
      const mockResponse = `${config.agentName} processed the following input: "${queryText.substring(0, 100)}${queryText.length > 100 ? '...' : ''}"`

      const processingTime = Date.now() - startTime

      const output: AgentOutput = {
        response: mockResponse,
        model: config.model,
        tokensUsed: queryText.length + mockResponse.length, // Rough estimate
        processingTime,
        agentName: config.agentName,
        completedAt: new Date().toISOString(),
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      const processingTime = Date.now() - startTime

      return {
        status: "error",
        result: {
          response: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
          model: config.model,
          tokensUsed: 0,
          processingTime,
          agentName: config.agentName,
          completedAt: new Date().toISOString(),
        } as AgentOutput,
      }
    }
  }

  validateInput(input: unknown): input is AgentInput {
    return agentInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is AgentConfig {
    return agentConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return agentInputSchema
  }

  getConfigSchema() {
    return agentConfigSchema
  }

  getDefaultConfig(): AgentConfig {
    return {
      agentName: "Generic Agent",
      model: "gpt-4o",
      systemPrompt: "You are a helpful assistant",
      temperature: 0.7,
      inputSource: "previous_step",
    }
  }
}