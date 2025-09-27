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
    
    for (const docRelevance of sortedDocuments) {
      if (remainingChunks <= 0) break
      
      // Calculate proportion of chunks this document should get
      const relevanceProportion = docRelevance.relevanceScore / totalRelevance
      const chunksForThisDoc = Math.round(remainingChunks * relevanceProportion)
      
      // Ensure we don't exceed remaining chunks
      const actualChunksToTake = Math.min(remainingChunks, Math.min(chunksForThisDoc, docRelevance.chunksLength))
      
      // Assign chunks to the original position in the array
      chunksAllocation[docRelevance.index] = actualChunksToTake
      remainingChunks -= actualChunksToTake
      
      loggerWithChild({ email }).info(
        `Document ${docRelevance.docId}: relevance=${docRelevance.relevanceScore.toFixed(3)}, ` +
        `proportion=${relevanceProportion.toFixed(3)}, allocated=${actualChunksToTake} chunks, chunksLength: ${docRelevance.chunksLength}`
      )
    }
    
    // If we still have remaining chunks to allocate (due to rounding), 
    // distribute them to documents with the highest relevance scores
    if (remainingChunks > 0) {
      for (const docRelevance of sortedDocuments) {
        if (remainingChunks <= 0) break
        const leftToAllocate = Math.min(remainingChunks, docRelevance.chunksLength - chunksAllocation[docRelevance.index])
        chunksAllocation[docRelevance.index] += leftToAllocate
        remainingChunks -= leftToAllocate
      }
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
