import { useEffect, useState } from "react"

// Shared signal so the Topbar (hamburger) and Sidebar (drawer) can coordinate
// without threading state through every route.

let current = false
const listeners = new Set<(next: boolean) => void>()

const set = (next: boolean): void => {
  current = next
  for (const l of listeners) {
    l(next)
  }
}

type Result = {
  open: boolean
  setOpen: (next: boolean) => void
}

export function useSidebarMobile(): Result {
  const [open, setLocal] = useState<boolean>(current)
  useEffect((): (() => void) => {
    listeners.add(setLocal)
    return (): void => {
      listeners.delete(setLocal)
    }
  }, [])
  return { open, setOpen: set }
}
