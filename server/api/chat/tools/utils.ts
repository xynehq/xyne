import { z, type ZodType } from "zod"
import type { Tool } from "@xynehq/jaf"
import { ToolErrorCodes, ToolResponse } from "@xynehq/jaf"
import {
  Apps,
  fileSchema,
  GoogleApps,
  type VespaSearchResponse,
  type VespaSearchResults,
} from "@xyne/vespa-ts"
import {
  isAppSelectionMap,
  parseAppSelections,
  searchToCitation,
} from "@/api/chat/utils"

import { answerContextMap } from "@/ai/context"
import type { UserMetadataType } from "@/types"
import { getDateForAI } from "@/utils/index"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { getLogger, Subsystem } from "@/logger"
import config from "@/config"
const Logger = getLogger(Subsystem.Chat)

export const userMetadata: UserMetadataType = {
  userTimezone: "Asia/Kolkata",
  dateForAI: getDateForAI({ userTimeZone: "Asia/Kolkata" }),
}

export async function formatSearchToolResponse(
  searchResults: VespaSearchResponse | null,
  searchContext: {
    query?: string
    app?: string
    labels?: string[]
    timeRange?: { startTime: number; endTime: number }
    offset?: number
    limit?: number
    searchType?: string
  },
): Promise<{
  result: string
  summary: string
  contexts: MinimalAgentFragment[]
}> {
  const children = (searchResults?.root?.children || []).filter(
    (item): item is VespaSearchResults =>
      !!(item.fields && "sddocname" in item.fields),
  )

  if (children.length === 0) {
    return {
      result: `No ${searchContext.searchType || "results"} found.`,
      summary: `No ${searchContext.searchType || "results"} found.`,
      contexts: [],
    }
  }

  const fragments: MinimalAgentFragment[] = await Promise.all(
    children.map(async (r) => {
      const citation = searchToCitation(r)
      return {
        id: citation.docId,
        content: await answerContextMap(
          r,
          userMetadata,
          config.maxDefaultSummary,
        ),
        source: citation,
        confidence: r.relevance || 0.7,
      }
    }),
  )

  let summaryText = `Found ${fragments.length} ${searchContext.searchType || "result"}${fragments.length !== 1 ? "s" : ""}`

  if (searchContext.query) {
    summaryText += ` matching '${searchContext.query}'`
  }

  if (searchContext.app) {
    summaryText += ` in ${searchContext.app}`
  }

  if (searchContext.labels && searchContext.labels.length > 0) {
    summaryText += ` with labels: ${searchContext.labels.join(", ")}`
  }

  if (searchContext.timeRange) {
    summaryText += ` from ${new Date(searchContext.timeRange.startTime).toLocaleDateString()} to ${new Date(searchContext.timeRange.endTime).toLocaleDateString()}`
  }

  if (searchContext.offset && searchContext.offset > 0) {
    summaryText += ` (showing items ${searchContext.offset + 1} to ${searchContext.offset + fragments.length})`
  }

  const topItemsList = fragments
    .slice(0, 3)
    .map((f) => `- "${f.source.title || "Untitled"}"`)
    .join("\n")
  summaryText += `.\nTop results:\n${topItemsList}`

  return {
    result: fragments.map((v) => v.content).join("\n"),
    contexts: fragments,
    summary: summaryText,
  }
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
