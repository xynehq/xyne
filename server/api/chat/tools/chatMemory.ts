import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import type { ZodType } from "zod"
import type { Ctx } from "./types"
import {
  SearchChatHistoryInputSchema,
  type SearchChatHistoryInput,
} from "@/api/chat/tool-schemas"
import { formatChatMemoryToolResponse } from "@/api/chat/tools/utils"
import { retrieveRelevantChatHistory } from "@/services/chatMemoryRetriever"
import { MEMORY_CONFIG } from "@/config"
import { getErrorMessage } from "@/utils"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Chat).child({ tool: "searchChatHistory" })

type ToolSchemaParameters<T> = Tool<T, Ctx>["schema"]["parameters"]
const toToolSchemaParameters = <T>(schema: ZodType<T>): ToolSchemaParameters<T> =>
  schema as unknown as ToolSchemaParameters<T>

export const searchChatHistoryTool: Tool<SearchChatHistoryInput, Ctx> = {
  schema: {
    name: "searchChatHistory",
    description:
      "Search a conversation for relevant context. Use when you need to recall what was said or decided. Pass chatId from 'Relevant Past Experiences' to search that conversation; omit chatId to search only the current conversation. Without a valid chatId no results are returned.",
    parameters: toToolSchemaParameters(SearchChatHistoryInputSchema),
  },
  async execute(params: SearchChatHistoryInput, context: Ctx) {
    const email = context.user.email
    const chatId = params.chatId ?? context.chat?.externalId
    const workspaceId = String(context.user.workspaceId ?? "")

    if (!email || !chatId) {
      return ToolResponse.error(
        ToolErrorCodes.MISSING_REQUIRED_FIELD,
        "A chatId is required: use the chatId from 'Relevant Past Experiences' for a past conversation, or ensure you are in a chat to search the current conversation.",
        { toolName: "searchChatHistory" },
      )
    }

    try {
      const rawFragments = await retrieveRelevantChatHistory({
        query: params.query,
        chatId,
        email,
        workspaceId,
        limit: params.limit ?? MEMORY_CONFIG.MAX_CHAT_MEMORY_CHUNKS,
      })
      const fragments = formatChatMemoryToolResponse(rawFragments, {
        query: params.query,
        chatId,
        limit: params.limit ?? MEMORY_CONFIG.MAX_CHAT_MEMORY_CHUNKS,
      })
      return ToolResponse.success(fragments)
    } catch (error) {
      const errMsg = getErrorMessage(error)
      Logger.error({ err: error, email, chatId }, "searchChatHistory failed")
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        errMsg,
        { toolName: "searchChatHistory" },
      )
    }
  },
}
