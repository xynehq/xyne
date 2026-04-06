import { readFile, writeFile } from "fs/promises"
import { extractTextAndImagesWithChunksFromPDF } from "../pdfChunks"

async function main() {
  const filePath = "/Users/nasim.sheikh/Downloads/jul-2025 - Master Circular for ESG Rating Providers (ERPs).pdf"
  const buffer = await readFile(filePath)
  const result = await extractTextAndImagesWithChunksFromPDF(new Uint8Array(buffer), "test", false, false, false)
  await writeFile("/tmp/pdf_chunks.txt", result.text_chunks.slice(0, 50).join("\n\n---\n\n"))
  console.log("Wrote chunks to /tmp/pdf_chunks.txt")
}
main().catch(console.error)
