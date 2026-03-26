import { z } from "zod"
import config from "@/config"
import { tocWindowSystemPrompt } from "@/ai/prompts"
import { jsonParseLLMOutput, getProviderByModel } from "@/ai/provider"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Ingest).child({ module: "knowledgeBase.toc" })

export const TOC_QUEUE_NAME = "file-toc-generation"
export const TOC_QUEUE_RETRY_LIMIT = 2
export const TOC_QUEUE_RETRY_DELAY_SECONDS = 60
export const TOC_QUEUE_EXPIRE_IN_HOURS = 12
export const TOC_PROCESSING_WORKER_THREADS = 1
export const TOC_PROCESSING_TEAM_SIZE = 3

export const TOC_PRESCAN_PAGE_LIMIT = 5
export const TOC_WINDOW_PAGE_LIMIT = 15
export const TOC_MAX_WINDOWS = 3
export const TOC_MAX_TOTAL_PAGES = 45

export const TOC_KNOWLEDGE_BASE_TOOL_DESCRIPTION = [
  "Read the background-generated table of contents for one exact PDF file in the accessible knowledge base scope. This will give you an overiview of the file along with its page numbers if available",
  "Use it only when the you need the document outline or chapter structure for a known PDF file.",
  "Do not use it for structure discovery across collections or folders; `ls` remains the browse tool across collections and folders.",
  "If the exact PDF file is not known yet, use `ls` first to resolve the file ID or canonical path, then call `toc`.",
].join(" ")

export const TocEntrySchema = z.object({
  title: z.string().min(1),
  level: z.number().int(),
  page_number: z.number().int(),
})

export const TocSchema = z.array(TocEntrySchema).nullable()

export const TocStatusSchema = z.enum([
  "pending",
  "processing",
  "completed",
  "not_found",
  "failed",
])

export const TocInfoSchema = z.object({
  status: TocStatusSchema,
  attempts: z.number().int().min(0),
  lastError: z.string().nullable().optional(),
})

export const TocToolStatusSchema = z.enum([
  "missing",
  "pending",
  "processing",
  "failed",
  "not_found",
  "completed",
])

export const TocToolOutputSchema = z.object({
  fileId: z.string(),
  collectionId: z.string(),
  status: TocToolStatusSchema,
  toc: TocSchema.optional(),
})

export const TocGenerationWindowResponseSchema = z.object({
  toc: z.array(TocEntrySchema).default([]),
  next_start_page: z.number().int().min(1).nullable().optional(),
  found_toc: z.boolean().optional(),
})

export type TocEntry = z.infer<typeof TocEntrySchema>
export type Toc = z.infer<typeof TocSchema>
export type TocInfo = z.infer<typeof TocInfoSchema>
export type TocStatus = z.infer<typeof TocStatusSchema>
export type TocToolStatus = z.infer<typeof TocToolStatusSchema>
export type TocToolOutput = z.infer<typeof TocToolOutputSchema>
export type TocGenerationWindowResponse = z.infer<
  typeof TocGenerationWindowResponseSchema
>

// Normalizes, validates, bounds, and deduplicates raw TOC entries before persistence.
export function sanitizeTocEntries(
  entries: TocEntry[],
  totalPages: number,
): TocEntry[] {
  const dedupe = new Set<string>()

  return entries
    .map((entry) => ({
      title: entry.title.trim(),
      level: entry.level,
      page_number: entry.page_number,
    }))
    .filter(
      (entry) =>
        entry.title.length > 0 &&
        Number.isInteger(entry.level) &&
        Number.isInteger(entry.page_number) &&
        entry.page_number >= 1 &&
        entry.page_number <= totalPages,
    )
    .filter((entry) => {
      const key = `${entry.title}\u0000${entry.level}\u0000${entry.page_number}`
      if (dedupe.has(key)) {
        return false
      }
      dedupe.add(key)
      return true
    })
}

// Calls the LLM on one TOC window and parses the structured continuation response.
export async function generateTocWindowResponse(args: {
  startPage: number
  endPage: number
  totalPages: number
  pages: Array<{ pageNumber: number; text: string }>
}): Promise<TocGenerationWindowResponse> {
  const requestedModelId = config.tocLlmModelRaw || null
  const modelId = config.tocLlmModel
  const payload = [
    `Physical PDF pages in this window: ${args.startPage}-${args.endPage} of ${args.totalPages}.`,
    "Each page is provided below with its physical PDF page number.",
    "Return JSON in this exact shape:",
    '{"toc":[{"title":"string","level":1,"page_number":7}],"next_start_page":null,"found_toc":false}',
    "Rules:",
    "- Use `toc` for the usable entries present in this window only.",
    "- `level` should reflect hierarchy depth inferred from indentation/numbering.",
    "- `page_number` must be the destination physical PDF page number named in the TOC, not the current window page.",
    "- Set `found_toc` to true when this window contains a usable TOC section.",
    "- Set `next_start_page` to the next physical PDF page to inspect only if the TOC continues later.",
    "- If the window does not contain a usable TOC, return an empty `toc`, `next_start_page: null`, and `found_toc: false`.",
    "",
    ...args.pages.map(
      (page) =>
        `PAGE ${page.pageNumber}\n${page.text.trim() || "[no extractable text]"}`,
    ),
  ].join("\n")

  const { text } = await getProviderByModel(modelId).converse(
    [
      {
        role: "user",
        content: [{ text: payload }],
      },
    ],
    {
      modelId,
      systemPrompt: tocWindowSystemPrompt,
      stream: false,
    },
  )

  Logger.info(
    {
      requestedModelId,
      resolvedModelId: modelId,
      startPage: args.startPage,
      endPage: args.endPage,
      totalPages: args.totalPages,
      responseText: text ?? "",
    },
    "[KnowledgeBase][TOC] Raw LLM response",
  )

  if (!text) {
    throw new Error("TOC model returned an empty response")
  }

  return TocGenerationWindowResponseSchema.parse(jsonParseLLMOutput(text))
}
