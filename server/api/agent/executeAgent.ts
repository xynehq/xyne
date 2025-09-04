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
import { getUserAndWorkspaceByEmail } from "@/db/user"

const Logger = getLogger(Subsystem.Server)


export const executeAgentSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  userQuery: z.string().min(1, "User query is required"),
  workspaceId: z.string().min(1, "Workspace ID is required"),
  userEmail: z.string().email("Valid email is required"),
  isStreamable: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_new_tokens: z.number().positive().optional(),
})

export type ExecuteAgentParams = z.infer<typeof executeAgentSchema>


type ExecuteAgentSuccess = {
  success: true
  chatId: string
  title: string
  agentName: string
  modelId: string
}

type StreamingExecuteAgentResponse = ExecuteAgentSuccess & {
  type: 'streaming'
  iterator: AsyncIterableIterator<ConverseResponse>
}

type NonStreamingExecuteAgentResponse = ExecuteAgentSuccess & {
  type: 'non-streaming'
  response: ConverseResponse
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





async function* createStreamingWithDBSave(
  originalIterator: AsyncIterableIterator<ConverseResponse>,
  dbSaveParams: {
    chatId: number
    userId: number
    chatExternalId: string
    workspaceExternalId: string
    email: string
    modelId: string
  }
): AsyncIterableIterator<ConverseResponse> {

  // Same accumulation pattern as AgentMessageApi
  Logger.info("🌊 createStreamingWithDBSave: Starting...")
  let answer = ""
  let costArr: number[] = []
  let tokenArr: { inputTokens: number; outputTokens: number }[] = []
  let wasStreamClosedPrematurely = false

  try {
    Logger.info("🌊 createStreamingWithDBSave: About to start for-await loop...")
    // Forward chunks while accumulating (same as AgentMessageApi)
    for await (const chunk of originalIterator) {
      if (chunk.text) {
        answer += chunk.text  // Accumulate full response
        yield { text: chunk.text }  // Forward to client
      }
      Logger.info("🌊 createStreamingWithDBSave: Forwarded chunk to client:", chunk.text)

      if (chunk.cost) {
        costArr.push(chunk.cost)  // Accumulate costs
        yield { cost: chunk.cost }
      }

      if (chunk.metadata?.usage) {
        tokenArr.push({  // Accumulate token usage
          inputTokens: chunk.metadata.usage.inputTokens,
          outputTokens: chunk.metadata.usage.outputTokens,
        })
        yield { metadata: chunk.metadata }
      }
    }


    Logger.info("🌊 createStreamingWithDBSave: Iterator completed, saving to DB...")

    // Save to DB after stream completes (same pattern as AgentMessageApi)
    if (answer || wasStreamClosedPrematurely) {
      const totalCost = costArr.reduce((sum, cost) => sum + cost, 0)
      const totalTokens = tokenArr.reduce(
        (sum, tokens) => sum + tokens.inputTokens + tokens.outputTokens,
        0,
      )

      // Save assistant message to database
      await insertMessage(db, {
        chatId: dbSaveParams.chatId,
        userId: dbSaveParams.userId,
        chatExternalId: dbSaveParams.chatExternalId,
        workspaceExternalId: dbSaveParams.workspaceExternalId,
        messageRole: MessageRole.Assistant,
        email: dbSaveParams.email,
        sources: [],
        message: answer,  // Full accumulated text
        modelId: dbSaveParams.modelId,
        cost: totalCost.toString(),
        tokensUsed: totalTokens,
      })

      Logger.info("Assistant message saved to database after streaming")
    }

  } catch (error) {
    Logger.error(error, "Error during streaming or DB save")
    throw error
  }
}


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
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      userEmail,
    )
    const { user, workspace } = userAndWorkspace
    Logger.info(`Fetched user: ${user.id} and workspace: ${workspace.id}`)

    Logger.info(`Fetching agent details for ${agentId}...`)
    const agent = await getAgentByExternalId(db, agentId, Number(workspace.id))

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


    Logger.info("Generating chat title...")

    const titleResp = await generateTitleUsingQuery(userQuery, {
      modelId: agent.model as Models,
      stream: false,
    })
    const title = titleResp.title
    Logger.info(`Generated title: ${title}`)


    const modelParams = {
      modelId: agent.model as Models,
      stream: isStreamable,
      json: false,
      reasoning: false,
      systemPrompt: agent.prompt || "You are a helpful assistant.",
      ...(temperature && { temperature }),
      ...(max_new_tokens && { max_new_tokens }),
    }

    const messages: Message[] = [
      {
        role: "user" as ConversationRole,
        content: [{ text: userQuery }],
      }
    ]

    Logger.info(`Calling LLM with model ${agent.model}...`)


    const insertedChat = await insertChat(db, {
      workspaceId: workspace.id,
      workspaceExternalId: workspaceId,
      userId: user.id,
      email: userEmail,
      title,
      attachments: [],
      agentId: agent.externalId,
    })

    await insertMessage(db, {
      chatId: insertedChat.id,
      userId: user.id,
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
      Logger.info("Agent execution started (streaming............)")

      // Add provider debugging
      const provider = getProviderByModel(agent.model as Models)
      Logger.info(`Provider for model ${agent.model}:`, typeof provider)

      try {
        Logger.info("Creating original iterator...")
        const originalIterator = provider.converseStream(messages, modelParams)
        Logger.info("Original iterator created, starting wrapper...")

        const wrappedIterator = createStreamingWithDBSave(originalIterator, {
          chatId: insertedChat.id,
          userId: user.id,
          chatExternalId: insertedChat.externalId,
          workspaceExternalId: workspaceId,
          email: userEmail,
          modelId: agent.model,
        })

        Logger.info("Wrapper created successfully")

        return {
          success: true,
          type: 'streaming',
          iterator: wrappedIterator,
          chatId: insertedChat.externalId,
          title,
          agentName: agent.name,
          modelId: agent.model,
        }
      } catch (providerError) {
        Logger.error(providerError, "Error creating streaming iterator")
        throw providerError
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


      await insertMessage(db, {
        chatId: insertedChat.id,
        userId: user.id,
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
        response: response,
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