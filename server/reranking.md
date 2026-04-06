# Chunk-Level Reranking Implementation

## Overview
This implementation adds optional chunk-level reranking to the search pipeline. Instead of returning entire documents as fragments, we extract individual chunks, rerank them by relevance to the query, and then group them back by document.

## Architecture

```
Vespa Search Results
       ↓
Extract Chunks (from chunks_summary)
       ↓
Rerank Chunks (LLM or External API)
       ↓
Group by Parent Document
       ↓
Format as Fragments
       ↓
Tool Result
```

## Files Created

### 1. `server/api/chat/reranker/types.ts`
- `Chunk` interface: Represents a single chunk with content, parentDocId, vespaScore
- `RerankedChunk` interface: Chunk with rerankScore and rank
- `Reranker` interface: Contract for all reranker implementations
- `RerankingConfig` interface: Configuration options
- `ChunkGroup` interface: Grouped chunks by parent document

### 2. `server/api/chat/reranker/llmReranker.ts`
- `LlmReranker` class: Uses configured fast model to score chunks 0-100
- Falls back to Vespa scores on LLM failure
- Implements `Reranker` interface

### 3. `server/api/chat/reranker/jinaReranker.ts`
- `JinaReranker` class: Calls Jina AI reranking API
- Default model: `jina-reranker-v3`
- Supports `return_documents` parameter (default: false)
- Requires `RERANKING_API_KEY` env var
- Falls back to Vespa scores on API failure
- Implements `Reranker` interface

### 4. `server/api/chat/reranker/index.ts`
- `createReranker()` factory function: Creates appropriate reranker based on config
- Exports all types and implementations

### 5. `server/api/chat/chunk-pipeline.ts`
- `extractChunksFromVespaResults()`: Extracts chunks from Vespa search results
- `groupChunksByDocument()`: Groups reranked chunks by parent document
- `chunkGroupsToFragments()`: Converts groups to MinimalAgentFragment format
- `rerankAndGroupChunks()`: Main pipeline function
- `isRerankingEnabled()`: Check if reranking is enabled

## Configuration (server/config.ts)

Added `reranking` config object:

```typescript
reranking: {
  enabled: boolean;        // RERANKING_ENABLED env var
  provider: "llm" | "jina" | "cohere";  // RERANKING_PROVIDER
  model?: string;          // RERANKING_MODEL (for LLM)
  apiKey?: string;         // RERANKING_API_KEY (for external APIs)
  apiUrl?: string;         // RERANKING_API_URL (custom endpoint)
  topK: number;            // RERANKING_TOP_K (default: 20)
}
```

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `RERANKING_ENABLED` | Enable chunk-level reranking | `false` |
| `RERANKING_PROVIDER` | Reranker provider: `llm`, `jina`, `cohere` | `llm` |
| `RERANKING_MODEL` | Model for LLM provider | Uses `defaultFastModel` |
| `RERANKING_API_KEY` | API key for external providers | - |
| `RERANKING_API_URL` | Custom API endpoint | - |
| `RERANKING_TOP_K` | Number of top chunks to return | `50` |

## Integration

Modified `server/api/chat/tools/global/index.ts`:
- Added imports for `isRerankingEnabled` and `rerankAndGroupChunks`
- Modified `executeVespaSearch()` to check `isRerankingEnabled()`
- When enabled: uses `rerankAndGroupChunks()` instead of `formatSearchToolResponse()`
- When disabled: existing behavior unchanged

## Usage

### Enable with LLM (default fast model):
```bash
RERANKING_ENABLED=true
RERANKING_PROVIDER=llm
RERANKING_TOP_K=20
```

### Enable with Jina AI:
```bash
RERANKING_ENABLED=true
RERANKING_PROVIDER=jina
RERANKING_API_KEY=your-jina-api-key
RERANKING_TOP_K=20
```

### Disable (default behavior):
```bash
RERANKING_ENABLED=false
# or unset the variable
```

## How It Works

1. **Extract**: Pull chunks from Vespa results, limited to 10 chunks per document (configurable)
2. **Rerank**: Score each chunk 0-100 for relevance to query
   - LLM: Uses system prompt with scoring guidelines
   - Jina: Calls API with query + documents
3. **Group**: Sort chunks by rerank score, group by parent document
4. **Aggregate**: Calculate average score for top 3 chunks per document
5. **Format**: Convert to `MinimalAgentFragment` with combined chunk content

## Fallback Behavior

- If reranker fails (LLM error, API error), falls back to Vespa scores
- If reranking is disabled, uses existing `formatSearchToolResponse()` unchanged
- Small chunk sets (≤3) skip LLM reranking for efficiency

## Future Enhancements

- [ ] Add Cohere reranker implementation
- [ ] Add caching for reranking results
- [ ] Support for hybrid reranking (Vespa + custom)
- [ ] Per-query reranking toggle
- [ ] Performance metrics and benchmarking