import type { Context } from "hono"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

// Only allow Google profile picture domains for security
const ALLOWED_DOMAINS = new Set([
  "lh1.googleusercontent.com",
  "lh2.googleusercontent.com",
  "lh3.googleusercontent.com",
  "lh4.googleusercontent.com",
  "lh5.googleusercontent.com",
  "lh6.googleusercontent.com",
])

const validateProfilePictureUrl = (url: string): boolean => {
  try {
    const parsedUrl = new URL(url)

    // Only allow HTTPS
    if (parsedUrl.protocol !== "https:") {
      return false
    }

    // Only allow Google profile picture domains
    return ALLOWED_DOMAINS.has(parsedUrl.hostname)
  } catch {
    return false
  }
}

const logger = getLogger(Subsystem.Server)

export const ProxyUrl = async (c: Context) => {
  const urlParam = c.req.param("url")
  if (!urlParam) {
    return c.text("URL parameter is required", 400)
  }
  const targetUrl = urlParam

  // Validate URL to prevent SSRF/LFI attacks
  if (!validateProfilePictureUrl(targetUrl)) {
    return c.text("Invalid profile picture URL", 400)
  }

  try {
    const response = await fetch(targetUrl, {
      headers: {
        "User-Agent": "Xyne-ProfileProxy/1.0",
      },
      signal: AbortSignal.timeout(5000), // 5 second timeout
    })

    if (!response.ok) {
      return c.text("Failed to fetch profile picture", 502)
    }

    // Only allow image content types
    const contentType = response.headers.get("Content-Type") || ""
    if (!contentType.startsWith("image/")) {
      return c.text("Invalid content type", 403)
    }

    return new Response(response.body, {
      status: response.status,
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=86400",
        "X-Content-Type-Options": "nosniff",
      },
    })
  } catch (error) {
    logger.error(error, "Profile picture proxy error")
    return c.text("Request failed", 500)
  }
}
