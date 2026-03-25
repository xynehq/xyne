import type { AgentState, StateManagerConfig } from "./types"

interface SessionEntry<TState> {
  state: TState
  persistFn?: (state: TState) => Promise<void>
}

export function createStateManager<TState extends AgentState>(
  config: StateManagerConfig<TState>,
) {
  const store = new Map<string, SessionEntry<TState>>()
  let activeSessionId: string | null = null

  return {
    register(sessionId: string): TState {
      const entry: SessionEntry<TState> = {
        state: { ...config.initialState },
        persistFn: config.onPersist,
      }
      store.set(sessionId, entry)
      activeSessionId = sessionId
      return entry.state
    },

    get(sessionId?: string): TState {
      const id = sessionId || activeSessionId
      if (!id) throw new Error("No active session")
      const entry = store.get(id)
      if (!entry) throw new Error(`Session not found: ${id}`)
      return entry.state
    },

    async persist(sessionId?: string): Promise<void> {
      const id = sessionId || activeSessionId
      if (!id) return
      const entry = store.get(id)
      if (entry?.persistFn) {
        await entry.persistFn(entry.state)
      }
    },

    unregister(sessionId: string): void {
      store.delete(sessionId)
      if (activeSessionId === sessionId) {
        activeSessionId = null
      }
    },

    getActiveSessionId(): string | null {
      return activeSessionId
    },
  }
}
