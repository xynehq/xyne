// Knowledge-base in-memory store.
//
// Holds folders, files, and in-flight uploads with subscription-based change
// notification (useSyncExternalStore). All mutations are local — backend
// wiring lands in a later phase. The mock upload simulator drives every file
// through queued → uploading → parsing → embedding → ready (or failed) so
// the UI can be tested end-to-end without a server.

import { useSyncExternalStore } from "react"
import type {
  BrowserEntry,
  FileEntry,
  FolderEntry,
} from "@/components/file-browser"
import { extOf, formatBytes, formatDate, stripExt } from "@/lib/files"

// ─── Types ──────────────────────────────────────────────────────────────────

export type FileStatus = "pending" | "ready" | "failed"

type StoredFile = {
  id: string
  // Full path including filename ("Reports/Annual Reports/2024.pdf")
  path: string
  sizeBytes: number
  ingestedAt: string
  status: FileStatus
  error?: string
}

type StoredFolder = {
  // Full path ("Reports/Annual Reports") — root folder is never stored
  // explicitly; an empty path means "root" and is implicit.
  path: string
  createdAt: string
}

export type UploadStage =
  | "queued"
  | "uploading"
  | "parsing"
  | "embedding"
  | "ready"
  | "failed"

export type UploadJob = {
  id: string
  // Display name (basename, no folders)
  fileName: string
  // Destination folder path (no trailing slash; "" for root)
  parentPath: string
  // Full path the file will live at
  destinationPath: string
  sizeBytes: number
  stage: UploadStage
  // 0–100 during "uploading", clamped at 100 for later stages
  progress: number
  error?: string
  // Id of the StoredFile that mirrors this job (so we can update status)
  fileId: string
}

// ─── Seed ───────────────────────────────────────────────────────────────────

type RawFile = {
  path: string
  sizeBytes: number
  ingestedAt: string
}

const MOCK_FILES: ReadonlyArray<RawFile> = [
  // SEBI Enforcements
  {
    path: "Enforcements/Recovery Proceedings/2026-02-12_release-order-recovery-certificate-no-rc422-of-2014-against-ahilya-commercial-pv.pdf",
    sizeBytes: 412_318,
    ingestedAt: "2026-02-12",
  },
  {
    path: "Enforcements/Recovery Proceedings/2026-02-12_release-order-recovery-certificate-no-rc737-of-2015-against-ahilya-commercial-pv.pdf",
    sizeBytes: 388_204,
    ingestedAt: "2026-02-12",
  },
  {
    path: "Enforcements/Recovery Proceedings/2025-12-30_completion-of-recovery-certificate-no-rc738-of-2015-against-ahilya-commercial-pv.pdf",
    sizeBytes: 410_990,
    ingestedAt: "2025-12-30",
  },
  {
    path: "Enforcements/Recovery Proceedings/2024-06-27_certificate-no-rc7864-of-2024-notice-of-demand.pdf",
    sizeBytes: 521_233,
    ingestedAt: "2024-06-27",
  },
  {
    path: "Enforcements/Recovery Proceedings/2024-03-20_notice-of-demand-dated-20-03-2024.pdf",
    sizeBytes: 364_122,
    ingestedAt: "2024-03-20",
  },
  {
    path: "Enforcements/Orders/Orders of AA under the RTI Act/2024-09-03_appeal-no-6108-of-2024-virendra-sharma.pdf",
    sizeBytes: 222_440,
    ingestedAt: "2024-09-03",
  },
  {
    path: "Enforcements/Orders/Orders of AA under the RTI Act/2025-12-22_appeal-no-6635-of-2025-madhup-sharma.pdf",
    sizeBytes: 218_330,
    ingestedAt: "2025-12-22",
  },
  {
    path: "Enforcements/Orders/Orders of Chairperson or Members/2024-02-16_order-non-compliance-alt-investment-funds.pdf",
    sizeBytes: 1_205_440,
    ingestedAt: "2024-02-16",
  },
  {
    path: "Enforcements/Unserved Summons or Notices/2024-01-17_unserved-hearing-notice-arjun-sharma.pdf",
    sizeBytes: 188_400,
    ingestedAt: "2024-01-17",
  },

  // Filings
  {
    path: "Filings/Public Issues/Draft Offer Documents filed with SEBI/2025-02-04_prostarm-info-systems-addendum-to-drhp.pdf",
    sizeBytes: 4_120_220,
    ingestedAt: "2025-02-04",
  },
  {
    path: "Filings/Public Issues/Draft Offer Documents filed with SEBI/2026-01-05_HORIZON-INDUSTRIAL-PARKS-DRHP.pdf",
    sizeBytes: 8_843_120,
    ingestedAt: "2026-01-05",
  },

  // Reports
  {
    path: "Reports/Annual Reports/2024-annual-report.pdf",
    sizeBytes: 12_344_200,
    ingestedAt: "2024-09-30",
  },
  {
    path: "Reports/Annual Reports/2025-annual-report.pdf",
    sizeBytes: 13_120_980,
    ingestedAt: "2025-09-30",
  },
  {
    path: "Reports/Annual Reports/2025-annual-financials.xlsx",
    sizeBytes: 1_904_220,
    ingestedAt: "2025-09-30",
  },
  {
    path: "Reports/Quarterly Bulletins/2025-Q4-bulletin.pdf",
    sizeBytes: 2_204_330,
    ingestedAt: "2025-12-15",
  },
  {
    path: "Reports/Investor Decks/2025-investor-presentation.pptx",
    sizeBytes: 8_120_300,
    ingestedAt: "2025-11-10",
  },
  {
    path: "Reports/Datasets/recovery-proceedings-register.csv",
    sizeBytes: 442_100,
    ingestedAt: "2026-03-01",
  },

  // Circulars
  {
    path: "Circulars/2025-11-04_master-circular-mutual-funds.pdf",
    sizeBytes: 980_220,
    ingestedAt: "2025-11-04",
  },
  {
    path: "Circulars/2026-03-18_circular-on-disclosure-requirements.pdf",
    sizeBytes: 712_140,
    ingestedAt: "2026-03-18",
  },
  {
    path: "Circulars/release-notes-2026-Q1.md",
    sizeBytes: 18_320,
    ingestedAt: "2026-04-02",
  },
  {
    path: "Circulars/supporting-data/aif-non-compliance.json",
    sizeBytes: 64_220,
    ingestedAt: "2026-03-15",
  },
]

// ─── Mutable store ──────────────────────────────────────────────────────────

const files = new Map<string, StoredFile>()
const folders = new Map<string, StoredFolder>()
const uploads = new Map<string, UploadJob>()
const listeners = new Set<() => void>()
let rev = 0

const bump = (): void => {
  rev += 1
  for (const fn of listeners) {
    fn()
  }
}

const subscribe = (fn: () => void): (() => void) => {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

const getRev = (): number => rev

const newId = (): string =>
  globalThis.crypto?.randomUUID?.() ??
  `id-${String(Math.random()).slice(2)}-${String(Date.now())}`

// Seed: every starter file ships as `ready`; intermediate folders are derived
// from file paths so the seed stays compact.
const splitParentAndName = (
  fullPath: string,
): { parent: string; name: string } => {
  const slash = fullPath.lastIndexOf("/")
  if (slash < 0) {
    return { parent: "", name: fullPath }
  }
  return { parent: fullPath.slice(0, slash), name: fullPath.slice(slash + 1) }
}

const ensureFolderChain = (folderPath: string): void => {
  if (folderPath === "") {
    return
  }
  const segs = folderPath.split("/")
  for (let i = 0; i < segs.length; i += 1) {
    const here = segs.slice(0, i + 1).join("/")
    if (!folders.has(here)) {
      folders.set(here, { path: here, createdAt: new Date().toISOString() })
    }
  }
}

const seed = (): void => {
  for (const raw of MOCK_FILES) {
    const { parent } = splitParentAndName(raw.path)
    ensureFolderChain(parent)
    const id = newId()
    files.set(id, {
      id,
      path: raw.path,
      sizeBytes: raw.sizeBytes,
      ingestedAt: raw.ingestedAt,
      status: "ready",
    })
  }
}
seed()

// ─── Lookup helpers ─────────────────────────────────────────────────────────

const parentOfFolder = (folderPath: string): string => {
  const slash = folderPath.lastIndexOf("/")
  return slash < 0 ? "" : folderPath.slice(0, slash)
}

const childFolders = (folderPath: string): StoredFolder[] => {
  const out: StoredFolder[] = []
  for (const f of folders.values()) {
    if (parentOfFolder(f.path) === folderPath) {
      out.push(f)
    }
  }
  return out
}

const filesInFolder = (folderPath: string): StoredFile[] => {
  const out: StoredFile[] = []
  for (const f of files.values()) {
    const parent = splitParentAndName(f.path).parent
    if (parent === folderPath) {
      out.push(f)
    }
  }
  return out
}

const folderCounts = (
  folderPath: string,
): { folderCount: number; fileCount: number } => {
  let folderCount = 0
  let fileCount = 0
  for (const f of folders.values()) {
    if (parentOfFolder(f.path) === folderPath) {
      folderCount += 1
    }
  }
  for (const f of files.values()) {
    if (splitParentAndName(f.path).parent === folderPath) {
      fileCount += 1
    }
  }
  return { folderCount, fileCount }
}

// ─── Entry projection ───────────────────────────────────────────────────────

const folderToEntry = (f: StoredFolder): FolderEntry => {
  const { folderCount, fileCount } = folderCounts(f.path)
  const total = folderCount + fileCount
  const parts: string[] = []
  if (folderCount > 0) {
    parts.push(`${String(folderCount)} folder${folderCount === 1 ? "" : "s"}`)
  }
  if (fileCount > 0) {
    parts.push(`${String(fileCount)} file${fileCount === 1 ? "" : "s"}`)
  }
  const caption = parts.length === 0 ? "Empty" : parts.join(" · ")
  const { name } = splitParentAndName(f.path)
  return {
    kind: "folder",
    id: f.path,
    name,
    caption,
    columns: {
      kind: "Folder",
      size:
        total === 0
          ? "Empty"
          : `${String(total)} item${total === 1 ? "" : "s"}`,
      updated: formatDate(f.createdAt),
    },
  }
}

const fileToEntry = (f: StoredFile): FileEntry => {
  const name = stripExt(splitParentAndName(f.path).name)
  const ext = extOf(f.path)
  const entry: FileEntry = {
    kind: "file",
    id: f.id,
    name,
    format: ext || "txt",
    caption: `${ext.toUpperCase() || "FILE"} · ${formatBytes(f.sizeBytes)} · ${formatDate(f.ingestedAt)}`,
    columns: {
      kind: ext.toUpperCase() || "File",
      size: formatBytes(f.sizeBytes),
      updated: formatDate(f.ingestedAt),
    },
  }
  if (f.status === "pending") {
    entry.indicator = { tone: "pending", label: "Indexing…" }
  } else if (f.status === "failed") {
    entry.indicator = {
      tone: "failed",
      label: f.error ?? "Ingestion failed",
    }
  }
  return entry
}

// ─── Read API ───────────────────────────────────────────────────────────────

export const listEntries = (
  folderPath: string,
): ReadonlyArray<BrowserEntry> => {
  const folderEntries = childFolders(folderPath)
    .slice()
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(folderToEntry)
  const fileEntries = filesInFolder(folderPath)
    .slice()
    .sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt))
    .map(fileToEntry)
  return [...folderEntries, ...fileEntries]
}

export const searchFiles = (
  folderPath: string,
  query: string,
  limit = 50,
): ReadonlyArray<BrowserEntry> => {
  const q = query.trim().toLowerCase()
  if (!q) {
    return []
  }
  const scope = folderPath === "" ? "" : `${folderPath}/`
  const hits: FileEntry[] = []
  for (const f of files.values()) {
    if (scope !== "" && !f.path.startsWith(scope)) {
      continue
    }
    if (f.path.toLowerCase().includes(q)) {
      hits.push(fileToEntry(f))
      if (hits.length >= limit) {
        break
      }
    }
  }
  return hits
}

export const listUploads = (): ReadonlyArray<UploadJob> => {
  // Newest first — feels right for a tray.
  return Array.from(uploads.values()).sort((a, b) =>
    b.id.localeCompare(a.id),
  )
}

// ─── Write API ──────────────────────────────────────────────────────────────

const uniqueFolderName = (parent: string, base: string): string => {
  const taken = new Set<string>()
  for (const f of folders.values()) {
    if (parentOfFolder(f.path) === parent) {
      taken.add(splitParentAndName(f.path).name)
    }
  }
  if (!taken.has(base)) {
    return base
  }
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${String(i)})`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
  return `${base} (${String(Date.now())})`
}

const uniqueFileName = (parent: string, base: string): string => {
  const taken = new Set<string>()
  for (const f of files.values()) {
    if (splitParentAndName(f.path).parent === parent) {
      taken.add(splitParentAndName(f.path).name)
    }
  }
  if (!taken.has(base)) {
    return base
  }
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  const ext = dot > 0 ? base.slice(dot) : ""
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${stem} (${String(i)})${ext}`
    if (!taken.has(candidate)) {
      return candidate
    }
  }
  return `${stem} (${String(Date.now())})${ext}`
}

export const createFolder = (parent: string, rawName: string): string => {
  const trimmed = rawName.trim() || "Untitled folder"
  const name = uniqueFolderName(parent, trimmed)
  const path = parent === "" ? name : `${parent}/${name}`
  folders.set(path, { path, createdAt: new Date().toISOString() })
  bump()
  return path
}

// File the user dropped or picked. The optional relativePath preserves
// subfolder structure when a directory was selected.
export type IncomingFile = {
  file: File
  // "subdir/file.pdf" or just "file.pdf"
  relativePath: string
}

const startMockProgression = (jobId: string): void => {
  // Phase 1: uploading 0 → 100 over ~1.4s. Phase 2: parsing. Phase 3:
  // embedding. Phase 4: ready or failed. All driven by setTimeout chains so
  // we don't need real network code for the demo.
  const tickMs = 120
  const stepMs = 700
  const upTick = (): void => {
    const j = uploads.get(jobId)
    if (!j || j.stage !== "uploading") {
      return
    }
    const next = Math.min(100, j.progress + 8 + Math.random() * 14)
    j.progress = next
    bump()
    if (next < 100) {
      setTimeout(upTick, tickMs)
    } else {
      j.stage = "parsing"
      bump()
      setTimeout(toEmbedding, stepMs)
    }
  }
  const toEmbedding = (): void => {
    const j = uploads.get(jobId)
    if (!j || j.stage !== "parsing") {
      return
    }
    j.stage = "embedding"
    bump()
    setTimeout(toReady, stepMs)
  }
  const toReady = (): void => {
    const j = uploads.get(jobId)
    if (!j || j.stage !== "embedding") {
      return
    }
    // Deterministic failure hook for demos: any filename containing "fail"
    // (case-insensitive) ends in the failed state. Everything else succeeds.
    const wantsFail = j.fileName.toLowerCase().includes("fail")
    const stored = files.get(j.fileId)
    if (wantsFail) {
      j.stage = "failed"
      j.error = "Unsupported format"
      if (stored) {
        stored.status = "failed"
        stored.error = "Unsupported format"
      }
    } else {
      j.stage = "ready"
      if (stored) {
        stored.status = "ready"
      }
    }
    bump()
    // Auto-dismiss successful uploads after a brief moment so the tray stays
    // lean — failed ones persist until the user dismisses them.
    if (j.stage === "ready") {
      setTimeout((): void => {
        uploads.delete(jobId)
        bump()
      }, 2500)
    }
  }
  setTimeout(upTick, tickMs)
}

export const enqueueUploads = (
  parentPath: string,
  incoming: ReadonlyArray<IncomingFile>,
): ReadonlyArray<string> => {
  const jobIds: string[] = []
  for (const item of incoming) {
    const { relativePath, file } = item
    const segs = relativePath.split("/").filter(Boolean)
    if (segs.length === 0) {
      continue
    }
    const baseName = segs[segs.length - 1] as string
    const subParent = segs.slice(0, -1).join("/")
    const destParent = [parentPath, subParent].filter(Boolean).join("/")
    ensureFolderChain(destParent)
    const uniqueName = uniqueFileName(destParent, baseName)
    const destPath =
      destParent === "" ? uniqueName : `${destParent}/${uniqueName}`
    const fileId = newId()
    files.set(fileId, {
      id: fileId,
      path: destPath,
      sizeBytes: file.size,
      ingestedAt: new Date().toISOString(),
      status: "pending",
    })
    const jobId = newId()
    uploads.set(jobId, {
      id: jobId,
      fileName: uniqueName,
      parentPath: destParent,
      destinationPath: destPath,
      sizeBytes: file.size,
      stage: "uploading",
      progress: 0,
      fileId,
    })
    jobIds.push(jobId)
    startMockProgression(jobId)
  }
  bump()
  return jobIds
}

export const cancelUpload = (jobId: string): void => {
  const j = uploads.get(jobId)
  if (!j) {
    return
  }
  // Cancel during in-flight stages removes both the job and the staged file.
  // Cancel on a terminal stage just dismisses the tray entry.
  if (j.stage === "uploading" || j.stage === "parsing" || j.stage === "embedding") {
    files.delete(j.fileId)
  }
  uploads.delete(jobId)
  bump()
}

// ─── React hooks ────────────────────────────────────────────────────────────

// useSyncExternalStore gates re-renders to revisions of the store; the
// projection (listEntries / searchFiles / listUploads) is fast enough to
// just recompute each time the gated render fires.
export const useKbEntries = (
  folderPath: string,
): ReadonlyArray<BrowserEntry> => {
  useSyncExternalStore(subscribe, getRev, getRev)
  return listEntries(folderPath)
}

export const useKbSearch = (
  folderPath: string,
  query: string,
): ReadonlyArray<BrowserEntry> => {
  useSyncExternalStore(subscribe, getRev, getRev)
  return searchFiles(folderPath, query)
}

export const useKbUploads = (): ReadonlyArray<UploadJob> => {
  useSyncExternalStore(subscribe, getRev, getRev)
  return listUploads()
}
