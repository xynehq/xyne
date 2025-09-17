import { readFileSync } from "fs"
import { resolve } from "path"
import { FileProcessorService } from "@/services/fileProcessor"
import { extractTextAndImagesWithChunksFromPDF } from "@/pdfChunks"

async function testPdfDirect() {
  let pdfPath = "/Users/aayush.shah/Downloads/juspay.pdf"
    // const pdfPath = "/Users/aayush.shah/Downloads/Aayush_Resume_2025.pdf"
  // pdfPath = "/Users/aayush.shah/Downloads/somatosensory.pdf"
  try {
    console.log("=== DIRECT PDF PROCESSING TEST ===")
    console.log("PDF Path:", pdfPath)

    // Read the PDF file
    // console.log("\n1. Reading PDF file...")
    const pdfBuffer = readFileSync(pdfPath)
    // console.log("File size:", pdfBuffer.length, "bytes")

    // console.log("\n2. Testing direct PDF processing (current knowledge base flow)...")
    // console.log("This simulates exactly what happens in the knowledge base upload:")
    // console.log("- FileProcessorService.processFile() is called")
    // console.log("- extractImages defaults to false")
    // console.log("- describeImages defaults to false")

    // // Test the exact flow used in knowledge base
    // const result = await FileProcessorService.processFile(
    //   pdfBuffer,
    //   "application/pdf",
    //   "small2.pdf",
    //   "test-doc-id",
    //   pdfPath
    //   // extractImages and describeImages default to false
    // )

    // console.log("\n=== RESULTS FROM KNOWLEDGE BASE FLOW ===")
    // console.log("Text chunks:", result.chunks.length)
    // console.log("Image chunks:", result.image_chunks.length)
    // console.log("Text chunk positions:", result.chunks_pos.length)
    // console.log("Image chunk positions:", result.image_chunks_pos.length)

    console.log("\n3. Testing with image processing enabled...")
    console.log("Parameters: extractImages=true, describeImages=true")

    // Test with images enabled to see the difference
    const imageResult = await extractTextAndImagesWithChunksFromPDF(
      new Uint8Array(pdfBuffer),
      "test-doc-with-images",
      true,  // extractImages enabled
      true   // describeImages enabled
    )

    console.log("\n=== RESULTS WITH IMAGES ENABLED ===")
    console.log("Text chunks:", imageResult.text_chunks.length)
    console.log("Image chunks:", imageResult.image_chunks.length)
    console.log("Text chunk positions:", imageResult.text_chunk_pos.length)
    console.log("Image chunk positions:", imageResult.image_chunk_pos.length)

    // console.log("\n=== COMPARISON ===")
    // console.log("Current KB flow - Text chunks:", result.chunks.length, "Image chunks:", result.image_chunks.length)
    // console.log("With images    - Text chunks:", imageResult.text_chunks.length, "Image chunks:", imageResult.image_chunks.length)

    // if (result.chunks.length > 0) {
    //   console.log("\n=== SAMPLE TEXT CHUNKS ===")
    //   result.chunks.slice(0, 2).forEach((chunk, idx) => {
    //     console.log(`\nText Chunk ${idx + 1}:`)
    //     console.log(chunk)
    //   })
    // }

    if (imageResult.image_chunks.length > 0) {
      console.log("\n=== SAMPLE IMAGE DESCRIPTIONS ===")
      imageResult.image_chunks.forEach((chunk, idx) => {
        console.log(`\nImage ${idx + 1}:`)
        console.log(chunk)
      })
    }

    console.log("\n=== TEST COMPLETED ===")
    console.log("✓ Check the debug logs above from pdfChunks.ts")
    console.log("✓ You can see exactly what's being processed in the current knowledge base flow")

  } catch (error) {
    console.error("Error processing PDF:", error)
    process.exit(1)
  }
}

// Run the test
testPdfDirect().catch(console.error)