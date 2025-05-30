import { type Context, Hono, type Next } from "hono"
import {
  AnswerApi,
  AutocompleteApi,
  autocompleteSchema,
  chatBookmarkSchema,
  chatDeleteSchema,
  chatHistorySchema,
  chatRenameSchema,
  chatTraceSchema,
  chatSchema,
  messageRetrySchema,
  messageSchema,
  SearchApi,
  chatStopSchema,
  getAllDocs,
} from "@/api/search"
import { zValidator } from "@hono/zod-validator"
import {
  addApiKeyConnectorSchema,
  addServiceConnectionSchema,
  answerSchema,
  createOAuthProvider,
  deleteConnectorSchema,
  oauthStartQuerySchema,
  searchSchema,
  updateConnectorStatusSchema,
  serviceAccountIngestMoreSchema,
} from "@/types"
import {
  AddApiKeyConnector,
  AddServiceConnection,
  CreateOAuthProvider,
  DeleteConnector,
  DeleteOauthConnector,
  GetConnectors,
  StartOAuth,
  UpdateConnectorStatus,
  ServiceAccountIngestMoreUsersApi,
} from "@/api/admin"
import { ProxyUrl } from "@/api/proxy"
import { init as initQueue } from "@/queue"
import { createBunWebSocket } from "hono/bun"
import type { ServerWebSocket } from "bun"
import { googleAuth } from "@hono/oauth-providers/google"
import { jwt } from "hono/jwt"
import type { JwtVariables } from "hono/jwt"
import { sign } from "hono/jwt"
import { db } from "@/db/client"
import { HTTPException } from "hono/http-exception"
import { createWorkspace, getWorkspaceByDomain } from "@/db/workspace"
import { createUser, getUserByEmail } from "@/db/user"
import { getCookie } from "hono/cookie"
import { serveStatic } from "hono/bun"
import config from "@/config"
import { OAuthCallback } from "@/api/oauth"
import { setCookieByEnv } from "@/utils"
import { getLogger, LogMiddleware } from "@/logger"
import { Subsystem } from "@/types"
import { GetUserWorkspaceInfo } from "@/api/auth"
import { AuthRedirectError, InitialisationError } from "@/errors"
import {
  ChatBookmarkApi,
  ChatDeleteApi,
  ChatHistory,
  ChatRenameApi,
  GetChatApi,
  MessageApi,
  MessageRetryApi,
  GetChatTraceApi,
  StopStreamingApi,
} from "@/api/chat"
import { UserRole } from "@/shared/types"
import { wsConnections } from "@/integrations/metricStream"
import {
  EvaluateHandler,
  ListDatasetsHandler,
  TuneDatasetHandler,
  TuningWsRoute,
  tuneDatasetSchema,
  DeleteDatasetHandler,
} from "@/api/tuning"
import {
  CreateAgentApi,
  ListAgentsApi,
  UpdateAgentApi,
  DeleteAgentApi,
  createAgentSchema,
  listAgentsSchema,
  updateAgentSchema,
} from "@/api/agent"
import metricRegister from "@/metrics/sharedRegistry"
import {handleFileUpload} from "@/api/files"
export type Variables = JwtVariables

const clientId = process.env.GOOGLE_CLIENT_ID!
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!
const redirectURI = config.redirectUri
const postOauthRedirect = config.postOauthRedirect

const jwtSecret = process.env.JWT_SECRET!

const CookieName = "auth-token"

const Logger = getLogger(Subsystem.Server)

const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>()

const app = new Hono<{ Variables: Variables }>()

const AuthMiddleware = jwt({
  secret: jwtSecret,
  cookie: CookieName,
})

// Middleware for frontend routes
// Checks if there is token in cookie or not
// If there is token, verify it is valid or not
// Redirect to auth page if no token or invalid token
const AuthRedirect = async (c: Context, next: Next) => {
  const authToken = getCookie(c, CookieName)

  // If no auth token is found
  if (!authToken) {
    Logger.warn("Redirected by server - No AuthToken")
    // Redirect to login page if no token found
    return c.redirect(`/auth`)
  }

  try {
    // Verify the token if available
    await AuthMiddleware(c, next)
  } catch (err) {
    Logger.error(
      err,
      `${new AuthRedirectError({ cause: err as Error })} ${(err as Error).stack}`,
    )
    Logger.warn("Redirected by server - Error in AuthMW")
    // Redirect to auth page if token invalid
    return c.redirect(`/auth`)
  }
}

const honoMiddlewareLogger = LogMiddleware(Subsystem.Server)

app.use("*", honoMiddlewareLogger)

export const WsApp = app.get(
  "/ws",
  upgradeWebSocket((c) => {
    let connectorId: string | undefined
    return {
      onOpen(event, ws) {
        connectorId = c.req.query("id")
        Logger.info(`Websocket connection with id ${connectorId}`)
        wsConnections.set(connectorId, ws)
      },
      onMessage(event, ws) {
        Logger.info(`Message from client: ${event.data}`)
        ws.send(JSON.stringify({ message: "Hello from server!" }))
      },
      onClose: (event, ws) => {
        Logger.info("Connection closed")
        if (connectorId) {
          wsConnections.delete(connectorId)
        }
      },
    }
  }),
)

export const AppRoutes = app
  .basePath("/api/v1")
  .use("*", AuthMiddleware)
  .post(
    "/autocomplete",
    zValidator("json", autocompleteSchema),
    AutocompleteApi,
  )
  .post("files/upload",handleFileUpload)
  .post("getAllFiles",getAllDocs)
  .post("/chat", zValidator("json", chatSchema), GetChatApi)
  .post(
    "/chat/bookmark",
    zValidator("json", chatBookmarkSchema),
    ChatBookmarkApi,
  )
  .post("/chat/rename", zValidator("json", chatRenameSchema), ChatRenameApi)
  .post("/chat/delete", zValidator("json", chatDeleteSchema), ChatDeleteApi)
  .post("/chat/stop", zValidator("json", chatStopSchema), StopStreamingApi)
  .get("/chat/history", zValidator("query", chatHistorySchema), ChatHistory)
  .get("/chat/trace", zValidator("query", chatTraceSchema), GetChatTraceApi)
  // this is event streaming end point
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
  .post("/tuning/evaluate", EvaluateHandler)
  .get("/tuning/datasets", ListDatasetsHandler)
  .post(
    "/tuning/tuneDataset",
    zValidator("json", tuneDatasetSchema),
    TuneDatasetHandler,
  )
  .delete("/tuning/datasets/:filename", DeleteDatasetHandler)
  .get("/tuning/ws/:jobId", TuningWsRoute)
  // Agent Routes
  .post("/agent/create", zValidator("json", createAgentSchema), CreateAgentApi)
  .get("/agents", zValidator("query", listAgentsSchema), ListAgentsApi)
  .put("/agent/:agentExternalId", zValidator("json", updateAgentSchema), UpdateAgentApi)
  .delete("/agent/:agentExternalId", DeleteAgentApi)
  // Admin Routes
  .basePath("/admin")
  // TODO: debug
  // for some reason the validation schema
  // is not making the keys mandatory
  .post(
    "/service_account",
    zValidator("form", addServiceConnectionSchema),
    AddServiceConnection,
  )
  .post(
    "/google/service_account/ingest_more",
    zValidator("json", serviceAccountIngestMoreSchema),
    ServiceAccountIngestMoreUsersApi,
  )
  // create the provider + connector
  .post(
    "/oauth/create",
    zValidator("form", createOAuthProvider),
    CreateOAuthProvider,
  )
  .post(
    "/apikey/create",
    zValidator("form", addApiKeyConnectorSchema),
    AddApiKeyConnector,
  )
  .get("/connectors/all", GetConnectors)
  .post(
    "/connector/update_status",
    zValidator("form", updateConnectorStatusSchema),
    UpdateConnectorStatus,
  )
  .delete(
    "/connector/delete",
    zValidator("form", deleteConnectorSchema),
    DeleteConnector,
  )
  .delete(
    "/oauth/connector/delete",
    zValidator("form", deleteConnectorSchema),
    DeleteOauthConnector,
  )

app.get("/oauth/callback", AuthMiddleware, OAuthCallback)
app.get(
  "/oauth/start",
  AuthMiddleware,
  zValidator("query", oauthStartQuerySchema),
  StartOAuth,
)

const generateToken = async (
  email: string,
  role: string,
  workspaceId: string,
) => {
  Logger.info(
    {
      tokenInfo: {
        // email: email,
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
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 60, // Token expires in 2 months
  }
  const jwtToken = await sign(payload, jwtSecret)
  return jwtToken
}
// we won't allow user to reach the login page if they are already logged in
// or if they have an expired token

// After google oauth is done, google redirects user
// here and this is where all the onboarding will happen
// if user account does not exist, then we will automatically
// create the user and workspace
// if workspace already exists for that domain then we just login
// the user and update the last logged in value
app.get(
  "/v1/auth/callback",
  googleAuth({
    client_id: clientId,
    client_secret: clientSecret,
    scope: ["openid", "email", "profile"],
    redirect_uri: redirectURI,
  }),
  async (c: Context) => {
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
    // hosted domain
    // @ts-ignore
    let domain = user.hd
    if (!domain && email) {
      domain = email.split("@")[1]
    }
    const name = user?.name || user?.given_name || user?.family_name || ""
    const photoLink = user?.picture || ""

    const existingUserRes = await getUserByEmail(db, email)
    // if user exists then workspace exists too
    if (existingUserRes && existingUserRes.length) {
      Logger.info(
        {
          requestId: c.var.requestId, // Access the request ID
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

    // check if workspace exists
    // just create the user
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

    // we could not find the user and the workspace
    // creating both

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

// Serving exact frontend routes and adding AuthRedirect wherever needed
app.get("/", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/chat", AuthRedirect, (c) => c.redirect("/"))
app.get("/trace", AuthRedirect, (c) => c.redirect("/"))
app.get("/auth", serveStatic({ path: "./dist/index.html" }))
app.get("/search", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get(
  "/chat/:param",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/trace/:chatId/:messageId",
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
app.get(
  "/admin/integrations/google",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get(
  "/admin/integrations/slack",
  AuthRedirect,
  serveStatic({ path: "./dist/index.html" }),
)
app.get("/tuning", AuthRedirect, serveStatic({ path: "./dist/index.html" }))
app.get("/oauth/success", serveStatic({ path: "./dist/index.html" })) // Serve assets (CSS, JS, etc.)
app.get("/assets/*", serveStatic({ root: "./dist" }))
export const init = async () => {
  await initQueue()
}

app.get("/metrics", async (c) => {
  try {
    const metrics = await metricRegister.metrics()
    return c.text(metrics, 200, {
      "Content-Type": metricRegister.contentType,
    })
  } catch (err) {
    return c.text("Error generating metrics", 500)
  }
})


init().catch((error) => {
  throw new InitialisationError({ cause: error })
})

const server = Bun.serve({
  fetch: app.fetch,
  port: config.port,
  websocket,
  idleTimeout: 180,
})
Logger.info(`listening on port: ${config.port}`)

const errorEvents: string[] = [
  `uncaughtException`,
  `unhandledRejection`,
  `rejectionHandled`,
]
errorEvents.forEach((eventType: string) =>
  process.on(eventType, (error: Error) => {
    Logger.error(error, `Caught via event: ${eventType}`)
  }),
)
