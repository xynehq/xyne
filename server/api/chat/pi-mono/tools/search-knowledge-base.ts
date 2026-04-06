/**
 * searchKnowledgeBase tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { executeSearchKnowledgeBase } from "../../tools/knowledgeBaseFlow"
import type { MinimalAgentFragment } from "@/api/chat/types"
import { mergeFragmentLists } from "../fragment-utils"
import {
  rankFragmentsWithReranker,
  buildRankedContextBlock,
} from "../fragment-ranking"

/**
 * Pagination metadata for knowledge base search results
 */
interface PaginationMetadata {
  returned: number
  totalAvailable: number
  limit: number
  offset: number
  hasMore: boolean
  nextOffset: number
}

/**
 * Format search fragments as lightweight summary for LLM.
 * Full content is available via the ranked context block.
 */
function formatFragmentsForLLM(
  fragments: MinimalAgentFragment[],
  query: string | undefined,
  pagination?: PaginationMetadata,
  requestedLimit?: number,
): string {
  if (fragments.length === 0) {
    return `<search_results query="${query || "unknown"}">\n  <message>No results found in knowledge base.</message>\n</search_results>`
  }

  let output = `<search_results query="${query || "unknown"}">\n`

  // 1. Clear Pagination Metadata
  if (pagination) {
    output += `  <metadata>\n`
    output += `    <total_available>${pagination.totalAvailable}</total_available>\n`
    output += `    <requested>${pagination.limit}</requested>\n`
    output += `    <returned>${pagination.returned}</returned>\n`
    output += `    <current_offset>${pagination.offset}</current_offset>\n`
    output += `    <has_more>${pagination.hasMore}</has_more>\n`
    output += `  </metadata>\n`
  }

  // 2. The Documents (combining metadata and content)
  output += `  <documents>\n`
  fragments.forEach((f, i) => {
    const title = f.source?.title || "Unknown"
    const docId = f.source?.docId || f.id || "unknown"
    const app = f.source?.app || "KnowledgeBase"
    const relevance = f.confidence ? (f.confidence * 100).toFixed(1) : "N/A"

    // Assuming f.content holds the raw text snippet.
    const content = f.content || "Content unavailable."

    output += `    <document index="${i + 1}" doc_id="${docId}" relevance="${relevance}%" source_app="${app}">\n`
    output += `      <title>${title}</title>\n`
    output += `      <content>\n${content}\n      </content>\n`
    output += `    </document>\n`
  })
  output += `  </documents>\n`

  // 3. Relevance Warning: If reranker filtered out most results
  if (requestedLimit && fragments.length > 0) {
    const returnRatio = fragments.length / requestedLimit
    // If less than 40% of requested results were returned, warn about low relevance
    if (returnRatio < 0.4) {
      output += `\n  <relevance_warning>\n    The query only returned ${fragments.length} document chunk${fragments.length === 1 ? "" : "s"} out of ${requestedLimit} requested.\n    The reranker filtered out ${requestedLimit - fragments.length} chunks as irrelevant to your query.\n    The documents shown may not contain the answer you need.\n    To improve results:\n    1. Try \`getDocumentOutline\` with the same query to discover document structure and find relevant sections.\n    2. Try a different \`offset\` to explore more results from this query.\n    3. Rephrase your query using different semantic terms that may appear in the source documents.\n  </relevance_warning>\n`
    }
  }

  // 4. Explicit Actionable Instruction for the Agent
  if (pagination?.hasMore) {
    output += `\n  <system_instruction>\n    More results are available. If you have not found the answer, you MUST call the searchKnowledgeBase tool again using \`offset: ${pagination.nextOffset}\`.\n  </system_instruction>\n`
  }

  output += `</search_results>`
  return output
}

const KNOWLEDGE_BASE_TARGET_DESCRIPTION =
  "A discriminated knowledge-base target object for browse/search. Set `type` to one of `collection`, `folder`, `file`, or `path`, then provide only the matching ID/path fields for that variant."

const KNOWLEDGE_BASE_OFFSET_DESCRIPTION =
  "Pagination offset. Use it after reviewing the current page to continue from the next unseen rows or fragments."

const KNOWLEDGE_BASE_EXCLUDED_IDS_DESCRIPTION =
  "Previously seen result document `docId`s to suppress on follow-up KB searches. Prefer `fragment.source.docId` values from prior results. Do not pass collection, folder, file, path, or fragment IDs."

const SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Search document content inside the caller's accessible knowledge-base scope and return cited fragments.",
  "Use it directly when the task is about document contents and the relevant KB scope is already known or broad KB search is acceptable.",
  "Pair it with `ls` when you need structural scoping, canonical-path confirmation, or file preselection such as searching only .txt files from a folder.",
  "If the collection, folder, file, or path is known, pass it in `filters.targets`; file targets can come from prior `ls` output.",
  "`filters.targets` narrows search by location, while `excludedIds` should contain previously seen document/result IDs to avoid rereading the same hits.",
  "",
  "**ID REFERENCE**: When using `filters.targets.fileId`, use the `id` field (UUID like 'b9680544-b86b-4af3-b9e7-5f1667526425') from `lsKnowledgeBase` output. Do NOT use `vespaDocId` here - that causes errors.",
].join(" ")

const searchKnowledgeBaseParams = Type.Object({
  query: Type.String({
    description:
      "Short, content-focused KB retrieval query. Use the semantic terms you expect inside documents, not navigation instructions. If the scope is known, narrow with `filters.targets` instead of stuffing paths or folder names into the query.",
    minLength: 1,
  }),
  filters: Type.Optional(
    Type.Object(
      {
        targets: Type.Optional(
          Type.Array(
            Type.Object(
              {
                type: Type.Union(
                  [
                    Type.Literal("collection"),
                    Type.Literal("folder"),
                    Type.Literal("file"),
                    Type.Literal("path"),
                  ],
                  {
                    description:
                      "Target type: collection, folder, file, or path",
                  },
                ),
                collectionId: Type.Optional(
                  Type.String({
                    description:
                      "Collection ID (required for type: collection or path)",
                  }),
                ),
                folderId: Type.Optional(
                  Type.String({
                    description: "Folder ID (required for type: folder)",
                  }),
                ),
                fileId: Type.Optional(
                  Type.String({
                    description: "File ID (required for type: file)",
                  }),
                ),
                path: Type.Optional(
                  Type.String({
                    description: "Path (required for type: path)",
                  }),
                ),
              },
              { description: KNOWLEDGE_BASE_TARGET_DESCRIPTION },
            ),
            {
              minItems: 1,
              description:
                "Optional union of KB locations to search inside the current allowed scope. Each target may be a collection root, folder subtree, exact file, or collection-relative path. Use this when the user query or prior `ls` output tells you where to search; file targets are especially useful after `ls` identifies a subset such as PDFs.",
            },
          ),
        ),
      },
      {
        description:
          "Optional structural scope for KB search. Omit it when a broad search across the caller's allowed KB scope is appropriate.",
      },
    ),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 20,
      description:
        "Maximum number of KB fragments to return (up to 30). Use 15-20 for most searches to ensure good recall; increase to 30 when broader coverage is needed.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      minimum: 0,
      description: KNOWLEDGE_BASE_OFFSET_DESCRIPTION,
    }),
  ),
  excludedIds: Type.Optional(
    Type.Array(Type.String(), {
      description: KNOWLEDGE_BASE_EXCLUDED_IDS_DESCRIPTION,
    }),
  ),
})

export const searchKnowledgeBaseTool = createXyneTool(
  "searchKnowledgeBase",
  SEARCH_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
  searchKnowledgeBaseParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState, persistState } = ctx

    try {
      // Build targets from params based on type
      let targets: any[] | undefined = undefined
      if (params.filters?.targets && params.filters.targets.length > 0) {
        targets = params.filters.targets.map((t) => {
          switch (t.type) {
            case "collection":
              return {
                type: "collection" as const,
                collectionId: t.collectionId!,
              }
            case "folder":
              return { type: "folder" as const, folderId: t.folderId! }
            case "file":
              return { type: "file" as const, fileId: t.fileId! }
            case "path":
              return {
                type: "path" as const,
                collectionId: t.collectionId!,
                path: t.path!,
              }
          }
        })
      }

      // NOTE: Do NOT auto-inject seenDocuments into excludedIds here.
      // excludedIds operates at the DOCUMENT level (Vespa's docId field), not chunk level.
      // A single document contains many chunks — excluding it blocks ALL chunks, even ones
      // relevant to different queries. The ranking pipeline deduplicates post-retrieval instead.
      // The LLM agent can still explicitly pass excludedIds via the tool parameter.

      const result = await executeSearchKnowledgeBase(
        {
          query: params.query,
          filters: targets ? { targets } : undefined,
          limit: params.limit || 15,
          offset: params.offset,
          excludedIds: params.excludedIds,
        },
        xyneState as any,
      )

      if (!result.success) {
        return {
          content: [
            { type: "text", text: result.error.message || "KB search failed" },
          ],
          isError: true,
          details: { toolName: "searchKnowledgeBase", error: result.error },
        }
      }

      const { fragments, totalCount, offset, limit } = result.data

      // Rank fragments internally using the configured reranker (Jina, LLM, or Cross-Encoder)
      const scoredFragments = await rankFragmentsWithReranker(
        fragments,
        xyneState.message.text,
        params.limit || 15,
      )

      // Merge fragments into currentTurnArtifacts.fragments (will be moved to allFragments at context time)
      const rankedFragments = scoredFragments.map(
        (s: { fragment: MinimalAgentFragment }) => s.fragment,
      )
      xyneState.currentTurnArtifacts.fragments = mergeFragmentLists(
        xyneState.currentTurnArtifacts.fragments,
        rankedFragments,
      )

      await persistState()

      // Build pagination metadata
      const pagination = {
        returned: fragments.length,
        totalAvailable: totalCount,
        limit,
        offset,
        hasMore: offset + fragments.length < totalCount,
        nextOffset: offset + fragments.length,
      }

      // Format lightweight summary for LLM
      const formattedResults = formatFragmentsForLLM(
        rankedFragments,
        params.query,
        pagination,
        15,
      )

      // Return combined: lightweight summary + ranked context
      // const fullContent = `${formattedResults}\n\n${rankedContext}`

      return {
        content: [{ type: "text", text: formattedResults }],
        details: {
          query: params.query,
          toolName: "searchKnowledgeBase",
          pagination,
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text", text: `KB search error: ${errMsg}` }],
        isError: true,
        details: { toolName: "searchKnowledgeBase", error: errMsg },
      }
    }
  },
)
