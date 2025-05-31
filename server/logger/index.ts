import { levels, pino, type Logger } from "pino"
import { Subsystem } from "@/types"
import type { MiddlewareHandler, Context, Next } from "hono"
import { getPath } from "hono/utils/url"
import { v4 as uuidv4 } from "uuid"
import { appRequest, appResponse, requestResponseLatency } from "@/metrics/app/app-metrics"

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

  return pino({
    name: loggerType,
    ...(isProduction
      ? { formatters: { level: (label) => ({ level: label }) } }
      : {
          transport: {
            target: "pino-pretty",
            options: {
              colorize: true,
              colorizeObjects: true,
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
        }),
    mixin(_mergeObject, _level) {
      const stack = new Error().stack?.split("\n")
      const caller = stack?.[4]?.trim() // This skips internal logger frames
      return isProduction && caller && !caller.includes("unknown")
        ? { caller }
        : {}
    },
  })
}

const logRequest = (
  logger: Logger,
  c: Context,
  requestId: any,
  start: number,
  status: number,
) => {
  const elapsed = time(start)
  const isError = status >= 400
  const isRedirect = status === 302

  const logData = {
    requestId,
    status,
    elapsed,
    ...(isError ? { error: c.res.body } : {}),
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
    const requestId = uuidv4()
    const c_reqId = "requestId" in c.req ? c.req.requestId : requestId
    c.set("requestId", c_reqId)

    const { method } = c.req
    const path = getPath(c.req.raw)

    logger.info({
      requestId: c_reqId,
      method,
      path,
      query: c.req.query("query") || c.req.query("prompt") || null,
      message: "Incoming request",
    })

    const start = Date.now()

    appRequest.inc({
      app_endpoint: getPath(c.req.raw),
      app_request_time: new Date(start).toISOString(),
      app_request_process_status: "received"
    }, 1)
    await next()

    const duration = (Date.now() - start)/1000
    
    const end = new Date().toISOString()
    appResponse.inc({
      app_endpoint: c.req.routePath,
      app_response_time: end,
      app_response_status: String(c.res.status),
    })
   
    requestResponseLatency.observe({
      app_endpoint: c.req.routePath,
      app_response_status: String(c.res.status),
    }, duration)
    logRequest(logger, c, c_reqId, start, c.res.status)

  }
}
