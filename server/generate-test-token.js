import { sign } from "hono/jwt"

const accessTokenSecret = "" // From .env ACCESS_TOKEN_SECRET

const payload = {
  sub: "test@test.com",
  role: "User",
  workspaceId: "test-workspace-id", // Use workspace external_id, not numeric id
  tokenType: "access",
  exp: Math.floor(Date.now() / 1000) + 60 * 60, // 1 hour expiration
}

const token = await sign(payload, accessTokenSecret)
console.log("Generated JWT Token:")
console.log(token)
