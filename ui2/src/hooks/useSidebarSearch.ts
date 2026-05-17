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
