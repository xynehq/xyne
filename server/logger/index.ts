import { levels, pino, type Logger } from "pino"
import { Subsystem, type loggerChildSchema } from "@/types"
import type { MiddlewareHandler, Context, Next } from "hono"
import { getPath } from "hono/utils/url"
import { v4 as uuidv4 } from "uuid"
import {
  appRequest,
  appResponse,
  requestResponseLatency,
} from "@/metrics/app/app-metrics"
import config from "@/config"
import { object } from "zod"

// Export Subsystem for other modules
export { Subsystem }

const { JwtPayloadKey } = config

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
  const isProduction = process.env.NODE_ENV === "production"

  if (isProduction) {
    const destination = pino.destination(1) // stdout

    return pino(
      {
        name: loggerType,
        timestamp: false,
        formatters: {
          level: (label) => ({ level: label }),
          log: (object) => {
            const { msg, ...rest } = object
            return { msg, ...rest }
          },
        },
        mixin(_mergeObject, _level) {
          const rawStack = new Error().stack
          const stack = rawStack ? rawStack.split("\n") : null
          const caller = stack?.[4]?.trim()
          return caller && !caller.includes("unknown") ? { caller } : {}
        },
      },
      {
        write: (str) => {
          try {
            const obj = JSON.parse(str)
            const { level, name, msg, ...rest } = obj
            const reordered = JSON.stringify({ level, name, msg, ...rest })
            destination.write(reordered + "\n")
          } catch {
            destination.write(str)
          }
        },
      },
    )
  }

  // Dev logger
  return pino({
    name: loggerType,
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        errorLikeObjectKeys: [
          "err",
          "error",
          "error_stack",
          "stack",
          "apiErrorHandlerCallStack",
        ],
        ignore: "pid,hostname",
      },
    },
  })
}

const logRequest = (
  logger: Logger,
  c: Context,
  requestId: any,
  start: number,
  status: number,
  sub: string,
) => {
  const elapsed = time(start)
  const isError = status >= 400
  const isRedirect = status === 302

  const email = sub ?? ""
  const logData = {
    requestId,
    status,
    elapsed,
    ...(isError ? { error: c.res.body } : {}),
    email,
  }

  if (isError) {
    logger.error(logData, "Request error")
  } else if (isRedirect) {
    logger.info(logData, "Request redirected")
  } else {
    logger.info(logData, "Request completed")
  }
}

export const LogMiddleware = (loggerType: Subsystem): MiddlewareHandler => {
  const logger = getLogger(loggerType)

  return async (c: Context, next: Next) => {
    const jwtPayload = (c.get(JwtPayloadKey) ?? {}) as Record<string, unknown>
    const sub = typeof jwtPayload.sub === "string" ? jwtPayload.sub : ""
    const email = sub
    const requestId = uuidv4()
    const c_reqId = "requestId" in c.req ? c.req.requestId : requestId
    c.set("requestId", c_reqId)

    const { method } = c.req
    const path = getPath(c.req.raw)
    const isMetrics = path.startsWith("/metrics")

    if (!isMetrics) {
      logger.info({
        requestId: c_reqId,
        method,
        path,
        query: c.req.query("query") || c.req.query("prompt") || null,
        message: "Incoming request",
        email,
      })
    }
    const start = Date.now()

    const offset = c.req.query("offset") ?? ""
    const agentId = c.req.query("agentId") ?? ""

    appRequest.inc(
      {
        app_endpoint: getPath(c.req.raw).includes("/api/v1/proxy")
          ? "/api/v1/proxy"
          : getPath(c.req.raw),
        app_request_process_status: "received",
        email: sub,
        offset: offset,
        agent_id: agentId,
      },
      1,
    )
    await next()

    const duration = (Date.now() - start) / 1000

    const end = new Date().toISOString()
    appResponse.inc({
      app_endpoint: c.req.routePath,
      app_response_status: String(c.res.status),
      email: sub,
    })

    requestResponseLatency.observe(
      {
        app_endpoint: c.req.routePath,
        app_response_status: String(c.res.status),
        email: sub,
      },
      duration,
    )
    if (!isMetrics) {
      logRequest(logger, c, c_reqId, start, c.res.status, sub)
    }
  }
}

export const getLoggerWithChild = (subsystem: Subsystem, child?: any) => {
  const baseLogger = child
    ? getLogger(subsystem).child(child)
    : getLogger(subsystem)

  return (children: loggerChildSchema = { email: "n/a" }): Logger => {
    return baseLogger.child(children)
  }
}
