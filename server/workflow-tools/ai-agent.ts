import { z } from "zod"
import { ToolType, ToolCategory } from "@/types/workflowTypes"
import type { WorkflowTool, ToolExecutionContext, ToolExecutionResult } from "./types"

// AI Agent tool configuration schema
export const aiAgentConfigSchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().optional(),
  inputType: z.enum(["form", "text", "previous_step"]).default("form"),
  temperature: z.number().min(0).max(2).default(0.7),
  modelId: z.string().default("gpt-4o"),
  isExistingAgent: z.boolean().default(false),
  dynamicallyCreated: z.boolean().default(false),
  agentCreationFailed: z.boolean().optional(),
  agentCreationError: z.string().optional(),
})

// AI Agent tool input schema
export const aiAgentInputSchema = z.object({
  prompt: z.string().optional(),
  systemPrompt: z.string().optional(),
  userQuery: z.string().optional(),
  formData: z.record(z.string(), z.any()).optional(),
  attachmentFileIds: z.array(z.string()).default([]),
  nonImageAttachmentFileIds: z.array(z.string()).default([]),
  previousStepContent: z.any().optional(),
})

// AI Agent tool output schema
export const aiAgentOutputSchema = z.object({
  aiOutput: z.string(),
  agentName: z.string(),
  model: z.string(),
  inputType: z.string(),
  processedAt: z.string(),
  chatId: z.string().nullable(),
  attachmentsProcessed: z.object({
    images: z.number(),
    documents: z.number(),
  }).optional(),
})

export type AiAgentConfig = z.infer<typeof aiAgentConfigSchema>
export type AiAgentInput = z.infer<typeof aiAgentInputSchema>
export type AiAgentOutput = z.infer<typeof aiAgentOutputSchema>

// Helper function to extract attachment IDs from form data
const extractAttachmentIds = (formData: Record<string, any>): {
  imageAttachmentIds: string[]
  documentAttachmentIds: string[]
} => {
  const imageIds: string[] = []
  const documentIds: string[] = []

  Object.entries(formData).forEach(([key, file]) => {
    if (file &&
      typeof file === 'object' &&
      file !== null &&
      'attachmentId' in file &&
      file.attachmentId) {

      if ('attachmentMetadata' in file && file.attachmentMetadata) {
        const metadata = file.attachmentMetadata
        if (metadata.isImage) {
          imageIds.push(file.attachmentId)
        } else {
          documentIds.push(file.attachmentId)
        }
      } else {
        // Fallback: assume non-image if no metadata
        documentIds.push(file.attachmentId)
      }
    }
  })

  return { imageAttachmentIds: imageIds, documentAttachmentIds: documentIds }
}

export class AiAgentTool implements WorkflowTool<AiAgentConfig, AiAgentInput, AiAgentOutput> {
  type = ToolType.AI_AGENT
  category = ToolCategory.ACTION

  async execute(
    input: AiAgentInput,
    config: AiAgentConfig,
    context: ToolExecutionContext
  ): Promise<ToolExecutionResult<AiAgentOutput>> {
    try {
      if (!config.agentId) {
        return {
          status: "error",
          result: {
            aiOutput: "No agent ID configured for this AI agent tool",
            agentName: config.agentName || "Unknown Agent",
            model: config.modelId || "gpt-4o",
            inputType: config.inputType || "text",
            processedAt: new Date().toISOString(),
            chatId: null,
          } as AiAgentOutput,
        }
      }

      // Extract agent parameters with dynamic values
      const prompt = input.prompt || input.systemPrompt || "Please analyze the provided content"
      const temperature = config.temperature || 0.7
      const workspaceId = context.workspaceId
      const userEmail = context.userEmail

      // Process input content based on input type
      let userQuery = ""
      let imageAttachmentIds: string[] = input.attachmentFileIds || []
      let documentAttachmentIds: string[] = input.nonImageAttachmentFileIds || []

      if (config.inputType === "form") {
        // Extract form data from input or previous step
        let formData = input.formData || {}
        
        if (!formData || Object.keys(formData).length === 0) {
          // Try to get form data from previous step results
          const stepKeys = Object.keys(context.previousStepResults || {})
          if (stepKeys.length > 0) {
            const latestStepKey = stepKeys[stepKeys.length - 1]
            const prevStepData = context.previousStepResults![latestStepKey]

            formData = prevStepData?.formSubmission?.formData ||
              prevStepData?.result?.formData ||
              prevStepData?.toolExecution?.result?.formData ||
              {}
          }
        }

        const extractedIds = extractAttachmentIds(formData)
        imageAttachmentIds = [...imageAttachmentIds, ...extractedIds.imageAttachmentIds]
        documentAttachmentIds = [...documentAttachmentIds, ...extractedIds.documentAttachmentIds]

        // Process text fields
        const textFields = Object.entries(formData)
          .filter(([key, value]) => typeof value === "string")
          .map(([key, value]) => `${key}: ${value}`)
          .join("\n")

        userQuery = `${prompt}\n\nForm Data:\n${textFields}`
      } else if (config.inputType === "previous_step") {
        const stepKeys = Object.keys(context.previousStepResults || {})
        if (stepKeys.length > 0) {
          const latestStepKey = stepKeys[stepKeys.length - 1]
          const prevStepData = context.previousStepResults![latestStepKey]
          const content = prevStepData?.result?.output ||
            prevStepData?.result?.content ||
            JSON.stringify(prevStepData?.result || {})
          userQuery = `${prompt}\n\nContent to analyze:\n${content}`
        } else {
          userQuery = prompt
        }
      } else {
        // Text input type
        userQuery = input.userQuery || prompt
      }

      // Import and execute agent
      const { executeAgentForWorkflowWithRag } = await import("@/api/agent/workflowAgentUtils")

      const fullResult = await executeAgentForWorkflowWithRag({
        agentId: config.agentId,
        userQuery,
        userEmail,
        workspaceId,
        isStreamable: false,
        temperature,
        attachmentFileIds: imageAttachmentIds,
        nonImageAttachmentFileIds: documentAttachmentIds,
      })

      if (!fullResult.success) {
        return {
          status: "error",
          result: {
            aiOutput: `Agent execution failed: ${fullResult.error}`,
            agentName: config.agentName || "Unknown Agent",
            model: config.modelId || "gpt-4o",
            inputType: config.inputType || "text",
            processedAt: new Date().toISOString(),
            chatId: null,
          } as AiAgentOutput,
        }
      }

      const output: AiAgentOutput = {
        aiOutput: fullResult.response,
        agentName: config.agentName ?? "Unknown Agent",
        model: config.modelId ?? "gpt-4o",
        inputType: config.inputType ?? "text",
        processedAt: new Date().toISOString(),
        chatId: null,
        attachmentsProcessed: {
          images: imageAttachmentIds.length,
          documents: documentAttachmentIds.length,
        },
      }

      return {
        status: "success",
        result: output,
      }
    } catch (error) {
      return {
        status: "error",
        result: {
          aiOutput: `Agent execution failed: ${error instanceof Error ? error.message : String(error)}`,
          agentName: config.agentName || "Unknown Agent",
          model: config.modelId || "gpt-4o",
          inputType: config.inputType || "text",
          processedAt: new Date().toISOString(),
          chatId: null,
        } as AiAgentOutput,
      }
    }
  }

  validateInput(input: unknown): input is AiAgentInput {
    return aiAgentInputSchema.safeParse(input).success
  }

  validateConfig(config: unknown): config is AiAgentConfig {
    return aiAgentConfigSchema.safeParse(config).success
  }

  getInputSchema() {
    return aiAgentInputSchema
  }

  getConfigSchema() {
    return aiAgentConfigSchema
  }

  getDefaultConfig(): AiAgentConfig {
    return {
      agentId: "",
      inputType: "form",
      temperature: 0.7,
      modelId: "gpt-4o",
      isExistingAgent: false,
      dynamicallyCreated: false,
    }
  }
}