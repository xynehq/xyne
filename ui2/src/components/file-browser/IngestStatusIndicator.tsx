// Small dot + label shown next to a file name to surface its ingestion
// state. Renders nothing for "completed" — successfully-ingested docs
// are the default and don't need decoration.

import { AlertTriangle, Loader2 } from "lucide-react"

export type IngestStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | string

type Props = {
  // `undefined` is included explicitly so callers can do
  // `status={entry.status}` under exactOptionalPropertyTypes — the
  // field is optional on FileEntry/FolderEntry and surfaces here.
  status?: string | null | undefined
  // "dot" — bare colored dot, fits inside dense rows.
  // "pill" — dot + short label, for grid cards / search results.
  variant?: "dot" | "pill"
}

const STATUS_META: Record<
  IngestStatus,
  { label: string; dot: string; text: string; bg: string }
> = {
  pending: {
    label: "Queued",
    dot: "bg-amber-500",
    text: "text-amber-700 dark:text-amber-300",
    bg: "bg-amber-100/60 dark:bg-amber-500/15",
  },
  processing: {
    label: "Ingesting",
    dot: "bg-sky-500",
    text: "text-sky-700 dark:text-sky-300",
    bg: "bg-sky-100/60 dark:bg-sky-500/15",
  },
  failed: {
    label: "Failed",
    dot: "bg-red-500",
    text: "text-red-700 dark:text-red-300",
    bg: "bg-red-100/60 dark:bg-red-500/15",
  },
}

const norm = (s: string | null | undefined): IngestStatus | null => {
  if (!s) return null
  const lower = s.toLowerCase()
  if (lower === "completed" || lower === "done") return null
  if (lower in STATUS_META) return lower as IngestStatus
  return null
}

export function IngestStatusIndicator({
  status,
  variant = "dot",
}: Props): JSX.Element | null {
  const key = norm(status)
  if (!key) return null
  const meta = STATUS_META[key]
  if (!meta) return null
  const isProcessing = key === "processing"
  const isFailed = key === "failed"

  if (variant === "pill") {
    return (
      <span
        title={meta.label}
        className={
          "inline-flex flex-shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium " +
          meta.bg +
          " " +
          meta.text
        }
      >
        {isProcessing ? (
          <Loader2 className="h-2.5 w-2.5 animate-spin" aria-hidden />
        ) : isFailed ? (
          <AlertTriangle className="h-2.5 w-2.5" aria-hidden />
        ) : (
          <span
            aria-hidden
            className={"h-1.5 w-1.5 rounded-full " + meta.dot}
          />
        )}
        <span>{meta.label}</span>
      </span>
    )
  }

  return (
    <span
      title={meta.label}
      aria-label={meta.label}
      className="inline-flex flex-shrink-0 items-center"
    >
      {isProcessing ? (
        <Loader2
          className="h-3 w-3 animate-spin text-sky-500"
          aria-hidden
        />
      ) : isFailed ? (
        <AlertTriangle
          className="h-3 w-3 text-red-500"
          aria-hidden
        />
      ) : (
        <span
          aria-hidden
          className={
            "h-2 w-2 rounded-full " +
            meta.dot +
            (key === "pending" ? " animate-pulse" : "")
          }
        />
      )}
    </span>
  )
}
