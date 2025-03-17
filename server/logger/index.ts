import { levels, pino, type Logger } from "pino"
import { Subsystem } from "@/types"
import type { MiddlewareHandler, Context, Next } from "hono"
import { getPath } from "hono/utils/url"
import { v4 as uuidv4 } from "uuid"

const humanize = (times: string[]) => {
  const [delimiter, separator] = [",", "."]

  const orderTimes = times.map((v) =>
    v.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + delimiter),
  )

  return orderTimes.join(separator)
}

const time = (start: number) => {
  const delta = Date.now() - start
  return humanize([
    delta < 1000 ? delta + "ms" : Math.round(delta / 1000) + "s",
  ])
}

export const getLogger = (loggerType: Subsystem) => {
  return pino({
    name: loggerType,
    formatters: {
      level(label) {
        return { level: label }
      },
    },
  })
}

export const LogMiddleware = (loggerType: Subsystem): MiddlewareHandler => {
  const logger = getLogger(loggerType)

  return async (c: Context, next: Next) => {
    const requestId = uuidv4()
    c.set("requestId", requestId)

    const { method } = c.req
    const path = getPath(c.req.raw)

    logger.info({
      requestId,
      method,
      path,
      query: c.req.query("query") || c.req.query("prompt") || null,
      message: "Incoming request",
    })

    const start = Date.now()
    await next()
    const elapsed = time(start)
    const { status } = c.res

    if (status >= 400) {
      logger.error({
        requestId,
        status,
        error: c.res.body,
        elapsed,
        message: "Request error",
      })
    } else if (status === 302) {
      logger.info({
        requestId,
        status,
        elapsed,
        message: "Request redirected",
      })
    } else {
      logger.info({
        requestId,
        status,
        elapsed,
        message: "Request completed",
      })
    }
  }
}
