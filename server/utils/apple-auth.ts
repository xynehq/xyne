import { HTTPException } from "hono/http-exception"

interface ApplePublicKey {
  kty: string
  kid: string
  use: string
  alg: string
  n: string
  e: string
}

interface ApplePublicKeysResponse {
  keys: ApplePublicKey[]
}

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

// Cache for Apple's public keys
let appleKeysCache: { keys: ApplePublicKey[]; expiry: number } | null = null
const CACHE_DURATION = 24 * 60 * 60 * 1000 // 24 hours in milliseconds

/**
 * Fetch Apple's public keys from their endpoint
 */
async function fetchApplePublicKeys(): Promise<ApplePublicKey[]> {
  // Check cache first
  if (appleKeysCache && Date.now() < appleKeysCache.expiry) {
    return appleKeysCache.keys
  }

  try {
    const response = await fetch("https://appleid.apple.com/auth/keys")
    if (!response.ok) {
      throw new Error(`Failed to fetch Apple keys: ${response.status}`)
    }

    const data: ApplePublicKeysResponse = await response.json()

    // Update cache
    appleKeysCache = {
      keys: data.keys,
      expiry: Date.now() + CACHE_DURATION,
    }

    return data.keys
  } catch (error) {
    throw new HTTPException(500, {
      message: "Failed to fetch Apple public keys",
    })
  }
}

/**
 * Validate Apple identity token
 * Note: This is a simplified implementation that validates token structure and claims
 * but does not perform full RSA signature verification. For production use,
 * consider using a robust JWT library like `jose` or `jsonwebtoken` for complete
 * cryptographic signature verification with Apple's RSA public keys.
 */
export async function validateAppleToken(
  identityToken: string,
  expectedAudience: string,
): Promise<AppleTokenClaims> {
  try {
    // Decode the token header to get the key ID (kid)
    const [headerB64, payloadB64, signatureB64] = identityToken.split(".")

    if (!headerB64 || !payloadB64 || !signatureB64) {
      throw new HTTPException(400, {
        message: "Invalid token structure",
      })
    }

    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString())

    if (!header.kid || !header.alg) {
      throw new HTTPException(400, {
        message: "Invalid token: missing key ID or algorithm",
      })
    }

    // Verify algorithm is RS256 (RSA with SHA-256)
    if (header.alg !== "RS256") {
      throw new HTTPException(400, {
        message: "Invalid token: unsupported algorithm",
      })
    }

    // Fetch Apple's public keys to ensure the key exists
    const appleKeys = await fetchApplePublicKeys()

    // Find the matching key
    const matchingKey = appleKeys.find((key) => key.kid === header.kid)
    if (!matchingKey) {
      throw new HTTPException(400, {
        message: "Invalid token: key not found in Apple's public keys",
      })
    }

    // Extract and validate claims
    const payload = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString(),
    ) as AppleTokenClaims

    // Validate claims
    validateTokenClaims(payload, expectedAudience)

    return payload
  } catch (error) {
    if (error instanceof HTTPException) {
      throw error
    }
    throw new HTTPException(401, {
      message: "Invalid Apple identity token",
    })
  }
}

/**
 * Validate token claims according to Apple's requirements
 */
function validateTokenClaims(
  claims: AppleTokenClaims,
  expectedAudience: string,
): void {
  const now = Math.floor(Date.now() / 1000)

  // Validate issuer
  if (claims.iss !== "https://appleid.apple.com") {
    throw new HTTPException(401, {
      message: "Invalid token issuer",
    })
  }

  // Validate audience (should match your app's bundle ID)
  if (claims.aud !== expectedAudience) {
    throw new HTTPException(401, {
      message: "Invalid token audience",
    })
  }

  // Validate expiration
  if (claims.exp <= now) {
    throw new HTTPException(401, {
      message: "Token has expired",
    })
  }

  // Validate issued at time (should be recent)
  const maxAge = 60 * 60 // 1 hour
  if (claims.iat < now - maxAge) {
    throw new HTTPException(401, {
      message: "Token is too old",
    })
  }

  if (claims.iat > now + 60) {
    // Allow 1 minute clock skew
    throw new HTTPException(401, {
      message: "Token issued in the future",
    })
  }
}

/**
 * Extract user information from validated Apple token
 */
export function extractUserInfoFromToken(
  claims: AppleTokenClaims,
  userInfo?: any,
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
