import { z } from "zod"
import { db } from "@/db/client"
import { getAgentByExternalIdWithPermissionCheck, type SelectAgent } from "@/db/agent"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { getLogger } from "@/logger"
import { Subsystem, type UserMetadataType } from "@/types"
import { getErrorMessage } from "@/utils"
import { getTracer } from "@/tracer"
import { getDateForAI } from "@/utils/index"
import { GetDocumentsByDocIds } from "@/search/vespa"
import { answerContextMap, cleanContext } from "@/ai/context" // Transform Vespa results to text
import { VespaSearchResultsSchema } from "@xyne/vespa-ts/types" // Type for Vespa results
import { ExecuteAgentForWorkflow } from "./workflowAgentUtils"
import {  UnderstandMessageAndAnswer } from "@/api/chat/chat"
import { agentWithNoIntegrationsQuestion } from "@/ai/provider"
import type { Citation, ImageCitation } from "@/shared/types"
import type { Models } from "@/ai/types"

import { generateSearchQueryOrAnswerFromConversation } from "@/ai/provider"
import { jsonParseLLMOutput } from "@/ai/provider"
import config from "@/config"
const {
    defaultBestModel,
    defaultFastModel,
    maxDefaultSummary,
    isReasoning,
    StartThinkingToken,
    EndThinkingToken,
    maxValidLinks,
} = config
import type { QueryRouterLLMResponse } from "@/ai/types"



const Logger = getLogger(Subsystem.Server)

/**
 * Parameters for executing an agent with full features (RAG, integrations, etc.)
 */
export interface ExecuteAgentFullParams {
    agentId: string                     
    userQuery: string                    
    userEmail: string                   
    workspaceId: string                  
    streamable?: boolean                 
    temperature?: number            
}

/**
 * Response from agent execution
 */
export interface ExecuteAgentFullResponse {
    success: boolean
    response?: string                    // AI's answer
    citations?: any[]                    // Document citations
    imageCitations?: any[]               // Image citations
    thinking?: string                    // AI's reasoning (if enabled)
    cost?: string                        // API cost
    tokensUsed?: number                  // Token count
    error?: string                       // Error message (if failed)
    chatId?: string | null               // No chat for workflows
    messageId?: string | null            // No message for workflows
}

/**
 * Execute an agent with full features: RAG, integrations, knowledge base
 * 
 * This is the CORE LOGIC extracted from AgentMessageApi.
 * Can be used by both chat UI and workflows.
 * 
 * @param params - Execution parameters
 * @returns Agent response with citations, costs, etc.
 */

export const executeAgentWithFullFeatures = async (
    params: ExecuteAgentFullParams
): Promise<ExecuteAgentFullResponse> => {
    try {
        Logger.info(`[agentCore] Starting execution for agent ${params.agentId}`)

        // Initialize tracer for performance monitoring
        const tracer = getTracer("agentCore")
        const executeAgentSpan = tracer.startSpan('executeAgentCore')

        // ============================================
        // STEP 1: Load User, Workspace, and Agent
        // ============================================

        const userAndWorkspace = await getUserAndWorkspaceByEmail(
            db,
            params.workspaceId,
            params.userEmail,
        )
        const { user, workspace } = userAndWorkspace

        Logger.info(`[agentCore] Resolved user ID: ${user.id}, workspace ID: ${workspace.id}`)

        const agent = await getAgentByExternalIdWithPermissionCheck(
            db,
            params.agentId,
            workspace.id,
            user.id,
        )
        //here add attachements id's in app_integrations : google_drive : [...attachmentFileIds]

        if (!agent) {
            Logger.error(`[agentCore] Agent ${params.agentId} not found or permission denied`)
            return {
                success: false,
                error: `Access denied: You don't have permission to use agent ${params.agentId}`,
            }
        }

        Logger.info(`[agentCore] Loaded agent: ${agent.name}`)
        Logger.info(`[agentCore] Agent features: RAG=${agent.isRagOn}, Integrations=${agent.appIntegrations?.length || 0}`)

        // ============================================
        const userTimezone = user?.timeZone || "Asia/Kolkata"
        const dateForAI = getDateForAI({ userTimeZone: userTimezone })
        const userMetadata: UserMetadataType = { userTimezone, dateForAI }

        Logger.info(`[agentCore] User timezone: ${userTimezone}, Date for AI: ${dateForAI}`)

        let contextualContent = ""
      

        // Extract KB from BOTH sources:
        const agentKBDocs = agent.docIds || []
        const directDocIds = agentKBDocs.map((doc) =>
            typeof doc === 'string' ? doc : doc.docId
        )

        // Extract KB from app_integrations
        let kbIntegrationDocIds: string[] = []
        if (agent.appIntegrations && typeof agent.appIntegrations === 'object') {
            const integrations = agent.appIntegrations as Record<string, any>
            if (integrations.knowledge_base && integrations.knowledge_base.itemIds) {
                kbIntegrationDocIds = integrations.knowledge_base.itemIds
            }
        }

        // Combine ALL sources
        const agentKBDocIds = [...directDocIds, ...kbIntegrationDocIds]

        // Merge with user attachments
        const uniqueFileIds = Array.from(new Set([
            ...agentKBDocIds,
        ]))



        Logger.info(`[agentCore] 📊 Combined file sources:`)

        Logger.info(`[agentCore]    - Agent KB docs: ${agentKBDocs.length}`)
        Logger.info(`[agentCore]    - Total unique files: ${uniqueFileIds.length}`)

        // Determine if we should use RAG
        const shouldUseRAG = agent.isRagOn && uniqueFileIds.length > 0


        // ============================================
        // TODO: Step 4 - Perform RAG search or direct LLM call
        // ===========================================



        let finalAnswer = ""
        let citations: Citation[] = []
        let imageCitations: ImageCitation[] = []
        let thinking = ""
        let totalCost = 0
        let totalTokens = 0



        if (shouldUseRAG) {
            // ===== Path 1: RAG Pipeline =====
            // Why? Agent has RAG enabled and files available
            // We search the documents and use context to answer

            Logger.info(`[agentCore] 🔍 Starting RAG pipeline...`)

            const ragSpan = executeAgentSpan?.startSpan("rag_processing")
            const understandSpan = ragSpan?.startSpan("understand_message")

            // Call RAG function (async generator that yields chunks)

            const classification = await classifyUserQuery(
                params.userQuery,
                params.userEmail,
                userMetadata,
                agent.model === "Auto" ? undefined : agent.model,
            )
                  Logger.info(`[agentCore] 📊 Classification result: ${JSON.stringify(classification)}`)

            // const iterator = UnderstandMessageAndAnswerForGivenContext(
            //     params.userEmail,                     // email
            //     params.userQuery,                     // userCtx (context from user)
            //     userMetadata,                         // timezone, date
            //     params.userQuery,                     // message (the question)
            //     0.5,                                  // alpha (search confidence threshold)
            //     uniqueFileIds,                        // fileIds (documents to search)
            //     false,                                // userRequestsReasoning
            //     understandSpan,                       // tracing span
            //     [],                                   // threadIds (empty for workflows)
            //     imageAttachmentFileIds,               // image attachments
            //     agent.prompt || undefined,   // agent's system prompt
            //     true,                                 // isMsgWithSources
            //     agent.model === "Auto" ? undefined : agent.model,             // model ID
            //     undefined,                            // isValidPath
            //     [],                                   // folderIds
            // )

            // STEP 2: Call UnderstandMessageAndAnswer
            // Why? This function properly extracts KB from app_integrations
            // It internally calls generateIterativeTimeFilterAndQueryRewrite which parses the agent JSON
            const iterator = UnderstandMessageAndAnswer(
                params.userEmail,           // email
                params.userEmail,           // userCtx (user context - can be same as email for workflows)
                userMetadata,               // timezone, date
                params.userQuery,           // message (the question)
                classification,             // QueryRouterLLMResponse from classifyUserQuery
                [],                         // messages (empty array for workflows - no conversation history)
                0.5,                        // alpha (search confidence threshold)
                false,                      // userRequestsReasoning
                understandSpan,             // tracing span
                JSON.stringify(agent),      // agentPrompt - CRITICAL: Must be stringified full agent with app_integrations!
                agent.model === "Auto" ? undefined : agent.model,  // modelId
                undefined,                  // pathExtractedInfo (not needed for workflows)
            )


            // Iterate through response chunks
            // Why? The function streams chunks (text, citations, costs)
            for await (const chunk of iterator) {
                if (chunk.text) {
                    // Regular answer text
                    if (!chunk.reasoning) {
                        finalAnswer += chunk.text
                    } else {
                        // Thinking/reasoning text (if enabled)
                        thinking += chunk.text
                    }
                }

                if (chunk.citation) {
                    // Document citation
                    citations.push(chunk.citation.item)
                }

                if (chunk.imageCitation) {
                    // Image citation
                    imageCitations.push(chunk.imageCitation)
                }

                if (chunk.cost) {
                    // API cost
                    totalCost += chunk.cost
                }

                if (chunk.metadata?.usage) {
                    // Token usage
                    totalTokens += chunk.metadata.usage.inputTokens + chunk.metadata.usage.outputTokens
                }
            }

            understandSpan?.end()
            ragSpan?.end()

            Logger.info(`[agentCore] ✅ RAG pipeline completed`)
            Logger.info(`[agentCore] 📊 Answer length: ${finalAnswer.length} characters`)
            Logger.info(`[agentCore] 📚 Citations: ${citations.length}`)
            Logger.info(`[agentCore] 💰 Cost: $${totalCost.toFixed(6)}`)

        } else {
            // ===== Path 2: Direct LLM Call =====
            // Why? RAG is disabled or no files available
            // We just call the LLM with the agent's prompt

            Logger.info(`[agentCore] 🤖 Starting direct LLM call (no RAG)...`)

            const llmSpan = executeAgentSpan?.startSpan("direct_llm_call")

            // Prepare messages for LLM
            const messages: { role: string; content: string }[] = []

            // Add agent's system prompt if available
            if (agent.prompt) {
                messages.push({
                    role: "system",
                    content: agent.prompt
                })
            }

            // Add user's query
            messages.push({
                role: "user",
                content: params.userQuery
            })

            // Add context from attachments if available
            if (contextualContent) {
                messages.push({
                    role: "system",
                    content: `Context from attachments:\n${contextualContent}`
                })
            }
// todo: check this warning in modelID
            const iterator = agentWithNoIntegrationsQuestion(
                params.userQuery,
                params.userEmail,
                {
                    modelId: agent.model === "Auto" ? undefined : agent.model,
                    temperature: params.temperature || 0.5,
                    stream: true,
                    agentPrompt: agent.prompt || undefined,
                    // Add context from attachments
                    messages: contextualContent ? [{
                        role: "user",
                        content: [{ text: `Context from attachments:\n${contextualContent}` }]
                    }] : undefined,
                }
            )

            // Collect response chunks
            for await (const chunk of iterator) {
                if (chunk.text) {
                    finalAnswer += chunk.text
                }

                if (chunk.cost) {
                    totalCost += chunk.cost
                }

                if (chunk.metadata?.usage) {
                    totalTokens += chunk.metadata.usage.inputTokens + chunk.metadata.usage.outputTokens
                }
            }

            llmSpan?.end()

            Logger.info(`[agentCore] ✅ Direct LLM call completed`)
            Logger.info(`[agentCore] 📊 Answer length: ${finalAnswer.length} characters`)
            Logger.info(`[agentCore] 💰 Cost: $${totalCost.toFixed(6)}`)
        }

        executeAgentSpan?.end()

        // Return final response
        return {
            success: true,
            response: finalAnswer,
            citations: citations.length > 0 ? citations : undefined,
            imageCitations: imageCitations.length > 0 ? imageCitations : undefined,
            thinking: thinking || undefined,
            cost: totalCost > 0 ? totalCost.toFixed(6) : undefined,
            tokensUsed: totalTokens,
            chatId: null,      // No chat for workflows
            messageId: null,   // No message for workflows
        }




    } catch (error) {
        Logger.error(error, "[agentCore] Agent execution failed")
        return {
            success: false,
            error: getErrorMessage(error)
        }
    }
}




async function classifyUserQuery(
    userQuery: string,
    userEmail: string,
    userMetadata: UserMetadataType,
    modelId?: string,
): Promise<QueryRouterLLMResponse> {
    Logger.info(`[agentCore] 🔍 Classifying user query...`)

    const classificationIterator = generateSearchQueryOrAnswerFromConversation(
        userQuery,
        userEmail,
        userMetadata,
        {
            modelId: (modelId as Models) || defaultBestModel,
            stream: true,
            json: true,
        },
    )

    let classificationText = ""
    for await (const chunk of classificationIterator) {
        if (chunk.text) {
            classificationText += chunk.text
        }
    }

    const classification = jsonParseLLMOutput(classificationText)

    const result: QueryRouterLLMResponse = {
        type: classification.type || "SearchWithoutFilters",
        direction: classification.direction || null,
        filterQuery: classification.filter_query || null,
        filters: {
            apps: classification.apps || null,
            startDate: classification.start_date || null,
            endDate: classification.end_date || null,
            people: classification.people || null,
        },
    }

    Logger.info(`[agentCore] ✅ Query classified as: ${result.type}`)
    return result
}


// if (import.meta.main) {
//     console.log("Testing Step 2: Build Context from Attachments...")

//     executeAgentWithFullFeatures({
//         agentId: "lb07g91lc2b1oqbwhz3lhw6y",
//         userQuery: "Analyze this resume and suggest improvements.",
//         userEmail: "aman.asrani@juspay.in",
//         workspaceId: "o0kwlormj94o8vlgm66zc5ua",
//         // attachmentFileIds: ["att_a9b4896e-044a-4391-82d7-2befd06a40e7"], // Image attachment
//         // nonImageAttachmentFileIds: ["doc_3f4e8b1c-1d2a-4e6f-9c3a-5b6d7e8f9a0b"], // Document attachment
//         // streamable: false,
//         // temperature: 0.7,
//     }).then(result => {
//         console.log("\n✅ Step 2 Result:")
//         console.log("Success:", result.success)
//         console.log("Response preview:", result.response?.substring(0, 10000))
//     }).catch(err => {
//         console.error("\n❌ Step 2 Failed:", err)
//     })
// }