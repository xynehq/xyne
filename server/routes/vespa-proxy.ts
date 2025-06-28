import VespaClient from "@/search/vespaClient"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { Context, Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { verify } from "hono/jwt"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa-proxy" })

// Initialize production Vespa client
const vespaClient = new VespaClient()

const userSecret = process.env.USER_SECRET!

// JWT-based API key validation - same approach as login tokens
const getEmailFromJWT = async (apiKey: string): Promise<string | null> => {
  try {
    // Verify the JWT token using the same secret as login tokens
    const payload = await verify(apiKey, userSecret)

    // Extract email from the 'sub' field (same as login tokens)
    const email = payload.sub as string

    return email || null
  } catch (error) {
    Logger.error("JWT verification failed:", error)
    return null
  }
}

// Hono middleware to validate API key and resolve email
export const validateApiKey = async (c: Context, next: Next) => {
  const apiKey = c.req.header("x-api-key")

  if (!apiKey) {
    Logger.error("No API key provided in x-api-key header")
    throw new HTTPException(401, { message: "API key required" })
  }

  const email = await getEmailFromJWT(apiKey)

  if (!email) {
    Logger.error("Invalid JWT API key")
    throw new HTTPException(401, { message: "Invalid API key" })
  }

  // Add resolved email to context
  c.set("resolvedEmail", email)
  c.set("apiKey", apiKey)

  await next()
}

// Vespa search proxy endpoint (Hono)
export const vespaSearchProxy = async (c: Context) => {
  try {
    const resolvedEmail = c.get("resolvedEmail")
    const payload = await c.req.json()

    // Replace the email in payload with resolved email
    payload.email = resolvedEmail

    // Remove apiKey from payload since it's not needed for actual Vespa call
    delete payload.apiKey

    const result = await vespaClient.search(payload)
    return c.json(result as any)
  } catch (error) {
    Logger.error(`Vespa search proxy error:`, error)
    throw new HTTPException(500, { message: "Internal server error" })
  }
}

// Vespa autocomplete proxy endpoint (Hono)
export const vespaAutocompleteProxy = async (c: Context) => {
  try {
    const resolvedEmail = c.get("resolvedEmail")
    const payload = await c.req.json()

    payload.email = resolvedEmail
    delete payload.apiKey

    const result = await vespaClient.autoComplete(payload)
    return c.json(result as any)
  } catch (error) {
    Logger.error(`Vespa autocomplete proxy error:`, error)
    throw new HTTPException(500, { message: "Internal server error" })
  }
}

// Vespa group search proxy endpoint (Hono)
export const vespaGroupSearchProxy = async (c: Context) => {
  try {
    const resolvedEmail = c.get("resolvedEmail")
    const payload = await c.req.json()

    payload.email = resolvedEmail
    delete payload.apiKey

    const result = await vespaClient.groupSearch(payload)
    return c.json(result as any)
  } catch (error) {
    Logger.error(`Vespa group search proxy error:`, error)
    throw new HTTPException(500, { message: "Internal server error" })
  }
}

// Vespa get items proxy endpoint (Hono)
export const vespaGetItemsProxy = async (c: Context) => {
  try {
    const resolvedEmail = c.get("resolvedEmail")
    const payload = await c.req.json()

    payload.email = resolvedEmail
    delete payload.apiKey

    const result = await vespaClient.getItems(payload)
    return c.json(result as any)
  } catch (error) {
    Logger.error(`Vespa get items proxy error:`, error)
    throw new HTTPException(500, { message: "Internal server error" })
  }
}

// Vespa chat container by channel proxy endpoint (Hono)
export const vespaChatContainerByChannelProxy = async (c: Context) => {
  try {
    const resolvedEmail = c.get("resolvedEmail")
    const { channelName } = await c.req.json()

    const result =
      await vespaClient.getChatContainerIdByChannelName(channelName)
    return c.json(result as any)
  } catch (error) {
    Logger.error(`Vespa chat container by channel proxy error:`, error)
    throw new HTTPException(500, { message: "Internal server error" })
  }
}

// Vespa chat user by email proxy endpoint (Hono)
export const vespaChatUserByEmailProxy = async (c: Context) => {
  try {
    const resolvedEmail = c.get("resolvedEmail")
    const { email } = await c.req.json()

    // Use the email from request body, not the resolved email for this query
    const result = await vespaClient.getChatUserByEmail(email)
    return c.json(result as any)
  } catch (error) {
    Logger.error(`Vespa chat user by email proxy error:`, error)
    throw new HTTPException(500, { message: "Internal server error" })
  }
}
