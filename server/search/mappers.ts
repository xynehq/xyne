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
} from "@/search/types"
import {
  AutocompleteEventSchema,
  AutocompleteFileSchema,
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
            ;(child.fields as any).relevance = child.relevance
            if ((child.fields as any).description) {
              ;(child.fields as any).description = (
                child.fields as VespaEventSearch
              ).description
            }
            return EventResponseSchema.parse(child.fields)
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
