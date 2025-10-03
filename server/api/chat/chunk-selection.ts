import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { Span } from "@/tracer"
import type { VespaSearchResult } from "@xyne/vespa-ts"

const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

/**
 * Calculate the number of chunks to allocate per document based on document relevance
 * Returns an array where each index corresponds to a document in searchResults
 */
export async function getChunkCountPerDoc(
  searchResults: VespaSearchResult[],
  topN: number,
  email: string,
  span?: Span
): Promise<number[]> {
  const mainSpan = span?.startSpan("get_chunk_count_per_doc")
  mainSpan?.setAttribute("search_results_count", searchResults.length)
  mainSpan?.setAttribute("top_n", topN)
  
  try {
    if (!searchResults || searchResults.length === 0) {
      loggerWithChild({ email }).warn("No search results provided")
      mainSpan?.end()
      return []
    }

    // Extract document relevance scores from search results
    const documentRelevances = searchResults.map((result, index) => {
      const fields = result?.fields || {} as any
      const docId = fields.docId || `doc_${index}`
      const textChunks = fields.chunks_summary || fields.chunks || []
      const chunksLength = (Array.isArray(textChunks) ? textChunks.length : 0)
      const relevanceScore = result.relevance || 0
      
      return {
        docId,
        relevanceScore,
        index,
        chunksLength,
      }
    })

    // Calculate total relevance across all documents
    const totalRelevance = documentRelevances.reduce((sum, dr) => sum + dr.relevanceScore, 0)
    
    if (totalRelevance === 0) {
      loggerWithChild({ email }).warn("Total relevance is 0, falling back to equal distribution")
      // Fallback: distribute chunks equally if no relevance scores
      const chunksPerDoc = Math.ceil(topN / documentRelevances.length)
      const result = documentRelevances.map((dr) => Math.min(chunksPerDoc, dr.chunksLength))
      
      mainSpan?.setAttribute("fallback_used", true)
      mainSpan?.setAttribute("chunks_per_doc", chunksPerDoc)
      mainSpan?.end()
      
      return result
    }
    
    // Sort documents by their relevance score (highest first) but keep track of original indices
    const sortedDocuments = [...documentRelevances].sort((a, b) => b.relevanceScore - a.relevanceScore)
    
    // Calculate chunks per document based on proportional relevance
    const chunksAllocation = new Array(documentRelevances.length).fill(0)
    let remainingChunks = topN

    let round = 1
    while (remainingChunks > 0) {
      const active = sortedDocuments.filter(d => chunksAllocation[d.index] < d.chunksLength)

      if (active.length === 0) break

      // Sum relevance over active docs
      let sumActiveRel = active.reduce((s, d) => s + d.relevanceScore, 0)

      // If all remaining active docs have zero relevance, fall back to equal distribution among active
      if (sumActiveRel === 0) {
        loggerWithChild({ email }).warn(
          `All active docs have zero relevance, falling back to equal distribution among ${active.length} docs`
        )
        let assignedThisRound = 0
        for (const d of active) {
          if (remainingChunks <= 0) break
          const capLeft = d.chunksLength - chunksAllocation[d.index]
          if (capLeft <= 0) continue
          const take = Math.min(1, capLeft, remainingChunks)
          chunksAllocation[d.index] += take
          remainingChunks -= take
          assignedThisRound += take
        }
        if (assignedThisRound === 0) break
        continue
      }

      // First pass: floor of proportional ideal, capped by capacity
      const floorAdds: Record<number, number> = {}
      let sumFloors = 0
      const fracs: Array<{ idx: number; frac: number; rel: number; capLeft: number }> = []

      for (const d of active) {
        const idx = d.index
        const capLeft = d.chunksLength - chunksAllocation[idx]
        if (capLeft <= 0) continue

        const ideal = (remainingChunks * d.relevanceScore) / sumActiveRel
        const floored = Math.min(capLeft, Math.floor(ideal))
        floorAdds[idx] = floored
        sumFloors += floored
      }

      let leftover = remainingChunks - sumFloors

      const assignedThisRound = remainingChunks - Math.max(0, leftover)
      if (assignedThisRound <= 0) break

      // Finalize this round's assignments
      for (const d of active) {
        const idx = d.index
        if (floorAdds[idx]) {
          chunksAllocation[idx] += floorAdds[idx]
        }
      }
      remainingChunks -= assignedThisRound
      loggerWithChild({ email }).info(
        `Round ${round} complete: totalAssigned=${assignedThisRound}, stillRemaining=${remainingChunks}`
      )
      round++
    }
    
    mainSpan?.setAttribute("total_documents", documentRelevances.length)
    mainSpan?.setAttribute("chunks_allocated", JSON.stringify(chunksAllocation))
    mainSpan?.setAttribute("total_relevance", totalRelevance)
    mainSpan?.end()
    
    return chunksAllocation
} catch (error) {
    mainSpan?.setAttribute("error", getErrorMessage(error))
    mainSpan?.end()
    loggerWithChild({ email }).error(
      error,
      `Error in getChunkCountPerDoc: ${getErrorMessage(error)}`
    )
    
    return []
  }
}
