import {
  Apps,
  SearchModes,
  type Entity,
  type EventStatusType,
  type MailParticipant,
  type VespaQueryConfig,
  type VespaSchema,
  type VespaSearchResponse,
} from "@xyne/vespa-ts"
import { searchVespaAgent, searchVespa } from "@/search/vespa"
import {
  formatSearchToolResponse,
  formatSearchToolResponseAsRawDocuments,
} from "../utils"
import { expandEmailThreadsInResults } from "@/api/chat/utils"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { MinimalAgentFragment } from "../../types"
import type { ToolRawDocument } from "@/api/chat/agent-schemas"
import { type KnowledgeBaseSelection } from "@/api/chat/knowledgeBaseSelections"

const Logger = getLogger(Subsystem.Chat)

interface UnifiedSearchOptions {
  email: string
  query?: string | null
  app?: Apps | Apps[] | null
  entity?: Entity | Entity[] | null
  timestampRange?: {
    from?: number | string | null
    to?: number | string | null
  } | null
  limit?: number
  offset?: number
  orderDirection?: "asc" | "desc"
  excludedIds?: string[]
  agentAppEnums?: Apps[]
  schema?: VespaSchema | null
  dataSourceIds?: string[] | undefined
  mailParticipant?: MailParticipant | null
  orderBy?: "asc" | "desc"
  owner?: string | null
  eventStatus?: EventStatusType | null
  eventAttendees?: string[] | null
  channelIds?: string[]
  selectedItems?: {}
  collectionIds?: string[]
  collectionFolderIds?: string[]
  collectionFileIds?: string[]
  collectionSelections?: KnowledgeBaseSelection[]
  /** When set with query, KB schema-only docs get precomputed DB context (live SQL results). */
  userId?: number | null
  workspaceId?: number | null
}

export async function executeVespaSearch(
  options: UnifiedSearchOptions,
): Promise<{
  fragments: MinimalAgentFragment[]
  rawDocuments: ToolRawDocument[]
}> {
  const {
    email,
    query,
    app,
    entity,
    timestampRange,
    limit = 10,
    offset = 0,
    orderDirection = "desc",
    excludedIds,
    agentAppEnums,
    schema,
    mailParticipant,
    channelIds,
    collectionIds,
    collectionFolderIds,
    collectionFileIds,
    collectionSelections,
    selectedItems,
    orderBy,
    owner,
    eventStatus,
    eventAttendees,
    userId,
    workspaceId,
  } = options

  if (!query || query.trim() === "") {
    throw new Error("No query provided for search.")
  }

  let searchResults: VespaSearchResponse | null = null
  const commonSearchOptions: Partial<VespaQueryConfig> = {
    limit,
    alpha: 0.5,
    excludedIds,
    offset,
    rankProfile: SearchModes.NativeRank,
    mailParticipants: mailParticipant || null,
    orderBy,
    owner,
    eventStatus,
    attendees: eventAttendees || null,
  }

  const fromTimestamp = timestampRange?.from
    ? new Date(timestampRange.from).getTime()
    : undefined
  const toTimestamp = timestampRange?.to
    ? new Date(timestampRange.to).getTime()
    : undefined

  const resolvedCollectionSelections =
    collectionSelections && collectionSelections.length
      ? collectionSelections
      : buildCollectionSelectionsFromIds(
          collectionIds,
          collectionFolderIds,
          collectionFileIds,
        )

  if (agentAppEnums && agentAppEnums.length > 0) {
    const appsToCheck = Array.isArray(app) ? app : app ? [app] : []
    const invalidApps = appsToCheck.filter((a) => !agentAppEnums.includes(a))
    if (invalidApps.length > 0) {
      const errorMsg = `${invalidApps.join(", ")} ${invalidApps.length > 1 ? "are" : "is"} not allowed app${invalidApps.length > 1 ? "s" : ""} for this agent. Cannot search.`
      throw new Error(errorMsg)
    }
    searchResults = await searchVespaAgent(
      query,
      email,
      app ?? null,
      entity ?? null,
      agentAppEnums,
      {
        ...commonSearchOptions,
        timestampRange:
          fromTimestamp && toTimestamp
            ? { from: fromTimestamp, to: toTimestamp }
            : undefined,
        dataSourceIds: options.dataSourceIds ?? undefined,
        channelIds,
        collectionSelections: resolvedCollectionSelections,
        selectedItem: selectedItems,
      },
    )
  } else {
    searchResults = await searchVespa(
      query,
      email,
      app ?? null,
      entity ?? null,
      {
        ...commonSearchOptions,
        timestampRange:
          fromTimestamp && toTimestamp
            ? { from: fromTimestamp, to: toTimestamp }
            : undefined,
        collectionSelections: resolvedCollectionSelections,
      },
    )
  }

  // Expand email threads if results contain emails
  if (searchResults?.root?.children && searchResults.root.children.length > 0) {
    searchResults.root.children = await expandEmailThreadsInResults(
      searchResults.root.children,
      email,
    )
  }

  const rawDocuments = await formatSearchToolResponseAsRawDocuments(
    searchResults,
    { email },
  )

  const fragments = await formatSearchToolResponse(searchResults, {
    query,
    app: Array.isArray(app) ? app.join(", ") : (app ?? undefined),
    timeRange:
      fromTimestamp && toTimestamp
        ? { startTime: fromTimestamp, endTime: toTimestamp }
        : undefined,
    offset,
    limit,
    searchType: "Global search result",
    userId: userId ?? undefined,
    workspaceId: workspaceId ?? undefined,
  })

  return { fragments, rawDocuments }
}

function buildCollectionSelectionsFromIds(
  collectionIds?: string[],
  collectionFolderIds?: string[],
  collectionFileIds?: string[],
): KnowledgeBaseSelection[] | undefined {
  if (
    (!collectionIds || collectionIds.length === 0) &&
    (!collectionFolderIds || collectionFolderIds.length === 0) &&
    (!collectionFileIds || collectionFileIds.length === 0)
  ) {
    return undefined
  }

  const selection: KnowledgeBaseSelection = {}
  if (collectionIds?.length) selection.collectionIds = collectionIds
  if (collectionFolderIds?.length)
    selection.collectionFolderIds = collectionFolderIds
  if (collectionFileIds?.length) selection.collectionFileIds = collectionFileIds

  return [selection]
}
