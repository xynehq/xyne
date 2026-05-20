// Tiny store for the global ⌘K file palette.
//
// Lives outside of React state so any route can pop the palette open without
// being plumbed through props or route context. The shape mirrors
// citation-store: a module-level value, a Set of listeners, and a
// useSyncExternalStore hook for components that need to render against it.

import { useSyncExternalStore } from "react"

type PaletteState = {
  open: boolean
  initialQuery: string
}

let state: PaletteState = { open: false, initialQuery: "" }
const listeners = new Set<() => void>()

const emit = (): void => {
  for (const fn of listeners) {
    fn()
  }
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return (): void => {
    listeners.delete(fn)
  }
}

const getState = (): PaletteState => state

export const useFilePaletteState = (): PaletteState =>
  useSyncExternalStore(subscribe, getState, getState)

export const openFilePalette = (initialQuery = ""): void => {
  state = { open: true, initialQuery }
  emit()
}

export const closeFilePalette = (): void => {
  if (!state.open) {
    return
  }
  state = { open: false, initialQuery: "" }
  emit()
}

export const toggleFilePalette = (): void => {
  if (state.open) {
    closeFilePalette()
  } else {
    openFilePalette()
  }
}
