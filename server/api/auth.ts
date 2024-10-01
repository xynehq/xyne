// import { Google, type GoogleRefreshedTokens, type GoogleTokens } from "arctic";

import type { Context } from "hono"

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

export const checkAuthApi = async (c: Context) => {
    return c.json({ success: true, message: "User logged in" })
}