// App-wide upload store for KB file uploads.
//
// Mirrors v1's `useUploadProgressStore` pattern (Zustand → here we use the
// v2 chat-store style: module-level state + useSyncExternalStore so uploads
// survive route changes without pulling in a new dep). One XHR per file so
// we can report true per-file byte progress via `xhr.upload.onprogress` —
// the fetch API can't expose that event. State outlives unmount so a user
// can navigate away from /kb mid-upload and come back to find the
// placeholder still progressing.

import { useMemo, useSyncExternalStore } from "react"
import { extOf } from "@/lib/files"

export type UploadStatus = "uploading" | "processing" | "completed" | "failed"

export type UploadingFile = {
  clientKey: string
  collectionId: string
  parentId: string | null
  fileName: string
  fileSize: number
  fileFormat: string
  status: UploadStatus
  progress: number
  itemId?: string
  error?: string
}

// ── Internals ───────────────────────────────────────────────────────────────
type Internal = UploadingFile & {
  file: File
  xhr?: XMLHttpRequest
}

type UploadResponseEnvelope = {
  results: Array<
    | { success: true; itemId: string; name: string }
    | { success: false; name: string; error: string }
  >
  summary: { total: number; successful: number; failed: number }
}

const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024
const MAX_CONCURRENT_UPLOADS = 5
let activeUploads = 0
const queuedKeys: string[] = []

const items = new Map<string, Internal>()
const listeners = new Set<() => void>()

let snapshot: UploadingFile[] = []

const recomputeSnapshot = (): void => {
  snapshot = Array.from(items.values()).map(strip)
}

const emit = (): void => {
  recomputeSnapshot()
  listeners.forEach((l) => {
    l()
  })
}

const strip = (e: Internal): UploadingFile => {
  // Drop the live XHR and File from the public projection.
  const { xhr: _xhr, file: _file, ...rest } = e
  return rest
}

const subscribe = (cb: () => void): (() => void) => {
  listeners.add(cb)
  return (): void => {
    listeners.delete(cb)
  }
}

const getSnapshot = (): UploadingFile[] => snapshot

// ── Wire ────────────────────────────────────────────────────────────────────
// Free a slot and kick the next queued upload (if any).
const releaseSlot = (): void => {
  activeUploads = Math.max(0, activeUploads - 1)
  const next = queuedKeys.shift()
  if (next !== undefined) {
    activeUploads += 1
    startXhr(next)
  }
}

// Entry point used by `start()` and `retry()` — runs immediately if under
// the concurrency cap, otherwise queues and lets `releaseSlot` drain it.
const enqueueXhr = (clientKey: string): void => {
  if (activeUploads < MAX_CONCURRENT_UPLOADS) {
    activeUploads += 1
    startXhr(clientKey)
  } else {
    queuedKeys.push(clientKey)
  }
}

const startXhr = (clientKey: string): void => {
  const e = items.get(clientKey)
  if (!e) {
    return
  }
  const xhr = new XMLHttpRequest()
  const fd = new FormData()
  if (e.parentId) {
    fd.set("parentId", e.parentId)
  }
  fd.append("files", e.file, e.file.name)
  xhr.open("POST", `/v2/kb/collections/${e.collectionId}/upload`)
  // Cookie-based auth — same as apiFetch.
  xhr.withCredentials = true

  xhr.upload.onprogress = (ev: ProgressEvent): void => {
    if (!ev.lengthComputable) {
      return
    }
    const cur = items.get(clientKey)
    if (!cur || cur.status !== "uploading") {
      return
    }
    const next = Math.min(100, Math.round((ev.loaded / ev.total) * 100))
    if (next === cur.progress) {
      return
    }
    cur.progress = next
    items.set(clientKey, cur)
    emit()
  }

  xhr.onload = (): void => {
    const cur = items.get(clientKey)
    if (!cur) {
      return
    }
    delete cur.xhr
    if (xhr.status >= 200 && xhr.status < 300) {
      try {
        const json = JSON.parse(xhr.responseText) as UploadResponseEnvelope
        const result = json.results[0]
        if (result?.success) {
          cur.status = "processing"
          cur.itemId = result.itemId
          cur.progress = 100
        } else if (result) {
          cur.status = "failed"
          cur.error = result.error || "Upload failed"
        } else {
          cur.status = "failed"
          cur.error = "Upload returned no result"
        }
      } catch {
        cur.status = "failed"
        cur.error = "Malformed server response"
      }
    } else {
      let msg = `Upload failed (HTTP ${String(xhr.status)})`
      try {
        const json = JSON.parse(xhr.responseText) as {
          message?: string
          error?: string
        }
        msg = json.message ?? json.error ?? msg
      } catch {
        // Non-JSON response (HTML error page, empty body) — keep generic msg.
      }
      cur.status = "failed"
      cur.error = msg
    }
    items.set(clientKey, cur)
    emit()
    releaseSlot()
  }

  xhr.onerror = (): void => {
    const cur = items.get(clientKey)
    if (!cur) {
      releaseSlot()
      return
    }
    delete cur.xhr
    cur.status = "failed"
    cur.error = "Network error"
    items.set(clientKey, cur)
    emit()
    releaseSlot()
  }

  xhr.onabort = (): void => {
    // cancel() already removed the entry; this is defensive cleanup for
    // the case where the abort happens between calls.
    if (items.has(clientKey)) {
      items.delete(clientKey)
      emit()
    }
    releaseSlot()
  }

  e.xhr = xhr
  items.set(clientKey, e)
  xhr.send(fd)
}

// ── Public API ──────────────────────────────────────────────────────────────
const start = (
  collectionId: string,
  parentId: string | null,
  files: ReadonlyArray<File>,
): void => {
  if (files.length === 0) {
    return
  }
  for (const file of files) {
    const clientKey =
      Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 11)
    const ext = extOf(file.name).toLowerCase()
    if (file.size > MAX_FILE_SIZE_BYTES) {
      const failed: Internal = {
        clientKey,
        collectionId,
        parentId,
        fileName: file.name,
        fileSize: file.size,
        fileFormat: ext || "txt",
        status: "failed",
        progress: 0,
        error: `File exceeds ${String(MAX_FILE_SIZE_BYTES / 1024 / 1024)} MB limit`,
        file,
      }
      items.set(clientKey, failed)
      continue
    }
    const entry: Internal = {
      clientKey,
      collectionId,
      parentId,
      fileName: file.name,
      fileSize: file.size,
      fileFormat: ext || "txt",
      status: "uploading",
      progress: 0,
      file,
    }
    items.set(clientKey, entry)
    enqueueXhr(clientKey)
  }
  emit()
}

const cancel = (clientKey: string): void => {
  const e = items.get(clientKey)
  if (!e) {
    return
  }
  const qIdx = queuedKeys.indexOf(clientKey)
  if (qIdx !== -1) {
    queuedKeys.splice(qIdx, 1)
  }
  if (e.xhr) {
    e.xhr.abort()
  }
  items.delete(clientKey)
  emit()
}

const retry = (clientKey: string): void => {
  const e = items.get(clientKey)
  if (!e) {
    return
  }
  e.status = "uploading"
  e.progress = 0
  delete e.error
  delete e.itemId
  delete e.xhr
  items.set(clientKey, e)
  enqueueXhr(clientKey)
  emit()
}

const dismiss = (clientKey: string): void => {
  if (!items.has(clientKey)) {
    return
  }
  items.delete(clientKey)
  emit()
}

/** Called by kb.tsx */
const markSeen = (itemId: string): void => {
  let changed = false
  for (const [k, e] of items.entries()) {
    if (e.itemId !== itemId) {
      continue
    }
    if (e.status === "processing" || e.status === "uploading") {
      items.delete(k)
      changed = true
    }
  }
  if (changed) {
    emit()
  }
}

export const uploadStore = {
  start,
  cancel,
  retry,
  dismiss,
  markSeen,
}

// ── Hooks ───────────────────────────────────────────────────────────────────
/** All in-flight uploads, regardless of collection/folder. */
export const useAllUploads = (): UploadingFile[] =>
  useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

/** Uploads scoped to a specific collection+folder — what kb.tsx renders. */
export const useUploadsFor = (
  collectionId: string | null,
  parentId: string | null,
): UploadingFile[] => {
  const all = useAllUploads()
  return useMemo(
    () =>
      collectionId === null
        ? []
        : all.filter(
            (u) => u.collectionId === collectionId && u.parentId === parentId,
          ),
    [all, collectionId, parentId],
  )
}
