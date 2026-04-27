import type { Context } from "hono"
import { set, z } from "zod"
import { HTTPException } from "hono/http-exception"
import { searchVespaInFiles, searchCollectionRAG } from "@/search/vespa"
import { getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import config from "@/config"

const loggerWithChild = getLoggerWithChild(Subsystem.Api)

const { JwtPayloadKey } = config

/**
 * Schema for highlight search request
 * Validates the incoming POST request body
 */
export const highlightSearchSchema = z.object({
  query: z.string().min(1),
  docId: z.string().min(1),
  chunkId: z.number().optional(),
})

export type HighlightSearchRequest = z.infer<typeof highlightSearchSchema>

/**
 * Highlight search result chunk interface
 */
interface HighlightChunkResult {
  id: number
  text: string // Contains <hi> tags from Vespa
  relevance: number
}

/**
 * Highlight search API response
 */
interface HighlightSearchResponse {
  chunk: HighlightChunkResult | null
  highlights: string[] // Extracted <hi> content
}

/**
 * POST /api/v1/highlight/search
 * 
 * Performs a Vespa search for the given query and filters results to return
 * the highlighted chunk content for a specific document. The response includes
 * the raw Vespa search result with <hi> tags which can be used for enhanced
 * keyword highlighting on the frontend.
 * 
 * @param c - Hono context
 * @returns JSON response with chunk data and extracted highlights
 */
export const HighlightSearchApi = async (c: Context) => {
  const { sub } = c.get(JwtPayloadKey)
  const email = sub
  const body = await c.req.json()
  const { query, docId, chunkId } = body as HighlightSearchRequest

  loggerWithChild({ email: email }).info(
    `[HighlightSearch] Query: "${query}", docId: ${docId}, chunkId: ${chunkId || "N/A"}`,
  )

  if (!query?.trim() || !docId) {
    throw new HTTPException(400, {
      message: "Query and docId are required",
    })
  }

  try {
    // Determine if this is a collection file
    const isCollectionFile = docId.startsWith("clf-") || docId.startsWith("att_")
    
    let vespaResults
    
    if (isCollectionFile) {
      loggerWithChild({ email: email }).info(
        `[HighlightSearch] Using searchCollectionRAG for collection file: ${docId}`,
      )
      vespaResults = await searchCollectionRAG(query, [docId], undefined)
    } else {
      vespaResults = await searchVespaInFiles(
        query,
        email,
        [docId],
        {
          limit: 1,
        },
      )
    }

    // Find the best matching chunk
    let bestChunk: HighlightChunkResult | null = null
    let highlights: string[] = []

    if (vespaResults?.root?.children && vespaResults.root.children.length > 0) {
      // Find the document matching docId
      for (const child of vespaResults.root.children) {
        const fields = (child as any).fields
        if (!fields) continue

        const childId = fields.docId || fields.documentid || child.id
        if (!childId || (childId !== docId)) {
          continue
        }

        // If chunkId is specified, extract the specific chunk from the document
        if (chunkId !== undefined && chunkId !== null) {
          // Check for summary fields (from search results)
          const chunksPos = fields.chunks_pos_summary || fields.chunks_pos
          const chunksArray = fields.chunks_summary || fields.chunks

          if (chunksPos && chunksArray && Array.isArray(chunksPos) && Array.isArray(chunksArray)) {
            // Find the position in chunks_pos that matches the requested chunk index
            const posIndex = chunksPos.findIndex((pos: number) => pos === chunkId)

            if (posIndex !== -1 && chunksArray[posIndex]) {
              const chunkText = chunksArray[posIndex]
              bestChunk = {
                id: chunkId,
                text: chunkText,
                relevance: child.relevance || 0,
              }
              highlights = extractHiTags(chunkText)
            }
          }
        }
        
        // Break after finding the matching document
        break
      }
    }

    loggerWithChild({ email: email }).info(
      `[HighlightSearch] Found ${highlights.length} highlights for docId: ${docId}`,
    )

    const response: HighlightSearchResponse = {
      chunk: bestChunk,
      highlights,
    }

    return c.json(response)
  } catch (error) {
    loggerWithChild({ email: email }).error(
      error,
      `[HighlightSearch] Error searching for highlights: query="${query}", docId=${docId}`,
    )
    throw new HTTPException(500, {
      message: "Error searching for document highlights",
    })
  }
}

/**
 * Extract content from <hi> tags in Vespa search results
 * 
 * @param htmlText - Text containing Vespa <hi> highlight tags
 * @returns Array of extracted highlight content
 */
function extractHiTags(htmlText: string): string[] {
  if (!htmlText) return []
  
  const regex = /<hi>([^<]*)<\/hi>/g
  const matches: string[] = []
  let match
  
  while ((match = regex.exec(htmlText)) !== null) {
    if (match[1] && match[1].trim()) {
      matches.push(match[1].trim())
    }
  }
  
  // Remove duplicates while preserving order
  return [...new Set(matches)]
}

export default HighlightSearchApi