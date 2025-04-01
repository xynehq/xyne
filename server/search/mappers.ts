// module contains all the transformations
// from vespa to the user accepted types

import {
  fileSchema,
  mailSchema,
  userSchema,
  type VespaAutocomplete,
  type VespaAutocompleteFile,
  type VespaAutocompleteMail,
  type VespaAutocompleteResponse,
  type VespaAutocompleteUser,
  type VespaSearchResponse,
  type VespaSearchResult,
  type VespaUser,
  MailResponseSchema,
  type VespaFileSearch,
  type VespaMailSearch,
  type VespaAutocompleteEvent,
  eventSchema,
  type VespaEventSearch,
  userQuerySchema,
  type VespaAutocompleteUserQueryHistory,
  type VespaMailAttachmentSearch,
  mailAttachmentSchema,
  MailAttachmentResponseSchema,
  type VespaAutocompleteMailAttachment,
  type ScoredChunk,
  VespaMatchFeatureSchema,
  type VespaAutocompleteChatUser,
  chatUserSchema,
  type VespaChatMessageSearch,
  chatMessageSchema,
  ChatMessageResponseSchema,
} from "@/search/types"
import {
  AutocompleteChatUserSchema,
  AutocompleteEventSchema,
  AutocompleteFileSchema,
  AutocompleteMailAttachmentSchema,
  AutocompleteMailSchema,
  AutocompleteUserQueryHSchema,
  AutocompleteUserSchema,
  EventResponseSchema,
  FileResponseSchema,
  UserResponseSchema,
  type AutocompleteResults,
  type SearchResponse,
} from "@/shared/types"
import type { z } from "zod"
import type { AppEntityCounts } from "@/search/vespa"
import { chunkDocument } from "@/chunks"
import { scale } from "@/utils"

function countHiTags(str: string): number {
  // Regular expression to match both <hi> and </hi> tags
  const regex = /<\/?hi>/g
  const matches = str.match(regex)
  return matches ? matches.length : 0
}

export const getSortedScoredChunks = (
  matchfeatures: z.infer<typeof VespaMatchFeatureSchema>,
  existingChunksSummary: string[],
  maxChunks?: number,
): ScoredChunk[] => {
  // return if no chunks summary
  if (!existingChunksSummary?.length) {
    return []
  }

  if (
    matchfeatures?.chunk_scores?.cells &&
    !Object.keys(matchfeatures?.chunk_scores?.cells).length
  ) {
    const mappedChunks = existingChunksSummary.map((v, index) => ({
      chunk: v,
      score: 0,
      index,
    }))
    return maxChunks ? mappedChunks.slice(0, maxChunks) : mappedChunks
  }

  const chunkScores = matchfeatures.chunk_scores.cells

  // add chunks with chunk scores
  const chunksWithIndices = existingChunksSummary.map((chunk, index) => ({
    index,
    chunk,
    score: scale(chunkScores[index]) || 0, // Default to 0 if doesn't have score
  }))

  const filteredChunks = chunksWithIndices.filter(
    ({ index }) => index in chunkScores,
  )

  const sortedChunks = filteredChunks.sort((a, b) => b.score - a.score)

  return maxChunks ? sortedChunks.slice(0, maxChunks) : sortedChunks
}

// Vespa -> Backend/App -> Client
const maxSearchChunks = 1

export const VespaSearchResponseToSearchResult = (
  resp: VespaSearchResponse,
): SearchResponse => {
  const { root, trace } = resp
  const children = root.children || []
  // Access the nested children array within the trace object
  const traceInfo = trace?.children || []

  // Filter out any potential trace items from children if they exist
  const searchHits = children.filter(
    (child: any) => !child.id?.startsWith("trace:"),
  )

  return {
    count: root.fields?.totalCount ?? 0,
    results: searchHits
      ? searchHits.map((child: VespaSearchResult) => {
          // Narrow down the type based on `sddocname`
          if ((child.fields as VespaFileSearch).sddocname === fileSchema) {
            // Directly use child.fields which includes matchfeatures
            const fields = child.fields as VespaFileSearch & { type?: string }
            fields.type = fileSchema
            fields.relevance = child.relevance

            // matchfeatures is already part of fields, no need to assign separately
            fields.chunks_summary = getSortedScoredChunks(
              fields.matchfeatures,
              fields.chunks_summary as string[],
              maxSearchChunks,
            )

            return FileResponseSchema.parse(fields)
          } else if ((child.fields as VespaUser).sddocname === userSchema) {
            // Directly use child.fields
            const fields = child.fields as VespaUser & {
              type?: string
              chunks_summary?: string[]
            }
            fields.type = userSchema
            fields.relevance = child.relevance
            // matchfeatures is already part of fields (if returned by Vespa)
            // Ensure chunks_summary processing happens before parsing
            fields.chunks_summary?.sort(
              (a, b) => countHiTags(b) - countHiTags(a),
            )
            fields.chunks_summary = fields.chunks_summary?.slice(
              0,
              maxSearchChunks,
            )
            return UserResponseSchema.parse(fields)
          } else if (
            (child.fields as VespaMailSearch).sddocname === mailSchema
          ) {
            // Directly use child.fields
            const fields = child.fields as VespaMailSearch & { type?: string }
            fields.type = mailSchema
            fields.relevance = child.relevance
            // matchfeatures is already part of fields
            fields.chunks_summary = getSortedScoredChunks(
              fields.matchfeatures,
              fields.chunks_summary as string[],
              maxSearchChunks,
            )
            return MailResponseSchema.parse(fields)
          } else if (
            (child.fields as VespaEventSearch).sddocname === eventSchema
          ) {
            // Directly use child.fields
            const fields = child.fields as VespaEventSearch & {
              type?: string
              chunks_summary?: string[]
            }
            fields.type = eventSchema
            fields.relevance = child.relevance
            // matchfeatures is already part of fields (if returned by Vespa)
            // creating a new property
            // Ensure chunks_summary processing happens before parsing
            fields.chunks_summary = fields.description
              ? chunkDocument(fields.description)
                  .map((v) => v.chunk)
                  .sort((a, b) => countHiTags(b) - countHiTags(a))
                  .slice(0, maxSearchChunks)
              : []
            // This line seems redundant as it's assigned above? Keeping it for now.
            fields.chunks_summary = fields.chunks_summary?.slice(
              0,
              maxSearchChunks,
            )
            return EventResponseSchema.parse(fields)
          } else if (
            (child.fields as VespaMailAttachmentSearch).sddocname ===
            mailAttachmentSchema
          ) {
            // Directly use child.fields
            const fields = child.fields as VespaMailAttachmentSearch & {
              type?: string
            }
            fields.type = mailAttachmentSchema
            fields.relevance = child.relevance
            // matchfeatures is already part of fields
            fields.chunks_summary = getSortedScoredChunks(
              fields.matchfeatures,
              fields.chunks_summary as string[],
              maxSearchChunks,
            )
            return MailAttachmentResponseSchema.parse(fields)
          } else if (
            (child.fields as VespaChatMessageSearch).sddocname ===
            chatMessageSchema
          ) {
            ;(child.fields as any).type = chatMessageSchema
            ;(child.fields as VespaChatMessageSearch).relevance =
              child.relevance
            ;(child.fields as VespaChatMessageSearch).attachmentIds = []
            ;(child.fields as VespaChatMessageSearch).mentions = []
            if (!(child.fields as VespaChatMessageSearch).teamId) {
              ;(child.fields as VespaChatMessageSearch).teamId = ""
            }
            return ChatMessageResponseSchema.parse(child.fields)
          }
          else {
            throw new Error(
              `Unknown schema type: ${(child.fields as any)?.sddocname ?? "undefined"}`,
            )
          }
        })
      : [],
    trace: traceInfo, // Add trace information to the top-level response
  }
}

export const VespaAutocompleteResponseToResult = (
  resp: VespaAutocompleteResponse,
): AutocompleteResults => {
  const { root } = resp
  if (!root.children) {
    return { results: [] }
  }
  let queryHistoryCount = 0
  return {
    results: root.children
      .map((child: VespaAutocomplete) => {
        // Narrow down the type based on `sddocname`
        if ((child.fields as VespaAutocompleteFile).sddocname === fileSchema) {
          const fields = child.fields as VespaAutocompleteFile & {
            type?: string
          }
          fields.type = fileSchema
          fields.relevance = child.relevance
          return AutocompleteFileSchema.parse(fields)
        } else if (
          (child.fields as VespaAutocompleteUser).sddocname === userSchema
        ) {
          const fields = child.fields as VespaAutocompleteUser & {
            type?: string
          }
          fields.type = userSchema
          fields.relevance = child.relevance
          return AutocompleteUserSchema.parse(fields)
        } else if (
          (child.fields as VespaAutocompleteMail).sddocname === mailSchema
        ) {
          const fields = child.fields as VespaAutocompleteMail & {
            type?: string
          }
          fields.type = mailSchema
          fields.relevance = child.relevance
          return AutocompleteMailSchema.parse(fields)
        } else if (
          (child.fields as VespaAutocompleteEvent).sddocname === eventSchema
        ) {
          const fields = child.fields as VespaAutocompleteEvent & {
            type?: string
          }
          fields.type = eventSchema
          fields.relevance = child.relevance
          return AutocompleteEventSchema.parse(fields)
        } else if (
          (child.fields as VespaAutocompleteUserQueryHistory).sddocname ===
          userQuerySchema
        ) {
          const fields = child.fields as VespaAutocompleteUserQueryHistory & {
            type?: string
          }
          fields.type = userQuerySchema
          fields.relevance = child.relevance
          return AutocompleteUserQueryHSchema.parse(fields)
        } else if (
          (child.fields as VespaAutocompleteMailAttachment).sddocname ===
          mailAttachmentSchema
        ) {
          const fields = child.fields as VespaAutocompleteMailAttachment & {
            type?: string
          }
          fields.type = mailAttachmentSchema
          fields.relevance = child.relevance
          return AutocompleteMailAttachmentSchema.parse(fields)
        } else if (
          (child.fields as VespaAutocompleteChatUser).sddocname ===
          chatUserSchema
        ) {
          ;(child.fields as any).type = chatUserSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteChatUserSchema.parse(child.fields)
        }
         else {
          throw new Error(
            `Unknown schema type: ${(child.fields as any)?.sddocname}`,
          )
        }
      })
      .filter((d) => {
        if (d.type === userQuerySchema) {
          return queryHistoryCount++ < 3
        }
        return true
      }),
  }
}

export function handleVespaGroupResponse(
  response: VespaSearchResponse,
): AppEntityCounts {
  const appEntityCounts: AppEntityCounts = {}

  // Navigate to the first level of groups
  const groupRoot = response.root.children?.[0] // Assuming this is the group:root level
  if (!groupRoot || !("children" in groupRoot)) return appEntityCounts // Safeguard for empty responses

  // Navigate to the app grouping (e.g., grouplist:app)
  const appGroup = groupRoot.children?.[0]
  if (!appGroup || !("children" in appGroup)) return appEntityCounts // Safeguard for missing app group

  // Iterate through the apps
  // @ts-ignore
  for (const app of appGroup.children) {
    const appName = app.value as string // Get the app name
    appEntityCounts[appName] = {} // Initialize the app entry

    // Navigate to the entity grouping (e.g., grouplist:entity)
    const entityGroup = app.children?.[0]
    if (!entityGroup || !("children" in entityGroup)) continue // Skip if no entities

    // Iterate through the entities
    // @ts-ignore
    for (const entity of entityGroup.children) {
      const entityName = entity.value as string // Get the entity name
      const count = entity.fields?.["count()"] || 0 // Get the count or default to 0
      appEntityCounts[appName][entityName] = count // Assign the count to the app-entity pair
    }
  }

  return appEntityCounts // Return the final map
}
