import type {
  PiMonoEvent,
  EventHandler,
  AgentState,
  EventRouterConfig,
  EventHandlerMap,
} from "./types"

export interface ExtendedEventRouterConfig<TState extends AgentState>
  extends EventRouterConfig<TState> {
  emit?: (eventName: string, data: unknown) => void | Promise<void>
}

export function createEventRouter<TState extends AgentState>(
  config: ExtendedEventRouterConfig<TState>,
) {
  const { state, session, handlers, onError, emit } = config

  const defaultEmit = (eventName: string, data: unknown) => {
    console.log(`[EMIT] ${eventName}:`, data)
  }

  const emitFn = emit || defaultEmit

  return {
    start() {
      const unsubscribe = session.subscribe(async (event: PiMonoEvent) => {
        try {
          const context = {
            state,
            session,
            emit: emitFn,
          }

          for (const handler of handlers) {
            const handled = await handler(event, context)
            if (handled) break
          }
        } catch (error) {
          onError?.(error as Error)
        }
      })

      return unsubscribe
    },
  }
}

export function createEventHandler<TState extends AgentState>(
  handlers: EventHandlerMap<TState>,
): EventHandler<TState> {
  return async (event, context) => {
    const handler = handlers[event.type as keyof typeof handlers]
    if (handler) {
      return await (handler as any)(event, context)
    }
    return false
  }
}
