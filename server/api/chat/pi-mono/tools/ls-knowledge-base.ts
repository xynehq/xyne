/**
 * lsKnowledgeBase tool - pi-mono version
 *
 * Fully wired to existing JAF implementation
 */

import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { executeLsKnowledgeBase } from "../../tools/knowledgeBaseFlow"

const KNOWLEDGE_BASE_TARGET_DESCRIPTION =
  "A discriminated knowledge-base target object for browse/search. Set `type` to one of `collection`, `folder`, `file`, or `path`, then provide only the matching ID/path fields for that variant."

const KNOWLEDGE_BASE_OFFSET_DESCRIPTION =
  "Pagination offset. Use it after reviewing the current page to continue from the next unseen rows or fragments."

const LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Browse the caller's accessible knowledge-base namespace.",
  "Use it to discover collections, inspect folder/file layout, confirm canonical paths, answer inventory or metadata questions directly, or obtain IDs for a later `searchKnowledgeBase.filters.targets` call.",
  "It is especially useful when the user wants answers constrained by structure or metadata such as a specific folder, collection, file set, or file type like PDFs.",
  "Skip `ls` only when the exact KB scope is already known and browsing will not improve the answer.",
  "Start shallow with `depth: 1` and `metadata: false` if unsure; but you are always free to enable metadata or deepen traversal only when the task truly needs row details or more hierarchy.",
].join(" ")

const lsKnowledgeBaseParams = Type.Object({
  target: Type.Optional(
    Type.Object(
      {
        type: Type.Union(
          [
            Type.Literal("collection"),
            Type.Literal("folder"),
            Type.Literal("file"),
            Type.Literal("path"),
          ],
          { description: "Target type: collection, folder, file, or path" },
        ),
        collectionId: Type.Optional(
          Type.String({
            description:
              "Collection ID (required for type: collection or path)",
          }),
        ),
        folderId: Type.Optional(
          Type.String({ description: "Folder ID (required for type: folder)" }),
        ),
        fileId: Type.Optional(
          Type.String({ description: "File ID (required for type: file)" }),
        ),
        path: Type.Optional(
          Type.String({ description: "Path (required for type: path)" }),
        ),
      },
      {
        description:
          "Optional KB location to browse. Omit it to list accessible collections. Provide a collection, folder, file, or path target when you already know where to inspect or when the user asked about a specific location.",
      },
    ),
  ),
  depth: Type.Optional(
    Type.Number({
      minimum: 5,
      maximum: 50,
      default: 5,
      description:
        "Traversal depth from the target. `5` lists immediate children only. Start shallow and increase depth only when the task truly needs more hierarchy.",
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 100,
      description:
        "Maximum number of browse rows to return from the flattened listing. Keep this small for discovery and page with `offset` when needed.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      minimum: 0,
      default: 0,
      description: KNOWLEDGE_BASE_OFFSET_DESCRIPTION,
    }),
  ),
  metadata: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        "Return persisted row metadata when true. Leave false for normal navigation; enable when you need details like description, mime type for filtering PDFs or other file types, timestamps, or collection metadata.",
    }),
  ),
})

export const lsKnowledgeBaseTool = createXyneTool(
  "lsKnowledgeBase",
  LS_KNOWLEDGE_BASE_TOOL_DESCRIPTION,
  lsKnowledgeBaseParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState } = ctx

    try {
      // Build target from params based on type
      let target: any = undefined
      if (params.target) {
        const t = params.target
        switch (t.type) {
          case "collection":
            target = {
              type: "collection" as const,
              collectionId: t.collectionId!,
            }
            break
          case "folder":
            target = { type: "folder" as const, folderId: t.folderId! }
            break
          case "file":
            target = { type: "file" as const, fileId: t.fileId! }
            break
          case "path":
            target = {
              type: "path" as const,
              collectionId: t.collectionId!,
              path: t.path!,
            }
            break
        }
      }
      const result = await executeLsKnowledgeBase(
        {
          target,
          depth: params.depth ?? 2,
          limit: params.limit,
          offset: params.offset ?? 0,
          metadata: params.metadata ?? false,
        },
        xyneState as any,
      )

      if (result.error) {
        return {
          content: [
            { type: "text", text: result.error.message || "KB ls failed" },
          ],
          isError: true,
          details: { toolName: "lsKnowledgeBase", error: result.error },
        }
      }
      const entries = result.data?.entries || []

      return {
        content: [{ type: "text", text: JSON.stringify(entries) }],
        details: {
          entries,
          total: result.data?.total || 0,
          toolName: "lsKnowledgeBase",
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [{ type: "text", text: `KB ls error: ${errMsg}` }],
        isError: true,
        details: { toolName: "lsKnowledgeBase", error: errMsg },
      }
    }
  },
)
