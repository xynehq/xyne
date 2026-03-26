import path from "path"
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import {
  TOC_MAX_TOTAL_PAGES,
  TOC_MAX_WINDOWS,
  TOC_PRESCAN_PAGE_LIMIT,
  TOC_WINDOW_PAGE_LIMIT,
  type Toc,
  type TocEntry,
  generateTocWindowResponse,
  sanitizeTocEntries,
} from "@/knowledgeBase/toc"

const Logger = getLogger(Subsystem.Ingest).child({ module: "pdfToc" })

const PDFJS = pdfjsLib
const openjpegWasmPath =
  path.join(__dirname, "../node_modules/pdfjs-dist/wasm/") + "/"
const qcmsWasmPath =
  path.join(__dirname, "../node_modules/pdfjs-dist/wasm/") + "/"

const TOC_PAGE_KEYWORDS = ["table of contents", "contents", "index"] as const

type PdfPageText = {
  pageNumber: number
  text: string
}

type PdfTextReader = {
  totalPages: number
  getPages(startPage: number, count: number): Promise<PdfPageText[]>
  destroy(): Promise<void>
}

export class TocGenerationLimitError extends Error {}

function normalizePageText(text: string): string {
  return text
    .replace(/\u00A0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
}

function buildLinesFromTextItems(items: any[]): string[] {
  const lines: string[] = []
  let currentParts: string[] = []
  let previousY: number | null = null
  let previousHeight = 0

  const flush = () => {
    if (!currentParts.length) {
      return
    }

    const line = currentParts.join(" ").replace(/[ ]+/g, " ").trim()
    if (line.length > 0) {
      lines.push(line)
    }
    currentParts = []
  }

  for (const item of items) {
    const text = typeof item?.str === "string" ? item.str.trim() : ""
    if (!text) {
      continue
    }

    const transform = Array.isArray(item?.transform) ? item.transform : []
    const y = typeof transform[5] === "number" ? transform[5] : null
    const height = typeof item?.height === "number" ? item.height : 0
    const tolerance = Math.max(previousHeight, height, 10) * 0.4
    const startsNewLine =
      previousY !== null && y !== null && Math.abs(y - previousY) > tolerance

    if (startsNewLine) {
      flush()
    }

    currentParts.push(text)

    if (item?.hasEOL) {
      flush()
    }

    previousY = y
    previousHeight = height
  }

  flush()
  return lines
}

async function createPdfTextReader(buffer: Uint8Array): Promise<PdfTextReader> {
  const loadingTask = PDFJS.getDocument({
    data: buffer,
    wasmUrl: openjpegWasmPath,
    iccUrl: qcmsWasmPath,
    verbosity: PDFJS.VerbosityLevel.ERRORS,
  })

  const pdfDocument = await loadingTask.promise

  return {
    totalPages: pdfDocument.numPages,
    async getPages(startPage, count) {
      const endPage = Math.min(pdfDocument.numPages, startPage + count - 1)
      const pages: PdfPageText[] = []

      for (let pageNumber = startPage; pageNumber <= endPage; pageNumber += 1) {
        const page = await pdfDocument.getPage(pageNumber)
        const textContent = await page.getTextContent({
          includeMarkedContent: false,
          disableNormalization: false,
        })

        pages.push({
          pageNumber,
          text: normalizePageText(
            buildLinesFromTextItems(textContent.items as any[]).join("\n"),
          ),
        })
      }

      return pages
    },
    async destroy() {
      await loadingTask.destroy()
    },
  }
}

function chooseTocStartPage(pages: PdfPageText[]): number {
  for (const page of pages) {
    const normalized = page.text.toLowerCase()
    if (TOC_PAGE_KEYWORDS.some((keyword) => normalized.includes(keyword))) {
      return page.pageNumber
    }
  }

  return 1
}

export async function extractPdfPagesText(args: {
  buffer: Uint8Array
  startPage: number
  count: number
}): Promise<{ totalPages: number; pages: PdfPageText[] }> {
  const reader = await createPdfTextReader(args.buffer)

  try {
    return {
      totalPages: reader.totalPages,
      pages: await reader.getPages(args.startPage, args.count),
    }
  } finally {
    await reader.destroy()
  }
}

export async function generatePdfToc(buffer: Buffer): Promise<{
  outcome: "completed" | "not_found"
  toc: Toc
}> {
  const reader = await createPdfTextReader(new Uint8Array(buffer))
  const rawEntries: TocEntry[] = []
  let currentStartPage = 1
  let processedPages = 0
  let windowsProcessed = 0

  try {
    const prescanPages = await reader.getPages(1, TOC_PRESCAN_PAGE_LIMIT)
    currentStartPage = chooseTocStartPage(prescanPages)

    while (
      windowsProcessed < TOC_MAX_WINDOWS &&
      processedPages < TOC_MAX_TOTAL_PAGES &&
      currentStartPage <= reader.totalPages
    ) {
      const remainingBudget = TOC_MAX_TOTAL_PAGES - processedPages
      const pageCount = Math.min(
        TOC_WINDOW_PAGE_LIMIT,
        remainingBudget,
        reader.totalPages - currentStartPage + 1,
      )

      if (pageCount <= 0) {
        break
      }

      const pages = await reader.getPages(currentStartPage, pageCount)
      if (!pages.length) {
        break
      }

      const response = await generateTocWindowResponse({
        startPage: pages[0]!.pageNumber,
        endPage: pages[pages.length - 1]!.pageNumber,
        totalPages: reader.totalPages,
        pages,
      })

      windowsProcessed += 1
      processedPages += pages.length
      rawEntries.push(...response.toc)

      if (response.next_start_page == null) {
        break
      }

      if (
        response.next_start_page <= currentStartPage ||
        response.next_start_page > reader.totalPages
      ) {
        throw new Error(
          `Invalid next_start_page returned for TOC extraction: ${response.next_start_page}`,
        )
      }

      if (
        windowsProcessed >= TOC_MAX_WINDOWS ||
        processedPages >= TOC_MAX_TOTAL_PAGES
      ) {
        throw new TocGenerationLimitError(
          "TOC extraction exceeded the maximum configured window budget",
        )
      }

      currentStartPage = response.next_start_page
    }

    const toc = sanitizeTocEntries(rawEntries, reader.totalPages)
    if (!toc.length) {
      return { outcome: "not_found", toc: null }
    }

    return { outcome: "completed", toc }
  } catch (error) {
    Logger.error(error, "PDF TOC generation failed")
    throw error
  } finally {
    await reader.destroy()
  }
}
