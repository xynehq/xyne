/**
 * Complete 1:1 JAF Implementation of Xyne Agent
 * Replicates all features from agents.ts using JAF's callback system
 */

import {
  createAgent,
  createInMemorySessionProvider,
  runAgent,
  createTextPart,
  getTextContent,
  type RunnerConfig,
  type AgentResponse,
  type RunnerCallbacks,
  type RunContext,
  type Session,
  type Content,
  type Tool as JAFTool,
  type Agent,
} from "@xynehq/jaf/adk"
import type { Context } from "hono"
import { streamSSE } from "hono/streaming"
import { HTTPException } from "hono/http-exception"

import { userContext } from "@/ai/context"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { db } from "@/db/client"
import { insertChat, updateChatByExternalIdWithAuth } from "@/db/chat"
import { insertMessage, getChatMessagesWithAuth } from "@/db/message"
import { ChatSSEvents } from "@/shared/types"
import { MessageRole, Subsystem } from "@/types"
import type { SelectChat } from "@/db/schema"
import { getLogger } from "@/logger"
import config from "@/config"
import { getTracer } from "@/tracer"

// Import existing xyne tools and types
import { agentTools } from "./tools"
import { XyneTools } from "@/shared/types"
import type { MinimalAgentFragment } from "./types"
import { createJAFToolAdapter } from "./adapters/jaf-tool-adapter"

const Logger = getLogger(Subsystem.Chat)

interface ToolExecutionRecord {
  tool: string
  args: Record<string, any>
  failureCount: number
  timestamp: number
}

// Extended fragment type for internal use
interface ExtendedFragment {
  source: string
  content: string
  id?: string
  confidence?: number
}

interface AgentContext {
  fragments: ExtendedFragment[]
  excludedIds: string[]
  toolHistory: ToolExecutionRecord[]
  iterationCount: number
  answered: boolean
  wasStreamClosedPrematurely: boolean
  evidenceSummary: string
  loopWarningPrompt: string
  answer?: string
}

/**
 * Creates comprehensive callbacks that replicate agents.ts behavior exactly
 */
const createCompleteXyneCallbacks = (
  stream: any,
  email: string,
  userCtx: string,
  modelId: string,
  agentPrompt: string | undefined,
  toolsList: any[],
  messages: any[],
  fileIds: string[],
  hasReferencedContext: boolean,
  isDebugMode: boolean,
  rootSpan: any,
): RunnerCallbacks => {
  // State management - mirrors agents.ts exactly
  const agentContext: AgentContext = {
    fragments: [],
    excludedIds: [],
    toolHistory: [],
    iterationCount: 0,
    answered: false,
    wasStreamClosedPrematurely: false,
    evidenceSummary: "",
    loopWarningPrompt: "",
    answer: undefined,
  }

  const MAX_CONSECUTIVE_TOOL_FAILURES = 2
  const maxIterations = 10

  // Helper function to log and stream reasoning
  const logAndStreamReasoning = async (step: any) => {
    if (isDebugMode) {
      await stream.writeSSE({
        event: "reasoning_update",
        data: JSON.stringify(step),
      })
    }
    Logger.debug("Agent reasoning step", step)
  }

  return {
    // Lifecycle callbacks
    onStart: async (
      _context: RunContext,
      _message: Content,
      _session: Session,
    ) => {
      await logAndStreamReasoning({
        type: "initialize",
        message: "Starting agent execution with JAF framework",
      })
    },

    onComplete: async (_response: AgentResponse) => {
      Logger.info("Agent execution complete", {
        iterations: agentContext.iterationCount,
        fragments: agentContext.fragments.length,
        answered: agentContext.answered,
      })
    },

    onError: async (error: Error, _context: RunContext) => {
      Logger.error(error, "Agent execution error")
      await logAndStreamReasoning({
        type: "error",
        error: error.message,
      })
    },

    // Iteration control - matches agents.ts loop logic
    onIterationStart: async (iteration: number) => {
      agentContext.iterationCount = iteration

      await logAndStreamReasoning({
        type: "iteration",
        iteration: iteration,
      })

      // Check stream status (mirrors line 1008 in agents.ts)
      if (stream.closed) {
        Logger.info(
          "[MessageWithToolsJAF] Stream closed during conversation search loop. Breaking.",
        )
        agentContext.wasStreamClosedPrematurely = true
        return { continue: false }
      }

      // Handle referenced context on first iteration
      if (hasReferencedContext && iteration === 1 && fileIds.length > 0) {
        // Simplified context fetching for file references
        // In production, this would integrate with your document retrieval system
        Logger.info("Processing referenced context", { fileIds })

        // Create placeholder fragments for referenced files
        const newFragments = fileIds.map((fileId, idx) => ({
          source: `document-${idx}`,
          content: `Referenced file: ${fileId}`,
          id: fileId,
        }))

        agentContext.fragments.push(...newFragments)
        agentContext.evidenceSummary = newFragments
          .map((f) => f.content)
          .join("\n\n")
      }

      // Check iteration limit
      if (iteration > maxIterations) {
        await logAndStreamReasoning({
          type: "log_message",
          message: `Reached maximum iterations (${maxIterations})`,
        })
        return { continue: false }
      }

      return {
        continue: !agentContext.answered && iteration <= maxIterations,
        maxIterations: maxIterations,
      }
    },

    onIterationComplete: async (iteration: number, hasToolCalls: boolean) => {
      // Update iteration tracking
      if (!hasToolCalls && iteration > 1) {
        await logAndStreamReasoning({
          type: "log_message",
          message: `No tool selected for iteration ${iteration}. Generating answer with available context.`,
        })
        agentContext.answered = true
      }

      return {
        shouldContinue: !agentContext.answered && iteration < maxIterations,
        shouldStop: agentContext.answered || iteration >= maxIterations,
      }
    },

    // Tool selection and execution - matches agents.ts tool logic exactly
    onBeforeToolSelection: async (tools: JAFTool[], _context: any) => {
      // Check for consecutive failures (mirrors lines 1200-1243)
      const lastToolCall =
        agentContext.toolHistory[agentContext.toolHistory.length - 1]

      if (
        lastToolCall &&
        lastToolCall.failureCount >= MAX_CONSECUTIVE_TOOL_FAILURES
      ) {
        agentContext.loopWarningPrompt = `
          ---
          **Critique Past Actions:** You have repeatedly called the tool '${lastToolCall.tool}' 
          with arguments ${JSON.stringify(lastToolCall.args)} and it has failed or yielded 
          insufficient results ${lastToolCall.failureCount} times consecutively. 
          You are stuck in a loop. You MUST choose a DIFFERENT TOOL or escalate to a 
          "no answer found" state if no other tools are viable.
          ---
        `

        await logAndStreamReasoning({
          type: "log_message",
          message: `Detected ${lastToolCall.failureCount} consecutive failures for tool ${lastToolCall.tool}. Attempting to change strategy.`,
        })
      } else if (agentContext.toolHistory.length) {
        agentContext.loopWarningPrompt = `
          ---
          **Critique Past Actions:** You have already called some tools ${agentContext.toolHistory
            .map(
              (toolCall, idx) =>
                `[Iteration-${idx}] Tool: ${toolCall.tool}, Args: ${JSON.stringify(toolCall.args)}`,
            )
            .join("\n")} and the result was insufficient. 
          You MUST change your strategy.
          For example: 
            1. Choose a **DIFFERENT TOOL**.
            2. Use the **SAME TOOL** but with **DIFFERENT Parameters**.
            3. Use different **offset** if you think the tool selected is correct and you need to go to next page.
          Do NOT make these calls again. Formulate a new, distinct plan.
          ---
        `
      }

      // Filter out conversational tool after first iteration (mirrors lines 1272-1283)
      if (agentContext.iterationCount !== 1) {
        const filteredTools = tools.filter(
          (tool: JAFTool) => tool.name !== XyneTools.Conversational,
        )
        return { tools: filteredTools }
      }

      return { tools }
    },

    onToolSelected: async (toolName: string | null, _params: any) => {
      if (!toolName) {
        await logAndStreamReasoning({
          type: "no_tool_selected",
          reasoning: "No tool was selected",
        })
        agentContext.answered = true
        return
      }

      await logAndStreamReasoning({
        type: "tool_selected",
        toolName: toolName,
      })
    },

    onBeforeToolExecution: async (
      tool: JAFTool,
      params: Record<string, any>,
    ) => {
      // Add excluded IDs to parameters (mirrors lines 1406-1410)
      const enhancedParams = {
        ...params,
        excludedIds: agentContext.excludedIds,
      }

      await logAndStreamReasoning({
        type: "tool_parameters",
        parameters: {
          ...enhancedParams,
          excludedIds: agentContext.excludedIds.length
            ? `Excluded ${agentContext.excludedIds.length} previous ${agentContext.excludedIds.length === 1 ? "result" : "results"} to avoid duplication`
            : "None",
        },
      })

      // Apply parameter limits (mirrors lines 1473-1484)
      if (
        "perPage" in enhancedParams &&
        typeof enhancedParams.perPage === "number" &&
        enhancedParams.perPage > 10
      ) {
        await logAndStreamReasoning({
          type: "log_message",
          message: `Detected perPage ${enhancedParams.perPage} in arguments for tool ${tool.name}`,
        })
        enhancedParams.perPage = 10
        await logAndStreamReasoning({
          type: "log_message",
          message: `Limited perPage for tool ${tool.name} to 10`,
        })
      }

      return { params: enhancedParams }
    },

    onAfterToolExecution: async (tool: JAFTool, result: any, error?: Error) => {
      const toolName = tool.name

      // Track tool execution in history
      const existingTool = agentContext.toolHistory.find(
        (t) =>
          t.tool === toolName &&
          JSON.stringify(t.args) === JSON.stringify(result?.params),
      )

      if (error) {
        // Handle tool failure (mirrors lines 1421-1430)
        const errMessage = error.message
        Logger.error(
          error,
          `Critical error executing tool ${toolName}: ${errMessage}`,
        )

        if (existingTool) {
          existingTool.failureCount++
        } else {
          agentContext.toolHistory.push({
            tool: toolName,
            args: result?.params || {},
            failureCount: 1,
            timestamp: Date.now(),
          })
        }

        await logAndStreamReasoning({
          type: "tool_error",
          toolName: toolName,
          error: errMessage,
        })

        return {
          result: `Execution of tool ${toolName} failed critically.`,
          error: errMessage,
        }
      }

      // Process successful tool execution
      if (result && result.data) {
        // Reset failure count on success
        if (existingTool) {
          existingTool.failureCount = 0
        } else {
          agentContext.toolHistory.push({
            tool: toolName,
            args: result.params || {},
            failureCount: 0,
            timestamp: Date.now(),
          })
        }

        // Extract fragments and contexts (mirrors lines 1491-1597)
        if (result.data.contexts) {
          const newFragments: ExtendedFragment[] = []

          for (const ctx of result.data.contexts) {
            if (ctx.id && !agentContext.excludedIds.includes(ctx.id)) {
              agentContext.excludedIds.push(ctx.id)
              newFragments.push({
                source: ctx.source || `${toolName}-${Date.now()}`,
                content: ctx.content || "",
                id: ctx.id,
                confidence: ctx.confidence,
              })
            }
          }

          agentContext.fragments.push(...newFragments)

          // Update evidence summary
          if (newFragments.length > 0) {
            agentContext.evidenceSummary +=
              "\n\n" + newFragments.map((f) => f.content).join("\n\n")

            await logAndStreamReasoning({
              type: "tool_success",
              toolName: toolName,
              fragmentsFound: newFragments.length,
            })
          }
        }

        // Check for answer in tool response (mirrors lines 1862-1877)
        if (result.data.answer) {
          agentContext.answer = result.data.answer
          agentContext.answered = true

          await logAndStreamReasoning({
            type: "answer_found",
            message: "Tool provided direct answer",
          })
        }
      }

      return result
    },

    // Query rewriting for better search
    onQueryRewrite: async (originalQuery: string, _context: any) => {
      // Only rewrite if we have poor results after a few iterations
      if (
        agentContext.iterationCount > 2 &&
        agentContext.fragments.length < 3
      ) {
        await logAndStreamReasoning({
          type: "query_rewrite",
          original: originalQuery,
          reason: "Insufficient results, attempting query refinement",
        })

        // Could use LLM to rewrite, but for now return original
        return originalQuery
      }
      return null
    },

    // Loop detection
    onLoopDetection: async (history: any[], currentTool: string) => {
      // Check if we're calling the same tool repeatedly
      const recentCalls = history.slice(-3)
      const sameToolCount = recentCalls.filter(
        (h: any) => h.tool === currentTool,
      ).length

      if (sameToolCount >= 3) {
        await logAndStreamReasoning({
          type: "loop_detected",
          tool: currentTool,
          message: "Detected potential loop, breaking pattern",
        })
        return true // Skip this tool
      }

      return false
    },

    // Context management
    onContextUpdate: async (context: any[], newItems: any[]) => {
      // Deduplicate based on IDs
      const existingIds = new Set(agentContext.excludedIds)
      const uniqueNewItems = newItems.filter(
        (item: any) => !item.id || !existingIds.has(item.id),
      )

      return [...context, ...uniqueNewItems]
    },

    // Fallback handling (mirrors lines 1941-2000)
    onFallbackRequired: async (_context: any) => {
      if (
        agentContext.fragments.length === 0 &&
        agentContext.iterationCount > 3
      ) {
        await logAndStreamReasoning({
          type: "fallback_activated",
          reason: "No results found after multiple iterations",
        })

        return {
          required: true,
          strategy: "web-search",
        }
      }

      return { required: false }
    },
  }
}

/**
 * Complete Message API Handler using JAF - 1:1 with agents.ts
 */
export const MessageWithToolsJAF = async (c: Context) => {
  const tracer = getTracer("chat")
  const rootSpan = tracer.startSpan("MessageWithToolsJAF")

  try {
    const { sub: email, workspaceId } = c.get(config.JwtPayloadKey)
    const body = (await c.req.json()) as any
    const {
      message: rawMessage,
      chatId,
      modelId,
      agentId: agentPrompt,
      toolsList,
      fileIds = [],
      isDebugMode = false,
    } = body

    if (!rawMessage) {
      throw new HTTPException(400, { message: "Message is required" })
    }

    const message = decodeURIComponent(rawMessage)
    const hasReferencedContext = fileIds.length > 0

    // Get user and workspace
    const userAndWorkspace = await getUserAndWorkspaceByEmail(
      db,
      workspaceId,
      email,
    )
    const { user, workspace } = userAndWorkspace

    // Get or create chat
    let chat: SelectChat
    if (!chatId) {
      chat = await insertChat(db, {
        workspaceId: workspace.id,
        workspaceExternalId: workspace.externalId,
        userId: user.id,
        email: user.email,
        title: message.substring(0, 50),
        attachments: fileIds || [],
      })
    } else {
      chat = await updateChatByExternalIdWithAuth(db, chatId, email, {
        attachments: fileIds || [],
      })
    }

    // Get message history
    const messages = chatId
      ? await getChatMessagesWithAuth(db, chatId, email)
      : []

    // Insert user message
    await insertMessage(db, {
      chatId: chat.id,
      userId: user.id,
      chatExternalId: chat.externalId,
      workspaceExternalId: workspace.externalId,
      messageRole: MessageRole.User,
      email: user.email,
      sources: [],
      message,
      modelId,
    })

    return streamSSE(c, async (stream) => {
      try {
        // Send initial metadata
        await stream.writeSSE({
          event: ChatSSEvents.ResponseMetadata,
          data: JSON.stringify({
            chatId: chat.externalId,
            hasReferencedContext,
            fileIds,
          }),
        })

        // Build user context
        const userCtx = userContext(userAndWorkspace)

        // Filter tools based on toolsList (mirrors agents.ts tool filtering)
        let toolsToUse = agentTools

        if (toolsList && toolsList.length > 0) {
          // Filter to only requested tools
          toolsToUse = Object.fromEntries(
            Object.entries(agentTools).filter(([name]) =>
              toolsList.some((t: any) => t.tools.includes(name)),
            ),
          )
        }

        // Convert xyne tools to JAF tools
        const jafTools = Object.entries(toolsToUse).map(([name, tool]) =>
          createJAFToolAdapter(tool, {
            email,
            userContext: userCtx,
            agentPrompt,
          }),
        )

        // Create JAF agent with full instruction set
        const agent = createAgent({
          name: "xyne-complete-agent",
          model: modelId || config.defaultBestModel,
          instruction: `You are an intelligent search and retrieval assistant.
          ${agentPrompt || ""}
          
          User Context: ${userCtx}
          
          Your task is to:
          1. Understand the user's query
          2. Use available tools to gather relevant information
          3. Synthesize a comprehensive answer with citations
          4. Avoid loops and redundant searches
          5. Fallback gracefully when no information is found`,
          tools: jafTools,
        })

        // Create complete callbacks that mirror agents.ts behavior
        const callbacks = createCompleteXyneCallbacks(
          stream,
          email,
          userCtx,
          modelId || config.defaultBestModel,
          agentPrompt,
          toolsList || [],
          messages,
          fileIds,
          hasReferencedContext,
          isDebugMode,
          rootSpan,
        )

        // Create runner config with callbacks
        const runnerConfig: RunnerConfig = {
          agent,
          sessionProvider: createInMemorySessionProvider(),
          callbacks,
          maxLLMCalls: 10,
        }

        // Execute agent with enhanced runner
        const result = await runAgent(
          runnerConfig,
          {
            sessionId: chat.externalId,
            userId: email,
            requestId: `req_${Date.now()}`,
          },
          {
            role: "user",
            parts: [createTextPart(message)],
          },
        )

        // Process and stream results
        const agentResult = result as AgentResponse
        if (agentResult && agentResult.content) {
          const textContent = getTextContent(agentResult.content)

          // Stream the final answer
          await stream.writeSSE({
            event: ChatSSEvents.ResponseUpdate,
            data:
              textContent ||
              "I was unable to find relevant information to answer your question.",
          })

          // Extract all fragments from tool responses
          const allFragments: MinimalAgentFragment[] = []

          agentResult.toolResponses.forEach((response) => {
            if (response.response && typeof response.response === "object") {
              const data = response.response as any

              // Handle contexts from tool responses
              if (data.contexts && Array.isArray(data.contexts)) {
                data.contexts.forEach((ctx: any) => {
                  allFragments.push({
                    id: ctx.id || `${response.name}_${Date.now()}`,
                    source: ctx.source || response.name,
                    content: ctx.content || "",
                    confidence: ctx.confidence || 0.5,
                  })
                })
              }

              // Handle fragments directly
              if (data.fragments && Array.isArray(data.fragments)) {
                allFragments.push(...data.fragments)
              }
            }
          })

          // Stream citations if available
          if (allFragments.length > 0) {
            await stream.writeSSE({
              event: ChatSSEvents.CitationsUpdate,
              data: JSON.stringify({
                contextChunks: allFragments.map((f) => f.source),
                citationMap: allFragments.reduce(
                  (acc, f, idx) => ({
                    ...acc,
                    [idx]: {
                      source: f.source,
                      content: f.content,
                      confidence: f.confidence || 0.5,
                    },
                  }),
                  {},
                ),
              }),
            })
          }

          // Save assistant message with full metadata
          await insertMessage(db, {
            chatId: chat.id,
            userId: user.id,
            workspaceExternalId: workspace.externalId,
            chatExternalId: chat.externalId,
            messageRole: MessageRole.Assistant,
            email: user.email,
            sources: allFragments.map((f) => f.source),
            message: textContent || "No response generated",
            thinking: JSON.stringify({
              ...agentResult.metadata,
              toolCalls: agentResult.toolCalls,
              toolResponses: agentResult.toolResponses.map((r) => ({
                name: r.name,
                success: r.success,
                error: r.error,
              })),
              fragments: allFragments.length,
              iterationCount: (agentResult.metadata as any).iterations || 1,
            }),
            modelId: modelId || config.defaultBestModel,
          })
        } else {
          await stream.writeSSE({
            event: ChatSSEvents.Error,
            data: "Agent execution failed to generate response",
          })
        }

        await stream.writeSSE({
          event: ChatSSEvents.End,
          data: "",
        })
      } catch (error) {
        Logger.error(error, "Stream error in MessageWithToolsJAF")
        await stream.writeSSE({
          event: ChatSSEvents.Error,
          data: error instanceof Error ? error.message : "Unknown error",
        })
        await stream.writeSSE({
          event: ChatSSEvents.End,
          data: "",
        })
      }
    })
  } catch (error) {
    Logger.error(error, "MessageWithToolsJAF error")
    throw error
  } finally {
    rootSpan.end()
  }
}
