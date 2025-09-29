import type { Context } from "hono"
import { deleteCookie, setCookie } from "hono/cookie"
import type { CookieOptions } from "hono/utils/cookie"
import fs from "node:fs/promises"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { stopwords as englishStopwords } from "@orama/stopwords/english"
import { OAuth2Client } from "google-auth-library"
import { Apps, AuthType } from "./shared/types"
import crypto from "node:crypto"
import type { QueryRouterResponse, TemporalClassifier } from "@/ai/types"
import {
  Client,
  CustomAuthenticationProvider,
} from "@microsoft/microsoft-graph-client"
import { OAuthClientInformationFullSchema } from "@modelcontextprotocol/sdk/shared/auth.js"
import {
  updateMicrosoftGraphClient,
  type MicrosoftClient,
  type MicrosoftGraphClient,
} from "./integrations/microsoft/client"
import { CustomServiceAuthProvider } from "./integrations/microsoft/utils"
import { scopes } from "./integrations/microsoft/config"
import { MicrosoftEntraId } from "arctic"
import config from "./config"

const Logger = getLogger(Subsystem.Utils)

export const checkAndReadFile = async (path: string) => {
  try {
    // Check if the file exists
    await fs.access(path)
    Logger.info(`File exists: ${path}`)

    // Read the file
    const data = JSON.parse(await fs.readFile(path, "utf8"))
    return data
  } catch (err) {
    if ((err as ErrnoException).code === "ENOENT") {
      return null
    } else {
      throw err
    }
  }
}

// @ts-ignore
export const progress_callback = (args) => {
  if (args.status != "progress") return
  let n = Math.floor(args.progress / 5)
  let str =
    "\r[" +
    "#".repeat(n) +
    ".".repeat(20 - n) +
    "] " +
    args.file +
    (n == 20 ? "\n" : "")
  process.stdout.write(str)
}

// to improve the dev experience we allow the cookie to be present
// in localhost:5173 which is frontend dev url
export const setCookieByEnv = (
  c: Context,
  CookieName: string,
  jwtToken: string,
  opts?: CookieOptions,
) => {
  const env = process.env.NODE_ENV
  if (env === "production") {
    setCookie(c, CookieName, jwtToken, opts)
  } else {
    Logger.info("Setting Cookie")
    setCookie(c, CookieName, jwtToken, {
      ...opts,
      secure: false,
      sameSite: "Lax",
      httpOnly: true,
    })
  }
}

export const deleteCookieByEnv = (
  c: Context,
  CookieName: string,
  opts?: CookieOptions,
) => {
  const env = process.env.NODE_ENV
  if (env === "production") {
    deleteCookie(c, CookieName, opts)
  } else {
    deleteCookie(c, CookieName, {
      ...opts,
      secure: false,
      sameSite: "Lax",
      httpOnly: true,
    })
  }
}

// this helps prevent typescript from
// being bothered by the error in the catch
export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

// // we want LLM to have a better understanding of time
export const getRelativeTime = (oldTimestamp: number) => {
  // If timestamp > 10^12, treat it as milliseconds

  const MILLISECOND_THRESHOLD = 1e10
  const oldTimestampInSeconds =
    oldTimestamp >= MILLISECOND_THRESHOLD
      ? Math.floor(oldTimestamp / 1000)
      : Math.floor(oldTimestamp)

  const now = Math.floor(Date.now() / 1000)
  const difference = now - oldTimestampInSeconds

  const formatter = new Intl.RelativeTimeFormat("en", { style: "narrow" })

  if (difference < 60) return formatter.format(-difference, "second")
  if (difference < 3600)
    return formatter.format(-Math.floor(difference / 60), "minute")
  if (difference < 86400)
    return formatter.format(-Math.floor(difference / 3600), "hour")
  if (difference < 2620800)
    return formatter.format(-Math.floor(difference / 86400), "day")
  if (difference < 31449600)
    return formatter.format(-Math.floor(difference / 2620800), "month")
  return formatter.format(-Math.floor(difference / 31449600), "year")
}

const MAX_RETRIES = 10

export const delay = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retry logic with exponential backoff and jitter.
 * @param fn - The function to retry.
 * @param context - Context for logging (e.g., function name, additional info).
 * @param retries - Number of retries attempted.
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  context: string,
  app: Apps,
  retries = 0,
  authClient?: OAuth2Client | MicrosoftGraphClient,
): Promise<T> => {
  try {
    return await fn() // Attempt the function
  } catch (error: any) {
    Logger.warn(error)
    const isQuotaError =
      error.message.includes("Quota exceeded") || error.code === 429
    // error.code === 403
    // Check for specific 403 Rate Limit errors that benefit from backoff
    const is403RetryableRateLimitError =
      error.code === 403 &&
      ["userRateLimitExceeded", "rateLimitExceeded"].includes(
        error.errors?.[0]?.reason,
      )

    const isGoogleTimeoutError =
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNABORTED" ||
      error.message.includes("timeout") ||
      error.message.includes("deadline") ||
      error.message.includes("The operation timed out") ||
      // Specific Google API timeout indicators
      error.code === 504 || // Gateway Timeout
      error.code === 503 // Service Unavailable

    // Combine checks for retryable errors
    if (
      (isQuotaError || isGoogleTimeoutError || is403RetryableRateLimitError) &&
      retries < MAX_RETRIES
    ) {
      const baseWaitTime = Math.pow(2, retries) * 3000 // Exponential backoff
      const jitter = Math.random() * 800 // Add jitter for randomness
      const waitTime = baseWaitTime + jitter

      let reason = "Quota/Timeout"
      if (is403RetryableRateLimitError) {
        reason = "403 Rate Limit"
      }

      Logger.info(
        `[${context}] ${reason} error. Retrying after ${waitTime.toFixed(
          0,
        )}ms (Attempt ${retries + 1}/${MAX_RETRIES})`,
      )
      await delay(waitTime)
      return retryWithBackoff(fn, context, app, retries + 1, authClient) // Retry recursively
    } else if (
      authClient &&
      (error.code === 401 || error.code === "InvalidAuthenticationToken") &&
      retries < MAX_RETRIES
    ) {
      if (authClient instanceof OAuth2Client) {
        if (IsGoogleApp(app)) {
          Logger.info(`401 encountered, refreshing OAuth access token...`)
          const { credentials } = await authClient?.refreshAccessToken()!
          authClient?.setCredentials(credentials)
          return retryWithBackoff(
            fn,
            context,
            app,
            retries + 1,
            authClient,
          )
        }
        else {
          throw new Error("Provided AppType is not google")
        }
      } else if (IsMicrosoftApp(app)) {
        if (authClient.refreshToken) {
          // OAuth/Delegated authentication
          const microsoft = new MicrosoftEntraId(
            "common",
            authClient.clientId,
            authClient.clientSecret,
            `${config.host}/oauth/callback`,
          )

          const refreshedTokens = await microsoft.refreshAccessToken(
            authClient.refreshToken,
            scopes,
          )
          updateMicrosoftGraphClient(
            authClient,
            refreshedTokens.accessToken(),
            refreshedTokens.refreshToken(),
          )
        } else if (authClient.tenantId) {
          // Service/app-only authentication
          const authProvider = new CustomServiceAuthProvider(
            authClient.tenantId,
            authClient.clientId,
            authClient.clientSecret,
          )
          updateMicrosoftGraphClient(
            authClient,
            await authProvider.getAccessToken(),
          )
        } else {
          throw new Error(
            "Not enough credentials provided for getting access token after expiry",
          )
        }
        return retryWithBackoff(fn, context, app, retries + 1, authClient)
      } else {
        throw new Error("401 error for unsupported app")
      }
    } else {
      Logger.error(
        `[${context}] Failed after ${retries} retries: ${error.message}`,
      )
      throw error // Rethrow error if retries are exhausted or not quota-related
    }
  }
}

export const splitGroupedCitationsWithSpaces = (text: string): string => {
  if (!text || typeof text !== "string") {
    throw new Error("Invalid input text")
  }

  // Only match groups containing numbers, commas and spaces
  return text.replace(
    /\[(\d+(?:\s*,\s*\d+)*)\]/g,
    (match: string, group: string) => {
      // Split by comma and clean each number
      const numbers = group
        .split(",")
        .map((n: string) => n.trim())
        .filter((n: string) => n.length > 0)

      // If no valid numbers found, return original match
      if (numbers.length === 0) {
        return match
      }

      return numbers.map((num: string) => `[${num}]`).join(" ")
    },
  )
}

export const removeStopwords = (text: string) => {
  const words = text.split(/\s+/)

  // Filter out stopwords
  const filteredWords = words.filter((word) => {
    const cleanWord = word.toLowerCase().replace(/[^\w]/g, "")
    return !englishStopwords.includes(cleanWord)
  })
  return filteredWords.join(" ")
}

export const IsGoogleApp = (app: Apps) => {
  return (
    app === Apps.GoogleDrive ||
    app === Apps.Gmail ||
    app === Apps.GoogleCalendar ||
    app === Apps.GoogleWorkspace
  )
}

export const IsMicrosoftApp = (app: Apps) => {
  return (
    app === Apps.MicrosoftDrive ||
    app === Apps.MicrosoftOutlook ||
    app === Apps.MicrosoftCalendar ||
    app === Apps.MicrosoftSharepoint
  )
}

export function scale(val: number): number | null {
  if (!val) return null
  return (2 * Math.atan(val / 4)) / Math.PI
}

// Function to hash the filename to hide the filename while
// Storing the data in the memory
export const hashPdfFilename = (filename: string): string => {
  const hashInput = filename
  const hash = crypto.createHash("md5").update(hashInput).digest("hex")

  const newFilename = hash
  Logger.info(`Filename hashed: ${filename} -> ${newFilename}`)
  return newFilename
}

export const interpretDateFromReturnedTemporalValue = (
  value: QueryRouterResponse["filters"],
) => {
  // Convert UTC timestamps to local time zone
  const from = value.startTime ? new Date(value.startTime) : null
  const to = value.endTime ? new Date(value.endTime) : null

  return { fromDate: from, toDate: to }
}
