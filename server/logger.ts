import { LOGGERTYPES, type additionalMessage } from '@/types'
import {pino } from 'pino'


export class ServerLogger {
    private logger;
    constructor(loggerType: LOGGERTYPES) {
        if (process.env.NODE_ENV !== 'production') {
            let destinationPath = getLoggerDestination(loggerType);
            this.logger = pino({
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
                        destination: destinationPath
                    },
                },
            },
            )
        } else {
            //  IF ENV IS IN DEVELOPMENT MODE 
            this.logger = pino({
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
                        include: 'level,time,name',
                    },
                }
            })
        }

    }

    public info = (message: string, optionalMessage?: additionalMessage) => {
        this.logger?.info(optionalMessage, message)
    }

    public error = (message: string, optionalMessage?: additionalMessage) => {
        this.logger?.error(optionalMessage, message)
    }

    public debug = (message: string, optionalMessage?: additionalMessage) => {
        this.logger?.debug(optionalMessage, message)
    }

    public trace = (message: string, optionalMessage?: additionalMessage) => {
        this.logger?.trace(optionalMessage, message)
    }
}


const getLoggerDestination = (loggerType: LOGGERTYPES) => {
    return `./logs/${loggerType}.log`;
}

export const getLogger = (loggerType: LOGGERTYPES,) => {
    return pino({
        name: loggerType,
        transport: {
            target: 'pino-pretty',
            options: {
                colorize: true,
            }
        }
    })
}
