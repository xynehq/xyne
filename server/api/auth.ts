// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono";
import config from "@/config"
import { db } from '@/db/client'
import { getUserAndWorkspaceByOnlyEmail } from "@/db/user";
import { userPublicSchema, workspacePublicSchema } from "@/db/schema";
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
    const userAndWorkspace = await getUserAndWorkspaceByOnlyEmail(db, email)
    if (!userAndWorkspace || userAndWorkspace.length === 0) {
        return c.json({ error: "User or Workspace not found" }, 404)
    }
    const { user, workspace } = userAndWorkspace[0];

    const userPublic = userPublicSchema.parse(user);
    const workspacePublic = workspacePublicSchema.parse(workspace);

    return c.json({
        user: userPublic,
        workspace: workspacePublic,
})
}