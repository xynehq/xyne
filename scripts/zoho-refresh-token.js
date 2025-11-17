#!/usr/bin/env node

/**
 * Quick Zoho Token Refresh Script
 * Refreshes access token using the provided refresh token
 */

const fetch = (...args) =>
  import("node-fetch").then(({ default: fetch }) => fetch(...args))
const querystring = require("querystring")

// Your Zoho credentials
const CONFIG = {
  CLIENT_ID: "1000.HRFLWOF4DAFL4SK4IZ3UKXCI6CRQJV",
  CLIENT_SECRET: "55898a4588dd60641f5bf5a00575cca7f82e580989",
  REFRESH_TOKEN:
    "1000.1c79e331da83dfa2a8244ef1f0a3bfde.9716adf4510ba82244f7ad5078fefe90",
  ACCOUNTS_URL: "https://accounts.zoho.com",
  SCOPE: "Desk.tickets.READ",
}

async function refreshZohoToken() {
  console.log("🔄 Refreshing Zoho access token...")

  const tokenData = {
    grant_type: "refresh_token",
    client_id: CONFIG.CLIENT_ID,
    client_secret: CONFIG.CLIENT_SECRET,
    refresh_token: CONFIG.REFRESH_TOKEN,
  }

  try {
    const response = await fetch(`${CONFIG.ACCOUNTS_URL}/oauth/v2/token`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: querystring.stringify(tokenData),
    })

    const responseText = await response.text()
    console.log("Raw response:", responseText.substring(0, 200))

    let data
    try {
      data = JSON.parse(responseText)
    } catch (parseError) {
      console.error("❌ Failed to parse response as JSON")
      console.error("Response status:", response.status)
      console.error(
        "Response headers:",
        Object.fromEntries(response.headers.entries()),
      )
      console.error(
        "Response text (first 500 chars):",
        responseText.substring(0, 500),
      )
      return null
    }

    if (!response.ok || data.error) {
      console.error("❌ Token refresh failed:")
      console.error("Status:", response.status)
      console.error("Error:", data.error)
      console.error("Description:", data.error_description)
      return null
    }

    console.log("✅ Token refresh successful!")
    console.log("\n📋 New Token Details:")
    console.log("=====================================")
    console.log("Access Token:", data.access_token)
    console.log("Token Type:", data.token_type || "Bearer")
    console.log("Expires In:", data.expires_in || 3600, "seconds")
    console.log("Scope:", data.scope || CONFIG.SCOPE)
    console.log("Generated At:", new Date().toISOString())
    console.log("=====================================\n")

    // Test the token
    await testToken(data.access_token)

    return data
  } catch (error) {
    console.error("❌ Error refreshing token:", error.message)
    return null
  }
}

async function testToken(accessToken) {
  console.log("🧪 Testing the new access token...")

  try {
    // Test with Zoho Desk API - get organizations
    const response = await fetch(
      "https://www.zohoapis.com/desk/v1/organizations",
      {
        headers: {
          Authorization: `Zoho-oauthtoken ${accessToken}`,
          "Content-Type": "application/json",
        },
      },
    )

    const data = await response.json()

    if (response.ok) {
      console.log("✅ Token is valid and working!")
      console.log(`📊 Organizations found: ${data.data?.length || 0}`)

      if (data.data && data.data.length > 0) {
        console.log("\n🏢 Available Organizations:")
        data.data.forEach((org, index) => {
          console.log(
            `${index + 1}. ${org.companyName || org.name} (ID: ${org.id})`,
          )
        })
      }
    } else {
      console.log("⚠️ Token validation failed:")
      console.log("Status:", response.status)
      console.log("Error:", data.message || data.errorCode || "Unknown error")
    }
  } catch (error) {
    console.log("⚠️ Error testing token:", error.message)
  }
}

// Export for use in other scripts
module.exports = {
  refreshZohoToken,
  testToken,
  CONFIG,
}

// Run if called directly
if (require.main === module) {
  refreshZohoToken()
    .then((tokens) => {
      if (tokens) {
        console.log("\n🎉 Token refresh completed successfully!")
        console.log("\n💡 Next steps:")
        console.log("1. Copy the access token for your API requests")
        console.log("2. Remember that access tokens typically expire in 1 hour")
        console.log("3. Use this script again when you need a fresh token")
      } else {
        console.log("\n❌ Token refresh failed. Please check your credentials.")
        process.exit(1)
      }
    })
    .catch((error) => {
      console.error("💥 Unexpected error:", error.message)
      process.exit(1)
    })
}
