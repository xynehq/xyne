/**
 * searchChatHistory tool - pi-mono version
 *
 * Search earlier parts of the conversation for relevant context
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"

const searchChatHistoryParams = Type.Object({
  query: Type.String({
    description:
      "Search query to find relevant earlier messages in the conversation",
    minLength: 1,
  }),
  chatId: Type.Optional(
    Type.String({
      description:
        "Conversation to search. Use the chatId from 'Relevant Past Experiences' when searching a past conversation; omit to search the current conversation only.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      description: "Max number of conversation messages to return",
      minimum: 1,
      maximum: 10,
      default: 5,
    }),
  ),
})

export const searchChatHistoryTool = createXyneTool(
  "searchChatHistory",
  "Search earlier parts of this conversation for relevant context. Only a limited recent window of messages is provided in context; use this when you need to recall what was said or decided in prior messages.",
  searchChatHistoryParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      const email = xyneState.user.email
      const workspaceId = xyneState.user.workspaceId

      if (!email) {
        return {
          content: [
            {
              type: "text",
              text: "User email is required to search chat history.",
            },
          ],
          isError: true,
          details: { toolName: "searchChatHistory" },
        }
      }

      const chatIdToSearch = params.chatId || xyneState.chat.externalId

      const results = await retrieveRelevantChatHistory({
        query: params.query,
        chatId: chatIdToSearch,
        email,
        workspaceId: workspaceId || "",
        limit: params.limit || 5,
      })

      const formattedResults = results.map((r) => ({
        userMessage: r.userMessage,
        assistantThinking: r.assistantThinking,
        assistantMessage: r.assistantMessage,
      }))

      return {
        content: [
          {
            type: "text",
            text: `Found ${formattedResults.length} relevant messages from chat history.`,
          },
        ],
        details: {
          results: formattedResults,
          query: params.query,
          chatId: chatIdToSearch,
          toolName: "searchChatHistory",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          { type: "text", text: `Chat history search error: ${errMsg}` },
        ],
        isError: true,
        details: { toolName: "searchChatHistory", error: errMsg },
      }
    }
  },
)
