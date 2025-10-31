import { HTTPException } from "hono/http-exception"
import { jwtVerify, createRemoteJWKSet } from "jose"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

interface AppleTokenClaims {
  iss: string
  aud: string
  exp: number
  iat: number
  sub: string
  email?: string
  email_verified?: boolean
  nonce?: string
  nonce_supported?: boolean
}

const Logger = getLogger(Subsystem.Auth)

// Apple's JWKS endpoint - jose will handle caching automatically
const APPLE_JWKS = createRemoteJWKSet(
  new URL("https://appleid.apple.com/auth/keys"),
)

export async function validateAppleToken(
  identityToken: string,
  expectedAudience: string,
): Promise<AppleTokenClaims> {
  try {
    // jose handles ALL validation automatically:
    // Token structure (header.payload.signature)
    // Header validation (kid, alg)
    // Algorithm verification (RS256)
    // Fetching Apple's public keys
    // Finding correct key by kid
    // Cryptographic signature verification
    // All claims validation (iss, aud, exp, iat)
    const { payload } = await jwtVerify(identityToken, APPLE_JWKS, {
      issuer: "https://appleid.apple.com",
      audience: expectedAudience,
      algorithms: ["RS256"],
    })

    return payload as AppleTokenClaims
  } catch (error) {
    Logger.error("Apple token validation failed", error)
    throw new HTTPException(401, {
      message: "Invalid Apple identity token",
    })
  }
}

/**
 * Extract user information from validated Apple token
 */
export function extractUserInfoFromToken(
  claims: AppleTokenClaims,
  userInfo?: {
    name?: {
      firstName?: string
      lastName?: string
    }
  },
): {
  id: string
  email?: string
  emailVerified: boolean
  name?: string
  givenName?: string
  familyName?: string
} {
  return {
    id: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified || false,
    name:
      userInfo?.name?.firstName && userInfo?.name?.lastName
        ? `${userInfo.name.firstName} ${userInfo.name.lastName}`
        : undefined,
    givenName: userInfo?.name?.firstName,
    familyName: userInfo?.name?.lastName,
  }
}
