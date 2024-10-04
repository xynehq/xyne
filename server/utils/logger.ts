import type { additionalMessage, LOGGERTYPES } from '@/types'
import { destination, pino } from 'pino'


export class SearchLogger {
    private logger: pino.Logger | undefined;
    constructor(loggerType: LOGGERTYPES) {
        if (process.env.NODE_ENV === 'production') {

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
                        //TODO :  set destination
                        // destination: {
                        //     dest: '../../logs/mylog.log',
                        //     minLength: 4096, // Buffer before writing
                        //     sync: false
                       // mkdir
                        // }
                    },
                }
            })
        } else {
            // IF ENV IS IN DEVELOPMENT MODE 
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
