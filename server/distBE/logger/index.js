import { levels, pino } from "pino";
import { Subsystem } from "../types.js"
import { getPath } from "hono/utils/url";
import { v4 as uuidv4 } from "uuid";
import dotenv from "dotenv"
dotenv.config()
const humanize = (times) => {
    const [delimiter, separator] = [",", "."];
    const orderTimes = times.map((v) => v.replace(/(\d)(?=(\d\d\d)+(?!\d))/g, "$1" + delimiter));
    return orderTimes.join(separator);
};
const time = (start) => {
    const delta = Date.now() - start;
    return humanize([
        delta < 1000 ? delta + "ms" : Math.round(delta / 1000) + "s",
    ]);
};
export const getLogger = (loggerType) => {
    const isProduction = process.env.NODE_ENV === "production";
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
    });
};
const logRequest = (logger, c, requestId, start, status) => {
    const elapsed = time(start);
    const isError = status >= 400;
    const isRedirect = status === 302;
    const logData = {
        requestId,
        status,
        elapsed,
        ...(isError ? { error: c.res.body } : {}),
    };
    if (isError) {
        logger.error(logData, "Request error");
    }
    else if (isRedirect) {
        logger.info(logData, "Request redirected");
    }
    else {
        logger.info(logData, "Request completed");
    }
};
export const LogMiddleware = (loggerType) => {
    const logger = getLogger(loggerType);
    return async (c, next) => {
        const requestId = uuidv4();
        const c_reqId = "requestId" in c.req ? c.req.requestId : requestId;
        c.set("requestId", c_reqId);
        const { method } = c.req;
        const path = getPath(c.req.raw);
        logger.info({
            requestId: c_reqId,
            method,
            path,
            query: c.req.query("query") || c.req.query("prompt") || null,
            message: "Incoming request",
        });
        const start = Date.now();
        await next();
        logRequest(logger, c, c_reqId, start, c.res.status);
    };
};
