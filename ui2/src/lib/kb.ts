// Knowledge-base data layer. Calls backendv2 (/v2/kb/*) and maps server rows
// onto the neutral BrowserEntry shape that the file-browser primitives in
// components/file-browser expect.

import type { BrowserEntry, FileEntry, FolderEntry } from "@/components/file-browser"
import { apiFetch } from "@/lib/api"
import { extOf, formatBytes, formatDate, stripExt } from "@/lib/files"

export type CollectionRow = {
  id: string
  name: string
  description: string | null
  totalItems: number
  uploadStatus: string
  isPrivate: boolean
  createdAt: string
  updatedAt: string
}

export type ItemRow = {
  id: string
  name: string
  type: "folder" | "file"
  parentId: string | null
  path: string
  mimeType: string | null
  fileSize: number | null
  uploadStatus: string
  updatedAt: string
  createdAt: string
}

type ListItemsResponse = { items: ItemRow[] }
type ListCollectionsResponse = { collections: CollectionRow[] }
type BreadcrumbResponse = { chain: { id: string; name: string }[] }
type UploadResponse = {
  results: Array<
    | { success: true; itemId: string; name: string }
    | { success: false; name: string; error: string }
  >
  summary: { total: number; successful: number; failed: number }
}

// ── Collections ────────────────────────────────────────────────────────────

export const listCollections = async (): Promise<CollectionRow[]> => {
  const res = await apiFetch<ListCollectionsResponse>("/v2/kb/collections")
  return res.collections
}

export const createCollection = async (
  name: string,
  description?: string,
): Promise<CollectionRow> =>
  apiFetch<CollectionRow>("/v2/kb/collections", {
    method: "POST",
    body: JSON.stringify({ name, ...(description ? { description } : {}) }),
  })

export const deleteCollection = async (clId: string): Promise<void> => {
  await apiFetch<{ ok: true }>(`/v2/kb/collections/${clId}`, {
    method: "DELETE",
  })
}

// Render a collection as a "folder" in the root view so the EntryGrid / List
// primitives can render it without special-casing.
export const collectionToFolderEntry = (c: CollectionRow): FolderEntry => {
  const total = c.totalItems
  return {
    kind: "folder",
    id: c.id,
    name: c.name,
    caption:
      total === 0
        ? "Empty collection"
        : `${String(total)} item${total === 1 ? "" : "s"}`,
    columns: {
      kind: "Collection",
      size: total === 0 ? "Empty" : `${String(total)} item${total === 1 ? "" : "s"}`,
      updated: formatDate(c.updatedAt),
    },
  }
}

// ── Items ──────────────────────────────────────────────────────────────────

export const listItems = async (
  clId: string,
  parentId: string | null,
): Promise<ItemRow[]> => {
  const qs = parentId ? `?parentId=${encodeURIComponent(parentId)}` : ""
  const res = await apiFetch<ListItemsResponse>(
    `/v2/kb/collections/${clId}/items${qs}`,
  )
  return res.items
}

export const createFolder = async (
  clId: string,
  name: string,
  parentId: string | null,
): Promise<ItemRow> =>
  apiFetch<ItemRow>(`/v2/kb/collections/${clId}/folders`, {
    method: "POST",
    body: JSON.stringify({ name, parentId }),
  })

export const deleteItem = async (
  clId: string,
  itemId: string,
): Promise<void> => {
  await apiFetch<{ ok: true }>(
    `/v2/kb/collections/${clId}/items/${itemId}`,
    { method: "DELETE" },
  )
}

export const uploadFiles = async (
  clId: string,
  files: ReadonlyArray<File>,
  parentId: string | null,
): Promise<UploadResponse> => {
  const fd = new FormData()
  if (parentId) {
    fd.set("parentId", parentId)
  }
  for (const f of files) {
    fd.append("files", f, f.name)
  }
  return apiFetch<UploadResponse>(`/v2/kb/collections/${clId}/upload`, {
    method: "POST",
    body: fd,
  })
}

export const getBreadcrumb = async (
  clId: string,
  itemId: string,
): Promise<{ id: string; name: string }[]> => {
  const res = await apiFetch<BreadcrumbResponse>(
    `/v2/kb/collections/${clId}/items/${itemId}/breadcrumb`,
  )
  return res.chain
}

export const fileContentUrl = (clId: string, itemId: string): string =>
  `/v2/kb/collections/${clId}/files/${itemId}/content`

// ── Citation resolution ────────────────────────────────────────────────────

export type CitationTarget = {
  docId: string
  itemId: string
  collectionId: string
  name: string
  chunkIndex: number | null
  pageNumber: number | null
  /** Short representative phrase from the cited chunk. The viewer feeds
   *  this into pdf.js's findController so the passage is highlighted in
   *  the text layer when the panel opens. */
  chunkText: string | null
}

/** Resolve a `[docId#chunk]` citation token emitted by pi-mono into the
 *  metadata needed to open the source file in the slide-over viewer. */
export const resolveCitation = (
  docId: string,
  chunkIndex: number | null,
): Promise<CitationTarget> => {
  const qs = chunkIndex !== null ? `?chunk=${String(chunkIndex)}` : ""
  return apiFetch<CitationTarget>(
    `/v2/kb/files/resolve/${encodeURIComponent(docId)}${qs}`,
  )
}

// ── Row → BrowserEntry mapping ─────────────────────────────────────────────

export const itemToEntry = (item: ItemRow): BrowserEntry => {
  if (item.type === "folder") {
    const f: FolderEntry = {
      kind: "folder",
      id: item.id,
      name: item.name,
      caption: formatDate(item.updatedAt),
      columns: {
        kind: "Folder",
        size: "—",
        updated: formatDate(item.updatedAt),
      },
    }
    return f
  }
  const ext = extOf(item.name)
  const size = item.fileSize ?? 0
  const fe: FileEntry = {
    kind: "file",
    id: item.id,
    name: stripExt(item.name),
    format: ext || "txt",
    caption: `${ext.toUpperCase() || "FILE"} · ${formatBytes(size)} · ${formatDate(item.updatedAt)}`,
    columns: {
      kind: ext.toUpperCase() || "File",
      size: formatBytes(size),
      updated: formatDate(item.updatedAt),
    },
  }
  return fe
}
