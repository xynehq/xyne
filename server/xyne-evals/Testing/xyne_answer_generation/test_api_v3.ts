#!/usr/bin/env bun

import { sign } from "hono/jwt"
import { db } from "../../../db/client"
import { getUserByEmail } from "../../../db/user"
import config from "../../../config"
import { readFileSync, writeFileSync } from "fs"
import { join } from "path"

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
 * Test API with given cookies
 */
async function testAPI(query: string, cookies: string): Promise<boolean> {
  const url = `http://localhost:3000/api/v1/message/create?selectedModelConfig=${encodeURIComponent('{"model":"Claude Sonnet 4","reasoning":false,"websearch":false,"deepResearch":false}')}&message=${encodeURIComponent(query)}`
  const test_url =
    `http://localhost:3000/api/v1/message/create?` +
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

  try {
    const response = await fetch(test_url, {
      method: "GET",
      headers: {
        Cookie: cookies,
        Accept: "text/event-stream",
        "User-Agent": "XyneAPITester/1.0",
      },
    })

    console.log(`Status: ${response.status}`)

    // If status is not OK, consider it a failure
    if (!response.ok) {
      console.log(`Request failed with status: ${response.status}`)
      return false
    }

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

    // Consider it successful if we got some content
    return result.length > 0
  } catch (error) {
    console.error("Error during API test:", error)
    return false
  }
}

/**
 * Main function that implements the required logic:
 * 1. Get cookies from env variable TEST_API_COOKIES
 * 2. Try fetching with those cookies
 * 3. If it fails, generate new cookies and update the env variable
 * 4. Try again getting cookies from env variable and fetch the answer
 */
async function main(query: string) {
  console.log("Starting API test with cookie management...\n")

  try {
    // Step 1: Get cookies from environment variable
    console.log("Step 1: Getting cookies from environment variable...")
    let cookies = getCookiesFromEnv()

    if (cookies) {
      console.log("Found existing cookies in environment variable")
      console.log("Cookies:", cookies.substring(0, 50) + "...")

      // Step 2: Try fetching with existing cookies
      console.log("\nStep 2: Testing API with existing cookies...")
      const success = await testAPI(query, cookies)

      if (success) {
        console.log("\n✅ API test successful with existing cookies!")
        return
      } else {
        console.log(
          "\n❌ API test failed with existing cookies, generating new ones...",
        )
      }
    } else {
      console.log(
        "No cookies found in environment variable or cookies are empty",
      )
    }

    // Step 3: Generate new cookies and update environment variable
    console.log("\nStep 3: Generating new authentication cookies...")
    const newCookies = await generateAuthenticationCookies()

    console.log("Step 4: Updating environment variable with new cookies...")
    updateCookiesInEnv(newCookies)

    // Step 5: Get cookies from environment variable again and test
    console.log(
      "\nStep 5: Getting updated cookies from environment variable...",
    )
    cookies = getCookiesFromEnv()

    if (!cookies) {
      throw new Error(
        "Failed to retrieve updated cookies from environment variable",
      )
    }

    console.log("Step 6: Testing API with updated cookies...")
    const finalSuccess = await testAPI(query, cookies)

    if (finalSuccess) {
      console.log("\n✅ API test successful with new cookies!")
    } else {
      console.log("\n❌ API test failed even with new cookies")
    }
  } catch (error) {
    console.error("Error in main function:", error)
    process.exit(1)
  }

  console.log("\n" + "=".repeat(50) + "\n")
}

// Run the script
const query = process.argv[2] || "Hello, how are you?"
main(query)
  .then(() => {
    console.log("Script completed successfully")
    process.exit(0)
  })
  .catch((error) => {
    console.error("Script failed:", error)
    process.exit(1)
  })
