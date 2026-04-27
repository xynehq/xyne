import { useMemo } from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "@/api"
import { getTopUniqueTokens, TextTokenizer } from "@/utils/textHighlighting"

/**
 * Vespa highlight search result chunk interface
 */
export interface VespaHighlightChunk {
  id: number
  text: string // Contains <hi> tags from Vespa
  relevance: number
}

/**
 * Hook return type for useVespaHighlight
 */
export interface VespaHighlightResult {
  chunk: VespaHighlightChunk | null
  highlights: string[] // Extracted <hi> content
  tokens: string[] // Tokenized and normalized highlights
  isLoading: boolean
  error: Error | null
}

/**
 * Options for useVespaHighlight hook
 */
export interface UseVespaHighlightOptions {
  query: string
  docId: string
  chunkId?: number
  enabled?: boolean
  caseSensitive?: boolean
}

/**
 * Cache key generator for Vespa highlight search
 */
function generateCacheKey(
  query: string,
  docId: string,
  chunkId?: number,
): string {
  return `vespa-highlight:${docId}:${chunkId !== undefined ? chunkId : "all"}:${query.toLowerCase().trim()}`
}

/**
 * Hook to fetch Vespa highlight search results for keyword highlighting
 * 
 * This hook performs an async Vespa search to get highlighted (<hi> tagged) content
 * for a specific document chunk. The extracted highlights are tokenized and normalized
 * to be used as keywords for enhanced text highlighting.
 * 
 * Features:
 * - Caching by docId + chunkId + query (via React Query)
 * - Automatic extraction and tokenization of <hi> tags
 * - Limiting to top 5 longest unique tokens for better specificity
 * - Error handling with fallback
 * 
 * @example
 * ```tsx
 * const { chunk, tokens, isLoading } = useVespaHighlight({
 *   query: "What is the authentication flow?",
 *   docId: "doc_123",
 *   chunkId: "0",
 *   enabled: !!queryText,
 * })
 * ```
 * 
 * @param options - Configuration options
 * @returns VespaHighlightResult with chunk data, extracted highlights, and tokens
 */
export function useVespaHighlight(
  options: UseVespaHighlightOptions,
): VespaHighlightResult {
  const { query, docId, chunkId, enabled = true, caseSensitive = false } = options

  const cacheKey = generateCacheKey(query, docId, chunkId)

  const { data, isLoading, error } = useQuery<{
    chunk: VespaHighlightChunk | null
    highlights: string[]
  }>({
    queryKey: ["vespa-highlight", cacheKey],
    queryFn: async () => {
      if (!query?.trim() || !docId) {
        return { chunk: null, highlights: [] }
      }

      try {
        const response = await api.highlight.search.$post({
          json: {
            query: query.trim(),
            docId,
            chunkId,
          },
        })

        if (!response.ok) {
          throw new Error(`Highlight search failed: ${response.status}`)
        }

        const result = await response.json()

        return {
          chunk: result.chunk,
          highlights: result.highlights || [],
        }
      } catch (err) {
        console.error("[useVespaHighlight] Error fetching highlights:", err)
        throw err
      }
    },
    enabled: enabled && !!query?.trim() && !!docId,
    staleTime: 1000 * 60 * 10, // 10 minutes - Vespa highlights don't change often
    gcTime: 1000 * 60 * 30, // 30 minutes - Keep in cache for longer
    refetchOnWindowFocus: false,
    retry: 2,
    retryDelay: (attemptIndex) => Math.min(1000 * 2 ** attemptIndex, 30000),
  })

  const tokens = useMemo(() => {
    if (!data?.highlights?.length) return []
    const allTokens = data.highlights.flatMap((text) =>
      TextTokenizer.tokenize(text, caseSensitive),
    )
    return getTopUniqueTokens(allTokens, 5)
  }, [data?.highlights, caseSensitive])

  return {
    chunk: data?.chunk || null,
    highlights: data?.highlights || [],
    tokens,
    isLoading,
    error: error as Error | null,
  }
}

/**
 * Helper function to prefetch Vespa highlight search results
 * Useful for preloading highlights when a citation is clicked
 * 
 * @param queryClient - React Query client instance
 * @param options - Options for the highlight search
 */
export function prefetchVespaHighlight(
  queryClient: ReturnType<typeof useQueryClient>,
  options: UseVespaHighlightOptions,
): Promise<void> {
  const { query, docId, chunkId } = options

  if (!query?.trim() || !docId) {
    return Promise.resolve()
  }

  const cacheKey = generateCacheKey(query, docId, chunkId)

  return queryClient.prefetchQuery({
    queryKey: ["vespa-highlight", cacheKey],
    queryFn: async () => {
      const response = await api.highlight.search.$post({
        json: {
          query: query.trim(),
          docId,
          chunkId,
        },
      })

      if (!response.ok) {
        throw new Error(`Highlight search failed: ${response.status}`)
      }

      return response.json()
    },
    staleTime: 1000 * 60 * 10,
  })
}

/**
 * Invalidate cached Vespa highlight results for a specific document/chunk
 * 
 * @param queryClient - React Query client instance
 * @param docId - Document ID to invalidate
 * @param chunkId - Optional chunk ID to invalidate (if not provided, invalidates all chunks for doc)
 */
export function invalidateVespaHighlightCache(
  queryClient: ReturnType<typeof useQueryClient>,
  docId: string,
  chunkId?: number,
): void {
  queryClient.invalidateQueries({
    queryKey: ["vespa-highlight"],
    predicate: (query) => {
      const key = query.queryKey[1] as string
      if (!key) return false

      if (chunkId !== undefined) {
        return key.includes(`vespa-highlight:${docId}:${chunkId}:`)
      }
      return key.includes(`vespa-highlight:${docId}:`)
    },
  })
}

export default useVespaHighlight
