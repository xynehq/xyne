import { useCallback, useEffect, useRef, useState } from "react"

const EXPAND_TRANSITION_MS = 320

type Args = {
  collapsed: boolean
  expand: () => void
}

type Result = {
  query: string
  setQuery: (next: string) => void
  searchRef: React.RefObject<HTMLInputElement | null>
  focusSearch: () => void
}

export function useSidebarSearch({ collapsed, expand }: Args): Result {
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement | null>(null)
  const [pendingFocus, setPendingFocus] = useState(false)

  const focusSearch = useCallback((): void => {
    if (collapsed) {
      setPendingFocus(true)
      expand()
    } else {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [collapsed, expand])

  useEffect((): (() => void) | undefined => {
    if (collapsed || !pendingFocus) return undefined
    const t = window.setTimeout((): void => {
      searchRef.current?.focus()
      searchRef.current?.select()
      setPendingFocus(false)
    }, EXPAND_TRANSITION_MS)
    return (): void => {
      window.clearTimeout(t)
    }
  }, [collapsed, pendingFocus])

  // ⌘K used to focus this sidebar search. That binding moved to the global
  // command palette (see _authenticated.tsx) — sidebar conversation search
  // is still reachable by clicking the input or the collapsed "Search" item.
  // Keeping no global keybinding here so the two never both fire.

  return { query, setQuery, searchRef, focusSearch }
}
