/**
 * searchKnowledgeBase tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import type { MinimalAgentFragment } from "@/api/chat/types"
import { Type } from "@sinclair/typebox"
import { executeSearchKnowledgeBase } from "../../tools/knowledgeBaseFlow"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import config from "@/config"
import { formatFragmentsForLLM } from "./tool-utils"

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
].join(" ")

const searchKnowledgeBaseParams = Type.Object({
  query: Type.String({
    description:
      "Short, content-focused KB retrieval query using 3-4 important keywords maximum. Example: 'ESG rating withdrawal' or 'minimum rating period'. Do NOT use long phrases or sentences - keep it to essential keywords only for optimal Vespa search results.",
    minLength: 1,
    maxLength: 100,
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
      maximum: 10,
      description:
        "Maximum number of KB fragments to return (up to 10). Keep this tight for precision-first retrieval; raise it only when the user needs broader coverage.",
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
    const { xyneState } = ctx
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
      const result = await executeSearchKnowledgeBase(
        {
          query: params.query,
          filters: targets ? { targets } : undefined,
          limit: params.limit,
          offset: params.offset,
          excludedIds: params.excludedIds,
        },
        xyneState as any,
      )
      if (result.error) {
        return {
          content: [
            { type: "text", text: result.error.message || "KB search failed" },
          ],
          isError: true,
          details: { toolName: "searchKnowledgeBase", error: result.error },
        }
      }

      const allFragments = result.data.fragments || []
      const fragments: MinimalAgentFragment[] = allFragments.filter(
        (fragment: MinimalAgentFragment) => {
          const docId = fragment.source?.docId
          const returnedChunkIndices = fragment.source?.returnedChunkIndices

          if (!returnedChunkIndices || returnedChunkIndices.length === 0) {
            if (!docId) return true
            return !xyneState.seenDocIds?.has(docId)
          }
          return returnedChunkIndices.some((chunkIdx: number) => {
            const chunkKey = `${docId}_${chunkIdx}`
            return !xyneState.seenChunks.has(chunkKey)
          })
        },
      )

      const startIndex = xyneState.allFragments.length + 1

      const toolKey = `searchKnowledgeBase:${params.query || "default"}`
      const existing =
        xyneState.currentTurnArtifacts.unrankedFragmentsByTool.get(toolKey)
      const mergedFragments = existing
        ? [...existing.fragments, ...fragments]
        : fragments
      xyneState.currentTurnArtifacts.unrankedFragmentsByTool.set(toolKey, {
        query: params.query || "",
        fragments: mergedFragments,
      })
      const context = formatFragmentsForLLM(fragments, startIndex)

      return {
        content: [{ type: "text", text: context }],
        details: {
          fragments: fragments,
          topFragmentSummary: fragments
            .slice(0, 3)
            .map((f) => {
              const title = f.source?.title || "Untitled"
              return `${title}`
            })
            .join("\n\n"),
          query: params.query,
          toolName: "searchKnowledgeBase",
          startIndex,
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
