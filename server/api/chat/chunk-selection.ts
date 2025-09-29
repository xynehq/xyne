import { getLogger, getLoggerWithChild } from "@/logger"
import { Subsystem } from "@/types"
import { getErrorMessage } from "@/utils"
import type { Span } from "@/tracer"

const Logger = getLogger(Subsystem.Chat)
const loggerWithChild = getLoggerWithChild(Subsystem.Chat)

/**
 * Calculate the number of chunks to allocate per document based on document relevance
 * Returns an array where each index corresponds to a document in searchResults
 */
export async function getChunkCountPerDoc(
  searchResults: any[],
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
      const fields = result?.fields || {}
      const docId = fields.docId || `doc_${index}`
      const textChunks = fields.chunks_summary || fields.chunks || []
      const chunksLength = (Array.isArray(textChunks) ? textChunks.length : 0)
      const relevanceScore = result.relevance || 0
      
      return {
        docId,
        relevanceScore,
        index, // Keep track of original position
        chunksLength,
      }
    })

    // Calculate total relevance across all documents
    const totalRelevance = documentRelevances.reduce((sum, dr) => sum + dr.relevanceScore, 0)
    
    if (totalRelevance === 0) {
      loggerWithChild({ email }).warn("Total relevance is 0, falling back to equal distribution")
      // Fallback: distribute chunks equally if no relevance scores
      const chunksPerDoc = Math.ceil(topN / documentRelevances.length)
      const result = documentRelevances.map(() => chunksPerDoc)
      
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

    // We'll work on the sorted list but write results back to original indices.
    // Iteratively re-proportion among docs that still have remaining capacity.
    let round = 1
    while (remainingChunks > 0) {
      loggerWithChild({ email }).info(
        `Allocation Round ${round}, remainingChunks= ${remainingChunks}`
      )
      // Active docs = those that still have capacity left
      const active = sortedDocuments.filter(d => chunksAllocation[d.index] < d.chunksLength)

      if (active.length === 0) break
      loggerWithChild({ email }).info(
        `Active docs: ${active.map(d => `${d.docId}(allocation= ${chunksAllocation[d.index]}, capacity= ${d.chunksLength}, relevance= ${d.relevanceScore.toFixed(3)})`).join(", ")}`
      )

      // Sum relevance over active docs
      let sumActiveRel = active.reduce((s, d) => s + d.relevanceScore, 0)
      loggerWithChild({ email }).info(
        `Sum active relevance for round ${round}: ${sumActiveRel.toFixed(3)}`
      )

      // If all remaining active docs have zero relevance, fall back to equal distribution among active (respecting caps)
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
        if (assignedThisRound === 0) break // no progress possible
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
        // const frac = Math.max(0, Math.min(capLeft - floored, ideal - floored))
        // if (capLeft - floored > 0) {
        //   fracs.push({ idx, frac, rel: d.relevanceScore, capLeft })
        // }

        loggerWithChild({ email }).info(
          `Doc ${d.docId}: idealAllocation=${ideal.toFixed(3)}, floor=${floored}, chunksLeft=${capLeft}` //frac=${frac.toFixed(3)}
        )
      }

      let leftover = remainingChunks - sumFloors

      // Second pass: distribute leftover 1-by-1 by largest fractional parts (tie-break by higher relevance)
      // if (leftover > 0 && fracs.length > 0) {
      //   fracs.sort((a, b) => {
      //     if (b.frac !== a.frac) return b.frac - a.frac
      //     return b.rel - a.rel
      //   })
      //   loggerWithChild({ email }).info(
      //     `Remainder before distribution: sumFloors=${sumFloors}, leftover=${leftover}. Fractional order: ${fracs.map(f => `docIdx=${f.idx}, frac=${f.frac.toFixed(3)}, rel=${f.rel.toFixed(3)}`).join("; ")}`
      //   )
      //   for (let i = 0; i < fracs.length && leftover > 0; i++) {
      //     const { idx, capLeft } = fracs[i]
      //     if ((floorAdds[idx] ?? 0) < capLeft) {
      //       floorAdds[idx] = (floorAdds[idx] ?? 0) + 1
      //       leftover -= 1
      //       loggerWithChild({ email }).info(`--> 1 extra chunk given to docIndex=${idx}`)
      //     }
      //   }
      // }

      const assignedThisRound = remainingChunks - Math.max(0, leftover)
      if (assignedThisRound <= 0) break // avoid infinite loop if nothing could be assigned

      // Finalize this round's assignments
      for (const d of active) {
        const idx = d.index
        if (floorAdds[idx]) {
          chunksAllocation[idx] += floorAdds[idx]
          loggerWithChild({ email }).info(
            `Allotted ${floorAdds[idx]} chunks to ${d.docId}, new total=${chunksAllocation[idx]}`
          )
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
    
    loggerWithChild({ email }).info(
      `Successfully processed ${documentRelevances.length} documents and calculated chunk allocation: ${JSON.stringify(chunksAllocation)}`
    )
    
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
