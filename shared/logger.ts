import { pino, type Logger } from 'pino'
import type { LOGGERTYPES } from './types'
import * as config from './config'
import type { MiddlewareHandler, Context, Next } from "hono"
import {getPath} from 'hono/utils/url'

const destinationPath = config.default.destinationPath;

export const getLogger = (loggerType: LOGGERTYPES) => {
    if(process.env.NODE_ENV === 'production') {
      return pino({
            name: loggerType,
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
                    customPrettifiers: {}
                },
            },
        },
        )
    }else {
       return pino({
            name: loggerType,
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


const getLoggerDestination = (loggerType: LOGGERTYPES) => {
    return `./${destinationPath}/${loggerType}.log`;
}


export const middlewareLogger = (loggerType: LOGGERTYPES): MiddlewareHandler => {

    const logger = getLogger(loggerType);

    return async (c: Context, next: Next) => {
        const { method } = c.req;
        const path = getPath(c.req.raw)

        logger.info(
            {
              requestId: "requestId" in c.req ? c.req.requestId : undefined,
              request: {
                method,
                path,
              },
            },
            "Incoming request",
          )

          const start = Date.now()

          await next()

          const { status } = c.res;

          if (c.res.ok) {
            logger.info(
                {
                  requestId: "requestId" in c.req ? c.req.requestId : undefined,
                  response: {
                    status,
                    ok: String(c.res.ok),
                  },
                },
                "Request completed",
              )
          } else {
            logger.error(
                {
                  requestId: "requestId" in c.req ? c.req.requestId : undefined,
                  response: {
                    status,
                    err: String(c.res),
                  },
                },
                "Request completed",
              )
          }
    }
}

// function time(start: number): string {
//     const delta = Date.now() - start
  
//     return humanize([delta < 1000 ? delta + "ms" : Math.round(delta / 1000) + "s"])
//   }

//   function humanize(times: string[]): string {
//     const [delimiter, separator] = [",", "."]
//     const orderTimes = times.map((v) => v.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + delimiter))
  
//     return orderTimes.join(separator)
//   }