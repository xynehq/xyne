import { pino, type Logger } from 'pino'
import { Subsystem } from '@/types'
import type { MiddlewareHandler, Context, Next } from "hono"
import { getPath } from 'hono/utils/url'
import { v4 as uuidv4 } from 'uuid';

export const getLogger = (loggerType: Subsystem) => {
  if (process.env.NODE_ENV === 'production') {
    return pino({
      name: `${loggerType}`,
      transport: {
        target: 'pino-pretty',
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
          destination: getLoggerDestination(loggerType),
        },
      },
    },)
  } else {
    return pino({
      name: `${loggerType}`,
      transport: {
        target: 'pino-pretty',
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
          ignore: 'pid,hostname',
        },
      },
    })
  }
}


const getLoggerDestination = (loggerType: Subsystem) => {
  return `./logs/${loggerType}.log`;
}

export const LogMiddleware = (loggerType: Subsystem): MiddlewareHandler => {

  const logger = getLogger(loggerType);

  return async (c: Context, next: Next, optionalMessage?: object) => {

    const requestId = uuidv4();
    const c_reqId = "requestId" in c.req ? c.req.requestId : requestId;
    c.set('requestId', c_reqId)
    const { method } = c.req;
    const path = getPath(c.req.raw)

    logger.info(
      {
        requestId: c_reqId,
        request: {
          method,
          path,
        },
        query: c.req.query('query') ? c.req.query('query') : c.req.query('prompt'),
      },
      "Incoming request",
    )

    const start = Date.now()

    await next()

    const { status } = c.res;

    if (c.res.ok) {
      logger.info(
        {
          requestId: "requestId" in c.req ? c.req.requestId : c_reqId,
          response: {
            status,
            ok: String(c.res.ok),
          },
        },
        "Request completed",
      )
    } else if (c.res.status >= 400) {
      logger.error(
        {
          requestId: c_reqId,
          response: {
            status,
            err: c.res.body,
          },
        },
        "Request Error",
      )
    } else if (c.res.status === 302) {
      logger.info(
        {
          requestId: c_reqId,
          response: {
            status,
          },
        },
        "Request redirected",
      )
    } else {
      logger.info(
        {
          requestId: c_reqId,
          response: {
            status,
          },
        },
        "Request completed",
      )
    }
  }
}
