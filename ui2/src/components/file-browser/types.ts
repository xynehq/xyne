// Neutral shapes for the file-browser primitives. Any feature (KB, Custom
// Agents, attachments list, …) maps its own data into these so the grid /
// list / cards stay completely feature-agnostic.

import type { ReactNode } from "react"

// Small state hint rendered as a corner dot on each entry. Tone maps to a
// fixed color (pending = yellow, failed = red, ready = green). The label is
// used for the title attribute + screen readers.
export type EntryIndicator = {
  tone: "pending" | "failed" | "ready"
  label: string
}

export type FileEntry = {
  kind: "file"
  id: string
  name: string
  format: string
  caption?: string
  columns?: Readonly<Record<string, string>>
  indicator?: EntryIndicator
}

export type FolderEntry = {
  kind: "folder"
  id: string
  name: string
  caption?: string
  columns?: Readonly<Record<string, string>>
  indicator?: EntryIndicator
}

export type BrowserEntry = FileEntry | FolderEntry

export type ColumnDef = {
  key: string
  header: string
  width?: string
  render?: (entry: BrowserEntry) => ReactNode
  mdOnly?: boolean
}

export type LeadingRenderer = (
  entry: BrowserEntry,
  size: "sm" | "md",
) => ReactNode
