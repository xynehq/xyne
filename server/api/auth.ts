// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono";
import config from "@/config"
import { db } from '@/db/client'
import { getUserByEmail } from "@/db/user";
import { getWorkspaceByEmail } from "@/db/workspace";
const { JwtPayloadKey } = config

// import { generateCodeVerifier, generateState } from "arctic";

// const clientId = process.env.GOOGLE_CLIENT_ID!
// const clientSecret = process.env.GOOGLE_CLIENT_SECRET!
// const redirectURI = process.env.GOOGLE_REDIRECT_URI!

// const google = new Google(clientId, clientSecret, redirectURI);


// const state = generateState();
// const codeVerifier = generateCodeVerifier();

// const url: URL = await google.createAuthorizationURL(state, codeVerifier, {
//     scopes: ['profile', 'email']
// });
// const tokens: GoogleTokens = await google.validateAuthorizationCode(code, codeVerifier);
// const refreshTokens: GoogleRefreshedTokens = await google.refreshAccessToken(refreshToken);

export const GetUserWorkspaceInfo = async (c: Context) => {
    const { sub } = c.get(JwtPayloadKey)
    const email = sub
    const workspace = await getWorkspaceByEmail(db, email)
    if (!workspace) {
        return c.json({ error: "Workspace not found" }, 404)
    }
    const user = await getUserByEmail(db, email)
    if (!user || !user.length) {
        return c.json({ error: "User not found" }, 404)
    }
    return c.json({user, workspace})
}