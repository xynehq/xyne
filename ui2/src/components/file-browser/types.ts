// Neutral shapes for the file-browser primitives. Any feature (KB, Custom
// Agents, attachments list, …) maps its own data into these so the grid /
// list / cards stay completely feature-agnostic.

import type { ReactNode } from "react"

export type FileEntry = {
  kind: "file"
  id: string
  name: string
  // Format string the FileCard interior + banner is keyed off. Pass the file
  // extension in lowercase ("pdf", "xlsx", …) or "code" / "img" / "video"
  // for grouped buckets.
  format: string
  // Subtitle shown under the name in EntryGrid. Pre-formatted by the caller.
  caption?: string
  // Per-column data for EntryList. Keys match ColumnDef.key on the caller side.
  columns?: Readonly<Record<string, string>>
  // Ingestion state surfaced next to the name. Lowercase string matching
  // the server's UploadStatus enum (pending/processing/completed/failed).
  // "completed" renders no indicator — successful ingest is the default.
  status?: string
}

export type FolderEntry = {
  kind: "folder"
  id: string
  name: string
  // Subtitle shown under the name in EntryGrid. Pre-formatted by the caller —
  // this is also where folder count info ("3 folders · 2 files") belongs.
  caption?: string
  // Per-column data for EntryList — keys match ColumnDef.key. Folders may want
  // different values than files (e.g. "Folder" instead of "PDF" under "Kind").
  columns?: Readonly<Record<string, string>>
  // Mirror of FileEntry.status — collections also carry an upload_status
  // (rollup of their items), shown the same way.
  status?: string
}

export type BrowserEntry = FileEntry | FolderEntry

export type ColumnDef = {
  key: string
  header: string
  // CSS width for the column (px, fr, %, anything valid in grid-template-
  // columns). Defaults to "120px"; the leading (primary) column always
  // takes 1fr automatically.
  width?: string
  // Optional cell renderer override. By default the cell reads
  // `entry.columns?.[key]` and renders as muted text.
  render?: (entry: BrowserEntry) => ReactNode
  // If `false`, the column stays visible on every breakpoint. Defaults to
  // hiding on small screens (`md:block`) so dense list views don't overflow
  // on mobile.
  mdOnly?: boolean
}

// Caller-provided renderer for the entry's leading visual (the FileCard /
// FolderCard slot). Receives the entry and the contextual size — EntryGrid
// passes "md", EntryList passes "sm" — so the caller can render
// proportionally without conditional branches per consumer.
export type LeadingRenderer = (
  entry: BrowserEntry,
  size: "sm" | "md",
) => ReactNode
