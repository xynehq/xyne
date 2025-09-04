import { z } from "zod"
import { db } from "@/db/client"
import { getAgentByExternalId, type SelectAgent } from "@/db/agent"
import { generateTitleUsingQuery, getProviderByModel } from "@/ai/provider"
import { insertChat } from "@/db/chat"
import { insertMessage } from "@/db/message"
import { Models, type ConverseResponse } from "@/ai/types"
import { getLogger } from "@/logger"
import { getErrorMessage } from "@/utils"
import type { Message, ConversationRole } from "@aws-sdk/client-bedrock-runtime"
import { Subsystem, MessageRole } from "@/types"
import { ragPipelineConfig, RagPipelineStages } from "../chat/types"

const Logger = getLogger(Subsystem.Server)

// Simplified schema - no modelId (we get it from agent)
export const executeAgentSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  userQuery: z.string().min(1, "User query is required"),
  isStreamable: z.boolean().optional().default(true),
  temperature: z.number().min(0).max(2).optional(),
  max_new_tokens: z.number().positive().optional(),
  workspaceId: z.string().min(1, "Workspace ID is required"),
  userEmail: z.string().email("Valid email is required"),
})

export type ExecuteAgentParams = z.infer<typeof executeAgentSchema>

// Reuse existing types instead of creating new ones
type ExecuteAgentSuccess = {
  success: true
  chatId: string
  title: string
  agentName: string
  modelId: string
}

type StreamingExecuteAgentResponse = ExecuteAgentSuccess & {
  type: 'streaming'
  iterator: AsyncIterableIterator<ConverseResponse>  // Reuse existing ConverseResponse
}

type NonStreamingExecuteAgentResponse = ExecuteAgentSuccess & {
  type: 'non-streaming'
  response: ConverseResponse  // Reuse existing ConverseResponse
}

type ExecuteAgentErrorResponse = {
  success: false
  error: string
  details?: any
}

export type ExecuteAgentResponse =
  | StreamingExecuteAgentResponse
  | NonStreamingExecuteAgentResponse
  | ExecuteAgentErrorResponse

/**
 * ExecuteAgent - Simplified agent execution function
 * 
 * This function provides a simplified subset of AgentMessageApi functionality:
 * 1. Generate chat title and insert in DB
 * 2. Fetch agent details from agent table (includes model)
 * 3. Call LLM directly with agent prompt + user query
 * 4. Return response (no reasoning loop, no RAG, no tools)
 */
export const executeAgent = async (params: ExecuteAgentParams): Promise<ExecuteAgentResponse> => {
  try {
    // Validate parameters
    const validatedParams = executeAgentSchema.parse(params)

    const {
      agentId,
      userQuery,
      isStreamable = true,
      temperature,
      max_new_tokens,
      workspaceId,
      userEmail,
    } = validatedParams

    Logger.info(`Executing agent ${agentId} for user ${userEmail}`)

    // Step 1: Fetch agent details (including model)
    Logger.info(`Fetching agent details for ${agentId}...`)
    const agent = await getAgentByExternalId(db, agentId, 1) // Using 1 as placeholder workspace

    if (!agent) {
      return {
        success: false,
        error: `Agent with ID ${agentId} not found`
      }
    }

    if (!agent.model) {
      return {
        success: false,
        error: `Agent ${agentId} has no model configured`
      }
    }

    Logger.info(`Found agent: ${agent.name} with model: ${agent.model}`)

    // Step 2: Generate chat title using agent's model (not pipeline config)
    Logger.info("Generating chat title...")
    //  const titleResp = await generateTitleUsingQuery(userQuery, {
    //          modelId: ragPipelineConfig[RagPipelineStages.NewChatTitle].modelId,
    //          stream: false,
    //        })

    const titleResp = await generateTitleUsingQuery(userQuery, {
      modelId: agent.model as Models,
      stream: false,
    })
    const title = titleResp.title
    Logger.info(`Generated title: ${title}`)

    // Step 3: Prepare model parameters
    const modelParams = {
      modelId: agent.model as Models,
      stream: isStreamable,
      json: false,
      reasoning: false,
      systemPrompt: agent.prompt || "You are a helpful assistant.",
      ...(temperature && { temperature }),
      ...(max_new_tokens && { max_new_tokens }),
    }

    // Step 4: Prepare messages for LLM
    const messages: Message[] = [
      {
        role: "user" as ConversationRole,
        content: [{ text: userQuery }],
      }
    ]

    Logger.info(`Calling LLM with model ${agent.model}...`)

    // Step 5: Create chat and initial user message in DB
    const insertedChat = await insertChat(db, {
      workspaceId: 1, // Placeholder
      workspaceExternalId: workspaceId,
      userId: 1, // Placeholder
      email: userEmail,
      title,
      attachments: [],
      agentId: agent.externalId,
    })

    await insertMessage(db, {
      chatId: insertedChat.id,
      userId: 1,
      chatExternalId: insertedChat.externalId,
      workspaceExternalId: workspaceId,
      messageRole: MessageRole.User,
      email: userEmail,
      sources: [],
      message: userQuery,
      modelId: agent.model,
    })

    // Step 6: Call LLM and return based on streaming preference
    if (isStreamable) {
      // Return streaming iterator
      const responseIterator = getProviderByModel(agent.model as Models).converseStream(
        messages,
        modelParams
      )

      return {
        success: true,
        type: 'streaming',
        iterator: responseIterator,
        chatId: insertedChat.externalId,
        title,
        agentName: agent.name,
        modelId: agent.model,
      }
    } else {
      // Get non-streaming response
      const response = await getProviderByModel(agent.model as Models).converse(
        messages,
        modelParams
      )

      if (!response.text) {
        return {
          success: false,
          error: "No response received from LLM"
        }
      }

      // Insert assistant message
      await insertMessage(db, {
        chatId: insertedChat.id,
        userId: 1,
        chatExternalId: insertedChat.externalId,
        workspaceExternalId: workspaceId,
        messageRole: MessageRole.Assistant,
        email: userEmail,
        sources: [],
        message: response.text,
        modelId: agent.model,
        cost: response.cost?.toString(),
      })

      Logger.info("Agent execution completed successfully (non-streaming)")

      return {
        success: true,
        type: 'non-streaming',
        chatId: insertedChat.externalId,
        title,
        response: response,  // Return full ConverseResponse object
        agentName: agent.name,
        modelId: agent.model,
      }
    }

  } catch (error) {
    Logger.error(error, "Error in executeAgent")

    if (error instanceof z.ZodError) {
      return {
        success: false,
        error: "Invalid request parameters",
        details: error.flatten().fieldErrors,
      }
    }

    return {
      success: false,
      error: getErrorMessage(error),
    }
  }
}