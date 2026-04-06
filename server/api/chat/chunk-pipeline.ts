/**
    * Chunk pipeline for extracting, reranking, and grouping chunks from Vespa search results
    */
   
   import type { VespaSearchResponse, VespaSearchResults } from "@xyne/vespa-ts"
   import { searchToCitation } from "@/api/chat/utils"
   import type { MinimalAgentFragment } from "@/api/chat/types"
   import { getLogger } from "@/logger"
   import { Subsystem } from "@/types"
   import { createReranker } from "./reranker"
   import type { Chunk, ChunkGroup, RerankedChunk } from "./reranker/types"
   import config from "@/config"
   
   const Logger = getLogger(Subsystem.Chat)
   
   /**
    * Extract chunks from Vespa search results
    * Each document in Vespa results contains multiple chunks
    * Limits chunks per document to avoid overwhelming the reranker
    */
   export function extractChunksFromVespaResults(
     searchResults: VespaSearchResponse | null,
     maxChunksPerDoc: number = 10
   ): Chunk[] {
     if (!searchResults?.root?.children) {
       return []
     }
   
     const chunks: Chunk[] = []
   
     for (const child of searchResults.root.children) {
       const result = child as VespaSearchResults
       if (!result.fields) continue
   
       const fields = result.fields as any
       const citation = searchToCitation(result)
   
       // Extract chunks from chunks_summary field
       const chunksSummary = fields.chunks_summary || []
       const chunksPos = fields.chunks_pos || []
   
       // Limit chunks per document to avoid overwhelming the reranker
       // Take only first N chunks from each document
       const chunksToExtract = Math.min(chunksSummary.length, maxChunksPerDoc)
   
       for (let i = 0; i < chunksToExtract; i++) {
         const chunkContent =
           typeof chunksSummary[i] === "string"
             ? chunksSummary[i]
             : chunksSummary[i]?.chunk || ""
   
         chunks.push({
           id: `${fields.docId}_chunk_${chunksPos[i] ?? i}`,
           content: chunkContent,
           parentDocId: fields.docId,
           vespaScore: result.relevance || 0.5,
           chunkIndex: chunksPos[i] ?? i,
           source: citation,
           metadata: {
             title: fields.title,
           },
         })
       }
     }
   
     Logger.info(
       {
         documentCount: searchResults.root.children.length,
         chunkCount: chunks.length,
         maxChunksPerDoc,
       },
       "[ChunkPipeline] Extracted chunks from Vespa results"
     )
   
     return chunks
   }
   
   /**
    * Group reranked chunks by parent document
    */
   export function groupChunksByDocument(rerankedChunks: RerankedChunk[]): ChunkGroup[] {
     const groups = new Map<string, ChunkGroup>()
   
     for (const chunk of rerankedChunks) {
       if (!groups.has(chunk.parentDocId)) {
         groups.set(chunk.parentDocId, {
           parentDocId: chunk.parentDocId,
           source: chunk.source,
           chunks: [],
           aggregatedScore: 0,
         })
       }
   
       const group = groups.get(chunk.parentDocId)!
       group.chunks.push(chunk)
     }
   
     // Calculate aggregated scores and sort chunks within each group
     for (const group of groups.values()) {
       // Sort chunks by rerank score descending
       group.chunks.sort((a, b) => b.rerankScore - a.rerankScore)
   
       // Aggregate score: average of top 3 chunks or all if less
       const topChunks = group.chunks.slice(0, 3)
       group.aggregatedScore =
         topChunks.reduce((sum, c) => sum + c.rerankScore, 0) / topChunks.length
     }
   
     // Convert to array and sort by aggregated score
     const sortedGroups = Array.from(groups.values()).sort(
       (a, b) => b.aggregatedScore - a.aggregatedScore
     )
   
     Logger.info(
       {
         groupCount: sortedGroups.length,
         topGroupScore: sortedGroups[0]?.aggregatedScore,
       },
       "[ChunkPipeline] Grouped chunks by document"
     )
   
     return sortedGroups
   }
   
   /**
    * Convert chunk groups to MinimalAgentFragment format with neighbor context
    * Each chunk is expanded to include its neighbors (i-1, i, i+1) for more context
    */
   export function chunkGroupsToFragments(
     groups: ChunkGroup[],
     maxChunksPerFragment: number = 5
   ): MinimalAgentFragment[] {
     const fragments: MinimalAgentFragment[] = []
   
     for (const group of groups) {
       // Take top chunks from each group
       const topChunks = group.chunks.slice(0, maxChunksPerFragment)
   
       // Build a map of all chunks by their index for quick lookup
       const chunkByIndex = new Map<number, RerankedChunk>()
       for (const chunk of group.chunks) {
         chunkByIndex.set(chunk.chunkIndex, chunk)
       }
   
       // Combine chunk contents with neighbors (i-1 + i + i+1)
       const expandedChunks = topChunks.map((chunk) => {
         const prevChunk = chunkByIndex.get(chunk.chunkIndex - 1)
         const nextChunk = chunkByIndex.get(chunk.chunkIndex + 1)
         
         const parts: string[] = []
         
         // Add previous chunk if exists
         if (prevChunk) {
           parts.push(`[Chunk ${prevChunk.chunkIndex + 1}] (Context)\n${prevChunk.content}`)
         }
         
         // Add current chunk (the main one)
         parts.push(`[Chunk ${chunk.chunkIndex + 1}] (Score: ${(chunk.rerankScore * 100).toFixed(1)}%) **RELEVANT CHUNK**\n${chunk.content}`)
         
         // Add next chunk if exists
         if (nextChunk) {
           parts.push(`[Chunk ${nextChunk.chunkIndex + 1}] (Context)\n${nextChunk.content}`)
         }
         
         return parts.join("\n\n")
       })
   
       const combinedContent = expandedChunks.join("\n\n---\n\n")
   
       // Calculate average confidence
       const avgConfidence =
         topChunks.reduce((sum, c) => sum + c.rerankScore, 0) / topChunks.length
   
       fragments.push({
         id: group.parentDocId,
         content: combinedContent,
         source: group.source,
         confidence: avgConfidence,
       })
     }
   
     Logger.info(
       {
         fragmentCount: fragments.length,
       },
       "[ChunkPipeline] Converted chunk groups to fragments with neighbor context"
     )
   
     return fragments
   }
   
   /**
    * Main pipeline function: extract, rerank, group, and format chunks
    */
   export async function rerankAndGroupChunks(
     searchResults: VespaSearchResponse | null,
     query: string,
     topK?: number,
     maxChunksPerDoc: number = 20
   ): Promise<MinimalAgentFragment[]> {
     // Step 1: Extract chunks (limited per document)
     const chunks = extractChunksFromVespaResults(searchResults, maxChunksPerDoc)
   
     if (chunks.length === 0) {
       return []
     }
   
     // Step 2: Create reranker and rerank chunks
     const reranker = createReranker()
   
     if (!reranker) {
       Logger.warn("[ChunkPipeline] Reranker not available, returning empty results")
       return []
     }
   
     const allRerankedChunks = await reranker.rerank(query, chunks, topK || config.reranking.topK)
   
     // Filter chunks with score above threshold (0.3)
     const SCORE_THRESHOLD = 0.001
     const rerankedChunks = allRerankedChunks.filter(
       (chunk) => chunk.rerankScore >= SCORE_THRESHOLD
     )
   
     Logger.info(
       {
         beforeFilter: allRerankedChunks.length,
         afterFilter: rerankedChunks.length,
         threshold: SCORE_THRESHOLD,
       },
       "[ChunkPipeline] Filtered chunks by score threshold"
     )
   
     if (rerankedChunks.length === 0) {
       Logger.warn("[ChunkPipeline] No chunks above threshold, returning empty results")
       return []
     }
   
     // Step 3: Group by document
     const groups = groupChunksByDocument(rerankedChunks)
   
     // Step 4: Convert to fragments
     return chunkGroupsToFragments(groups)
   }
   
   /**
    * Check if reranking is enabled
    */
   export function isRerankingEnabled(): boolean {
     return config.reranking.enabled
   }