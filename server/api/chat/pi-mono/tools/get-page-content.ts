import { Type } from "@sinclair/typebox"
import { createXyneTool } from "../adapter"
import type { XyneToolContext } from "../adapter"
import { GetDocumentsByDocIds } from "@/search/vespa"
import { mergeFragmentLists } from "../fragment-utils"

const GET_PAGE_CONTENT_DESCRIPTION = [
  "Retrieve the exact text content of a specific page from a document.",
  "Use this tool when you know exactly which page contains the answer (e.g., from reading the document outline with `getDocumentOutline`).",
  "This is much more precise and exhaustive than keyword searching when you already know the page number.",
  "**Parameters:**",
  "- `vespaDocId`: The Vespa document ID (e.g. from `lsKnowledgeBase` or `getDocumentOutline`).",
  "- `pageNos`: An array of 1-based page numbers to retrieve. Can be a single page `[5]` or multiple pages `[5, 6, 7]`.",
].join(" ")

const getPageContentParams = Type.Object({
  vespaDocId: Type.String({
    description: "The Vespa document ID (vespaDocId) of the file to retrieve.",
    minLength: 1,
  }),
  pageNos: Type.Array(
    Type.Number({
      description: "A 1-based page number to retrieve.",
      minimum: 1,
    }),
    {
      description:
        "An array of 1-based page numbers to retrieve (e.g., [5] for Page 5, or [5, 6, 7] for Pages 5-7).",
      minItems: 1,
      maxItems: 20,
    },
  ),
  includeImages: Type.Optional(
    Type.Boolean({
      description:
        "Whether to include text descriptions of images found on the page. Defaults to true.",
      default: true,
    }),
  ),
})

export const getPageContentTool = createXyneTool(
  "getPageContent",
  GET_PAGE_CONTENT_DESCRIPTION,
  getPageContentParams,
  async (toolCallId, params, signal, onUpdate, ctx: XyneToolContext) => {
    try {
      const includeImages = params.includeImages ?? true
      const targetPageIndices = params.pageNos.map((p) => p - 1) // Convert 1-based to 0-indexed

      // Mock span for tracing (GetDocumentsByDocIds requires a span object)
      const mockSpan = {
        setAttribute: () => mockSpan,
        addEvent: () => mockSpan,
        end: () => mockSpan,
        startSpan: () => mockSpan,
      }

      const documents = await GetDocumentsByDocIds(
        [params.vespaDocId],
        mockSpan as any,
      )

      if (
        !documents ||
        !documents.root?.children ||
        documents.root.children.length === 0
      ) {
        return {
          content: [
            {
              type: "text",
              text: `Could not find document with ID ${params.vespaDocId}.`,
            },
          ],
          isError: true,
          details: { toolName: "getPageContent" },
        }
      }

      const doc = documents.root.children[0]
      const fields = doc.fields as any

      if (
        !fields ||
        (!fields.chunks && !fields.chunks_summary) ||
        !fields.chunks_map
      ) {
        return {
          content: [
            {
              type: "text",
              text: "Document does not have properly mapped chunks.",
            },
          ],
          isError: true,
          details: { toolName: "getPageContent" },
        }
      }

      const chunksMap = fields.chunks_map as Array<{
        chunk_index: number
        page_numbers: number[]
        block_labels?: string[]
      }>
      const imageChunksMap = fields.image_chunks_map as Array<{
        chunk_index: number
        page_numbers: number[]
        block_labels?: string[]
      }>

      const chunks = (fields.chunks || fields.chunks_summary || []) as string[]
      const imageChunks = (fields.image_chunks ||
        fields.image_chunks_summary ||
        []) as string[]

      // Filter chunks maps for the requested pages
      const pageChunkIndices = [
        ...new Set(
          (chunksMap || [])
            .filter(
              (meta) =>
                meta.page_numbers &&
                targetPageIndices.some((p) => meta.page_numbers.includes(p)),
            )
            .map((meta) => meta.chunk_index),
        ),
      ].sort((a, b) => a - b)

      const pageImageChunkIndices = includeImages
        ? [
            ...new Set(
              (imageChunksMap || [])
                .filter(
                  (meta) =>
                    meta.page_numbers &&
                    targetPageIndices.some((p) =>
                      meta.page_numbers.includes(p),
                    ),
                )
                .map((meta) => meta.chunk_index),
            ),
          ].sort((a, b) => a - b)
        : []

      if (pageChunkIndices.length === 0 && pageImageChunkIndices.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `Pages [${params.pageNos.join(", ")}] not found or are empty in document ${params.vespaDocId}.`,
            },
          ],
          details: { toolName: "getPageContent", pageNos: params.pageNos },
        }
      }

      let output = `<page_content doc_id="${params.vespaDocId}" pages="${params.pageNos.join(",")}" text_chunks="${pageChunkIndices.length}" image_chunks="${pageImageChunkIndices.length}">\n`

      const newFragments: any[] = []

      // Add text chunks, stripping the [Page N] prefix if present to save tokens
      for (const idx of pageChunkIndices) {
        if (idx < chunks.length) {
          let text = chunks[idx]
          // Strip [Page N] or [Page N-M] prefix since context already defines the page
          text = text.replace(/^\[Page \d+(-\d+)?\]\s*/, "")
          output += `${text}\n\n`

          newFragments.push({
            id: `${params.vespaDocId}_chunk_${idx}`,
            content: text,
            source: {
              docId: `${params.vespaDocId}_chunk_${idx}`, // using chunk ID as docId to ensure uniqueness
              title: fields.title || "Unknown Document",
              app: "KnowledgeBase",
              pageNumber: params.pageNos.join(", "),
            },
            confidence: 1,
          })
        }
      }

      // Merge fragments into current turn state so they are available for citations
      if (ctx.xyneState && newFragments.length > 0) {
        ctx.xyneState.currentTurnArtifacts.fragments = mergeFragmentLists(
          ctx.xyneState.currentTurnArtifacts.fragments || [],
          newFragments,
        )
        await ctx.persistState()
      }

      // Add image chunks if requested
      if (includeImages && pageImageChunkIndices.length > 0) {
        for (const idx of pageImageChunkIndices) {
          if (idx < imageChunks.length) {
            output += `[Image Description: ${imageChunks[idx]}]\n\n`
          }
        }
      }

      output += `</page_content>`

      return {
        content: [{ type: "text", text: output.trim() }],
        details: {
          toolName: "getPageContent",
          pageNos: params.pageNos,
          textChunksRead: pageChunkIndices.length,
          imageChunksRead: pageImageChunkIndices.length,
        },
      }
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error)
      return {
        content: [
          {
            type: "text",
            text: `Critical error in getPageContent: ${errMsg}`,
          },
        ],
        isError: true,
        details: { toolName: "getPageContent", error: errMsg },
      }
    }
  },
)
