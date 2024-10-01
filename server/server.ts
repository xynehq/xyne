import { Hono, type Context, type Next } from 'hono'
import { logger } from 'hono/logger'
import { AutocompleteApi, autocompleteSchema, SearchApi } from '@/api/search'
import { zValidator } from '@hono/zod-validator'
import { addServiceConnectionSchema, createOAuthProvider, oauthStartQuerySchema, searchSchema, UserRole } from '@/types'
import { AddServiceConnection, CreateOAuthProvider, GetConnectors, StartOAuth } from '@/api/admin'
import { init as initQueue } from '@/queue'
import { createBunWebSocket } from 'hono/bun'
import type { ServerWebSocket } from 'bun'
import { googleAuth } from '@hono/oauth-providers/google'
import { jwt } from 'hono/jwt'
import type { JwtVariables } from 'hono/jwt'
type Variables = JwtVariables
import { sign } from 'hono/jwt'
import { db } from '@/db/client'
import { HTTPException } from 'hono/http-exception'
import { createWorkspace, getWorkspaceByDomain } from '@/db/workspace'
import { createUser, getUserByEmail } from '@/db/user'
import { getCookie, setCookie } from 'hono/cookie'
import { serveStatic } from 'hono/bun'
import config from '@/config'
import { OAuthCallback } from './api/oauth'
import { setCookieByEnv } from './utils'
import { html, raw } from 'hono/html'



const clientId = process.env.GOOGLE_CLIENT_ID!
const clientSecret = process.env.GOOGLE_CLIENT_SECRET!
const redirectURI = process.env.GOOGLE_REDIRECT_URI!

const postOauthRedirect = process.env.POST_OAUTH_REDIRECT!
const jwtSecret = process.env.JWT_SECRET!

const CookieName = 'auth-token'


const { upgradeWebSocket, websocket } =
    createBunWebSocket<ServerWebSocket>()

const app = new Hono<{ Variables: Variables }>()

const AuthMiddleware = jwt({
    secret: jwtSecret,
    cookie: CookieName
})

const isBrowserGETRequest = (c: Context) => {
    if (c.req.method === 'GET') {
        const acceptHeader = c.req.header('Accept');
        if (acceptHeader?.includes('text/html')) {
            return true;
        } else {
            return false;
        }
    } else {
        false;
    }
}

const CheckCookieMiddleware = async (c: Context, next: Next) => {
    const authToken = getCookie(c, CookieName);

    // If no auth token is found
    if (!authToken) {
        if (isBrowserGETRequest(c)) {
            console.log("Redirected by server - No AuthToken")
            return c.redirect('http://localhost:5173/auth') 
        } else {
            return c.json({ message: "Unauthorized" }, 401);
        }
    }

    try {
        await AuthMiddleware(c, next);
    } catch (err) {
        console.error(err);
        if (isBrowserGETRequest(c)) {
            console.log("Redirected by server - Error in AuthMW")
            return c.redirect('http://localhost:5173/auth') 
        } else {
            return c.json({ message: "Unauthorized" }, 401);
        }
    }
};

app.use('*', logger())

export const wsConnections = new Map();

export const WsApp = app.get(
    '/ws',
    upgradeWebSocket((c) => {
        let connectorId: string | undefined
        return {
            onOpen(event, ws) {
                connectorId = c.req.query('id')
                wsConnections.set(connectorId, ws)
            },
            onMessage(event, ws) {
                console.log(`Message from client: ${event.data}`)
                ws.send(JSON.stringify({ message: 'Hello from server!' }))
            },
            onClose: (event, ws) => {
                console.log('Connection closed')
                if (connectorId) {
                    wsConnections.delete(connectorId)
                }
            },
        }
    })
)

// export type WebSocketApp = typeof WsApp

export const AppRoutes = app.basePath('/api')
    .use('*', CheckCookieMiddleware)
    .post('/autocomplete', zValidator('json', autocompleteSchema), AutocompleteApi)
    .get('/search', zValidator('query', searchSchema), SearchApi)
    .basePath('/admin')
    // TODO: debug
    // for some reason the validation schema
    // is not making the keys mandatory
    .post('/service_account', zValidator('form', addServiceConnectionSchema), AddServiceConnection)
    // create the provider + connector
    .post('/oauth/create', zValidator('form', createOAuthProvider), CreateOAuthProvider)
    .get('/connectors/all', GetConnectors)


app.get('/oauth/callback', AuthMiddleware, OAuthCallback)

// temporarily removing the AuthMiddleware for dev environment
// if (process.env.NODE_ENV === "production") {
app.get('/oauth/start', AuthMiddleware, zValidator('query', oauthStartQuerySchema), StartOAuth)
// } else {
//     app.get('/oauth/start', zValidator('query', oauthStartQuerySchema), StartOAuth)
// }
const generateToken = async (email: string, role: string, workspaceId: string) => {
    console.log('generating token')
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
    '/v1/auth/callback',
    googleAuth({
        client_id: clientId,
        client_secret: clientSecret,
        scope: ['openid', 'email', 'profile'],
    }),
    async (c: Context) => {
        const token = c.get('token')
        const grantedScopes = c.get('granted-scopes')
        const user = c.get('user-google')

        const email = user?.email
        if (!email) {
            throw new HTTPException(500, { message: 'Could not get the email of the user' })
        }

        if (!user?.verified_email) {
            throw new HTTPException(500, { message: 'User email is not verified' })
        }
        // hosted domain
        let domain = user.hd
        if (!domain && email) {
            domain = email.split('@')[1]
        }
        const name = user?.name || user?.given_name || user?.family_name || ""
        const photoLink = user?.picture || ""

        const existingUserRes = await getUserByEmail(db, email)
        // if user exists then workspace exists too
        if (existingUserRes && existingUserRes.length) {
            console.log('User found')
            const existingUser = existingUserRes[0]
            const jwtToken = await generateToken(existingUser.email, existingUser.role, existingUser.workspaceExternalId)
            setCookieByEnv(c, CookieName, jwtToken)
            return c.redirect(postOauthRedirect)
        }

        // check if workspace exists
        // just create the user
        const existingWorkspaceRes = await getWorkspaceByDomain(domain)
        if (existingWorkspaceRes && existingWorkspaceRes.length) {
            console.log('Workspace found, creating user')
            const existingWorkspace = existingWorkspaceRes[0]
            const [user] = await createUser(db, existingWorkspace.id, email, name, photoLink, token?.token, "test", UserRole.SuperAdmin, existingWorkspace.externalId)
            const jwtToken = await generateToken(user.email, user.role, user.workspaceExternalId)
            setCookieByEnv(c, CookieName, jwtToken)
            return c.redirect(postOauthRedirect)
        }

        // we could not find the user and the workspace
        // creating both

        console.log('Creating workspace and user')
        const userAcc = await db.transaction(async (trx) => {
            const [workspace] = await createWorkspace(trx, email, domain)
            const [user] = await createUser(trx, workspace.id, email, name, photoLink, token?.token, "test", UserRole.SuperAdmin, workspace.externalId)
            return user
        })

        const jwtToken = await generateToken(userAcc.email, userAcc.role, userAcc.workspaceExternalId)
        setCookieByEnv(c, CookieName, jwtToken)
        return c.redirect(postOauthRedirect)
    }
)

// app.get('/oauth/success', async (c: Context) => {
//     return c.html(
//         <html>
//         <head>
//         <title>Test Site </title>
//             { html`
//         <script>
//             window.onload = function () {
//             window.opener.postMessage({ success: true }, "*"); // Send a success message to the parent window
//             window.close(); // Close the popup window
//             </script>
//         };
//     `}
//           </head>
//     < body > Hello! </body>
//     </html>)
// })
app.get('*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));


export const init = async () => {
    await initQueue()
}
init().catch(e => {
    console.error(e)
})

const server = Bun.serve({
    fetch: app.fetch,
    port: config.port,
    websocket
})
console.log(`listening on port: ${config.port}`)