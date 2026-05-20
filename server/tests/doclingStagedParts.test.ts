import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PDFDocument } from "pdf-lib"

const pathExists = async (targetPath: string): Promise<boolean> => {
  try {
    await readFile(targetPath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false
    }
    throw error
  }
}

describe("Docling staged PDF parts", () => {
  test("writes page parts to disk and cleans them after use", async () => {
    const tempRoot = await mkdtemp(
      path.join(os.tmpdir(), "xyne-docling-staged-parts-"),
    )
    process.env.DOCLING_TEMP_RESULTS_DIR = tempRoot
    process.env.DOCLING_KEEP_TEMP_RESULTS = "false"

    const { PdfProcessor } = await import("@/lib/pdfProcessor")

    try {
      const pdf = await PDFDocument.create()
      for (let index = 0; index < 5; index += 1) {
        pdf.addPage([100, 100])
      }
      const sourceBytes = await pdf.save()
      const sourceBuffer = Buffer.from(sourceBytes)
      const sourcePath = path.join(tempRoot, "source.pdf")
      await Bun.write(sourcePath, sourceBuffer)

      const loadedPdfDocument = await PdfProcessor.loadDocument(sourceBuffer)
      expect(loadedPdfDocument?.pageCount).toBe(5)

      const stagedParts = await PdfProcessor.stageDoclingPageParts({
        fileId: "file-test",
        source: loadedPdfDocument!,
        sourcePath,
        fileName: "source.pdf",
        vespaDocId: "vespa-doc-test",
        pageChunkSize: 2,
        knownTotalPages: 5,
      })

      expect(stagedParts.partsTotal).toBe(3)
      expect(stagedParts.parts.map((part) => part.startPage)).toEqual([0, 2, 4])
      expect(stagedParts.parts.map((part) => part.endPage)).toEqual([2, 4, 5])

      const manifest = JSON.parse(
        await readFile(stagedParts.manifestPath, "utf8"),
      )
      expect(manifest.partsTotal).toBe(3)
      expect(manifest.parts[0].partPath).toBe("parts/00000.pdf")

      for (const part of stagedParts.parts) {
        expect(await pathExists(part.partPath)).toBe(true)
        const partPdf = await PDFDocument.load(
          await PdfProcessor.readStagedPartBuffer(part),
        )
        expect(partPdf.getPageCount()).toBe(part.endPage - part.startPage)
      }

      await PdfProcessor.deleteStagedPart(stagedParts.parts[0])
      expect(await pathExists(stagedParts.parts[0].partPath)).toBe(false)

      await PdfProcessor.cleanupStagedDoclingParts(stagedParts)
      expect(await pathExists(stagedParts.manifestPath)).toBe(false)
    } finally {
      await rm(tempRoot, { recursive: true, force: true })
    }
  }, 15_000)
})
