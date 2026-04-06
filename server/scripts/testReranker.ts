/**
 * Quick test for the CrossEncoderReranker
 */
import { CrossEncoderReranker } from "@/api/chat/reranker/crossEncoderReranker"
import type { Chunk } from "@/api/chat/reranker/types"

async function main() {
  const reranker = new CrossEncoderReranker()

  const query = "What are the internal audit requirements for ESG rating providers?"

  const chunks: Chunk[] = [
    {
      id: "1",
      content: "Chapter IV covers Internal Audit for ERPs. Requirements include annual review of rating processes, compliance verification, and quality assurance of methodologies used.",
      parentDocId: "doc1",
      vespaScore: 0.5,
      chunkIndex: 0,
      source: { title: "ESG Master Circular", docId: "doc1", app: "kb", entity: "file", chunkIndex: 0, confidence: 0.5 },
    },
    {
      id: "2",
      content: "The application fees for registration as an ESG Rating Provider shall be submitted online through SEBI Intermediary Portal.",
      parentDocId: "doc1",
      vespaScore: 0.6,
      chunkIndex: 1,
      source: { title: "ESG Master Circular", docId: "doc1", app: "kb", entity: "file", chunkIndex: 1, confidence: 0.6 },
    },
    {
      id: "3",
      content: "ERPs shall conduct internal audit annually. The internal audit shall cover rating process review, compliance with regulations, conflict of interest management, and adequacy of rating methodologies.",
      parentDocId: "doc1",
      vespaScore: 0.4,
      chunkIndex: 2,
      source: { title: "ESG Master Circular", docId: "doc1", app: "kb", entity: "file", chunkIndex: 2, confidence: 0.4 },
    },
    {
      id: "4",
      content: "Periodic disclosures to SEBI include half-yearly reports on rating actions, newly rated entities, and rating transitions.",
      parentDocId: "doc1",
      vespaScore: 0.7,
      chunkIndex: 3,
      source: { title: "ESG Master Circular", docId: "doc1", app: "kb", entity: "file", chunkIndex: 3, confidence: 0.7 },
    },
  ]

  console.log("=== Cross-Encoder Reranker Test ===")
  console.log(`Query: "${query}"`)
  console.log(`Chunks: ${chunks.length}`)
  console.log("")

  const start = Date.now()
  const results = await reranker.rerank(query, chunks)
  const elapsed = Date.now() - start

  console.log(`\nReranking took ${elapsed}ms\n`)
  console.log("Results (ranked by relevance):")
  for (const r of results) {
    console.log(`  [${r.rank}] Score: ${r.rerankScore.toFixed(4)} | "${r.content.substring(0, 80)}..."`)
  }
}

main().catch(console.error)
