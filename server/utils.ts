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

// we want LLM to have a better understanding of time
export const getRelativeTime = (oldTimestamp: number) => {
  const now = Math.floor(Date.now() / 1000)
  const difference = now - oldTimestamp

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
