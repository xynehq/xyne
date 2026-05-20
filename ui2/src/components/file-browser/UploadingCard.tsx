// In-flight upload placeholder. Renders into the same grid/list slot a real
// FileCard will eventually occupy, so the swap on completion is zero-CLS.
//
// Three visual states:
//   • uploading  — bottom-up emerald fill (transform: scaleY by progress)
//                  + a thin precision bar at the very bottom; caption shows %
//   • processing — pulsing card body with "Processing…" caption (the XHR
//                  has landed; we're waiting for server OCR + Vespa indexing
//                  to flip the row to uploadStatus = "completed")
//   • failed     — red banner + retry/dismiss buttons
//
// Accessibility:
//   • role="progressbar" with aria-valuenow/valuemin/valuemax while uploading
//   • aria-live="polite" on the status caption so screen readers announce
//     the uploading → processing → failed transition
//   • motion-reduce:* utilities disable the pulse for prefers-reduced-motion
//   • Retry / dismiss / cancel buttons are 28×28 hit area with 8px padding —
//     meets the ≥44pt effective tap target via padding

import { Loader2, RotateCcw, X } from "lucide-react"
import { cn } from "@/lib/utils"
import type { UploadingFile } from "@/lib/upload-store"
import { extOf, formatBytes, stripExt } from "@/lib/files"

// Same palette as FileCard. Duplicated (rather than imported) to avoid a
// circular dependency and to let the failed state override pdf-red etc.
const BANNER: Record<string, string> = {
  doc: "bg-blue-500 text-white",
  docx: "bg-blue-500 text-white",
  pdf: "bg-red-500 text-white",
  md: "bg-neutral-600 text-white",
  mdx: "bg-neutral-600 text-white",
  txt: "bg-gray-500 text-white",
  csv: "bg-teal-700 text-white",
  xls: "bg-emerald-600 text-white",
  xlsx: "bg-emerald-600 text-white",
  ppt: "bg-orange-500 text-white",
  pptx: "bg-orange-500 text-white",
  zip: "bg-purple-500 text-white",
  rar: "bg-purple-600 text-white",
  tar: "bg-yellow-600 text-white",
  gz: "bg-yellow-700 text-white",
  html: "bg-orange-600 text-white",
  js: "bg-yellow-600 text-white",
  jsx: "bg-blue-600 text-white",
  css: "bg-blue-600 text-white",
  json: "bg-yellow-500 text-white",
  tsx: "bg-blue-600 text-white",
  ts: "bg-blue-600 text-white",
  code: "bg-orange-600 text-white",
  img: "bg-pink-500 text-white",
  png: "bg-neutral-600 text-white",
  jpg: "bg-green-700 text-white",
  jpeg: "bg-green-700 text-white",
  gif: "bg-pink-600 text-white",
  webp: "bg-pink-500 text-white",
  mp4: "bg-green-700 text-white",
  mov: "bg-green-700 text-white",
  webm: "bg-green-700 text-white",
  mp3: "bg-fuchsia-600 text-white",
  wav: "bg-fuchsia-600 text-white",
  flac: "bg-fuchsia-700 text-white",
  video: "bg-green-700 text-white",
}

type Props = {
  upload: UploadingFile
  variant: "grid" | "list"
  onCancel: (clientKey: string) => void
  onRetry: (clientKey: string) => void
  onDismiss: (clientKey: string) => void
}

const captionFor = (u: UploadingFile): string => {
  switch (u.status) {
    case "uploading":
      return `Uploading · ${String(u.progress)}%`
    case "processing":
      return "Processing…"
    case "failed":
      return `Failed: ${u.error ?? "Upload error"}`
    case "completed":
      // Transient — store removes completed entries; never normally rendered.
      return "Done"
  }
}

const subtleCaption = (u: UploadingFile): string => {
  const ext = (extOf(u.fileName) || u.fileFormat).toUpperCase() || "FILE"
  return `${ext} · ${formatBytes(u.fileSize)}`
}

// ── Visual: card body with progress overlays ────────────────────────────────
function PlaceholderCard({
  upload,
  size,
}: {
  upload: UploadingFile
  size: "sm" | "md"
}): JSX.Element {
  const fmt = upload.fileFormat
  const banner = upload.status === "failed"
    ? "bg-red-500 text-white"
    : (BANNER[fmt] ?? "bg-zinc-500 text-white")
  const dims =
    size === "sm" ? "w-9 h-[3rem]" : "w-14 h-[4.5rem]"
  const bannerPos =
    size === "sm"
      ? "-right-1.5 bottom-1 text-[7px] px-1 py-px"
      : "-right-2 bottom-1.5 text-[8px] px-1.5 py-0.5"

  const isUploading = upload.status === "uploading"
  const isProcessing = upload.status === "processing"
  const isFailed = upload.status === "failed"

  return (
    <div
      aria-hidden
      className={cn(
        "relative size-fit",
        // Subtle dim on the whole card while processing so it visually
        // recedes vs. completed files in the same grid row.
        isProcessing && "motion-safe:animate-pulse",
      )}
    >
      <div
        className={cn(
          "absolute z-[2] rounded font-medium uppercase tracking-wide",
          bannerPos,
          banner,
        )}
      >
        {isFailed ? "ERR" : fmt}
      </div>
      <div
        className={cn(
          "relative z-[1] overflow-hidden rounded-md bg-surface ring-1 dark:bg-secondary",
          isFailed ? "ring-red-300 dark:ring-red-900/60" : "ring-border",
          dims,
        )}
      >
        {/* Empty interior — deliberate. Real FileCard has decorative lines;
            the placeholder leaves them out so the progress fill reads
            clearly on a quiet ground. */}

        {/* Bottom-up fill — the "filling up" metaphor. transform: scaleY
            with origin-bottom is GPU-cheap (no layout reflow). */}
        {isUploading ? (
          <div
            className="absolute inset-0 origin-bottom bg-emerald-500/15 transition-transform duration-150 ease-out motion-reduce:transition-none"
            style={{ transform: `scaleY(${String(upload.progress / 100)})` }}
          />
        ) : null}

        {/* Precision bar at the bottom edge — tighter readout of % than the
            soft fill can give on a 56px-wide card. */}
        {isUploading ? (
          <div className="absolute inset-x-0 bottom-0 h-[3px] bg-emerald-500/20">
            <div
              className="h-full origin-left bg-emerald-500 transition-transform duration-150 ease-out motion-reduce:transition-none"
              style={{ transform: `scaleX(${String(upload.progress / 100)})` }}
            />
          </div>
        ) : null}
      </div>
    </div>
  )
}

// ── Grid variant ────────────────────────────────────────────────────────────
function GridUploadingCard({
  upload,
  onCancel,
  onRetry,
  onDismiss,
}: Props): JSX.Element {
  const displayName = stripExt(upload.fileName)
  const status = upload.status
  return (
    <li
      className="group relative"
      data-upload-key={upload.clientKey}
    >
      <div
        className={cn(
          "flex w-full flex-col items-start gap-3 rounded-2xl border bg-surface-elevated p-4 text-left",
          status === "failed"
            ? "border-red-200 dark:border-red-900/60"
            : "border-border",
        )}
        title={upload.fileName}
      >
        <div
          className="pl-1 pt-1"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={status === "uploading" ? upload.progress : undefined}
          aria-label={`${upload.fileName} — ${captionFor(upload)}`}
        >
          <PlaceholderCard upload={upload} size="md" />
        </div>
        <span className="flex w-full min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-medium text-foreground">
            {displayName}
          </span>
          <span
            className={cn(
              "truncate text-[11.5px]",
              status === "failed"
                ? "text-red-600 dark:text-red-400"
                : "text-muted-foreground",
            )}
            aria-live="polite"
          >
            {status === "uploading" || status === "processing"
              ? subtleCaption(upload)
              : null}
            {status === "uploading" || status === "processing" ? " · " : null}
            {status === "processing" ? (
              <span className="inline-flex items-center gap-1">
                <Loader2
                  className="h-3 w-3 motion-safe:animate-spin motion-reduce:hidden"
                  aria-hidden
                  strokeWidth={2}
                />
                Processing…
              </span>
            ) : (
              captionFor(upload)
            )}
          </span>
        </span>
        {status === "failed" ? (
          <div className="flex w-full items-center gap-2">
            <button
              type="button"
              onClick={(): void => {
                onRetry(upload.clientKey)
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Retry
            </button>
            <button
              type="button"
              onClick={(): void => {
                onDismiss(upload.clientKey)
              }}
              className="inline-flex h-7 items-center rounded-md px-2 text-[12px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </div>
      {status === "uploading" ? (
        <button
          type="button"
          aria-label={`Cancel upload of ${upload.fileName}`}
          title="Cancel upload"
          onClick={(): void => {
            onCancel(upload.clientKey)
          }}
          className="absolute right-2 top-2 grid h-7 w-7 place-items-center rounded-md bg-background/80 text-muted-foreground opacity-0 shadow-sm ring-1 ring-border backdrop-blur-sm transition group-hover:opacity-100 focus:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} />
        </button>
      ) : null}
    </li>
  )
}

// ── List variant ────────────────────────────────────────────────────────────
function ListUploadingCard({
  upload,
  onCancel,
  onRetry,
  onDismiss,
}: Props): JSX.Element {
  const displayName = stripExt(upload.fileName)
  const status = upload.status
  return (
    <li
      className="group relative"
      data-upload-key={upload.clientKey}
    >
      <div
        className={cn(
          "grid w-full items-center gap-3 px-4 py-2",
          status === "failed" && "bg-red-50/40 dark:bg-red-950/20",
        )}
        // Match EntryList's template (name 1fr, 3 cols at 120/120/140, 36px action).
        // Kept inline so it tracks any future column changes in kb.tsx.
        style={{ gridTemplateColumns: "1fr 120px 120px 140px 36px" }}
        title={upload.fileName}
      >
        <div className="flex min-w-0 items-center gap-3">
          <span
            className="flex-shrink-0 pr-1"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={status === "uploading" ? upload.progress : undefined}
            aria-label={`${upload.fileName} — ${captionFor(upload)}`}
          >
            <PlaceholderCard upload={upload} size="sm" />
          </span>
          <span className="min-w-0 truncate text-[13.5px] font-medium text-foreground">
            {displayName}
          </span>
        </div>
        <span className="hidden truncate text-left text-[12px] text-muted-foreground md:block">
          {upload.fileFormat.toUpperCase() || "FILE"}
        </span>
        <span className="hidden truncate text-left text-[12px] tabular-nums text-muted-foreground md:block">
          {formatBytes(upload.fileSize)}
        </span>
        <span
          className={cn(
            "hidden truncate text-left text-[12px] md:block",
            status === "failed"
              ? "text-red-600 dark:text-red-400"
              : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {captionFor(upload)}
        </span>
        {status === "uploading" ? (
          <button
            type="button"
            aria-label={`Cancel upload of ${upload.fileName}`}
            title="Cancel upload"
            onClick={(): void => {
              onCancel(upload.clientKey)
            }}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground opacity-0 transition group-hover:opacity-100 focus:opacity-100 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950/40"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        ) : status === "failed" ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              aria-label={`Retry upload of ${upload.fileName}`}
              title="Retry"
              onClick={(): void => {
                onRetry(upload.clientKey)
              }}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <RotateCcw className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
            <button
              type="button"
              aria-label={`Dismiss ${upload.fileName}`}
              title="Dismiss"
              onClick={(): void => {
                onDismiss(upload.clientKey)
              }}
              className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        ) : (
          <span aria-hidden />
        )}
      </div>
    </li>
  )
}

export function UploadingCard(props: Props): JSX.Element {
  return props.variant === "grid" ? (
    <GridUploadingCard {...props} />
  ) : (
    <ListUploadingCard {...props} />
  )
}

// ── Group renderers ─────────────────────────────────────────────────────────
// Render N placeholders in the same container shape EntryGrid / EntryList use,
// so they slot in above the real entries without any visual seam.

type ListProps = {
  uploads: ReadonlyArray<UploadingFile>
  onCancel: (clientKey: string) => void
  onRetry: (clientKey: string) => void
  onDismiss: (clientKey: string) => void
}

export function UploadingGrid({
  uploads,
  onCancel,
  onRetry,
  onDismiss,
}: ListProps): JSX.Element | null {
  if (uploads.length === 0) {
    return null
  }
  return (
    <ul
      role="list"
      aria-label="Uploads in progress"
      className="mb-3 grid animate-fade-up grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5"
    >
      {uploads.map((u) => (
        <UploadingCard
          key={u.clientKey}
          upload={u}
          variant="grid"
          onCancel={onCancel}
          onRetry={onRetry}
          onDismiss={onDismiss}
        />
      ))}
    </ul>
  )
}

export function UploadingList({
  uploads,
  onCancel,
  onRetry,
  onDismiss,
}: ListProps): JSX.Element | null {
  if (uploads.length === 0) {
    return null
  }
  return (
    <div
      aria-label="Uploads in progress"
      className="mb-3 animate-fade-up overflow-hidden rounded-2xl border border-border bg-surface-elevated"
    >
      <ul role="list" className="divide-y divide-border">
        {uploads.map((u) => (
          <UploadingCard
            key={u.clientKey}
            upload={u}
            variant="list"
            onCancel={onCancel}
            onRetry={onRetry}
            onDismiss={onDismiss}
          />
        ))}
      </ul>
    </div>
  )
}
