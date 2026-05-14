import {
  GetDocument,
  GetDocumentsByDocIds,
  searchVespaKnowledgeBase,
} from "@/search/vespa"
import { Type } from "@sinclair/typebox"
import { KbItemsSchema, SearchModes } from "@xyne/vespa-ts/types"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"

const GET_DOCUMENT_OUTLINE_DESCRIPTION = [
  "Retrieves the Table of Contents (TOC/outline) of documents to understand structure and locate specific sections. Essential first step for navigating large documents before reading specific pages.",
  "**WHEN TO USE**:",
  "1. User asks about specific topics in potentially long documents (reports, manuals, contracts)",
  "2. Initial semantic search returns no results or misses the user's intent",
  "3. You need to locate the exact page numbers for a specific section or chapter",
  "**REQUIRED PRE-STEP**: Use `lsKnowledgeBase` first to find the target file and obtain its `vespaDocId`.",
  "**INPUT OPTIONS**:",
  "- `fileIds`: Array of vespaDocId values (preferred - direct lookup)",
  "- `query`: Semantic search query to find relevant documents (fallback when you don't have fileIds)",
  "**WHAT YOU GET**: Hierarchical outline showing sections/chapters with page numbers, e.g.:",
  "```\n- Chapter 1: Introduction (Page 1)\n  - 1.1 Background (Page 3)\n  - 1.2 Objectives (Page 5)\n- Chapter 2: Methodology (Page 10)\n```",
  "**NEXT STEP**: Identify the exact page number(s) containing relevant content, then call `getPageContent` with those specific page numbers to retrieve the full text.",
  "**WORKFLOW**: lsKnowledgeBase → getDocumentOutline → getPageContent",
].join("\n")

const getDocumentOutlineParams = Type.Object({
  query: Type.Optional(
    Type.String({
      description:
        "A semantic search query to find relevant documents. REQUIRED if `fileIds` is not provided. Must be a descriptive phrase, not a single generic word.",
      minLength: 4,
    }),
  ),
  fileIds: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "An array of Vespa document IDs (vespa_doc_id) to retrieve outlines for. Use the `vespa_doc_id` field from `lsKnowledgeBase` output (not the `id` field). If provided, `query` can be omitted.",
      maxItems: 5,
    }),
  ),
  limit: Type.Optional(
    Type.Number({
      minimum: 1,
      maximum: 10,
      description:
        "Maximum number of unique document outlines to return. Defaults to 5.",
    }),
  ),
  offset: Type.Optional(
    Type.Number({
      minimum: 0,
      description:
        "Pagination offset for the underlying KB search. Use if the system instructs you that more outlines are available.",
    }),
  ),
})

export const getDocumentOutlineTool = createXyneTool(
  "getDocumentOutline",
  GET_DOCUMENT_OUTLINE_DESCRIPTION,
  getDocumentOutlineParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    const { xyneState } = ctx

    try {
      const maxOutlines = params.limit ?? 5
      const discoveredOutlines: Array<{
        docId: string
        title: string
        outline: string
      }> = []
      const discoveredDocIds = new Set<string>()
      // If fileIds are provided, fetch documents directly by ID
      if (params.fileIds && params.fileIds.length > 0) {
        try {
          // Mock span for tracing (GetDocumentsByDocIds requires a span object)
          const mockSpan = {
            setAttribute: () => mockSpan,
            addEvent: () => mockSpan,
            end: () => mockSpan,
            startSpan: () => mockSpan,
          }
          const documents = await GetDocumentsByDocIds(
            params.fileIds,
            mockSpan as any,
          )
          if (
            documents &&
            documents.root?.children &&
            documents.root.children.length > 0
          ) {
            for (const doc of documents.root.children) {
              const fields = doc.fields as any
              if (fields && fields.docId && fields.documentOutline) {
                if (discoveredDocIds.has(fields.docId)) continue

                discoveredDocIds.add(fields.docId)
                discoveredOutlines.push({
                  docId: fields.docId,
                  title: fields.title || "Untitled",
                  outline: fields.documentOutline,
                })

                if (discoveredOutlines.length >= maxOutlines) break
              }
            }
          }
        } catch (fetchErr) {
          const errMsg =
            fetchErr instanceof Error ? fetchErr.message : String(fetchErr)
          return {
            content: [
              {
                type: "text",
                text: `Error fetching documents by ID: ${errMsg}`,
              },
            ],
            isError: true,
            details: { toolName: "getDocumentOutline", error: errMsg },
          }
        }
      } else if (params.query) {
        // Use query-based search when no fileIds provided
        try {
          // Use direct Vespa search to bypass agent-scoped strict filtering
          const searchResult = await searchVespaKnowledgeBase(
            params.query,
            xyneState.user.email,
            {
              limit: maxOutlines * 3 + (params.offset || 0),
              offset: params.offset,
              rankProfile: SearchModes.NativeRank,
            },
          )

          if (searchResult && searchResult.root?.children?.length > 0) {
            for (const item of searchResult.root.children) {
              const fields = item.fields as any
              if (fields && fields.docId && fields.documentOutline) {
                if (discoveredDocIds.has(fields.docId)) continue

                discoveredDocIds.add(fields.docId)
                discoveredOutlines.push({
                  docId: fields.docId,
                  title: fields.title || "Untitled",
                  outline: fields.documentOutline,
                })

                if (discoveredOutlines.length >= maxOutlines) break
              }
            }
          }
        } catch (searchErr) {
          const errMsg =
            searchErr instanceof Error ? searchErr.message : String(searchErr)
          return {
            content: [
              {
                type: "text",
                text: `Error searching for documents to extract outlines: ${errMsg}`,
              },
            ],
            isError: true,
            details: { toolName: "getDocumentOutline", error: errMsg },
          }
        }
      } else {
        return {
          content: [
            {
              type: "text",
              text: "Either `query` or `fileIds` must be provided to retrieve document outlines.",
            },
          ],
          isError: true,
          details: { toolName: "getDocumentOutline" },
        }
      }

      if (discoveredDocIds.size === 0) {
        const searchContext = params.fileIds
          ? `file IDs: ${params.fileIds.join(", ")}`
          : `query "${params.query}"`
        return {
          content: [
            {
              type: "text",
              text: `No documents found matching the ${searchContext}.`,
            },
          ],
          details: { toolName: "getDocumentOutline" },
        }
      }

      if (discoveredOutlines.length === 0) {
        const searchContext = params.fileIds
          ? `file IDs: ${params.fileIds.join(", ")}`
          : `query "${params.query}"`
        return {
          content: [
            {
              type: "text",
              text: `Found ${discoveredDocIds.size} document(s) matching ${searchContext}, but none have a stored outline/table of contents.`,
            },
          ],
          details: {
            toolName: "getDocumentOutline",
            searchedDocIds: Array.from(discoveredDocIds),
          },
        }
      }

      // Format output with pagination info
      const hasMore =
        discoveredOutlines.length >= maxOutlines && !params.fileIds
      const nextOffset = (params.offset ?? 0) + maxOutlines * 3
      const queryAttr = params.query ? `query="${params.query}" ` : ""
      let output = `<document_outlines ${queryAttr}documents_found="${discoveredDocIds.size}" outlines_returned="${discoveredOutlines.length}" has_more="${hasMore}">\n`
      for (const { docId, title, outline } of discoveredOutlines) {
        output += `<document_outline doc_id="${docId}" title="${title}">\n${outline}\n</document_outline>\n`
      }
      if (hasMore) {
        output += `<system_instruction>More outlines may be available. Call getDocumentOutline again with offset: ${nextOffset} to see more.</system_instruction>\n`
      }
      output += `</document_outlines>`

      return {
        content: [{ type: "text", text: output }],
        details: {
          toolName: "getDocumentOutline",
          documentsSearched: discoveredDocIds.size,
          outlinesReturned: discoveredOutlines.length,
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          {
            type: "text",
            text: `Critical error in getDocumentOutline: ${errMsg}`,
          },
        ],
        isError: true,
        details: { toolName: "getDocumentOutline", error: errMsg },
      }
    }
  },
)
