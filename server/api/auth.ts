// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";
import type { Context } from "hono"
import config from "@/config"
import { db } from "@/db/client"
import { getUserAndWorkspaceByEmail } from "@/db/user"
import { type PublicUserWorkspace } from "@/db/schema"
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
  const { sub, workspaceId } = c.get(JwtPayloadKey)
  const email = sub
  const userAndWorkspace: PublicUserWorkspace =
    await getUserAndWorkspaceByEmail(db, workspaceId, email)
  return c.json(userAndWorkspace)
}
