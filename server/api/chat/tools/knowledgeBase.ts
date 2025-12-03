import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import type { ZodType } from "zod"
import { Apps } from "@xyne/vespa-ts/types"
import { getErrorMessage } from "@/utils"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { Ctx } from "./types"
import {
  SearchKnowledgeBaseInputSchema,
  type SearchKnowledgeBaseToolParams,
} from "../tool-schemas"
import { parseAgentAppIntegrations } from "./utils"
import {
  buildKnowledgeBaseCollectionSelections,
  KnowledgeBaseScope,
  type KnowledgeBaseSelection,
} from "@/api/chat/knowledgeBaseSelections"
import { executeVespaSearch } from "./global"

const Logger = getLogger(Subsystem.Chat)
type ToolSchemaParameters<T> = Tool<T, Ctx>["schema"]["parameters"]
const toToolSchemaParameters = <T>(
  schema: ZodType,
): ToolSchemaParameters<T> => schema as unknown as ToolSchemaParameters<T>

const buildOverrideSelections = (
  params: SearchKnowledgeBaseToolParams,
): KnowledgeBaseSelection[] => {
  const selection: KnowledgeBaseSelection = {}
  if (params.collectionId) selection.collectionIds = [params.collectionId]
  if (params.folderId) selection.collectionFolderIds = [params.folderId]
  if (params.fileId) selection.collectionFileIds = [params.fileId]

  return Object.keys(selection).length ? [selection] : []
}

export const searchKnowledgeBaseTool: Tool<
  SearchKnowledgeBaseToolParams,
  Ctx
> = {
  schema: {
    name: "searchKnowledgeBase",
    description:
      "Search the user's knowledge base collections and return relevant document fragments with citations.",
    parameters: toToolSchemaParameters<SearchKnowledgeBaseToolParams>(
      SearchKnowledgeBaseInputSchema,
    ),
  },
  async execute(params, context) {
    const email = context.user.email
    if (!email) {
      return ToolResponse.error(
        ToolErrorCodes.MISSING_REQUIRED_FIELD,
        "User email not found while executing searchKnowledgeBase",
        { toolName: "searchKnowledgeBase" },
      )
    }

    const query = params.query?.trim()
    if (!query) {
      return ToolResponse.error(
        ToolErrorCodes.MISSING_REQUIRED_FIELD,
        "Query cannot be empty for knowledge base search",
        { toolName: "searchKnowledgeBase" },
      )
    }

    try {
      const agentPrompt = context.agentPrompt
      const { selectedItems } = parseAgentAppIntegrations(agentPrompt)
      const scope = agentPrompt
        ? KnowledgeBaseScope.AgentScoped
        : KnowledgeBaseScope.UserOwned

      const baseSelections = await buildKnowledgeBaseCollectionSelections({
        scope,
        email,
        selectedItems,
      })

      const overrides = buildOverrideSelections(params)
      const collectionSelections =
        overrides.length > 0 ? overrides : baseSelections

      Logger.info(
        {
          email,
          scope,
          baseSelectionCount: baseSelections.length,
          overrideSelectionCount: overrides.length,
          appliedSelectionCount: collectionSelections.length,
          selectedItemKeys: Object.keys(
            selectedItems as Record<string, unknown>,
          ).length,
        },
        "[MessageAgents][searchKnowledgeBaseTool] Using KnowledgeBaseScope for KB search",
      )

      if (!collectionSelections.length) {
        return ToolResponse.error(
          ToolErrorCodes.EXECUTION_FAILED,
          "No accessible knowledge base collections found for this user",
          { toolName: "searchKnowledgeBase" },
        )
      }

      const fragments = await executeVespaSearch({
        email,
        query,
        app: Apps.KnowledgeBase,
        agentAppEnums: [Apps.KnowledgeBase],
        limit: params.limit,
        offset: params.offset ?? 0,
        excludedIds: params.excludedIds,
        collectionSelections,
        selectedItems,
      })

      if (!fragments.length) {
        return ToolResponse.error(
          ToolErrorCodes.EXECUTION_FAILED,
          "No knowledge base results found for the query.",
          { toolName: "searchKnowledgeBase" },
        )
      }

      return ToolResponse.success(fragments)
    } catch (error) {
      return ToolResponse.error(
        ToolErrorCodes.EXECUTION_FAILED,
        `Knowledge base search failed: ${getErrorMessage(error)}`,
        { toolName: "searchKnowledgeBase" },
      )
    }
  },
}
