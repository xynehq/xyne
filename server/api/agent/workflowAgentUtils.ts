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
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { GetDocumentsByDocIds } from "@/search/vespa" // Retrieve non-image attachments from Vespa
import { answerContextMap, cleanContext } from "@/ai/context"  // Transform Vespa results to text
import { VespaSearchResultsSchema } from "@/search/types"  // Type for Vespa results
import { getTracer, type Span } from "@/tracer"
import { createAgentSchema } from "@/api/agent"
import type { CreateAgentPayload } from "@/api/agent"
import { insertAgent } from "@/db/agent" 

const Logger = getLogger(Subsystem.Server)

export const executeAgentSchema = z.object({
  agentId: z.string().min(1, "Agent ID is required"),
  userQuery: z.string().min(1, "User query is required"),
  workspaceId: z.string().min(1, "Workspace ID is required"),
  userEmail: z.string().email("Valid email is required"),
  isStreamable: z.boolean().optional().default(false),
  temperature: z.number().min(0).max(2).optional(),
  max_new_tokens: z.number().positive().optional(),
  attachmentFileIds: z.array(z.string()).optional().default([]),        // For images: ["att_123", "att_456"]
  nonImageAttachmentFileIds: z.array(z.string()).optional().default([]), // For PDFs: ["att_789"]
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


/**
 * ExecuteAgentForWorkflow - Simplified agent execution function with attachment support
 * 
 * This function provides a simplified subset of AgentMessageApi functionality:
 * 1. Generate chat title and insert in DB
 * 2. Fetch agent details from agent table (includes model)
 * 3. Process attachments (images and documents)
 * 4. Call LLM directly with agent prompt + user query + attachments
 * 5. Return response (no reasoning loop, no RAG, no tools)
 */
export const ExecuteAgentForWorkflow = async (params: ExecuteAgentParams): Promise<ExecuteAgentResponse> => {
  try {
    // Validate parameters
    const validatedParams = executeAgentSchema.parse(params)
    const tracer = getTracer("executeAgent")
    const executeAgentSpan = tracer.startSpan('executeAgent')
    const {
      agentId,
      userQuery,
      isStreamable = true,
      temperature,
      max_new_tokens,
      workspaceId,
      userEmail,
      attachmentFileIds = [],
      nonImageAttachmentFileIds = [],
    } = validatedParams

    Logger.info(`🚀 executeAgent called with parameters:`)
    Logger.info(`   - agentId: ${agentId}`)
    Logger.info(`   - userEmail: ${userEmail}`)
    Logger.info(`   - workspaceId: ${workspaceId}`)
    Logger.info(`   - userQuery length: ${userQuery.length}`)
    Logger.info(`   - isStreamable: ${isStreamable}`)
    Logger.info(`   - attachmentFileIds: ${JSON.stringify(attachmentFileIds)}`)
    Logger.info(`   - nonImageAttachmentFileIds: ${JSON.stringify(nonImageAttachmentFileIds)}`)

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

    // ========================================
    // ATTACHMENT PROCESSING SECTION
    // ========================================

    let contextualContent = ""
    let finalImageFileNames: string[] = []

    Logger.info("🔍 Starting attachment processing...")
    Logger.info(`📎 Non-image attachments: ${JSON.stringify(nonImageAttachmentFileIds)}`)
    Logger.info(`🖼️ Image attachments: ${JSON.stringify(attachmentFileIds)}`)

    // Step 1: Handle Non-Image Attachments (PDFs, DOCX, etc.)
    if (nonImageAttachmentFileIds.length > 0) {
      Logger.info(`📄 Processing ${nonImageAttachmentFileIds.length} non-image attachments`)

      try {
        // Retrieve document content from Vespa (same as chat.ts:1974-1979)
        Logger.info(`🔍 Calling GetDocumentsByDocIds with IDs: ${JSON.stringify(nonImageAttachmentFileIds)}`)

        //fetching document from VESPA
        const results = await GetDocumentsByDocIds(nonImageAttachmentFileIds, executeAgentSpan!)

        Logger.info(`📊 GetDocumentsByDocIds returned:`, {
          hasRoot: !!results.root,
          hasChildren: !!(results.root?.children),
          childrenCount: results.root?.children?.length || 0,
        })

        if (results.root.children && results.root.children.length > 0) {
          Logger.info(`📚 Found ${results.root.children.length} documents, transforming to readable context...`)

          // Transform Vespa results to readable context (same as chat.ts:2054-2120)
          const contextPromises = results.root.children.map(async (v, i) => {
            Logger.info(`📖 Processing document ${i} with ID: ${v.id}`)

            const content = await answerContextMap(
              v as z.infer<typeof VespaSearchResultsSchema>,
              0,    // maxSummaryChunks (0 = include all chunks)
              true, // isSelectedFiles
            )

            Logger.info(`📝 Document ${i} processed, content length: ${content.length} characters`)
            return `Index ${i} \n ${content}`
          })

          const resolvedContexts = await Promise.all(contextPromises)
          contextualContent = cleanContext(resolvedContexts.join("\n"))

          Logger.info(`✅ Context building completed!`)
          Logger.info(`📏 Total context length: ${contextualContent.length} characters`)
          Logger.info(`📄 Context preview (first 200 chars): ${contextualContent.substring(0, 200)}...`)

        } else {
          Logger.warn("⚠️ No documents found in Vespa results")
        }

      } catch (error) {
        Logger.error(error, "❌ Error processing non-image attachments")
        // Continue execution even if attachment processing fails
      }
    } else {
      Logger.info("📄 No non-image attachments to process")
    }

    // Step 2: Handle Image Attachments 
    if (attachmentFileIds.length > 0) {
      Logger.info(`🖼️ Processing ${attachmentFileIds.length} image attachments`)

      // Transform attachment IDs to image file names (same as chat.ts:2127-2131)
      finalImageFileNames = attachmentFileIds.map((fileid, index) => {
        const imageName = `${index}_${fileid}_${0}`  // Format: "0_att_123_0"
        Logger.info(`🏷️ Transformed attachment ID "${fileid}" → image name "${imageName}"`)
        return imageName
      })

      Logger.info(`🖼️ Final image file names: ${JSON.stringify(finalImageFileNames)}`)
    } else {
      Logger.info("🖼️ No image attachments to process")
    }

    Logger.info("✅ Attachment processing completed!")
    Logger.info(`📊 Summary:`)
    Logger.info(`   - Context length: ${contextualContent.length} characters`)
    Logger.info(`   - Image files: ${finalImageFileNames.length}`)

    // ========================================
    // END ATTACHMENT PROCESSING SECTION
    // ========================================

    Logger.info("Generating chat title...")

    const titleResp = await generateTitleUsingQuery(userQuery, {
      modelId: agent.model as Models,
      stream: false,
    })
    const title = titleResp.title
    Logger.info(`Generated title: ${title}`)

    Logger.info("🔧 Building model parameters...")

    const modelParams = {
      modelId: agent.model as Models,
      stream: isStreamable,
      json: false,
      reasoning: false,
      systemPrompt: agent.prompt || "You are a helpful assistant.",

      // ADD IMAGE SUPPORT:
      ...(finalImageFileNames.length > 0 ? { imageFileNames: finalImageFileNames } : {}),

      ...(temperature !== undefined ? { temperature } : {}),
      ...(max_new_tokens !== undefined ? { max_new_tokens } : {}),
    }

    Logger.info("🔧 Model parameters built:", {
      modelId: modelParams.modelId,
      hasImages: !!(modelParams as any).imageFileNames,
      imageCount: ((modelParams as any).imageFileNames || []).length,
      systemPromptLength: modelParams.systemPrompt.length,
      hasTemperature: temperature !== undefined,
      hasMaxTokens: max_new_tokens !== undefined,
    })

    Logger.info("💬 Constructing LLM messages...")

    // UPDATE MESSAGE CONSTRUCTION TO INCLUDE CONTEXT:
    const userContent = contextualContent
      ? `Context from attached documents:\n${contextualContent}\n\nUser Query: ${userQuery}`  // Include document context
      : userQuery  // No context, just user query

    Logger.info("💬 Message construction details:", {
      hasContext: !!contextualContent,
      contextLength: contextualContent.length,
      userQueryLength: userQuery.length,
      finalContentLength: userContent.length,
    })

    Logger.info("💬 Final user content preview (first 300 chars):")
    Logger.info(userContent.substring(0, 300) + (userContent.length > 300 ? "..." : ""))

    const messages: Message[] = [
      {
        role: "user" as ConversationRole,
        content: [{ text: userContent }],  // User query + document context
      }
    ]

    Logger.info("💬 Messages array constructed with 1 user message")

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
      Logger.info("🌊 Agent execution started (streaming mode)")
      Logger.info("🌊 About to call LLM with attachments:", {
        hasImages: finalImageFileNames.length > 0,
        imageFiles: finalImageFileNames,
        hasContext: contextualContent.length > 0,
        contextLength: contextualContent.length,
      })

      // Add provider debugging
      const provider = getProviderByModel(agent.model as Models)
      Logger.info(`🤖 Provider for model ${agent.model}:`, typeof provider)

      try {
        Logger.info("🔄 Creating original iterator...")
        const originalIterator = provider.converseStream(messages, modelParams)
        Logger.info("🔄 Original iterator created, starting wrapper...")

        const wrappedIterator = createStreamingWithDBSave(originalIterator, {
          chatId: insertedChat.id,
          userId: user.id,
          chatExternalId: insertedChat.externalId,
          workspaceExternalId: workspaceId,
          email: userEmail,
          modelId: agent.model,
        })

        Logger.info("✅ Wrapper created successfully")

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
        Logger.error(providerError, "❌ Error creating streaming iterator")
        throw providerError
      }
    } else { 
      Logger.info("💫 Agent execution started (non-streaming mode)")
      Logger.info("💫 About to call LLM with attachments:", {
        hasImages: finalImageFileNames.length > 0,
        imageFiles: finalImageFileNames,
        hasContext: contextualContent.length > 0,
        contextLength: contextualContent.length,
      })

      // Get non-streaming response
      const response = await getProviderByModel(agent.model as Models).converse(
        messages,
        modelParams
      )

      Logger.info("💫 LLM response received:", {
        hasText: !!response.text,
        textLength: response.text?.length || 0,
        hasCost: !!response.cost,
        cost: response.cost,
      })

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

      Logger.info("✅ Agent execution completed successfully (non-streaming)")

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


  Logger.info("🌊 createStreamingWithDBSave: Starting...")
  let answer = ""
  let costArr: number[] = []
  let tokenArr: { inputTokens: number; outputTokens: number }[] = []
  let wasStreamClosedPrematurely = false

  try {
    Logger.info("🌊 createStreamingWithDBSave: About to start for-await loop...")

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


//this function will be used to be called by workflow feature
export const createAgentHelperInWorkflow = async (
  agentData: CreateAgentPayload,
  userId: number,
  workspaceId: number
): Promise<SelectAgent> => {
  try {
    const validatedBody = createAgentSchema.parse(agentData)

    const agentDataForInsert = {
      name: validatedBody.name,
      description: validatedBody.description,
      prompt: validatedBody.prompt,
      model: validatedBody.model,
      isPublic: validatedBody.isPublic,
      appIntegrations: validatedBody.appIntegrations,
      allowWebSearch: validatedBody.allowWebSearch,
      isRagOn: validatedBody.isRagOn,
      uploadedFileNames: validatedBody.uploadedFileNames,
      docIds: validatedBody.docIds,
    }

    const newAgent = await db.transaction(async (tx) => {
      return await insertAgent(tx, agentDataForInsert, userId, workspaceId)
    })

    return newAgent
  } catch (error) {
    // Re-throw validation errors as-is for the caller to handle
    // Logger.error(error, `Failed to create agent: ${getErrorMessage(error)}`)
    if (error instanceof z.ZodError) {
      throw error
    }

    // Wrap other errors with more context
    const errMsg = getErrorMessage(error)
    throw new Error(`Failed to create agent: ${errMsg}`)
  }
}