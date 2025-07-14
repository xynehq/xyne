import VespaClient from "@/search/vespaClient"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import type { Context, Next } from "hono"
import { HTTPException } from "hono/http-exception"
import { verify } from "hono/jwt"
import { groupVespaSearch, searchVespa } from "@/search/vespa"

const Logger = getLogger(Subsystem.Vespa).child({ module: "vespa-proxy" })

// Initialize production Vespa client
const vespaClient = new VespaClient()

const userSecret = process.env.USER_SECRET!

// Helper types and functions for email override and proxy error handling
type EmailOverridable = { email?: string }

const withEmailOverride = <T extends EmailOverridable>(
  obj: T,
  email: string,
): T => {
  return { ...obj, email }
}

const handleProxy = <T extends Record<string, any> | any>(
  handler: (body: any, email: string) => Promise<T>,
  loggerMsg: string,
) => {
  return async (c: Context) => {
    try {
      const body = await c.req.json()
      const email = c.get("resolvedEmail") ?? body.email
      const result = await handler(body, email)
      return c.json(result as Record<string, any>)
    } catch (error) {
      Logger.error(`${loggerMsg}:`, error)
      throw new HTTPException(500, { message: "Internal server error" })
    }
  }
}

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
export const vespaSearchProxy = handleProxy(
  (body, email) => vespaClient.search(withEmailOverride(body, email)),
  "Vespa search proxy error",
)

// Vespa autocomplete proxy endpoint (Hono)
export const vespaAutocompleteProxy = handleProxy(
  (body, email) => vespaClient.autoComplete(withEmailOverride(body, email)),
  "Vespa autocomplete proxy error",
)

// Vespa group search proxy endpoint (Hono)
export const vespaGroupSearchProxy = handleProxy(
  (body, email) => vespaClient.groupSearch(withEmailOverride(body, email)),
  "Vespa group search proxy error",
)

// Vespa get items proxy endpoint (Hono)
export const vespaGetItemsProxy = handleProxy(
  (body, email) => vespaClient.getItems(withEmailOverride(body, email)),
  "Vespa get items proxy error",
)

// Vespa chat container by channel proxy endpoint (Hono)
export const vespaChatContainerByChannelProxy = handleProxy(
  ({ channelName }) => vespaClient.getChatContainerIdByChannelName(channelName),
  "Vespa chat container by channel proxy error",
)

// Vespa chat user by email proxy endpoint (Hono)
export const vespaChatUserByEmailProxy = handleProxy(
  (_body, email) => vespaClient.getChatUserByEmail(email),
  "Vespa chat user by email proxy error",
)

// Vespa get document proxy endpoint (Hono)
export const vespaGetDocumentProxy = handleProxy(
  (options, email) =>
    vespaClient.getDocument(withEmailOverride(options ?? {}, email)),
  "Vespa get document proxy error",
)

// Vespa get documents by IDs proxy endpoint (Hono)
export const vespaGetDocumentsByIdsProxy = handleProxy(
  (options, email) =>
    vespaClient.getDocumentsByOnlyDocIds(
      withEmailOverride(options ?? {}, email),
    ),
  "Vespa get documents by IDs proxy error",
)

// Vespa get users by names and emails proxy endpoint (Hono)
export const vespaGetUsersByNamesAndEmailsProxy = handleProxy(
  (body) => vespaClient.getUsersByNamesAndEmails(body),
  "Vespa get users by names and emails proxy error",
)

// Vespa get documents by thread ID proxy endpoint (Hono)
export const vespaGetDocumentsByThreadIdProxy = handleProxy(
  ({ threadIds }) => vespaClient.getDocumentsBythreadId(threadIds),
  "Vespa get documents by thread ID proxy error",
)

// Vespa get emails by thread IDs proxy endpoint (Hono)
export const vespaGetEmailsByThreadIdsProxy = handleProxy(
  ({ threadIds }, email) => vespaClient.getEmailsByThreadIds(threadIds, email),
  "Vespa get emails by thread IDs proxy error",
)

// Vespa get documents with field proxy endpoint (Hono)
export const vespaGetDocumentsWithFieldProxy = handleProxy(
  ({ fieldName, options, limit = 100, offset = 0 }) =>
    vespaClient.getDocumentsWithField(fieldName, options, limit, offset),
  "Vespa get documents with field proxy error",
)

// Vespa get random document proxy endpoint (Hono)
export const vespaGetRandomDocumentProxy = handleProxy(
  ({ namespace, schema, cluster }) =>
    vespaClient.getRandomDocument(namespace, schema, cluster),
  "Vespa get random document proxy error",
)

// Group vespa search proxy endpoint (Hono)
export const groupVespaSearchProxy = handleProxy(
  (options, email) =>
    groupVespaSearch(
      options.query,
      email,
      options.limit,
      options.timestampRange,
    ),
  "Vespa group search proxy error",
)

// Vespa search proxy endpoint (Hono)
export const searchVespaProxy = handleProxy((body, email) => {
  const { query, app, entity, ...rest } = body
  return searchVespa(query, email, app, entity, rest)
}, "Vespa search proxy error")