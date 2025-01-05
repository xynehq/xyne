import type { Context } from "hono"
import { setCookie } from "hono/cookie"
import type { CookieOptions } from "hono/utils/cookie"
import fs from "node:fs/promises"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

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

// this helps prevent typescript from
// being bothered by the error in the catch
export const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) return error.message
  return String(error)
}

// // we want LLM to have a better understanding of time
export const getRelativeTime = (oldTimestamp: number) => {
  // Convert `oldTimestamp` to seconds if it is in milliseconds
  const oldTimestampInSeconds = Math.floor(oldTimestamp / 1000)
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

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Retry logic with exponential backoff and jitter.
 * @param fn - The function to retry.
 * @param context - Context for logging (e.g., function name, additional info).
 * @param retries - Number of retries attempted.
 */
export const retryWithBackoff = async <T>(
  fn: () => Promise<T>,
  context: string,
  retries = 0,
): Promise<T> => {
  try {
    return await fn() // Attempt the function
  } catch (error: any) {
    const isQuotaError =
      error.message.includes("Quota exceeded") ||
      error.code === 429 ||
      error.code === 403
    const isGoogleTimeoutError =
      error.code === "ETIMEDOUT" ||
      error.code === "ECONNABORTED" ||
      error.message.includes("timeout") ||
      error.message.includes("deadline") ||
      error.message.includes("The operation timed out") ||
      // Specific Google API timeout indicators
      error.code === 504 || // Gateway Timeout
      error.code === 503 // Service Unavailable
    if ((isQuotaError || isGoogleTimeoutError) && retries < MAX_RETRIES) {
      const baseWaitTime = Math.pow(2, retries) * 3000 // Exponential backoff
      const jitter = Math.random() * 800 // Add jitter for randomness
      const waitTime = baseWaitTime + jitter

      Logger.info(
        `[${context}] Quota error. Retrying after ${waitTime.toFixed(
          0,
        )}ms (Attempt ${retries + 1}/${MAX_RETRIES})`,
      )
      await delay(waitTime)

      return retryWithBackoff(fn, context, retries + 1) // Retry recursively
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
