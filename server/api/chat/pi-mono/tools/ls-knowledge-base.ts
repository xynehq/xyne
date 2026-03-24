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

const KnowledgeBaseTargetSchema = Type.Union(
  [
    Type.Object(
      {
        type: Type.Literal("collection"),
        collectionId: Type.String({
          description:
            "Knowledge-base collection row ID as a string, typically a UUID. Reuse `ls` output directly here: for a collection row, pass `entries[i].id`; for a previously targeted `ls` response, pass `target.collection_id`. This stays a collection DB ID through KB search and is translated downstream into Vespa `clId` filtering. Do not pass a folder ID, file ID, or path here.",
        }),
      },
      {
        description:
          'Object shape: `{ type: "collection", collectionId: string }`. Targets an entire collection root. Best when the user names a known collection or you want to browse/search everything inside it.',
      },
    ),
    Type.Object(
      {
        type: Type.Literal("folder"),
        folderId: Type.String({
          description:
            'Knowledge-base folder row ID as a string, typically a UUID. Reuse `ls` output directly here: when an `ls` entry has `type: "folder"`, pass that row\'s `id` as `folderId`. This is later translated into KB folder selections and then Vespa `clFd` filtering. Do not pass a collection ID, file ID, or path here.',
        }),
      },
      {
        description:
          'Object shape: `{ type: "folder", folderId: string }`. Targets a folder subtree inside a collection. Useful after `ls` returns a folder ID or the folder is already known.',
      },
    ),
    Type.Object(
      {
        type: Type.Literal("file"),
        fileId: Type.String({
          description:
            "Knowledge-base file row ID as a string, typically a UUID. Reuse `ls` output directly here: when an `ls` entry has `type: \"file\"`, pass that row's `id` as `fileId`. This is later translated into the file's Vespa document `docId` filtering downstream. Do not pass a collection ID, folder ID, or path here.",
        }),
      },
      {
        description:
          'Object shape: `{ type: "file", fileId: string }`. Targets one exact file. Use for pinpointed browsing/search when the relevant document is already known.',
      },
    ),
    Type.Object(
      {
        type: Type.Literal("path"),
        collectionId: Type.String({
          description:
            'Knowledge-base collection row ID as a string, typically a UUID. Required with `type: "path"` so the path is resolved inside the correct collection. Reuse `ls` output directly here with `entries[i].collection_id` or `target.collection_id` from a prior targeted `ls` response.',
        }),
        path: Type.String({
          description:
            'Collection-relative path string such as `/`, `/Policies`, `/Policies/Security`, or `/Policies/Security.md`. Reuse `ls` output directly here with `entries[i].path` or `target.path` from a prior targeted `ls` response. A missing leading slash is accepted and will be canonicalized. `path: "/"` means the collection root. `.` and `..` path segments are invalid. The resolved path is then translated into collection, folder, or file search scope before Vespa filtering.',
        }),
      },
      {
        description:
          'Object shape: `{ type: "path", collectionId: string, path: string }`. Targets a collection-relative path when the location is known or easier to express than raw folder/file IDs.',
      },
    ),
  ],
  { description: KNOWLEDGE_BASE_TARGET_DESCRIPTION },
)

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
      minimum: 1,
      maximum: 5,
      default: 1,
      description:
        "Traversal depth from the target. `1` lists immediate children only. Start shallow and increase depth only when the task truly needs more hierarchy.",
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
    const { xyneState, persistState } = ctx

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
          depth: params.depth ?? 1,
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
        content: [{ type: "text", text: `Found ${entries.length} KB items` }],
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
