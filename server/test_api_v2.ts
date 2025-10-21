#!/usr/bin/env bun

import { EventSource } from "eventsource"
import { exit } from "process"
import { sign } from "hono/jwt"
import { db } from "./db/client"
import { getUserByEmail } from "./db/user"
import config from "./config"

// This variable will act as our "cookie jar" for the script
let scriptCookies: string | null = null

// Use environment variable for test user email, or default to a test email
const TEST_USER_EMAIL = "arshith.balaraju@juspay.in"

const accessTokenSecret = process.env.ACCESS_TOKEN_SECRET!
const refreshTokenSecret = process.env.REFRESH_TOKEN_SECRET!

const AccessTokenCookieName = "access-token"
const RefreshTokenCookieName = "refresh-token"

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
    //this is to see what userResult is coming and if the use is actually found.
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
    // console.log('the access token generated is : ' + accessToken)
    // console.log('the refresh token generated is : ' + refreshToken)

    // Format cookies the same way the server does
    const accessTokenCookie = `${AccessTokenCookieName}=${accessToken}`
    const refreshTokenCookie = `${RefreshTokenCookieName}=${refreshToken}`

    // Combine cookies for the script to use
    scriptCookies = `${accessTokenCookie}; ${refreshTokenCookie}`
    // console.log('generated final cookie is : ' + scriptCookies);
    // console.log("Successfully generated authentication tokens.");
    return scriptCookies
  } catch (error) {
    console.error("Error generating authentication tokens:", error)
    throw error
  }
}

/**
 * Performs an initial authenticated request to warm up the connection and handle token refresh,
 * mimicking the behavior of the frontend's `_authenticated.tsx` route loader.
 */

/**
 * testAPI now uses a proper, browser-like authentication flow.
 */
async function testAPI(query: string, cookie?: string) {
  const url = `http://localhost:5173/api/v1/message/create?selectedModelConfig=${encodeURIComponent('{"model":"Claude Sonnet 4","reasoning":false,"websearch":false,"deepResearch":false}')}&message=${encodeURIComponent(query)}`
  const test_url =
    `http://localhost:5173/api/v1/message/create?` +
    `message=${encodeURIComponent(query)}&` +
    `selectedModelConfig=${encodeURIComponent(
      JSON.stringify({
        model: "Claude Sonnet 4",
        reasoning: true, // Enable reasoning
        websearch: false, // Enable web search
        deepResearch: false,
      }),
    )}&` +
    `agentic=true` // Enable agentic mode;
  console.log(`Testing: ${query}`)
  console.log(`URL: ${url}`)
  console.log("---")

  const cookies = await generateAuthenticationCookies()

  console.log("the resultant cookies are : " + cookies)

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Cookie: cookies,
        Accept: "text/event-stream",
        "User-Agent": "XyneAPITester/1.0",
      },
    })

    console.log(`Status: ${response.status}`)

    const reader = response.body?.getReader()
    const decoder = new TextDecoder()
    let result = ""

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
            !line.includes("messageId")
          ) {
            const data = line.slice(6)
            if (data.trim() && data !== "[DONE]") {
              result += data
              process.stdout.write(data) // Real-time output
            }
          }
        }
      }
    }

    console.log(`\n\n🔍 MESSAGE CONTENT:`)
    console.log("=".repeat(50))
    console.log(`"${result}"`)
    console.log("=".repeat(50))
    console.log(`Length: ${result.length} chars`)
  } catch (error) {
    console.error("Error:", error)
  }

  console.log("\n" + "=".repeat(50) + "\n")
}

// Test different types of queries
async function runTests() {
  const queries = [
    // "Hello",
    // "What time is it?",
    // "How does AI work?",
    // "Find my recent emails",
    // "What are you?",
    // "Show me my calendar",
    "Search for documents about project management",
  ]
  // const cookie = await getAuthCookies();
  for (const query of queries) {
    await testAPI(query)
    await new Promise((resolve) => setTimeout(resolve, 3000)) // Wait 30 seconds between requests
  }
  process.exit(0)
}

// Run specific query if provided, otherwise run all tests
const query = process.argv[2]
if (query) {
  // const cookie = await getAuthCookies();
  await testAPI(query)
  process.exit(0)
} else {
  console.log("Running comprehensive API tests...\n")
  runTests()
}
