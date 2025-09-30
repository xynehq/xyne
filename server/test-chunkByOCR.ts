import { promises as fsPromises } from "fs"
import { chunkByOCR, chunkByOCRFromBuffer } from "./lib/chunkByOCR"

// Mock OCR response data from user
const mockOcrResponse = {
  "0": [
    {
      block_label: "doc_title",
      block_bbox: [393, 136, 2433, 342],
      block_content:
        "Building blocks poised to bring 10Ximpact for  our travel partners, across the ecosysem ",
    },
    {
      block_label: "image",
      block_bbox: [48, 382, 2859, 1620],
      block_content:
        "Full Suite FinOps Tool 81Orchestration& FRM virtual cards maker-checker reporting & insights \nsmart & dynamic routing custom FRM engines Al based recon supplier payments notifcations 300+ global PSPS & Payment methods flag anomalies Expense Management Detect anomalies Split settlements Smart Retries 司Superior Checkout Experience Reliable Global Coverage High Efficiency Low risk & Cost 1-click checkout customisable UiUx aMaDEus multiple payment networks 15+ currencies seamless 3DS experience Offers & loyalty engine Sabre Travelport single APl Integration work with global banks Tokenisation & card vault refunds & chargebacks GDS VISA local payment methods multi language support agodo \nNetworks HSBC Boost Conversions OTA/TMCs CHASEO Global Coverage \nAcquirers Customer(CTA/BTA)IATA BSP 9",
      image_index: 0,
    },
  ],
  "1": [
    {
      block_label: "text",
      block_bbox: [139, 232, 880, 267],
      block_content: "BOOSTCONVERSIONS&REDUCEFRAUD ",
    },
    {
      block_label: "doc_title",
      block_bbox: [142, 299, 1542, 502],
      block_content: "Salvage failed transactions with  Payment Retries ",
    },
    {
      block_label: "paragraph_title",
      block_bbox: [137, 609, 515, 676],
      block_content: "## 1Silent Retries ",
    },
    {
      block_label: "text",
      block_bbox: [241, 704, 989, 845],
      block_content:
        "lf a transaction fails because of a technical reason, we retry the transaction with a different PSP.\n",
    },
    {
      block_label: "text",
      block_bbox: [241, 875, 1044, 962],
      block_content:
        "Te decision whether to retry or not is based on errorreason.\n",
    },
    {
      block_label: "paragraph_title",
      block_bbox: [138, 1038, 545, 1101],
      block_content: "## 2Manual Retries ",
    },
    {
      block_label: "text",
      block_bbox: [240, 1130, 1051, 1329],
      block_content:
        "In case a transaction fails with a definitive error message, we redirect the user to a Payment Retry screen and nudge the user to use a different Payment Instrument ",
    },
    {
      block_label: "table",
      block_bbox: [1207, 626, 2834, 1334],
      block_content:
        "<html><body><table><tbody><tr><td>Merchant ID …</td><td>Success GMV</td><td>… Total Success Transactions</td><td>… Total Retried GMV</td><td>… Total Retried Transactions</td><td>… Success Rate …</td></tr><tr><td>9</td><td>352,793</td><td>798</td><td>539,021</td><td>1,163</td><td>68.62%</td></tr><tr><td></td><td>229,852</td><td>513</td><td>344,956</td><td>745</td><td>68.86%</td></tr><tr><td></td><td>149,088</td><td>336</td><td>310,843</td><td>626</td><td>53.67%</td></tr><tr><td></td><td>190,204</td><td>271</td><td>916,316</td><td>1,179</td><td>22.99%</td></tr><tr><td></td><td>203,285</td><td>264</td><td>260,963</td><td>338</td><td>78.11%</td></tr><tr><td></td><td>218,477</td><td>224</td><td>398,677</td><td>469</td><td>47.76%</td></tr><tr><td></td><td>414,896</td><td>182</td><td>1,700,841</td><td>763</td><td>23.85%</td></tr><tr><td></td><td>563,032</td><td>177</td><td>821,652</td><td>251</td><td>70.52%</td></tr><tr><td></td><td>838,128</td><td>175</td><td>1,123,564</td><td>247</td><td>70.85%</td></tr><tr><td></td><td>124,010</td><td>153</td><td>853,399</td><td>653</td><td>23.43%</td></tr><tr><td></td><td>424,841</td><td>147</td><td>899,385</td><td>361</td><td>40.72%</td></tr><tr><td></td><td>347,240</td><td>137</td><td>1,252,796</td><td>1,143</td><td>11.99%</td></tr><tr><td>ＮＺＭарσοＡтрσ</td><td>25,130</td><td>126</td><td>47,321</td><td>246</td><td>51.22%</td></tr><tr><td></td><td>1,387,151</td><td>116</td><td>3,379,458</td><td>233</td><td>49.79%</td></tr><tr><td></td><td>6,423,357</td><td>111</td><td>15,583,594</td><td>269</td><td>41.26%</td></tr></tbody></table></body></html>",
    },
    {
      block_label: "vision_footnote",
      block_bbox: [1306, 1369, 2734, 1399],
      block_content:
        "For the first merchant,we retried 1,163 transactions over a 24 hr window and 798 were successful ",
    },
  ],
  "2": [
    {
      block_label: "text",
      block_bbox: [138, 232, 881, 268],
      block_content: "BOOSTCONVERSIONS&REDUCEFRAUD ",
    },
    {
      block_label: "doc_title",
      block_bbox: [139, 300, 1659, 502],
      block_content:
        "Adaptive payment flows based on  yourdata ＆fallback3DS newuser ",
    },
    {
      block_label: "text",
      block_bbox: [137, 620, 1460, 729],
      block_content:
        "Select the most optimized flow to balance user experience and fraud prevention, leveraging customerand payment data.",
    },
    {
      block_label: "image",
      block_bbox: [101, 911, 1991, 1403],
      block_content:
        "Step UP 。Memproses pembayaran Anda...\nForrepeat UX JUSPAY Safe \n3DS SUCCESSFUL Bind device a No Step UP if \nFAILED Silent Retry using Acquirer 2",
      image_index: 0,
    },
    {
      block_label: "image",
      block_bbox: [2112, 337, 2667, 1469],
      block_content:
        "10:10Pembayaran BCA ID Check KodeOfetikllakirkenoHPAna4Digttakh666MohonmasukkanKodeOtentikasl pembayaran inisebelurnwaktu habis \nSisa waktu:05:29\nNama Merchant :Takopedia.com Jumlah ：IDR20.900.00Tanggal Transaksi Rabu,19Jul2023\n14:00:39GMT+0700NomorBCA Mastercard xXXXxxxExxXx6537Kode Otentikasi Mastercard 。\nBatalkan Kirim WangKude Dfenlal OK oTPberilarnhahjanganberithukankepadaslapapun Hubungi HaloBCAviaWhatsAppdi08111500998.ketik HaloBCAuntukmemulalatauviatelepon1500888untukbantuan secured by  JUSPAY otomatismembacaOTP berhasil dikirim ke nomor ponsel yang ditautkan Ketuk untuk memasukkan secara manual \n00:29",
      image_index: 1,
    },
  ],
  "3": [
    {
      block_label: "paragraph_title",
      block_bbox: [145, 102, 446, 253],
      block_content: "## CASE STUDY - I IndiGo ",
    },
    {
      block_label: "image",
      block_bbox: [130, 475, 2748, 1618],
      block_content:
        "Coverage Payment Processing Cost Authentication & Risk Management System integrations 10%V 15+25%Adaptive 3DS FRMEngine 8+ Global IATA 曲Pay worldpay &more LowerProcessing Settlement Lower Cross Border FRM Requested 3D Secure PSPs cybersourco Authentication Costs Currencies Fees \nAllow Rule Match \nAPPROVED REJECTED navitaire IATA BSP Block Rule Match an aMaDEus company IATA OTP \n****\nCheckout Conversion Review Rule Match IATA ©IFG ARC \nHouse Number Street \n12B MGRoad \nIntelligent routing 12%个Uplift Address Verification Country India City Bangalore Payment integrations 自Cost System Postal Code State \n560095Karanataka Automatic Retries Currency 20+Across SEA,Middle East \nCountries and EU Cybersource €Customer location \nDecision \nPSPs and Acquirers Manager Integrity Check APMs DEAL Pay Alipay &more 于Payment method \nValidation with third $Ticket size party/merchant for navitaire Adaptive amount and booking Offers capillary an aMaDcuscompany  InspireNetz &more Pricing& Currency & more state before proceeding ahead with Payments.\nConversion \n",
      image_index: 0,
    },
  ],
}

async function testChunkByOCR() {
  try {
    console.log("🚀 Starting chunkByOCR test...\n")

    // Load the image file
    const imagePath =
      "/Users/aayush.shah/Downloads/robust_test_images/page-1-image-1.png"
    console.log(`📷 Loading image from: ${imagePath}`)

    const imageBuffer = await fsPromises.readFile(imagePath)
    console.log(
      `✅ Image loaded successfully. Size: ${imageBuffer.length} bytes\n`,
    )

    // Create images map - using the same image for all image_index references
    const images = {
      0: imageBuffer, // Use for all image_index: 0 references
      1: imageBuffer, // Use for image_index: 1 reference on page 2
    }

    // Test document ID
    const docId = "test-doc-12345"

    console.log("🔧 Calling chunkByOCR function...\n")

    // Call the chunkByOCR function
    const result = await chunkByOCR(docId, mockOcrResponse, images)

    // Print the results
    console.log("📊 RESULTS:")
    console.log("=".repeat(50))

    console.log("\n📝 TEXT CHUNKS:")
    console.log("-".repeat(30))
    result.text_chunks.forEach((chunk, index) => {
      console.log(`\nChunk ${index + 1}:`)
      console.log(`Content: "${chunk}"`)
      console.log(`Byte length: ${Buffer.byteLength(chunk, "utf8")} bytes`)
      if (result.text_chunks_pos[index]) {
        console.log(`Page: ${result.text_chunks_pos[index].page_number}`)
        console.log(
          `Block labels: [${result.text_chunks_pos[index].block_labels.join(", ")}]`,
        )
      }
    })

    console.log("\n🖼️  IMAGE CHUNKS:")
    console.log("-".repeat(30))
    result.image_chunks.forEach((imageChunk, index) => {
      console.log(`\nImage ${index + 1}:`)
      console.log(`Description: "${imageChunk}"`)
      if (result.image_chunk_pos[index]) {
        console.log(`Page: ${result.image_chunk_pos[index].page_number}`)
        console.log(
          `Block labels: [${result.image_chunk_pos[index].block_labels.join(", ")}]`,
        )
      }
    })

    console.log("\n📈 SUMMARY:")
    console.log("-".repeat(30))
    console.log(`Total text chunks: ${result.text_chunks.length}`)
    console.log(`Total image chunks: ${result.image_chunks.length}`)
    console.log(`Text chunks metadata count: ${result.text_chunks_pos.length}`)
    console.log(`Image chunks metadata count: ${result.image_chunk_pos.length}`)

    console.log("\n✅ Test 1 completed successfully!")

    // Test 2: New buffer-based function with dummy API
    console.log(
      "\n\n=== TEST 2: New chunkByOCRFromBuffer function with Dummy API ===",
    )

    // Create a sample buffer (simulate a file)
    const sampleText =
      "This is a sample document buffer for testing OCR processing capabilities with dummy API responses."
    const testBuffer = Buffer.from(sampleText, "utf-8")
    const testFileName = "test-document.txt"
    const testDocId = "buffer-test-doc-67890"

    console.log(
      `🔧 Calling chunkByOCRFromBuffer with buffer (${testBuffer.length} bytes)...\n`,
    )

    // Call the new buffer-based function
    const result2 = await chunkByOCRFromBuffer(
      testBuffer,
      testFileName,
      testDocId,
    )

    console.log("📊 RESULTS FROM BUFFER FUNCTION WITH DUMMY API:")
    console.log("=".repeat(50))

    console.log("\n📝 TEXT CHUNKS:")
    console.log("-".repeat(30))
    result2.chunks.forEach((chunk, index) => {
      console.log(`\nChunk ${index + 1}:`)
      console.log(`Content: "${chunk}"`)
      console.log(`Byte length: ${Buffer.byteLength(chunk, "utf8")} bytes`)
      if (result2.chunks_pos[index]) {
        console.log(`Page: ${result2.chunks_pos[index].page_number}`)
        console.log(
          `Block labels: [${result2.chunks_pos[index].block_labels.join(", ")}]`,
        )
      }
    })

    console.log("\n🖼️  IMAGE CHUNKS:")
    console.log("-".repeat(30))
    result2.image_chunks.forEach((imageChunk, index) => {
      console.log(`\nImage ${index + 1}:`)
      console.log(`Description: "${imageChunk}"`)
      if (result2.image_chunks_pos[index]) {
        console.log(`Page: ${result2.image_chunks_pos[index].page_number}`)
        console.log(
          `Block labels: [${result2.image_chunks_pos[index].block_labels.join(", ")}]`,
        )
      }
    })

    console.log("\n📈 SUMMARY:")
    console.log("-".repeat(30))
    console.log(`Total text chunks: ${result2.chunks.length}`)
    console.log(`Total image chunks: ${result2.image_chunks.length}`)
    console.log(`Text chunks metadata count: ${result2.chunks_pos.length}`)
    console.log(
      `Image chunks metadata count: ${result2.image_chunks_pos.length}`,
    )

    console.log("\n✅ Both tests completed successfully!")
  } catch (error) {
    console.error("❌ Test failed:", error)
    if (error instanceof Error) {
      console.error("Error message:", error.message)
      console.error("Stack trace:", error.stack)
    }
  }
}

// Run the test
testChunkByOCR()
