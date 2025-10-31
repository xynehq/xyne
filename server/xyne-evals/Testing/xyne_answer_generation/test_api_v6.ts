#!/usr/bin/env bun

import { sign } from "hono/jwt"
import { db } from "../../../db/client"
import { getUserByEmail } from "../../../db/user"
import config from "../../../config"
import {
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  statSync,
} from "fs"
import { randomUUID } from "crypto"
import { join } from "path"

// Use environment variable for test user email, or default to a test email
const TEST_USER_EMAIL = "arshith.balaraju@juspay.in"

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET!

const AccessTokenCookieName = "access-token"
const RefreshTokenCookieName = "refresh-token"

// Configuration constants
const TRACER_TIMEOUT_MS = 90000 // 30 seconds
const POLLING_INTERVAL_MS = 1500 // Check every 1.5 seconds
const TRACER_DIR = join(process.cwd(), "xyne-evals", "data", "tracer-data")

/**
 * Generate JWT tokens programmatically (same logic as server.ts)
 */
const generateTokens = async (
  email: string,
  role: string,
  workspaceId: string,
  forRefreshToken: boolean = false,
) => {
  const payload = forRefreshToken
    ? {
        sub: email,
        role: role,
        workspaceId,
        tokenType: "refresh",
        exp: Math.floor(Date.now() / 1000) + config.RefreshTokenTTL,
      }
    : {
        sub: email,
        role: role,
        workspaceId,
        tokenType: "access",
        exp: Math.floor(Date.now() / 1000) + config.AccessTokenTTL,
      }
  const jwtToken = await sign(
    payload,
    forRefreshToken ? refreshTokenSecret : accessTokenSecret,
  )
  return jwtToken
}

/**
 * Generate authentication cookies programmatically by creating JWT tokens
 */
async function generateAuthenticationCookies() {
  console.log(`Generating authentication tokens for user: ${TEST_USER_EMAIL}`)

  try {
    // Get user from database
    const userResult = await getUserByEmail(db, TEST_USER_EMAIL)
    console.log("User query result:", JSON.stringify(userResult))

    if (!userResult || userResult.length === 0) {
      throw new Error(
        `User ${TEST_USER_EMAIL} not found in database. Please ensure this user exists or set TEST_USER_EMAIL environment variable to a valid user email.`,
      )
    }

    const user = userResult[0]
    console.log(
      `Found user: ${user.email} with role: ${user.role} in workspace: ${user.workspaceExternalId}`,
    )

    // Generate tokens using the same logic as the server
    const accessToken = await generateTokens(
      user.email,
      user.role,
      user.workspaceExternalId,
    )
    const refreshToken = await generateTokens(
      user.email,
      user.role,
      user.workspaceExternalId,
      true,
    )

    // Format cookies the same way the server does
    const accessTokenCookie = `${AccessTokenCookieName}=${accessToken}`
    const refreshTokenCookie = `${RefreshTokenCookieName}=${refreshToken}`

    // Combine cookies for the script to use
    const scriptCookies = `${accessTokenCookie}; ${refreshTokenCookie}`
    console.log("Successfully generated authentication tokens.")
    return scriptCookies
  } catch (error) {
    console.error("Error generating authentication tokens:", error)
    throw error
  }
}

/**
 * Read cookies from environment variable TEST_API_COOKIES
 */
function getCookiesFromEnv(): string | null {
  const cookies = process.env.TEST_API_COOKIES
  return cookies && cookies.trim() !== "" ? cookies : null
}

/**
 * Update the TEST_API_COOKIES environment variable in the .env file
 */
function updateCookiesInEnv(newCookies: string) {
  try {
    const envPath = join(process.cwd(), ".env")
    let envContent = readFileSync(envPath, "utf8")

    // Replace the TEST_API_COOKIES line
    const cookieRegex = /^TEST_API_COOKIES\s*=.*$/m
    if (cookieRegex.test(envContent)) {
      envContent = envContent.replace(
        cookieRegex,
        `TEST_API_COOKIES = "${newCookies}"`,
      )
    } else {
      // If not found, append it
      envContent += `\nTEST_API_COOKIES = "${newCookies}"`
    }

    writeFileSync(envPath, envContent, "utf8")
    console.log("Successfully updated TEST_API_COOKIES in .env file")

    // Update the current process environment as well
    process.env.TEST_API_COOKIES = newCookies
  } catch (error) {
    console.error("Error updating .env file:", error)
    throw error
  }
}

/**
 * Parse agentic mode responses that contain JAF (Juspay Agentic Framework) events
 * JAF events have specific structure for final outputs in run_end and final_output events
 */
function parseAgenticResponse(text: string): string {
  try {
    // Split the text into individual JSON objects
    const jsonObjects = []
    let braceCount = 0
    let currentJson = ""

    for (let i = 0; i < text.length; i++) {
      const char = text[i]

      if (char === "{") {
        if (braceCount === 0) {
          currentJson = ""
        }
        braceCount++
      }

      currentJson += char

      if (char === "}") {
        braceCount--
        if (braceCount === 0) {
          try {
            const parsed = JSON.parse(currentJson)
            jsonObjects.push(parsed)
          } catch (e) {
            // Skip invalid JSON
          }
          currentJson = ""
        }
      }
    }

    console.log(`Found ${jsonObjects.length} JSON objects in agentic response`)

    // PRIORITY 1: Look for JAF "final_output" events (most reliable for final answer)
    for (const obj of jsonObjects) {
      if (
        obj.type === "final_output" &&
        obj.data?.output &&
        typeof obj.data.output === "string"
      ) {
        console.log("Found JAF final_output event with data.output")
        return cleanUpAnswer(obj.data.output)
      }
    }

    // PRIORITY 2: Look for JAF "run_end" events with completed status and output
    for (const obj of jsonObjects) {
      if (
        obj.type === "run_end" &&
        obj.data?.outcome?.status === "completed" &&
        obj.data?.outcome?.output
      ) {
        console.log(
          "Found JAF run_end event with completed status and outcome.output",
        )
        return cleanUpAnswer(obj.data.outcome.output)
      }
    }

    // PRIORITY 3: Look for any JAF "run_end" events with output (even without status check)
    for (const obj of jsonObjects) {
      if (obj.type === "run_end" && obj.data?.outcome?.output) {
        console.log("Found JAF run_end event with outcome.output")
        return cleanUpAnswer(obj.data.outcome.output)
      }
    }

    // PRIORITY 4: Look for assistant_message events without tool_calls (final answer content)
    for (const obj of jsonObjects) {
      if (
        obj.type === "assistant_message" &&
        obj.data?.message?.content &&
        typeof obj.data.message.content === "string" &&
        !obj.data.message.tool_calls
      ) {
        console.log("Found JAF assistant_message event with final content")
        return cleanUpAnswer(obj.data.message.content)
      }
    }

    // PRIORITY 5: Accumulate all assistant_message content for complete answer
    let accumulatedAnswer = ""
    for (const obj of jsonObjects) {
      if (
        obj.type === "assistant_message" &&
        obj.data?.message?.content &&
        typeof obj.data.message.content === "string" &&
        !obj.data.message.tool_calls
      ) {
        accumulatedAnswer += obj.data.message.content
      }
    }

    if (accumulatedAnswer.trim()) {
      console.log("Found accumulated assistant_message content")
      return cleanUpAnswer(accumulatedAnswer)
    }

    console.log("No meaningful content found in JAF events")
    return cleanUpAnswer(text)
  } catch (error) {
    console.warn("Error parsing agentic JAF response:", error)
    return cleanUpAnswer(text)
  }
}

/**
 * Clean up the answer by removing citations, metadata, and extra formatting
 */
function cleanUpAnswer(answer: string): string {
  if (!answer || typeof answer !== "string") {
    return ""
  }

  let cleaned = answer

  // Remove citation metadata objects like {"contextChunks":[...],"citationMap":{...}}
  cleaned = cleaned.replace(
    /\{"contextChunks":\[.*?\],"citationMap":\{.*?\}\}/g,
    "",
  )

  // Remove citations like [1], [2], [1,2], etc.
  cleaned = cleaned.replace(/\[\d+(?:,\s*\d+)*\]/g, "")

  // Remove multiple consecutive spaces and normalize whitespace
  cleaned = cleaned.replace(/\s+/g, " ")

  // Remove leading/trailing whitespace
  cleaned = cleaned.trim()

  // Remove any remaining JSON artifacts
  cleaned = cleaned.replace(/^["']|["']$/g, "")

  // Remove escape characters
  cleaned = cleaned
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\"/g, '"')

  return cleaned
}

/**
 * Monitor the tracer directory for new files created after the API call
 */
async function waitForTracerFile(
  correlationId: string,
): Promise<string | null> {
  const tracerFilePath = join(TRACER_DIR, `${correlationId}.json`)
  console.log(`🔍 Waiting for specific tracer file: ${tracerFilePath}`)
  console.log(`⏰ Timeout: ${TRACER_TIMEOUT_MS / 1000} seconds`)

  const endTime = Date.now() + TRACER_TIMEOUT_MS

  while (Date.now() < endTime) {
    if (existsSync(tracerFilePath)) {
      console.log(`✅ Found tracer file: ${tracerFilePath}`)
      return tracerFilePath
    }
    // Wait before next poll
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_MS))
  }

  console.log(`⏰ Timeout reached waiting for tracer file: ${tracerFilePath}`)
  return null
}

/**
 * Extract relevant information from tracer JSON file
 */
function extractTracerInfo(tracerFilePath: string): any {
  try {
    console.log(`📖 Reading tracer file: ${tracerFilePath}`)
    const tracerContent = readFileSync(tracerFilePath, "utf8")
    const tracerData = JSON.parse(tracerContent)

    if (!tracerData.spans || !Array.isArray(tracerData.spans)) {
      console.warn(`⚠️  No spans array found in tracer data`)
      return {
        error: "No spans array found in tracer data",
        tracerFilePath,
      }
    }

    console.log(`🔍 Found ${tracerData.spans.length} spans in tracer data`)

    // Extract tool results from "tool_call_end" spans
    const toolResults: any[] = []
    let serialNumber = 1

    // Extract agentic answer from "final_output" span
    let agenticAnswer = ""

    for (const span of tracerData.spans) {
      // Look for tool_call_end spans
      if (span.name === "tool_call_end" && span.attributes) {
        const toolName = span.attributes.tool_name || "unknown"
        const contextDocIds = span.attributes.context_doc_ids || []

        // Parse context_doc_ids if it's a string (JSON array)
        let parsedContextDocIds = contextDocIds
        if (typeof contextDocIds === "string") {
          try {
            parsedContextDocIds = JSON.parse(contextDocIds)
          } catch (e) {
            console.warn(`⚠️  Failed to parse context_doc_ids: ${contextDocIds}`)
            parsedContextDocIds = []
          }
        }

        toolResults.push({
          "s.no": serialNumber++,
          ToolName: toolName,
          ToolContext: parsedContextDocIds,
        })

        console.log(
          `🔧 Found tool: ${toolName} with ${parsedContextDocIds.length} context docs`,
        )
      }

      // Look for final_output span
      if (
        span.name === "final_output" &&
        span.attributes &&
        span.attributes.final_output
      ) {
        agenticAnswer = span.attributes.final_output
        console.log(
          `📝 Found final output: ${agenticAnswer.substring(0, 100)}${
            agenticAnswer.length > 100 ? "..." : ""
          }`,
        )
      }
    }

    const extractedInfo = {
      traceId: tracerData.traceId || null,
      agenticAnswer: agenticAnswer,
      toolResults: toolResults,
      totalSpans: tracerData.spans.length,
      toolCallsCount: toolResults.length,
      // Keep full tracer data for debugging if needed
      fullTracerData: tracerData,
    }

    console.log(
      `✅ Extracted: traceId=${extractedInfo.traceId}, agenticAnswer=${
        agenticAnswer ? "found" : "not found"
      }, tools=${toolResults.length}`,
    )
    return extractedInfo
  } catch (error) {
    console.error(`❌ Error reading tracer file ${tracerFilePath}:`, error)
    return {
      error: `Failed to read tracer file: ${
        error instanceof Error ? error.message : String(error)
      }`,
      tracerFilePath,
    }
  }
}

/**
 * Test API with given cookies and wait for tracer file
 */
async function testAPIAndWaitForTracer(
  query: string,
  cookies: string,
  questionId: string | number,
): Promise<{ answer: string | null; tracerInfo: any; success: boolean }> {
  // Generate a unique correlation ID for this specific API call
  const correlationId = randomUUID()

  const agenticUrl =
    `http://localhost:3000/api/v1/message/create?` +
    `correlationId=${correlationId}&` +
    `message=${encodeURIComponent(query)}&` +
    `selectedModelConfig=${encodeURIComponent(
      JSON.stringify({
        model: "Claude Sonnet 4",
        reasoning: true,
        websearch: false,
        deepResearch: false,
      }),
    )}&` +
    `agentic=true`

  console.log(
    `\n🚀 Processing Question ID ${questionId}: "${query.substring(0, 100)}${
      query.length > 100 ? "..." : ""
    }"`,
  )
  console.log(`📍 API URL: ${agenticUrl}`)
  console.log("---")

  try {
    const response = await fetch(agenticUrl, {
      method: "GET",
      headers: {
        Cookie: cookies,
        Accept: "text/event-stream",
        "User-Agent": "XyneAPITester/1.0",
      },
    })

    console.log(`📊 API Response Status: ${response.status}`)

    if (!response.ok) {
      console.log(`❌ API request failed with status: ${response.status}`)
      return {
        answer: null,
        tracerInfo: { error: `API call failed with status ${response.status}` },
        success: false,
      }
    }

    // Process the streaming response
    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let rawResult = ""

    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split("\n")

        for (const line of lines) {
          if (
            line.startsWith("data: ") &&
            !line.includes("chatId") &&
            !line.includes("messageId") &&
            line.slice(6).trim() !== "[DONE]"
          ) {
            const data = line.slice(6)
            if (data.trim()) {
              rawResult += data
            }
          }
        }
      }
    }

    console.log(`📝 API response completed, length: ${rawResult.length} chars`)

    // Wait for tracer file to be created
    console.log(`\n🔍 Waiting for tracer file...`)
    const tracerFilePath = await waitForTracerFile(correlationId)

    let tracerInfo: any
    if (tracerFilePath) {
      tracerInfo = extractTracerInfo(tracerFilePath)
    } else {
      tracerInfo = { error: "Tracer file not found within timeout period" }
      console.log(`❌ No tracer file found for question ${questionId}`)
    }

    return { answer: null, tracerInfo, success: true }
  } catch (error) {
    console.error(`❌ Error during API test for question ${questionId}:`, error)
    return {
      answer: null,
      tracerInfo: {
        error: `API call error: ${
          error instanceof Error ? error.message : String(error)
        }`,
      },
      success: false,
    }
  }
}

/**
 * Validate authentication by testing with a simple query
 */
async function validateAuthentication(cookies: string): Promise<boolean> {
  const testQuery = "Hello, this is a test query for authentication validation."

  console.log("🔐 Validating authentication with test query...")

  try {
    const url = `http://localhost:3000/api/v1/message/create?selectedModelConfig=${encodeURIComponent(
      '{"model":"Claude Sonnet 4","reasoning":false,"websearch":false,"deepResearch":false}',
    )}&message=${encodeURIComponent(testQuery)}`

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: cookies,
        Accept: "text/event-stream",
        "User-Agent": "XyneAPITester/1.0",
      },
    })

    const isValid = response.ok
    console.log(
      `🔐 Authentication validation: ${
        isValid ? "✅ Valid" : "❌ Invalid"
      } (Status: ${response.status})`,
    )
    return isValid
  } catch (error) {
    console.error("🔐 Authentication validation error:", error)
    return false
  }
}

/**
 * Main function that processes QA data with tracer file correlation
 */
async function main() {
  console.log(
    "🎯 Starting API test with QA data, tracer file polling, and response correlation...\n",
  )

  try {
    // --- File paths ---
    const qaInputPath = join(
      process.cwd(),
      "xyne-evals",
      "data",
      "qa_gen_from_actual",
      "data_qa_filtered.json",
    )
    const outputPath = join(
      process.cwd(),
      "xyne-evals",
      "Testing",
      "xyne_answer_generation",
      "test_api_v6_results.json",
    )

    console.log(`📂 Reading QA data from: ${qaInputPath}`)

    if (!existsSync(qaInputPath)) {
      throw new Error(`Input file not found: ${qaInputPath}`)
    }

    const qaData = JSON.parse(readFileSync(qaInputPath, "utf-8"))
    console.log(`Found ${qaData.length} questions in the input file.`)

    // --- Slice Configuration ---
    // Get slice parameters from command line arguments or use defaults
    const startIndex = parseInt(process.argv[2]) || 0
    const count = parseInt(process.argv[3]) || 3 // Process 3 questions by default
    const batchSize = parseInt(process.argv[4]) || 10 // Process in batches of 10 by default
    const endIndex = Math.min(startIndex + count, qaData.length)
    const questionsToProcess = qaData.slice(startIndex, endIndex)

    console.log(`🔪 Slice Configuration:`)
    console.log(`   Start Index: ${startIndex}`)
    console.log(`   Count: ${count}`)
    console.log(`   Batch Size: ${batchSize}`)
    console.log(`   End Index: ${endIndex}`)
    console.log(
      `   Processing ${
        questionsToProcess.length
      } questions (from index ${startIndex} to ${endIndex - 1})`,
    )
    console.log(
      `   Usage: bun run test_api_v6.ts <startIndex> <count> <batchSize>`,
    )
    console.log(
      `   Example: bun run test_api_v6.ts 0 100 10 (process 100 questions in batches of 10)`,
    )
    console.log("")

    // --- Cookie Management ---
    console.log("🔍 Step 1: Getting cookies from environment variable...")
    let cookies = getCookiesFromEnv()

    if (cookies) {
      console.log("✅ Found existing cookies. Testing their validity...")
      const isValid = await validateAuthentication(cookies)

      if (!isValid) {
        console.log("⚠️ Existing cookies are invalid. Regenerating...")
        cookies = null
      } else {
        console.log("✅ Existing cookies are valid.")
      }
    }

    if (!cookies) {
      console.log("\n🔐 Generating new authentication cookies...")
      const newCookies = await generateAuthenticationCookies()
      updateCookiesInEnv(newCookies)
      cookies = getCookiesFromEnv()
      if (!cookies) {
        throw new Error(
          "Failed to obtain valid cookies even after regeneration.",
        )
      }
      console.log("✅ Successfully generated and stored new cookies.")
    }

    console.log("🍪 Using cookies:", cookies.substring(0, 50) + "...")

    // --- Initialize output ---
    // Load existing results if the file exists, otherwise start with empty array
    let existingResults: any[] = []
    if (existsSync(outputPath)) {
      try {
        const existingContent = readFileSync(outputPath, "utf-8")
        existingResults = JSON.parse(existingContent)
        console.log(
          `📚 Found existing results file with ${existingResults.length} entries`,
        )
      } catch (error) {
        console.warn(`⚠️  Could not read existing results file: ${error}`)
        existingResults = []
      }
    } else {
      console.log(`📄 No existing results file found, starting fresh`)
    }

    let allNewResults: any[] = []

    // --- Batch Processing Loop ---
    for (let i = 0; i < questionsToProcess.length; i += batchSize) {
      const batch = questionsToProcess.slice(i, i + batchSize)
      console.log(
        `\n✨ Processing batch ${i / batchSize + 1} (questions ${i + 1} to ${
          i + batch.length
        })`,
      )

      const promises = batch.map(async (item: any, j: number) => {
        const questionIndex = i + j
        const query = item.Question
        const questionId = item.question_id || `q_${questionIndex + 1}`

        console.log("-".repeat(50))
        console.log(
          `  🚀 Starting Question ${questionIndex + 1}/${
            questionsToProcess.length
          } (ID: ${questionId})`,
        )

        const result = await testAPIAndWaitForTracer(query, cookies, questionId)

        return {
          ...item,
          Agentic_answer: result.tracerInfo.agenticAnswer || "",
          Tool_results: result.tracerInfo.toolResults || [],
        }
      })

      const batchResults = await Promise.all(promises)
      allNewResults.push(...batchResults)

      // Save intermediate results after each batch
      const combinedIntermediate = [...existingResults, ...allNewResults]
      writeFileSync(
        outputPath,
        JSON.stringify(combinedIntermediate, null, 2),
        "utf-8",
      )
      console.log(
        `\n💾 Saved intermediate results for batch ${
          i / batchSize + 1
        }. Total entries: ${combinedIntermediate.length}`,
      )
    }

    // --- Final Summary ---
    const successCount = allNewResults.filter(
      (r) => r.Agentic_answer && r.Agentic_answer.length > 0,
    ).length
    const toolsCount = allNewResults.filter(
      (r) => r.Tool_results && r.Tool_results.length > 0,
    ).length

    console.log("\n" + "=".repeat(100))
    console.log("🎉 PROCESSING COMPLETE")
    console.log("=".repeat(100))
    console.log(
      `📊 Total questions processed this run: ${allNewResults.length}`,
    )
    console.log(
      `✅ Successful answers extracted: ${successCount}/${allNewResults.length}`,
    )
    console.log(
      `🔧 Questions with tool usage: ${toolsCount}/${allNewResults.length}`,
    )
    console.log(
      `📁 Total entries in final file: ${
        existingResults.length + allNewResults.length
      }`,
    )
    console.log(`💾 Final results saved to: ${outputPath}`)
    console.log("=".repeat(100))
  } catch (error) {
    console.error("💥 Error in main function:", error)
    process.exit(1)
  }
}

// Run the script
main()
  .then(() => {
    console.log("✅ Script completed successfully")
    process.exit(0)
  })
  .catch((error) => {
    console.error("💥 Script failed:", error)
    process.exit(1)
  })
