import { useSyncExternalStore } from "react"

export type Preferences = {
  collapseTools: boolean
  hideProjectChatsInRecents: boolean
}

const DEFAULTS: Preferences = {
  // Nest thinking + tool calls + sub-agent dispatches inside the
  // collapsible "Thoughts" chip. Users who want to see every chip
  // inline can flip this off in settings.
  collapseTools: true,
  // Hide conversations that are already filed into a project from the
  // sidebar's Recents list — projects become the primary surface for those
  // chats. Flip off if you want every chat in one stream.
  hideProjectChatsInRecents: true,
}

const STORAGE_KEY = "ui2.preferences.v1"

const load = (): Preferences => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed = JSON.parse(raw) as Partial<Preferences>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

const persist = (next: Preferences): void => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // localStorage full / unavailable — best-effort only.
  }
}

let current: Preferences = load()
const listeners = new Set<() => void>()

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return (): void => {
    listeners.delete(fn)
  }
}

const getSnapshot = (): Preferences => current

export const preferencesStore = {
  get(): Preferences {
    return current
  },
  set(patch: Partial<Preferences>): void {
    const next: Preferences = { ...current, ...patch }
    let dirty = false
    for (const k of Object.keys(patch) as Array<keyof Preferences>) {
      if (current[k] !== next[k]) {
        dirty = true
        break
      }
    }
    if (!dirty) return
    current = next
    persist(current)
    for (const fn of listeners) fn()
  },
}

export function usePreferences(): Preferences {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
