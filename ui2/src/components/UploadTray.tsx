// Floating upload progress tray. Mounts once under the authenticated
// layout so uploads stay visible while the user navigates between
// collections / chats / settings. The underlying XHRs already outlive
// route changes via uploadStore; this just surfaces them globally.
//
// Renders nothing when no uploads are active. Auto-collapses to a
// compact summary chip; expand for per-file rows. Clicking a file row
// navigates into the collection (+ folder) it's being uploaded to.

import { useMemo, useState } from "react"
import { Link } from "@tanstack/react-router"
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Upload,
  X,
} from "lucide-react"

import { useAllUploads, uploadStore, type UploadingFile } from "@/lib/upload-store"
import { formatBytes } from "@/lib/files"
import { cn } from "@/lib/utils"

const STATUS_RANK: Record<UploadingFile["status"], number> = {
  uploading: 0,
  processing: 1,
  failed: 2,
  completed: 3,
}

export function UploadTray(): JSX.Element | null {
  const all = useAllUploads()
  const [open, setOpen] = useState(true)
  // Manually dismissed = true → user closed the tray for this batch; stays
  // hidden until a brand-new upload arrives. We compare a snapshot of the
  // current clientKey set with what was dismissed; any new key resets.
  const [dismissedKeys, setDismissedKeys] = useState<Set<string>>(new Set())

  // Show every in-flight upload + recently-finished ones so the user has
  // a moment to read the final state. Anything dismissed by the user is
  // filtered out.
  const visible = useMemo(
    () =>
      all
        .filter((u) => !dismissedKeys.has(u.clientKey))
        .sort((a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status]),
    [all, dismissedKeys],
  )

  // Roll-up summary across visible uploads. Bytes are estimated as
  // fileSize * progress/100 for uploading rows; completed/processing
  // rows count their full size. Failed rows don't contribute to the
  // "uploaded" pool but stay in the total so the percentage doesn't
  // jump when one fails late.
  const summary = useMemo(() => {
    let totalBytes = 0
    let uploadedBytes = 0
    let countUploading = 0
    let countProcessing = 0
    let countCompleted = 0
    let countFailed = 0
    for (const u of visible) {
      totalBytes += u.fileSize
      if (u.status === "uploading") {
        uploadedBytes += Math.floor((u.fileSize * u.progress) / 100)
        countUploading++
      } else if (u.status === "processing") {
        uploadedBytes += u.fileSize
        countProcessing++
      } else if (u.status === "completed") {
        uploadedBytes += u.fileSize
        countCompleted++
      } else {
        countFailed++
      }
    }
    const pct =
      totalBytes === 0 ? 0 : Math.min(100, Math.round((uploadedBytes / totalBytes) * 100))
    return {
      totalBytes,
      uploadedBytes,
      pct,
      countUploading,
      countProcessing,
      countCompleted,
      countFailed,
      pending: countUploading + countProcessing,
      done: countCompleted,
    }
  }, [visible])

  if (visible.length === 0) {
    return null
  }

  const headerLabel =
    summary.pending > 0
      ? `Uploading ${String(summary.pending)} file${summary.pending === 1 ? "" : "s"}`
      : summary.countFailed > 0
        ? `${String(summary.countFailed)} upload${summary.countFailed === 1 ? "" : "s"} failed`
        : `${String(summary.done)} upload${summary.done === 1 ? "" : "s"} complete`

  return (
    <div
      role="region"
      aria-label="Upload progress"
      className="fixed bottom-4 right-4 z-40 w-[360px] overflow-hidden rounded-xl border border-border bg-surface-elevated shadow-lg backdrop-blur-md"
    >
      {/* Header — summary line + collapse + dismiss-all */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Upload
          className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
          aria-hidden
          strokeWidth={1.75}
        />
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-[12.5px] font-medium text-foreground">
            {headerLabel}
          </span>
          <span className="truncate text-[11px] text-muted-foreground">
            {formatBytes(summary.uploadedBytes)} of {formatBytes(summary.totalBytes)}
            <span className="px-1.5 text-muted-foreground/60">·</span>
            <span className="tabular-nums">{summary.pct}%</span>
          </span>
        </div>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={open ? "Collapse" : "Expand"}
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          ) : (
            <ChevronUp className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          )}
        </button>
        <button
          type="button"
          onClick={() => {
            setDismissedKeys(new Set(visible.map((u) => u.clientKey)))
          }}
          aria-label="Dismiss"
          title="Dismiss"
          className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
        </button>
      </div>

      {/* Tray-wide progress bar — same bytes/total the header reports. */}
      <div className="h-1 w-full bg-secondary/50">
        <div
          className="h-full bg-primary/70 transition-[width] duration-200"
          style={{ width: `${String(summary.pct)}%` }}
        />
      </div>

      {open && (
        <ul className="max-h-72 overflow-y-auto py-1">
          {visible.map((u) => (
            <li key={u.clientKey}>
              <UploadRow
                file={u}
                onDismiss={(): void => {
                  if (u.status === "uploading") {
                    uploadStore.cancel(u.clientKey)
                  }
                  setDismissedKeys((prev) => {
                    const next = new Set(prev)
                    next.add(u.clientKey)
                    return next
                  })
                }}
                onRetry={(): void => {
                  uploadStore.retry(u.clientKey)
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function UploadRow({
  file,
  onDismiss,
  onRetry,
}: {
  file: UploadingFile
  onDismiss: () => void
  onRetry: () => void
}): JSX.Element {
  const href = `/kb?cl=${encodeURIComponent(file.collectionId)}${file.parentId ? `&parent=${encodeURIComponent(file.parentId)}` : ""}`
  return (
    <div className="group flex items-center gap-2 px-3 py-1.5">
      <StatusIcon status={file.status} />
      <Link
        to={href}
        className="flex min-w-0 flex-1 flex-col text-left transition hover:text-foreground"
        title={file.fileName}
      >
        <span className="truncate text-[12.5px] text-foreground">
          {file.fileName}
        </span>
        <span className="truncate text-[11px] text-muted-foreground">
          {statusCaption(file)}
        </span>
      </Link>
      {file.status === "failed" && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          Retry
        </button>
      )}
      <button
        type="button"
        onClick={onDismiss}
        aria-label={file.status === "uploading" ? "Cancel" : "Dismiss"}
        className={cn(
          "grid h-6 w-6 flex-shrink-0 place-items-center rounded-md text-muted-foreground/0 transition group-hover:text-muted-foreground hover:bg-secondary hover:text-foreground",
          file.status === "failed" && "text-muted-foreground",
        )}
      >
        <X className="h-3 w-3" aria-hidden strokeWidth={2} />
      </button>
    </div>
  )
}

function StatusIcon({ status }: { status: UploadingFile["status"] }): JSX.Element {
  if (status === "uploading" || status === "processing") {
    return (
      <Loader2
        className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-primary"
        aria-hidden
        strokeWidth={1.75}
      />
    )
  }
  if (status === "failed") {
    return (
      <AlertTriangle
        className="h-3.5 w-3.5 flex-shrink-0 text-destructive"
        aria-hidden
        strokeWidth={1.75}
      />
    )
  }
  return (
    <CheckCircle2
      className="h-3.5 w-3.5 flex-shrink-0 text-foreground/60"
      aria-hidden
      strokeWidth={1.75}
    />
  )
}

const statusCaption = (u: UploadingFile): string => {
  if (u.status === "uploading") {
    const uploaded = Math.floor((u.fileSize * u.progress) / 100)
    return `${formatBytes(uploaded)} / ${formatBytes(u.fileSize)} · ${String(u.progress)}%`
  }
  if (u.status === "processing") {
    return `Processing · ${formatBytes(u.fileSize)}`
  }
  if (u.status === "failed") {
    return u.error ?? "Upload failed"
  }
  return `Completed · ${formatBytes(u.fileSize)}`
}
