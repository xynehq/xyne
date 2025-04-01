import { Hono } from "hono"
import {
  AnswerApi,
  AutocompleteApi,
  autocompleteSchema,
  chatBookmarkSchema,
  chatDeleteSchema,
  chatHistorySchema,
  chatRenameSchema,
  chatSchema,
  messageRetrySchema,
  messageSchema,
  SearchApi,
} from "./api/search.js"
import { zValidator } from "@hono/zod-validator"
import {
  addServiceConnectionSchema,
  answerSchema,
  createOAuthProvider,
  oauthStartQuerySchema,
  searchSchema,
} from "./types.js"
import {
  AddServiceConnection,
  CreateOAuthProvider,
  GetConnectors,
  StartOAuth,
} from "./api/admin.js"
import { ProxyUrl } from "./api/proxy.js"
import { init as initQueue } from "./queue/index.js"
import { googleAuth } from "@hono/oauth-providers/google"
import { jwt } from "hono/jwt"
import { sign } from "hono/jwt"
import { db } from "./db/client.js"
import { HTTPException } from "hono/http-exception"
import { createWorkspace, getWorkspaceByDomain } from "./db/workspace.js"
import { createUser, getUserByEmail } from "./db/user.js"
import { getCookie } from "hono/cookie"
import config from "./config.js"
import { OAuthCallback } from "./api/oauth.js"
import { setCookieByEnv } from "./utils.js"
import { getLogger, LogMiddleware } from "./logger/index.js"
import { Subsystem } from "./types.js"
import { GetUserWorkspaceInfo } from "./api/auth.js"
import { AuthRedirectError, InitialisationError } from "./errors/index.js"
import {
  ChatBookmarkApi,
  ChatDeleteApi,
  ChatHistory,
  ChatRenameApi,
  GetChatApi,
  MessageApi,
  MessageRetryApi,
} from "./api/chat.js"
import { UserRole } from "./shared/types.js"
import { wsConnections } from "./integrations/google/ws.js"
import { serve } from "@hono/node-server"

import dotenv from "dotenv"
dotenv.config()
// Import serveStatic and upgradeWebSocket helpers
import { serveStatic } from "hono/serve-static"
// import { upgradeWebSocket } from "hono/websocket"

const clientId = process.env.GOOGLE_CLIENT_ID
const clientSecret = process.env.GOOGLE_CLIENT_SECRET
const redirectURI = config.redirectUri
const postOauthRedirect = config.postOauthRedirect
const jwtSecret = process.env.JWT_SECRET
const CookieName = "auth-token"
const Logger = getLogger(Subsystem.Server)

const app = new Hono()

const AuthMiddleware = jwt({
  secret: jwtSecret,
  cookie: CookieName,
})

// Middleware for frontend routes: Checks if an auth token exists and is valid
const AuthRedirect = async (c, next) => {
  const authToken = getCookie(c, CookieName)
  if (!authToken) {
    Logger.warn("Redirected by server - No AuthToken")
    return c.redirect(`/auth`)
  }
  try {
    await AuthMiddleware(c, next)
  } catch (err) {
    Logger.error(err, `${new AuthRedirectError({ cause: err })} ${err.stack}`)
    Logger.warn("Redirected by server - Error in AuthMW")
    return c.redirect(`/auth`)
  }
}

const honoMiddlewareLogger = LogMiddleware(Subsystem.Server)
app.use("*", honoMiddlewareLogger)

// WebSocket route using Hono's upgradeWebSocket helper
// export const WsApp = app.get(
//   "/ws",
//   upgradeWebSocket((c) => {
//     let connectorId
//     return {
//       onOpen(event, ws) {
//         connectorId = c.req.query("id")
//         Logger.info(`Websocket connection with id ${connectorId}`)
//         wsConnections.set(connectorId, ws)
//       },
//       onMessage(event, ws) {
//         Logger.info(`Message from client: ${event.data}`)
//         ws.send(JSON.stringify({ message: "Hello from server!" }))
//       },
//       onClose(event, ws) {
//         Logger.info("Connection closed")
//         if (connectorId) {
//           wsConnections.delete(connectorId)
//         }
//       },
//     }
//   }),
// )

export const AppRoutes = app
  .get("/", (c) => c.text("Hello Node.js!"))
  .basePath("/api/v1")
  .use("*", AuthMiddleware)
  .post(
    "/autocomplete",
    zValidator("json", autocompleteSchema),
    AutocompleteApi,
  )
  .post("/chat", zValidator("json", chatSchema), GetChatApi)
  .post(
    "/chat/bookmark",
    zValidator("json", chatBookmarkSchema),
    ChatBookmarkApi,
  )
  .post("/chat/rename", zValidator("json", chatRenameSchema), ChatRenameApi)
  .post("/chat/delete", zValidator("json", chatDeleteSchema), ChatDeleteApi)
  .get("/chat/history", zValidator("query", chatHistorySchema), ChatHistory)
  .get("/message/create", zValidator("query", messageSchema), MessageApi)
  .get(
    "/message/retry",
    zValidator("query", messageRetrySchema),
    MessageRetryApi,
  )
  .get("/search", zValidator("query", searchSchema), SearchApi)
  .get("/me", GetUserWorkspaceInfo)
  .get("/proxy/:url", ProxyUrl)
  .get("/answer", zValidator("query", answerSchema), AnswerApi)
  .basePath("/admin")
  .post(
    "/service_account",
    zValidator("form", addServiceConnectionSchema),
    AddServiceConnection,
  )
  .post(
    "/oauth/create",
    zValidator("form", createOAuthProvider),
    CreateOAuthProvider,
  )
  .get("/connectors/all", GetConnectors)

app.get("/oauth/callback", AuthMiddleware, OAuthCallback)
app.get(
  "/oauth/start",
  AuthMiddleware,
  zValidator("query", oauthStartQuerySchema),
  StartOAuth,
)

const generateToken = async (email, role, workspaceId) => {
  Logger.info(
    {
      tokenInfo: {
        role: role,
        workspaceId,
      },
    },
    "generating token for the following",
  )
  const payload = {
    sub: email,
    role: role,
    workspaceId,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60, // Expires in 2 months
  }
  const jwtToken = await sign(payload, jwtSecret)
  return jwtToken
}

app.get(
  "/v1/auth/callback",
  googleAuth({
    client_id: clientId,
    client_secret: clientSecret,
    scope: ["openid", "email", "profile"],
    redirect_uri: redirectURI,
  }),
  async (c) => {
    const token = c.get("token")
    const grantedScopes = c.get("granted-scopes")
    const user = c.get("user-google")
    const email = user?.email
    if (!email) {
      throw new HTTPException(500, {
        message: "Could not get the email of the user",
      })
    }
    if (!user?.verified_email) {
      throw new HTTPException(500, { message: "User email is not verified" })
    }
    let domain = user.hd
    if (!domain && email) {
      domain = email.split("@")[1]
    }
    const name = user?.name || user?.given_name || user?.family_name || ""
    const photoLink = user?.picture || ""
    const existingUserRes = await getUserByEmail(db, email)
    if (existingUserRes && existingUserRes.length) {
      Logger.info(
        {
          requestId: c.var.requestId,
          user: {
            email: user.email,
            name: user.name,
            verified_email: user.verified_email,
          },
        },
        "User found and authenticated",
      )
      const existingUser = existingUserRes[0]
      const jwtToken = await generateToken(
        existingUser.email,
        existingUser.role,
        existingUser.workspaceExternalId,
      )
      setCookieByEnv(c, CookieName, jwtToken)
      return c.redirect(postOauthRedirect)
    }
    const existingWorkspaceRes = await getWorkspaceByDomain(domain)
    if (existingWorkspaceRes && existingWorkspaceRes.length) {
      Logger.info("Workspace found, creating user")
      const existingWorkspace = existingWorkspaceRes[0]
      const [user] = await createUser(
        db,
        existingWorkspace.id,
        email,
        name,
        photoLink,
        UserRole.User,
        existingWorkspace.externalId,
      )
      const jwtToken = await generateToken(
        user.email,
        user.role,
        user.workspaceExternalId,
      )
      setCookieByEnv(c, CookieName, jwtToken)
      return c.redirect(postOauthRedirect)
    }
    Logger.info("Creating workspace and user")
    const userAcc = await db.transaction(async (trx) => {
      const [workspace] = await createWorkspace(trx, email, domain)
      const [user] = await createUser(
        trx,
        workspace.id,
        email,
        name,
        photoLink,
        UserRole.SuperAdmin,
        workspace.externalId,
      )
      return user
    })
    const jwtToken = await generateToken(
      userAcc.email,
      userAcc.role,
      userAcc.workspaceExternalId,
    )
    setCookieByEnv(c, CookieName, jwtToken)
    return c.redirect(postOauthRedirect)
  },
)

app.get("/", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/chat", AuthRedirect, (c) => c.redirect("/"))
app.get("/auth", serveStatic({ path: "./dist/index.html" }))
app.get("/search", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get(
  "/chat/:param",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/integrations",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get("/oauth/success", serveStatic({ path: "./dist/index.html" }))
app.get("/assets/*", serveStatic({ root: "./dist" }))

export const init = async () => {
  await initQueue()
}

init().catch((error) => {
  throw new InitialisationError({ cause: error })
})

// Start the server using Node.js

serve({ fetch: app.fetch, port: config.port })

// process.on("uncaughtException", (error) => {
//   Logger.error(error, "uncaughtException")
// })
