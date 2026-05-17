// Workspace-accessible custom agents. The user picks one to bind a chat to a
// curated document scope (a public agent lets the user query docs they don't
// personally own — that's the whole point of the v1 agents feature).
//
// Mirrors `useModels` in shape so the composer's selector code can stay
// symmetric. Selection persists to localStorage so the picker remembers the
// last choice across reloads; null = "no agent, KB-only mode".

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react"
import { getAgents, type AgentInfo } from "./api"

const STORAGE_KEY = "ui2.selectedAgent"

type AgentsContextValue = {
  agents: AgentInfo[]
  loading: boolean
  /** externalId of the active agent, or null for KB-only mode. */
  selected: string | null
  setSelected: (externalId: string | null) => void
}

const readStored = (): string | null => {
  try {
    return window.localStorage.getItem(STORAGE_KEY)
  } catch {
    return null
  }
}

const writeStored = (value: string | null): void => {
  try {
    if (value === null) {
      window.localStorage.removeItem(STORAGE_KEY)
    } else {
      window.localStorage.setItem(STORAGE_KEY, value)
    }
  } catch {
    // localStorage may be unavailable (private mode); ignore.
  }
}

const AgentsContext = createContext<AgentsContextValue | null>(null)

export function AgentsProvider({
  children,
}: {
  children: ReactNode
}): JSX.Element {
  const [agents, setAgents] = useState<AgentInfo[]>([])
  const [loading, setLoading] = useState<boolean>(true)
  const [selected, setSelectedState] = useState<string | null>(() =>
    readStored(),
  )

  useEffect((): (() => void) => {
    let cancelled = false
    const load = async (): Promise<void> => {
      try {
        const { agents: list } = await getAgents()
        if (cancelled) return
        setAgents(list)
        // Drop the persisted selection if the agent no longer exists (deleted
        // or revoked). Don't auto-pick a default — KB-only is a valid mode
        // and we'd rather have the user opt-in than silently change scope.
        setSelectedState((prev) => {
          if (prev && list.some((a) => a.externalId === prev)) return prev
          if (prev) writeStored(null)
          return null
        })
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn("getAgents failed", err)
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void load()
    return () => {
      cancelled = true
    }
  }, [])

  const setSelected = useCallback((externalId: string | null) => {
    setSelectedState(externalId)
    writeStored(externalId)
  }, [])

  const value = useMemo<AgentsContextValue>(
    () => ({ agents, loading, selected, setSelected }),
    [agents, loading, selected, setSelected],
  )

  return (
    <AgentsContext.Provider value={value}>{children}</AgentsContext.Provider>
  )
}

export function useAgents(): AgentsContextValue {
  const ctx = useContext(AgentsContext)
  if (!ctx) {
    throw new Error("useAgents must be used inside <AgentsProvider>")
  }
  return ctx
}
