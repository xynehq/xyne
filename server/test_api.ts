#!/usr/bin/env bun

/**
 * Simple curl-like script for testing the Xyne message API
 *
 * This replicates exactly what your browser does when making API calls
 */

// Store your long-lived refresh token here.
// You only need to get this from your browser's cookie storage once.
// const REFRESH_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcnNoaXRoLmJhbGFyYWp1QGp1c3BheS5pbiIsInJvbGUiOiJTdXBlckFkbWluIiwid29ya3NwYWNlSWQiOiJzMnJlcGM5cnV6MWZzbTJudnV3YTd3MDgiLCJ0b2tlblR5cGUiOiJyZWZyZXNoIiwiZXhwIjoxNzYxMTMyNjQ4fQ.IzpLfo_Fev5mFTK-8fR9IL4EEDC4ZYzrhw_Ec6x_Y9k';
// async function getAuthCookies(): Promise<string> {
//   console.log('Refreshing authentication tokens...');
//   const refreshTokenUrl = 'http://localhost:5173/api/v1/refresh-token';

//   const response = await fetch(refreshTokenUrl, {
//     method: 'POST',
//     headers: {
//       'Cookie': `refresh-token=${REFRESH_TOKEN}`,
//     },
//     redirect: 'manual'
//   });

//   const newCookiesArray = response.headers.getSetCookie();

//   // --- Start of New Debugging Block ---
//   console.log('Server response from /refresh-token:');
//   console.log(`- Status: ${response.status}`);
//   console.log(`- Raw Set-Cookie Headers:`, newCookiesArray);
//   // --- End of New Debugging Block ---

//   if (!newCookiesArray || newCookiesArray.length === 0) {
//     throw new Error('No Set-Cookie headers found in the response. Your REFRESH_TOKEN may be invalid or expired.');
//   }

//   const cookies = newCookiesArray.map(cookie => {
//     const parts = cookie.split(';')[0].split('=');
//     // Ensure the cookie has a key and a value
//     if (parts.length === 2 && parts[1]) {
//       return `${parts[0]}=${parts[1]}`;
//     }
//     return null; // Return null for empty or malformed cookies
//   }).filter(c => c !== null); // Filter out the null values

//   if (cookies.length === 0) {
//       throw new Error('Extracted cookie values are empty. The server may have cleared the cookies, indicating an invalid refresh token.');
//   }

//   const cookieString = cookies.join('; ');
//   console.log(`Successfully parsed cookies: ${cookieString}`);
//   return cookieString;
// }

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

  try {
    const response = await fetch(test_url, {
      method: "GET",
      headers: {
        Cookie:
          "access-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcnNoaXRoLmJhbGFyYWp1QGp1c3BheS5pbiIsInJvbGUiOiJTdXBlckFkbWluIiwid29ya3NwYWNlSWQiOiJzMnJlcGM5cnV6MWZzbTJudnV3YTd3MDgiLCJ0b2tlblR5cGUiOiJhY2Nlc3MiLCJleHAiOjE3NTg1NDg4OTZ9.9h1MXVCxbZc83tDwo_jQvJrMSHEeTZMXzVdzCbRO3os; refresh-token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhcnNoaXRoLmJhbGFyYWp1QGp1c3BheS5pbiIsInJvbGUiOiJTdXBlckFkbWluIiwid29ya3NwYWNlSWQiOiJzMnJlcGM5cnV6MWZzbTJudnV3YTd3MDgiLCJ0b2tlblR5cGUiOiJyZWZyZXNoIiwiZXhwIjoxNzYxMTM3Mjk2fQ.dxOhRpzXBb5EzjFceLp6EjK2XSXJYAOewwbzZ5Ddtk4",
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
    "Hello",
    "What time is it?",
    "How does AI work?",
    "Find my recent emails",
    "What are you?",
    "Show me my calendar",
    "Search for documents about project management",
  ]
  // const cookie = await getAuthCookies();
  for (const query of queries) {
    await testAPI(query)
    await new Promise((resolve) => setTimeout(resolve, 3000)) // Wait 30 seconds between requests
  }
}

// Run specific query if provided, otherwise run all tests
const query = process.argv[2]
if (query) {
  // const cookie = await getAuthCookies();
  testAPI(query)
} else {
  console.log("Running comprehensive API tests...\n")
  runTests()
}
