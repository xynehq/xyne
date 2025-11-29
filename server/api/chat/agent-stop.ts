export const STOP_REQUESTED_ERROR = "MESSAGE_AGENTS_STOP_REQUESTED"

export class MessageAgentStopError extends Error {
  constructor(message = "MessageAgents stop requested") {
    super(message)
    this.name = STOP_REQUESTED_ERROR
  }
}

export const isMessageAgentStopError = (
  error: unknown,
): error is MessageAgentStopError => {
  return (
    error instanceof MessageAgentStopError ||
    (error instanceof Error && error.name === STOP_REQUESTED_ERROR)
  )
}

export const throwIfStopRequested = (signal?: AbortSignal) => {
  if (signal?.aborted) {
    throw new MessageAgentStopError()
  }
}

export const raceWithStop = async <T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> => {
  if (!signal) {
    return promise
  }

  if (signal.aborted) {
    throw new MessageAgentStopError()
  }

  return await Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      const onAbort = () => {
        signal.removeEventListener("abort", onAbort)
        reject(new MessageAgentStopError())
      }
      signal.addEventListener("abort", onAbort, { once: true })
    }),
  ])
}
