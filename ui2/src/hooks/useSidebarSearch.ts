import { useCallback, useEffect, useRef, useState } from "react"

// Manages the sidebar's "find conversations" input — value, ref, and the
// "focus the input now, or expand the sidebar first then focus" behavior used
// by both ⌘K and the collapsed-state search icon.
//
// The 320ms delay matches the sidebar's width transition; we wait for the
// input to be in its expanded position before focusing.
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
      // Will focus once expand animation finishes (see effect below).
      setPendingFocus(true)
      expand()
    } else {
      searchRef.current?.focus()
      searchRef.current?.select()
    }
  }, [collapsed, expand])

  // Drain `pendingFocus` once the sidebar has finished expanding.
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

  // ⌘K / Ctrl+K focuses the search field (expanding the sidebar first if
  // it's collapsed). Universal pattern matching Slack/Linear/GitHub.
  useEffect((): (() => void) => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        focusSearch()
      }
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [focusSearch])

  return { query, setQuery, searchRef, focusSearch }
}
