import {
  isAppSelectionMap,
  parseAppSelections,
  searchToCitation,
} from "@/api/chat/utils"
import {
  Apps,
  GoogleApps,
  KbItemsSchema,
  type VespaSearchResponse,
  type VespaSearchResults,
  fileSchema,
  getSortedScoredChunks,
} from "@xyne/vespa-ts"
import { ChatMemoryEntity } from "@xyne/vespa-ts/types"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import { type ZodType, z } from "zod"

import { answerContextMap } from "@/ai/context"
import type { Citation, MinimalAgentFragment } from "@/api/chat/types"
import config from "@/config"
import { getPrecomputedDbContextIfNeeded } from "@/lib/databaseContext"
import { Subsystem, getLogger } from "@/logger"
import type { UserMetadataType } from "@/types"
import { getDateForAI } from "@/utils/index"
import { getChunkCountPerDoc } from "../chunk-selection"
const Logger = getLogger(Subsystem.Chat)

export const userMetadata: UserMetadataType = {
  userTimezone: "Asia/Kolkata",
  dateForAI: getDateForAI({ userTimeZone: "Asia/Kolkata" }),
}

function computeReturnedChunkIndices(
  fields: any,
  maxSummaryChunks: number | undefined,
): number[] | undefined {
  if (!fields.chunks_pos_summary || !Array.isArray(fields.chunks_pos_summary)) {
    return undefined
  }

  let chunks: Array<{ chunk: string; index: number; score: number }> = []

  if (fields.matchfeatures) {
    chunks = getSortedScoredChunks(
      fields.matchfeatures,
      fields.chunks_summary as string[],
    )
  } else {
    // No matchfeatures, chunks stay in original order
    chunks =
      fields.chunks_summary?.map((chunk: any, idx: number) => ({
        chunk: typeof chunk === "string" ? chunk : chunk.chunk,
        index: idx,
        score: 0,
      })) || []
  }

  const returnedChunkIndices = chunks
    .slice(0, maxSummaryChunks)
    .map((v) => fields.chunks_pos_summary?.[v.index] ?? v.index)
    .filter((idx: number) => idx !== undefined && idx !== null)

  return returnedChunkIndices
}

export async function formatSearchToolResponse(
  searchResults: VespaSearchResponse | null,
  searchContext: {
    email?: string
    query?: string
    app?: string
    labels?: string[]
    timeRange?: { startTime: number; endTime: number }
    offset?: number
    limit?: number
    searchType?: string
    /** When set with query, precomputed DB context (live SQL results) is built for schema-only KB docs. */
    userId?: number | null
    workspaceId?: number | null
  },
): Promise<MinimalAgentFragment[]> {
  const children = (searchResults?.root?.children || []).filter(
    (item): item is VespaSearchResults =>
      !!(item.fields && "sddocname" in item.fields),
  )

  if (children.length === 0) {
    return []
  }

  const builtUserQuery = searchContext.query?.trim() ?? ""
  const precomputedDbContext = await getPrecomputedDbContextIfNeeded(
    children,
    builtUserQuery || undefined,
    searchContext.userId,
    searchContext.workspaceId,
  )

  const metadataForContext: UserMetadataType = {
    ...userMetadata,
    userId: searchContext.userId ?? undefined,
    workspaceId: searchContext.workspaceId ?? undefined,
  }

  const chunksPerDocument = await getChunkCountPerDoc(
    children,
    config.maxChunksPerTool,
    searchContext.email ?? "",
  )

  const fragments: MinimalAgentFragment[] = await Promise.all(
    children.map(async (r, idx) => {
      const citation = searchToCitation(r)
      // One child = one document (Vespa returns docs with chunks scored); use docId as fragment id.
      const fragmentId = citation.docId

      // Determine if chunk citations are enabled for KB files
      const allowChunkCitations = r.fields?.sddocname === KbItemsSchema

      // Calculate which chunks will actually be returned in the content
      // This is needed for accurate deduplication
      let returnedChunkIndices: number[] | undefined
      if (allowChunkCitations) {
        const fields = r.fields as any
        const maxSummaryChunks =
          config.maxDefaultSummary ?? fields.chunks_summary?.length

        returnedChunkIndices = computeReturnedChunkIndices(
          fields,
          maxSummaryChunks,
        )
      }

      // Enhance citation with returnedChunkIndices for deduplication
      const enhancedCitation: Citation = {
        ...citation,
        returnedChunkIndices,
      }

      return {
        id: fragmentId,
        content: await answerContextMap(
          r,
          metadataForContext,
          config.maxDefaultSummary,
          undefined,
          allowChunkCitations,
          builtUserQuery || undefined,
          precomputedDbContext,
        ),
        source: enhancedCitation,
        confidence: r.relevance || 0.7,
      }
    }),
  )

  return fragments
}

export type ChatMemoryFragment = {
  turnNumber: number
  userMessage: string
  assistantMessage: string
  assistantThinking?: string
  text: string
  docId: string
  relevance?: number
}

/**
 * Format chat memory retrieval results into MinimalAgentFragment[] for tool response.
 * Same pattern as formatSearchToolResponse: returns fragments the agent can cite and use.
 */
export function formatChatMemoryToolResponse(
  fragments: ChatMemoryFragment[],
  _context: {
    query?: string
    chatId?: string
    limit?: number
  },
): MinimalAgentFragment[] {
  if (!fragments?.length) return []
  return fragments.map((f) => {
    const contentParts: string[] = [
      `Turn ${f.turnNumber}:`,
      `User: ${f.userMessage}`,
      `Assistant: ${f.assistantMessage}`,
    ]
    if (f.assistantThinking?.trim()) {
      contentParts.splice(2, 0, `Assistant thinking: ${f.assistantThinking}`)
    }
    const source: Citation = {
      docId: f.docId,
      title: `Conversation turn ${f.turnNumber}`,
      url: "",
      app: Apps.ChatMemory,
      entity:
        ChatMemoryEntity.ConversationTurn as unknown as Citation["entity"],
    }
    return {
      id: f.docId,
      content: contentParts.join("\n"),
      source,
      confidence: f.relevance ?? 0.7,
    }
  })
}

export function parseAgentAppIntegrations(agentPrompt?: string): {
  agentAppEnums: Apps[]
  agentSpecificCollectionIds: string[]
  agentSpecificCollectionFolderIds: string[]
  agentSpecificCollectionFileIds: string[]
  selectedItems: {}
} {
  Logger.debug({ agentPrompt }, "Parsing agent prompt for app integrations")
  let agentAppEnums: Apps[] = []
  let agentSpecificCollectionIds: string[] = []
  let agentSpecificCollectionFolderIds: string[] = []
  let agentSpecificCollectionFileIds: string[] = []
  let selectedItem: any = {}

  if (!agentPrompt) {
    return {
      agentAppEnums,
      agentSpecificCollectionIds,
      agentSpecificCollectionFolderIds,
      agentSpecificCollectionFileIds,
      selectedItems: selectedItem,
    }
  }

  let agentPromptData: { appIntegrations?: string[] } = {}

  try {
    agentPromptData = JSON.parse(agentPrompt)
    if (isAppSelectionMap(agentPromptData.appIntegrations)) {
      const { selectedApps, selectedItems } = parseAppSelections(
        agentPromptData.appIntegrations,
      )
      // agentAppEnums = selectedApps.filter(isValidApp);
      selectedItem = selectedItems
      agentAppEnums = [...new Set(selectedApps)]
      // Handle selectedItems logic...
    }

    if (selectedItem[Apps.KnowledgeBase]) {
      const source = selectedItem[Apps.KnowledgeBase]
      for (const itemId of source) {
        if (itemId.startsWith("cl-")) {
          // Entire collection - remove cl- prefix
          agentSpecificCollectionIds.push(itemId.replace(/^cl[-_]/, ""))
        } else if (itemId.startsWith("clfd-")) {
          // Collection folder - remove clfd- prefix
          agentSpecificCollectionFolderIds.push(itemId.replace(/^clfd[-_]/, ""))
        } else if (itemId.startsWith("clf-")) {
          // Collection file - remove clf- prefix
          agentSpecificCollectionFileIds.push(itemId.replace(/^clf[-_]/, ""))
        }
      }
    } else {
      Logger.info("No selected items found ")
    }
    Logger.debug({ agentPromptData }, "Parsed agent prompt data")
  } catch (error) {
    Logger.warn("Failed to parse agentPrompt JSON", {
      error,
      agentPrompt,
    })
    return {
      agentAppEnums,
      agentSpecificCollectionIds,
      agentSpecificCollectionFolderIds,
      agentSpecificCollectionFileIds,
      selectedItems: selectedItem,
    }
  }

  // Remove duplicates
  agentAppEnums = [...new Set(agentAppEnums)]

  return {
    agentAppEnums,
    agentSpecificCollectionIds,
    agentSpecificCollectionFolderIds,
    agentSpecificCollectionFileIds,
    selectedItems: selectedItem,
  }
}
