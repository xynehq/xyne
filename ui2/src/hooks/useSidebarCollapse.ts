import { useCallback, useEffect, useState } from "react"

// Persistent sidebar collapse state + ⌘\ / Ctrl+\ shortcut to toggle.
// State is sticky across reloads via localStorage.

const STORAGE_KEY = "ui2.sidebarCollapsed"

function readInitial(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "true"
  } catch {
    return false
  }
}

type Result = {
  collapsed: boolean
  toggle: () => void
}

export function useSidebarCollapse(): Result {
  const [collapsed, setCollapsed] = useState<boolean>(readInitial)

  const toggle = useCallback((): void => {
    setCollapsed((prev): boolean => {
      const next = !prev
      try {
        window.localStorage.setItem(STORAGE_KEY, String(next))
      } catch {
        // ignore
      }
      return next
    })
  }, [])

  useEffect((): (() => void) => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault()
        toggle()
      }
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [toggle])

  return { collapsed, toggle }
}
