// Shared helpers used by both EntryList and EntryGrid. Anything that
// would otherwise live duplicated at the top of both files belongs here.

import { useLayoutEffect, useRef, useState } from "react"
import { FileCard } from "./FileCard"
import { FolderCard } from "./FolderCard"
import type { BrowserEntry, LeadingRenderer } from "./types"

// Default leading visual: FolderCard for folders, FileCard keyed off
// `entry.format` for files. Used by both the list and grid unless the
// caller overrides via `renderLeading`.
export const defaultLeading: LeadingRenderer = (entry, size) =>
  entry.kind === "folder" ? (
    <FolderCard size={size} />
  ) : (
    <FileCard format={entry.format || "txt"} size={size} />
  )

// Honours the caller's `disableFiles` / `disableFolders` flags. Returning
// true keeps the row visible but suppresses hover affordance and click.
export function isEntryDisabled(
  entry: BrowserEntry,
  disableFiles: boolean,
  disableFolders: boolean,
): boolean {
  return (
    (entry.kind === "file" && disableFiles) ||
    (entry.kind === "folder" && disableFolders)
  )
}

// Tracks where the virtualized list begins inside the caller's scroll
// container. Anything stacked above the list (count text, upload
// placeholders, …) shifts this value, so it's recomputed via a
// ResizeObserver whenever the layout above the list changes. The
// returned ref must be attached to the element whose top is being
// measured (the list / grid body).
export function useScrollMargin(
  scrollParentRef: React.RefObject<HTMLElement | null>,
): {
  listRef: React.RefObject<HTMLDivElement | null>
  scrollMargin: number
} {
  const listRef = useRef<HTMLDivElement>(null)
  const [scrollMargin, setScrollMargin] = useState(0)
  useLayoutEffect((): (() => void) | undefined => {
    const list = listRef.current
    const scroller = scrollParentRef.current
    if (!list || !scroller) {
      return undefined
    }
    const measure = (): void => {
      const lr = list.getBoundingClientRect()
      const sr = scroller.getBoundingClientRect()
      const next = lr.top - sr.top + scroller.scrollTop
      setScrollMargin((prev) => (prev === next ? prev : next))
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(scroller)
    if (list.parentElement) {
      ro.observe(list.parentElement)
    }
    return (): void => {
      ro.disconnect()
    }
  }, [scrollParentRef])
  return { listRef, scrollMargin }
}
