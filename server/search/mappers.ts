// module contains all the transformations
// from vespa to the user accepted types

import type {
  VespaAutocomplete,
  VespaAutocompleteFile,
  VespaAutocompleteResponse,
  VespaAutocompleteUser,
  VespaFile,
  VespaSearchResponse,
  VespaSearchResult,
  VespaUser,
} from "@/search/types"
import {
  AutocompleteFileSchema,
  AutocompleteUserSchema,
  FileResponseSchema,
  SearchResultsSchema,
  UserResponseSchema,
  type Autocomplete,
  type AutocompleteResults,
  type SearchResponse,
} from "@/shared/types"

// Vespa -> Backend/App -> Client

export const VespaSearchResponseToSearchResult = (
  resp: VespaSearchResponse,
): SearchResponse => {
  const { root } = resp
  return {
    count: root.fields?.totalCount ?? 0,
    results: root.children.map((child: VespaSearchResult) => {
      // Narrow down the type based on `sddocname`
      if ((child.fields as VespaFile).sddocname === "file") {
        ;(child.fields as any).type = "file"
        return FileResponseSchema.parse(child.fields)
      } else if ((child.fields as VespaUser).sddocname === "user") {
        ;(child.fields as any).type = "user"
        return UserResponseSchema.parse(child.fields)
      } else {
        throw new Error(
          `Unknown schema type: ${(child.fields as any)?.sddocname}`,
        )
      }
    }),
  }
}

export const VespaAutocompleteResponseToResult = (
  resp: VespaAutocompleteResponse,
): AutocompleteResults => {
  const { root } = resp
  if (!root.children) {
    return { results: [] }
  }
  return {
    results: root.children.map((child: VespaAutocomplete) => {
      // Narrow down the type based on `sddocname`
      if ((child.fields as VespaAutocompleteFile).sddocname === "file") {
        ;(child.fields as any).type = "file"
        ;(child.fields as any).relevance = child.relevance
        return AutocompleteFileSchema.parse(child.fields)
      } else if ((child.fields as VespaAutocompleteUser).sddocname === "user") {
        ;(child.fields as any).type = "user"
        ;(child.fields as any).relevance = child.relevance
        return AutocompleteUserSchema.parse(child.fields)
      } else {
        throw new Error(
          `Unknown schema type: ${(child.fields as any)?.sddocname}`,
        )
      }
    }),
  }
}
