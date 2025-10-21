// --- Load Environment Variables ---
// import { config as loadEnv } from 'dotenv';
// import { resolve } from 'path';
// loadEnv({ path: resolve(__dirname, '.env') });
// --------------------------------

import { sign } from "hono/jwt"
import { db } from "./db/client"
import { getUserByEmail } from "./db/user"
import config from "./config"
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

// Use environment variable for test user email, or default to a test email
const TEST_USER_EMAIL = "telkar.varasree@juspay.in"

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET!

const AccessTokenCookieName = "access-token"
const RefreshTokenCookieName = "refresh-token"

/**
 * JSON parser similar to jsonParseLLMOutput from chat.ts
 * Extracts answer from JSON response and cleans it up
 */
function parseAnswerFromResponse(text: string): string {
  if (!text || text.trim() === "") {
    return ""
  }

  try {
    // Clean up the text first
    let cleanText = text.trim()

    // Handle agentic mode responses that contain multiple JSON objects
    if (cleanText.includes('{"text":"') && cleanText.includes('"step":')) {
      return parseAgenticResponse(cleanText)
    }

    // Remove code blocks if present
    if (cleanText.includes("```json")) {
      const jsonCodeBlockMatch = cleanText.match(
        /```(?:json\s*)?\n?([\s\S]*?)```/,
      )
      if (jsonCodeBlockMatch) {
        cleanText = jsonCodeBlockMatch[1].trim()
      }
    }

    // Try to find JSON structure
    const startBrace = cleanText.indexOf("{")
    const endBrace = cleanText.lastIndexOf("}")

    if (startBrace !== -1 && endBrace !== -1) {
      const jsonText = cleanText.substring(startBrace, endBrace + 1)

      try {
        const parsed = JSON.parse(jsonText)

        // Extract answer field if it exists
        if (parsed.answer && typeof parsed.answer === "string") {
          return cleanUpAnswer(parsed.answer)
        }

        // If no answer field, try other common response fields
        if (parsed.response && typeof parsed.response === "string") {
          return cleanUpAnswer(parsed.response)
        }

        if (parsed.text && typeof parsed.text === "string") {
          return cleanUpAnswer(parsed.text)
        }
      } catch (jsonError) {
        // If JSON parsing fails, try partial JSON parsing
        try {
          const { parse } = require("partial-json")
          const partialParsed = parse(jsonText)

          if (
            partialParsed.answer &&
            typeof partialParsed.answer === "string"
          ) {
            return cleanUpAnswer(partialParsed.answer)
          }
        } catch (partialError) {
          // If all JSON parsing fails, return cleaned text
          return cleanUpAnswer(cleanText)
        }
      }
    }

    // If no JSON structure found, return cleaned up text
    return cleanUpAnswer(cleanText)
  } catch (error) {
    console.warn("Error parsing response:", error)
    return cleanUpAnswer(text)
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

    // Debug: Show all event types found
    const eventTypes = jsonObjects
      .map((obj) => obj.type || "unknown")
      .filter(Boolean)
    console.log("JAF Event types found:", [...new Set(eventTypes)])

    // Debug: Show a few sample objects to understand structure
    console.log("Sample JAF objects (first 3):")
    for (let i = 0; i < Math.min(3, jsonObjects.length); i++) {
      console.log(`Object ${i}:`, JSON.stringify(jsonObjects[i], null, 2))
    }

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

    // FALLBACK: Look for any objects with "outcome" containing final output
    for (const obj of jsonObjects) {
      if (obj.outcome?.output && typeof obj.outcome.output === "string") {
        console.log("Found fallback outcome.output")
        return cleanUpAnswer(obj.outcome.output)
      }
      if (
        obj.data?.outcome?.output &&
        typeof obj.data.outcome.output === "string"
      ) {
        console.log("Found fallback data.outcome.output")
        return cleanUpAnswer(obj.data.outcome.output)
      }
    }

    // LAST RESORT: Look for meaningful text content (excluding tool/step messages)
    let finalAnswer = ""
    for (let i = jsonObjects.length - 1; i >= 0; i--) {
      const obj = jsonObjects[i]

      if (obj.text && typeof obj.text === "string") {
        const textContent = obj.text.trim()

        // Skip step messages, iteration messages, and tool-related messages
        if (
          !textContent.includes("Iteration") &&
          !textContent.includes("Tool selected") &&
          !textContent.includes("Parameters:") &&
          !textContent.includes("Executing") &&
          !textContent.includes("Completed iteration") &&
          !textContent.includes("We're reading your question") &&
          !textContent.includes("stepId") &&
          !textContent.includes("agent:") &&
          !textContent.includes("Planning search") &&
          textContent.length > 50
        ) {
          // Meaningful content should be longer

          finalAnswer = textContent
          break
        }
      }
    }

    if (finalAnswer) {
      console.log("Found meaningful text content as fallback")
      return cleanUpAnswer(finalAnswer)
    }

    // If still no meaningful answer found, extract all non-step text
    const meaningfulTexts = []
    for (const obj of jsonObjects) {
      if (obj.text && typeof obj.text === "string") {
        const textContent = obj.text.trim()
        if (
          !textContent.includes("Iteration") &&
          !textContent.includes("Tool") &&
          !textContent.includes("Parameters") &&
          !textContent.includes("Executing") &&
          !textContent.includes("step") &&
          !textContent.includes("agent:") &&
          textContent.length > 20
        ) {
          meaningfulTexts.push(textContent)
        }
      }
    }

    const finalResult = meaningfulTexts.join(" ").trim()
    if (finalResult) {
      console.log("Found combined meaningful texts as final fallback")
      return cleanUpAnswer(finalResult)
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
    const envPath = join(__dirname, ".env")
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
 * Test API with given cookies and parse response to extract clean answer
 */
async function testAPI(
  query: string,
  cookies: string,
  useReasoningMode: boolean = false,
): Promise<string | null> {
  // Regular mode (no reasoning)
  const regularUrl = `http://localhost:3000/api/v1/message/create?selectedModelConfig=${encodeURIComponent('{"model":"Claude Sonnet 4","reasoning":false,"websearch":false,"deepResearch":false}')}&message=${encodeURIComponent(query)}`

  // Reasoning/Agentic mode
  const reasoningUrl =
    `http://localhost:3000/api/v1/message/create?` +
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

  const targetUrl = useReasoningMode ? reasoningUrl : regularUrl
  const mode = useReasoningMode ? "Reasoning/Agentic" : "Regular"

  console.log(`\n🔄 Testing [${mode} Mode]: ${query}`)
  console.log(`📍 URL: ${targetUrl}`)
  console.log("---")

  try {
    const response = await fetch(targetUrl, {
      method: "GET",
      headers: {
        Cookie: cookies,
        Accept: "text/event-stream",
        "User-Agent": "XyneAPITester/1.0",
      },
    })

    console.log(`📊 Status: ${response.status}`)
    console.log("Response body is :", response)
    // If status is not OK, consider it a failure
    if (!response.ok) {
      console.log(`❌ Request failed with status: ${response.status}`)
      return null
    }

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let rawResult = ""
    let reasoningContent = ""
    let answerContent = ""
    let allSSEEvents = [] // Capture all SSE events for debugging

    if (reader) {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value)
        const lines = chunk.split("\n")

        let currentEvent = ""
        let currentData = ""

        for (const line of lines) {
          // Capture event type
          if (line.startsWith("event: ")) {
            currentEvent = line.slice(7).trim()
          }

          // Capture data
          if (line.startsWith("data: ")) {
            currentData = line.slice(6)

            // Store event for debugging
            if (useReasoningMode) {
              allSSEEvents.push({ event: currentEvent, data: currentData })
            }

            // Skip metadata events but capture everything else
            if (
              !currentData.includes("chatId") &&
              !currentData.includes("messageId") &&
              currentData.trim() !== "[DONE]"
            ) {
              rawResult += currentData
            }

            // Reset for next event
            currentEvent = ""
            currentData = ""
          }
        }
      }
    }

    // Handle reasoning vs regular mode differently
    if (useReasoningMode) {
      console.log(
        `\n🔍 [REASONING MODE] Captured ${allSSEEvents.length} SSE events`,
      )

      // Show event types for debugging
      const eventTypes = [
        ...new Set(allSSEEvents.map((e) => e.event).filter(Boolean)),
      ]
      console.log("SSE Event types:", eventTypes)

      // PRIORITY 1: Look for JAF run_end events specifically
      const jafEvents = allSSEEvents.filter(
        (e) =>
          e.data.includes('"type":"run_end"') ||
          e.data.includes('"type":"final_output"'),
      )
      if (jafEvents.length > 0) {
        console.log(
          `\n🎯 Found ${jafEvents.length} JAF run_end/final_output events:`,
        )
        jafEvents.forEach((event, i) => {
          console.log(`JAF Event ${i + 1}:`, event.data)
        })

        // Extract and return the final output from JAF events
        for (const event of jafEvents) {
          try {
            const parsed = JSON.parse(event.data)
            if (parsed.type === "run_end" && parsed.data?.outcome?.output) {
              console.log("🎯 Extracting final output from JAF run_end event")
              const finalOutput = cleanUpAnswer(parsed.data.outcome.output)
              console.log(`\n✅ FINAL OUTPUT [${mode} Mode] from JAF run_end:`)
              console.log("=".repeat(60))
              console.log(`"${finalOutput}"`)
              console.log("=".repeat(60))
              return finalOutput
            }
            if (parsed.type === "final_output" && parsed.data?.output) {
              console.log(
                "🎯 Extracting final output from JAF final_output event",
              )
              const finalOutput = cleanUpAnswer(parsed.data.output)
              console.log(
                `\n✅ FINAL OUTPUT [${mode} Mode] from JAF final_output:`,
              )
              console.log("=".repeat(60))
              console.log(`"${finalOutput}"`)
              console.log("=".repeat(60))
              return finalOutput
            }
          } catch (e) {
            console.warn("Failed to parse JAF event:", e)
          }
        }
      }

      // PRIORITY 2: No JAF events found - try to extract from SSE update events
      console.log(
        "\n⚠️  No JAF run_end/final_output events found - looking for SSE final answers",
      )

      // Debug: Show all events to understand the structure
      console.log("\n📋 ALL 20 SSE Events for analysis:")
      for (let i = 0; i < allSSEEvents.length; i++) {
        const event = allSSEEvents[i]
        // console.log(`Event ${i + 1}: type="${event.event}", data="${event.data.substring(0, 150)}${event.data.length > 150 ? '...' : ''}"`);
      }

      // Collect ALL "u" (update) events that form the complete response
      const responseUpdates = []
      let foundFirstResponse = false

      for (let i = 0; i < allSSEEvents.length; i++) {
        const event = allSSEEvents[i]

        // Look for "u" (update) events that contain actual response content
        if (
          event.event === "u" &&
          event.data &&
          !event.data.includes("chatId") &&
          !event.data.includes("messageId") &&
          !event.data.startsWith("{") &&
          event.data.trim() !== "[DONE]"
        ) {
          // Check if this is part of the actual response (not planning/thinking)
          if (
            !event.data.includes("We're reading your question") &&
            !event.data.includes("Iteration") &&
            !event.data.includes("I need to search") &&
            !event.data.includes("agent:") &&
            !event.data.includes("Planning") &&
            !event.data.includes("stepId")
          ) {
            foundFirstResponse = true
            responseUpdates.push({ index: i + 1, data: event.data })
          }
        }

        // Also capture events with empty type that might contain response fragments
        else if (
          event.event === "" &&
          event.data &&
          !event.data.includes("chatId") &&
          !event.data.includes("messageId") &&
          !event.data.startsWith("{") &&
          event.data.trim() !== "[DONE]" &&
          event.data.trim() !== "" &&
          foundFirstResponse
        ) {
          responseUpdates.push({ index: i + 1, data: event.data })
        }
      }

      console.log(
        `\n🔍 Found ${responseUpdates.length} response update events:`,
      )
      responseUpdates.forEach((update) => {
        console.log(`Response Event ${update.index}: "${update.data}"`)
      })

      if (responseUpdates.length > 0) {
        // Combine ALL response updates to form the complete answer
        const completeResponse = responseUpdates
          .map((update) => update.data)
          .join("")
          .trim()
        console.log(
          `🎯 Combining ${responseUpdates.length} response fragments into complete answer`,
        )
        const cleanedAnswer = cleanUpAnswer(completeResponse)
        console.log(
          `\n✅ FINAL OUTPUT [${mode} Mode] from combined SSE events:`,
        )
        console.log("=".repeat(60))
        console.log(`"${cleanedAnswer}"`)
        console.log("=".repeat(60))
        return cleanedAnswer
      }

      // Alternative: Look for "e" (end) events that might contain final output
      const endEvents = allSSEEvents.filter(
        (e) =>
          e.event === "e" &&
          e.data &&
          !e.data.includes("chatId") &&
          !e.data.includes("messageId") &&
          e.data.trim() !== "[DONE]" &&
          e.data.length > 10,
      )

      if (endEvents.length > 0) {
        console.log(
          `\n🔍 Found ${endEvents.length} end events, using last one:`,
        )
        const finalAnswer = endEvents[endEvents.length - 1].data.trim()
        console.log(`End event data: "${finalAnswer}"`)
        const cleanedAnswer = cleanUpAnswer(finalAnswer)
        console.log(`\n✅ FINAL OUTPUT [${mode} Mode] from end events:`)
        console.log("=".repeat(60))
        console.log(`"${cleanedAnswer}"`)
        console.log("=".repeat(60))
        return cleanedAnswer
      }

      // PRIORITY 3: Fallback - parse all accumulated rawResult for reasoning mode
      console.log(
        "\n🔄 Fallback: Parsing accumulated rawResult for reasoning mode",
      )
      const fallbackAnswer = parseAnswerFromResponse(rawResult)
      if (fallbackAnswer && fallbackAnswer.trim()) {
        console.log(`\n✅ FINAL OUTPUT [${mode} Mode] from rawResult fallback:`)
        console.log("=".repeat(60))
        console.log(`"${fallbackAnswer}"`)
        console.log("=".repeat(60))
        return fallbackAnswer
      }

      // Show debug info if nothing worked
      console.log("\n📋 DEBUG: LAST 5 SSE Events:")
      const startIdx = Math.max(0, allSSEEvents.length - 5)
      for (let i = startIdx; i < allSSEEvents.length; i++) {
        const event = allSSEEvents[i]
        console.log(
          `Event ${i + 1}: type="${event.event}", data="${event.data.substring(0, 200)}${event.data.length > 200 ? "..." : ""}"`,
        )
      }

      console.log(`\n⚠️  No answer found in reasoning mode`)
      return null
    } else {
      // REGULAR MODE: Use standard parsing
      console.log(
        `\n📝 [REGULAR MODE] Raw Response Length: ${rawResult.length} chars`,
      )

      // Parse and clean the response for regular mode
      const cleanAnswer = parseAnswerFromResponse(rawResult)

      if (cleanAnswer) {
        console.log(`\n✅ FINAL OUTPUT [${mode} Mode]:`)
        console.log("=".repeat(60))
        console.log(`"${cleanAnswer}"`)
        console.log("=".repeat(60))
        console.log(`📏 Clean Answer Length: ${cleanAnswer.length} chars`)
        return cleanAnswer
      } else {
        console.log(`\n⚠️  No clean answer extracted from response`)
        console.log(
          `📄 Raw response preview: "${rawResult.substring(0, 200)}..."`,
        )
        return null
      }
    }
  } catch (error) {
    console.error(`❌ Error during API test [${mode} Mode]:`, error)
    return null
  }
}

/**
 * Test both URL modes and return results
 */
async function testBothModes(
  query: string,
  cookies: string,
): Promise<{ regular: string | null; reasoning: string | null }> {
  console.log(`\n🚀 Testing both modes for query: "${query}"`)
  console.log("=".repeat(80))

  // Test regular mode
  // const regularResult = await testAPI(query, cookies, false);
  const regularResult = null

  // Small delay between requests
  await new Promise((resolve) => setTimeout(resolve, 1000))

  // Test reasoning mode
  const reasoningResult = await testAPI(query, cookies, true)

  return {
    regular: regularResult,
    reasoning: reasoningResult,
  }
}

/**
 * Main function that implements the required logic:
 * 1. Reads questions from qa_output_v1.json.
 * 2. Allows slicing the questions to process a subset.
 * 3. Ensures valid authentication cookies are available by testing them first and regenerating if needed.
 * 4. For each question, calls the API in both regular and reasoning modes.
 * 5. Appends the regular mode answer to non_agentic_answers.json.
 * 6. Appends the reasoning mode answer to agentic_answers.json.
 */
async function main() {
  console.log(
    "🎯 Starting API test with QA data, cookie management, and response parsing...\n",
  )

  try {
    // --- File and Data Handling ---
    const qaInputPath = join(__dirname, "flipkart_scenario_qa.json")
    const nonAgenticOutputPath = join(
      __dirname,
      "non_agentic_answers_flipkart_new.json",
    )
    const agenticOutputPath = join(
      __dirname,
      "agentic_answers_flipkart_new.json",
    )

    console.log(`\n📂 Reading QA data from: ${qaInputPath}`)
    const qaData = JSON.parse(readFileSync(qaInputPath, "utf-8"))
    console.log(`Found ${qaData.length} questions in the input file.`)

    // --- Slice Configuration ---
    // Adjust the slice range to process a subset of questions
    const startIndex = 0
    const endIndex = 45 // Process first 100 questions. Change this to process more.
    const questionsToProcess = qaData.slice(startIndex, endIndex)
    console.log(
      `🔪 Processing a slice of ${questionsToProcess.length} questions (from index ${startIndex} to ${endIndex}).\n`,
    )

    // --- Cookie Management ---
    console.log("🔍 Step 1: Getting cookies from environment variable...")
    let cookies = getCookiesFromEnv()

    if (cookies) {
      console.log("✅ Found existing cookies. Testing their validity...")
      const dryRunQuery =
        questionsToProcess.length > 0 ? questionsToProcess[0].Question : "Hello"
      const testResults = await testAPI(dryRunQuery, cookies, false)

      if (testResults === null) {
        console.log("⚠️ API test failed with existing cookies. Regenerating...")
        cookies = null // Invalidate cookies
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

    // Initialize or clear output files
    writeFileSync(nonAgenticOutputPath, "[]", "utf-8")
    writeFileSync(agenticOutputPath, "[]", "utf-8")
    console.log(
      `\n✨ Initialized output files: ${nonAgenticOutputPath} and ${agenticOutputPath}`,
    )

    // --- Processing Loop ---
    for (let i = 0; i < questionsToProcess.length; i++) {
      const item = questionsToProcess[i]
      const query = item.Question

      console.log("\n" + "=".repeat(80))
      console.log(
        `🚀 Processing Question ${i + 1}/${questionsToProcess.length}: "${query}"`,
      )
      console.log("=".repeat(80))

      const results = await testBothModes(query, cookies)

      // Handle Non-Agentic (Regular) Result
      if (results.regular) {
        const nonAgenticResult = {
          ...item,
          Non_agentic_answer: results.regular,
        }
        const currentNonAgentic = JSON.parse(
          readFileSync(nonAgenticOutputPath, "utf-8"),
        )
        currentNonAgentic.push(nonAgenticResult)
        writeFileSync(
          nonAgenticOutputPath,
          JSON.stringify(currentNonAgentic, null, 2),
          "utf-8",
        )
        console.log(`✅ Appended Non-Agentic answer to ${nonAgenticOutputPath}`)
      } else {
        console.log(
          `⚠️  Skipping Non-Agentic answer for Question ${i + 1} due to failed API call.`,
        )
      }

      // Handle Agentic (Reasoning) Result
      if (results.reasoning) {
        const agenticResult = {
          ...item,
          Agentic_answer: results.reasoning,
        }
        const currentAgentic = JSON.parse(
          readFileSync(agenticOutputPath, "utf-8"),
        )
        currentAgentic.push(agenticResult)
        writeFileSync(
          agenticOutputPath,
          JSON.stringify(currentAgentic, null, 2),
          "utf-8",
        )
        console.log(`✅ Appended Agentic answer to ${agenticOutputPath}`)
      } else {
        console.log(
          `⚠️  Skipping Agentic answer for Question ${i + 1} due to failed API call.`,
        )
      }
    }
  } catch (error) {
    console.error("💥 Error in main function:", error)
    process.exit(1)
  }

  console.log("\n" + "=".repeat(80) + "\n")
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
