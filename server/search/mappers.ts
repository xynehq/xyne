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

// Vespa -> Backend/App -> Client

export const VespaSearchResponseToSearchResult = (
  resp: VespaSearchResponse,
): SearchResponse => {
  const { root } = resp
  return {
    count: root.fields?.totalCount ?? 0,
    results: root.children
      ? root.children.map((child: VespaSearchResult) => {
          // Narrow down the type based on `sddocname`
          if ((child.fields as VespaFileSearch).sddocname === fileSchema) {
            ;(child.fields as any).type = fileSchema
            ;(child.fields as any).relevance = child.relevance
            ;(child.fields as any).chunks_summary = (
              child.fields as VespaFileSearch
            ).chunks_summary
            return FileResponseSchema.parse(child.fields)
          } else if ((child.fields as VespaUser).sddocname === userSchema) {
            ;(child.fields as any).type = userSchema
            ;(child.fields as any).relevance = child.relevance
            return UserResponseSchema.parse(child.fields)
          } else if (
            (child.fields as VespaMailSearch).sddocname === mailSchema
          ) {
            ;(child.fields as any).type = mailSchema
            ;(child.fields as any).relevance = child.relevance
            if ((child.fields as any).chunks_summary) {
              ;(child.fields as any).chunks_summary = (
                child.fields as VespaMailSearch
              ).chunks_summary
            }
            return MailResponseSchema.parse(child.fields)
          } else if (
            (child.fields as VespaEventSearch).sddocname === eventSchema
          ) {
            ;(child.fields as any).type = eventSchema
            ;(child.fields as VespaEventSearch).relevance = child.relevance
            if ((child.fields as VespaEventSearch).description) {
              ;(child.fields as VespaEventSearch).description = (
                child.fields as VespaEventSearch
              ).description
            }
            return EventResponseSchema.parse(child.fields)
          } else if (
            (child.fields as VespaMailAttachmentSearch).sddocname ===
            mailAttachmentSchema
          ) {
            ;(child.fields as any).type = mailAttachmentSchema
            ;(child.fields as any).relevance = child.relevance
            return MailAttachmentResponseSchema.parse(child.fields)
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
          } else {
            throw new Error(
              `Unknown schema type: ${(child.fields as any)?.sddocname}`,
            )
          }
        })
      : [],
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
          ;(child.fields as any).type = fileSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteFileSchema.parse(child.fields)
        } else if (
          (child.fields as VespaAutocompleteUser).sddocname === userSchema
        ) {
          ;(child.fields as any).type = userSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteUserSchema.parse(child.fields)
        } else if (
          (child.fields as VespaAutocompleteMail).sddocname === mailSchema
        ) {
          ;(child.fields as any).type = mailSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteMailSchema.parse(child.fields)
        } else if (
          (child.fields as VespaAutocompleteEvent).sddocname === eventSchema
        ) {
          ;(child.fields as any).type = eventSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteEventSchema.parse(child.fields)
        } else if (
          (child.fields as VespaAutocompleteUserQueryHistory).sddocname ===
          userQuerySchema
        ) {
          ;(child.fields as any).type = userQuerySchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteUserQueryHSchema.parse(child.fields)
        } else if (
          (child.fields as VespaAutocompleteMailAttachment).sddocname ===
          mailAttachmentSchema
        ) {
          ;(child.fields as any).type = mailAttachmentSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteMailAttachmentSchema.parse(child.fields)
        } else if (
          (child.fields as VespaAutocompleteChatUser).sddocname ===
          chatUserSchema
        ) {
          ;(child.fields as any).type = chatUserSchema
          ;(child.fields as any).relevance = child.relevance
          return AutocompleteChatUserSchema.parse(child.fields)
        } else {
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
