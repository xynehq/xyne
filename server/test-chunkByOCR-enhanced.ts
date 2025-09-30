import { promises as fsPromises } from "fs"
import { chunkByOCR, chunkByOCRFromBuffer } from "./lib/chunkByOCR"

// Load the actual image file from Downloads
async function loadTestImageBuffer(): Promise<Buffer> {
  const imagePath = "/Users/aayush.shah/Downloads/image.png"
  try {
    console.log(`📷 Loading real image from: ${imagePath}`)
    const imageBuffer = await fsPromises.readFile(imagePath)
    console.log(
      `✅ Real image loaded successfully. Size: ${imageBuffer.length} bytes`,
    )
    return imageBuffer
  } catch (error) {
    console.error(
      `❌ Failed to load image from ${imagePath}:`,
      (error as Error).message,
    )
    console.log("🔄 Falling back to test image buffer...")
    // Fallback to a test image if the real one can't be loaded
    const whitePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg=="
    return Buffer.from(whitePixelPng, "base64")
  }
}

// Create a dummy API response that mimics the structure from the provided JSON
async function createDummyLayoutParsingApiResponse() {
  const realImageBuffer = await loadTestImageBuffer()
  const realImageBase64 = realImageBuffer.toString("base64")

  return {
    layoutParsingResults: [
      {
        prunedResult: {
          model_settings: {
            use_doc_preprocessor: false,
            use_seal_recognition: true,
            use_table_recognition: true,
            use_formula_recognition: true,
            use_chart_recognition: false,
            use_region_detection: true,
          },
          parsing_res_list: [
            {
              block_label: "doc_title",
              block_content:
                "Building blocks poised to bring 10X impact for our travel partners, across the ecosystem",
              block_bbox: [393, 136, 2433, 342],
            },
            {
              block_label: "image",
              block_content:
                "Full Suite FinOps Tool Orchestration & FRM virtual cards maker-checker reporting & insights smart & dynamic routing custom FRM engines AI based recon supplier payments notifications 300+ global PSPs & Payment methods flag anomalies Expense Management Detect anomalies Split settlements Smart Retries Superior Checkout Experience Reliable Global Coverage High Efficiency Low risk & Cost 1-click checkout customizable UiUx multiple payment networks 15+ currencies seamless 3DS experience Offers & loyalty engine single API Integration work with global banks Tokenization & card vault refunds & chargebacks GDS VISA local payment methods multi language support Networks HSBC Boost Conversions OTA/TMCs Global Coverage Acquirers Customer(CTA/BTA) IATA BSP",
              block_bbox: [48, 382, 2859, 1620],
            },
          ],
        },
        markdown: {
          text: '# Building blocks poised to bring 10X impact for our travel partners, across the ecosystem\n\n<div style="text-align: center;"><img src="imgs/img_in_image_box_48_382_2859_1620.jpg" alt="Image" width="97%" /></div>\n',
          isStart: false,
          isEnd: true,
          images: {
            "imgs/img_in_image_box_48_382_2859_1620.jpg": realImageBase64,
          },
        },
      },
      {
        prunedResult: {
          model_settings: {
            use_doc_preprocessor: false,
            use_seal_recognition: true,
            use_table_recognition: true,
            use_formula_recognition: true,
            use_chart_recognition: false,
            use_region_detection: true,
          },
          parsing_res_list: [
            {
              block_label: "text",
              block_content: "BOOST CONVERSIONS & REDUCE FRAUD",
              block_bbox: [139, 232, 880, 267],
            },
            {
              block_label: "doc_title",
              block_content: "Salvage failed transactions with Payment Retries",
              block_bbox: [142, 299, 1542, 502],
            },
            {
              block_label: "paragraph_title",
              block_content: "1 Silent Retries",
              block_bbox: [137, 609, 515, 676],
            },
            {
              block_label: "text",
              block_content:
                "If a transaction fails because of a technical reason, we retry the transaction with a different PSP.",
              block_bbox: [241, 704, 989, 845],
            },
            {
              block_label: "text",
              block_content:
                "The decision whether to retry or not is based on error reason.",
              block_bbox: [241, 875, 1044, 962],
            },
            {
              block_label: "paragraph_title",
              block_content: "2 Manual Retries",
              block_bbox: [138, 1038, 545, 1101],
            },
            {
              block_label: "text",
              block_content:
                "In case a transaction fails with a definitive error message, we redirect the user to a Payment Retry screen and nudge the user to use a different Payment Instrument",
              block_bbox: [240, 1130, 1051, 1329],
            },
            {
              block_label: "table",
              block_content:
                "<html><body><table><tbody><tr><td>Merchant ID</td><td>Success GMV</td><td>Total Success Transactions</td><td>Total Retried GMV</td><td>Total Retried Transactions</td><td>Success Rate</td></tr><tr><td>9</td><td>352,793</td><td>798</td><td>539,021</td><td>1,163</td><td>68.62%</td></tr><tr><td></td><td>229,852</td><td>513</td><td>344,956</td><td>745</td><td>68.86%</td></tr></tbody></table></body></html>",
              block_bbox: [1207, 627, 2834, 1333],
            },
            {
              block_label: "vision_footnote",
              block_content:
                "For the first merchant, we retried 1,163 transactions over a 24 hr window and 798 were successful",
              block_bbox: [1306, 1369, 2734, 1399],
            },
          ],
        },
        markdown: {
          text: "BOOST CONVERSIONS & REDUCE FRAUD\n\n# Salvage failed transactions with Payment Retries\n\n## 1 Silent Retries\n\nIf a transaction fails because of a technical reason, we retry the transaction with a different PSP.\n\nThe decision whether to retry or not is based on error reason.\n\n## 2 Manual Retries\n\nIn case a transaction fails with a definitive error message, we redirect the user to a Payment Retry screen and nudge the user to use a different Payment Instrument",
          isStart: false,
          isEnd: false,
          images: {},
        },
      },
    ],
    dataInfo: {
      totalPages: 2,
      processingTime: "1.5s",
    },
  }
}

// Mock OCR response data that matches the chunkByOCR expected format
const mockOcrResponse = {
  "0": [
    {
      block_label: "doc_title",
      block_bbox: [393, 136, 2433, 342],
      block_content:
        "# Building blocks poised to bring 10X impact for our travel partners, across the ecosystem",
    },
    {
      block_label: "image",
      block_bbox: [48, 382, 2859, 1620],
      block_content:
        "Full Suite FinOps Tool Orchestration & FRM virtual cards maker-checker reporting & insights smart & dynamic routing custom FRM engines AI based recon supplier payments notifications 300+ global PSPs & Payment methods flag anomalies Expense Management Detect anomalies Split settlements Smart Retries Superior Checkout Experience Reliable Global Coverage High Efficiency Low risk & Cost 1-click checkout customizable UiUx multiple payment networks 15+ currencies seamless 3DS experience Offers & loyalty engine single API Integration work with global banks Tokenization & card vault refunds & chargebacks GDS VISA local payment methods multi language support Networks HSBC Boost Conversions OTA/TMCs Global Coverage Acquirers Customer(CTA/BTA) IATA BSP",
      image_index: 0,
    },
  ],
  "1": [
    {
      block_label: "text",
      block_bbox: [139, 232, 880, 267],
      block_content: "BOOST CONVERSIONS & REDUCE FRAUD",
    },
    {
      block_label: "doc_title",
      block_bbox: [142, 299, 1542, 502],
      block_content: "# Salvage failed transactions with Payment Retries",
    },
    {
      block_label: "paragraph_title",
      block_bbox: [137, 609, 515, 676],
      block_content: "## 1 Silent Retries",
    },
    {
      block_label: "text",
      block_bbox: [241, 704, 989, 845],
      block_content:
        "If a transaction fails because of a technical reason, we retry the transaction with a different PSP.",
    },
    {
      block_label: "text",
      block_bbox: [241, 875, 1044, 962],
      block_content:
        "The decision whether to retry or not is based on error reason.",
    },
    {
      block_label: "paragraph_title",
      block_bbox: [138, 1038, 545, 1101],
      block_content: "## 2 Manual Retries",
    },
    {
      block_label: "text",
      block_bbox: [240, 1130, 1051, 1329],
      block_content:
        "In case a transaction fails with a definitive error message, we redirect the user to a Payment Retry screen and nudge the user to use a different Payment Instrument",
    },
    {
      block_label: "table",
      block_bbox: [1207, 627, 2834, 1333],
      block_content:
        "<html><body><table><tbody><tr><td>Merchant ID</td><td>Success GMV</td><td>Total Success Transactions</td><td>Total Retried GMV</td><td>Total Retried Transactions</td><td>Success Rate</td></tr><tr><td>9</td><td>352,793</td><td>798</td><td>539,021</td><td>1,163</td><td>68.62%</td></tr><tr><td></td><td>229,852</td><td>513</td><td>344,956</td><td>745</td><td>68.86%</td></tr></tbody></table></body></html>",
    },
    {
      block_label: "vision_footnote",
      block_bbox: [1306, 1369, 2734, 1399],
      block_content:
        "For the first merchant, we retried 1,163 transactions over a 24 hr window and 798 were successful",
    },
  ],
}

// Mock the callLayoutParsingApi function
const originalFetch = global.fetch

function setupMockApi() {
  console.log("🔧 Setting up mock API for layout parsing...")

  // @ts-ignore
  global.fetch = async (url: string, options: any) => {
    console.log("🌐 Mock API called:", { url, method: options?.method })

    if (url.includes("layout-parsing")) {
      const mockResponse = await createDummyLayoutParsingApiResponse()

      console.log("📡 Mock API: Returning dummy response", {
        layoutResultsCount: mockResponse.layoutParsingResults.length,
      })

      return {
        ok: true,
        status: 200,
        json: async () => ({
          outputs: [
            {
              data: [JSON.stringify({ result: mockResponse })],
            },
          ],
        }),
        text: async () => "",
      }
    }

    // Fallback to original fetch for other URLs
    return originalFetch(url, options)
  }
}

function restoreMockApi() {
  console.log("🔄 Restoring original fetch...")
  global.fetch = originalFetch
}

async function testChunkByOCR() {
  try {
    console.log("🚀 Starting enhanced chunkByOCR test...\n")
    console.log("=".repeat(60))

    // TEST 1: Direct chunkByOCR function with mock data
    console.log("\n=== TEST 1: Direct chunkByOCR function ===")

    const testImageBuffer = await loadTestImageBuffer()

    // Create images map using the test image buffer
    const images = {
      0: testImageBuffer, // For image_index: 0 on page 0
    }

    const docId = "test-doc-12345"
    console.log(`📋 Testing with docId: ${docId}\n`)

    console.log("🔧 Calling chunkByOCR function...")
    const result1 = await chunkByOCR(docId, mockOcrResponse, images)

    console.log("\n📊 Raw Results:")
    console.log("chunks:", result1.chunks)
    console.log("chunks_map:", result1.chunks_map)
    console.log("chunks_pos:", result1.chunks_pos)
    console.log("image_chunks:", result1.image_chunks)
    console.log("image_chunks_map:", result1.image_chunks_map)
    console.log("image_chunks_pos:", result1.image_chunks_pos)

    console.log("\n📊 RESULTS FROM DIRECT FUNCTION:")
    console.log("=".repeat(50))

    console.log("\n📝 TEXT CHUNKS:")
    console.log("-".repeat(30))
    result1.chunks.forEach((chunk, index) => {
      console.log(`\nChunk ${index + 1}:`)
      console.log(`Content: "${chunk}"`)
      console.log(`Full length: ${chunk.length} chars`)
      console.log(`Byte length: ${Buffer.byteLength(chunk, "utf8")} bytes`)
      if (result1.chunks_map[index]) {
        console.log(`Page: ${result1.chunks_map[index].page_number}`)
        console.log(
          `Block labels: [${result1.chunks_map[index].block_labels.join(", ")}]`,
        )
      }
    })

    console.log("\n🖼️  IMAGE CHUNKS:")
    console.log("-".repeat(30))
    result1.image_chunks.forEach((imageChunk, index) => {
      console.log(`\nImage ${index + 1}:`)
      console.log(`Description: "${imageChunk}"`)
      if (result1.image_chunks_map[index]) {
        console.log(`Page: ${result1.image_chunks_map[index].page_number}`)
        console.log(
          `Block labels: [${result1.image_chunks_map[index].block_labels.join(", ")}]`,
        )
      }
    })

    console.log("\n📈 SUMMARY TEST 1:")
    console.log("-".repeat(30))
    console.log(`Total text chunks: ${result1.chunks.length}`)
    console.log(`Total image chunks: ${result1.image_chunks.length}`)
    console.log(`Text chunks metadata count: ${result1.chunks_map.length}`)
    console.log(
      `Image chunks metadata count: ${result1.image_chunks_map.length}`,
    )

    console.log("\n✅ Test 1 completed successfully!")

    // TEST 2: chunkByOCRFromBuffer function with mock API
    console.log(
      "\n\n=== TEST 2: chunkByOCRFromBuffer function with Mock API ===",
    )

    setupMockApi()

    try {
      // Create a sample buffer (simulate a PDF/document file)
      const sampleText =
        "This is a sample document buffer for testing OCR processing capabilities with dummy API responses."
      const testBuffer = Buffer.from(sampleText, "utf-8")
      const testFileName = "test-document.pdf"
      const testDocId = "buffer-test-doc-67890"

      console.log(
        `🔧 Calling chunkByOCRFromBuffer with buffer (${testBuffer.length} bytes)...\n`,
      )

      // Call the buffer-based function
      const result2 = await chunkByOCRFromBuffer(
        testBuffer,
        testFileName,
        testDocId,
      )

      console.log("📊 RESULTS FROM BUFFER FUNCTION WITH MOCK API:")
      console.log("=".repeat(50))

      console.log("\n📝 TEXT CHUNKS:")
      console.log("-".repeat(30))
      result2.chunks.forEach((chunk, index) => {
        console.log(`\nChunk ${index + 1}:`)
        console.log(
          `Content: "${chunk.substring(0, 100)}${chunk.length > 100 ? "..." : ""}"`,
        )
        console.log(`Full length: ${chunk.length} chars`)
        console.log(`Byte length: ${Buffer.byteLength(chunk, "utf8")} bytes`)
        if (result2.chunks_map[index]) {
          console.log(`Page: ${result2.chunks_map[index].page_number}`)
          console.log(
            `Block labels: [${result2.chunks_map[index].block_labels.join(", ")}]`,
          )
        }
      })

      console.log("\n🖼️  IMAGE CHUNKS:")
      console.log("-".repeat(30))
      result2.image_chunks.forEach((imageChunk, index) => {
        console.log(`\nImage ${index + 1}:`)
        console.log(
          `Description: "${imageChunk.substring(0, 100)}${imageChunk.length > 100 ? "..." : ""}"`,
        )
        if (result2.image_chunks_map[index]) {
          console.log(`Page: ${result2.image_chunks_map[index].page_number}`)
          console.log(
            `Block labels: [${result2.image_chunks_map[index].block_labels.join(", ")}]`,
          )
        }
      })

      console.log("\n📈 SUMMARY TEST 2:")
      console.log("-".repeat(30))
      console.log(`Total text chunks: ${result2.chunks.length}`)
      console.log(`Total image chunks: ${result2.image_chunks.length}`)
      console.log(`Text chunks metadata count: ${result2.chunks_map.length}`)
      console.log(
        `Image chunks metadata count: ${result2.image_chunks_map.length}`,
      )

      console.log("\n✅ Test 2 completed successfully!")
    } finally {
      restoreMockApi()
    }

    console.log("\n🎉 All tests completed successfully!")
    console.log(
      "🔍 Check the console logs above for detailed debugging information from the chunkByOCR functions.",
    )
    console.log(
      "📁 Check the downloads/xyne_images_db/ directory for saved images.",
    )
  } catch (error) {
    console.error("❌ Test failed:", error)
    if (error instanceof Error) {
      console.error("Error message:", error.message)
      console.error("Stack trace:", error.stack)
    }
  } finally {
    // Ensure mock is restored even if tests fail
    restoreMockApi()
  }
}

// Run the test
testChunkByOCR()
