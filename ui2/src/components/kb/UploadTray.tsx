// Bottom-right tray that surfaces in-flight uploads and their ingestion
// progress. Subscribes to the kb store; collapses to a compact pill when
// nothing is happening.

import { useState } from "react"
import { Check, ChevronDown, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { formatBytes } from "@/lib/files"
import { cancelUpload, useKbUploads, type UploadJob } from "@/lib/kb"

const stageLabel = (j: UploadJob): string => {
  switch (j.stage) {
    case "uploading":
      return `Uploading… ${String(Math.round(j.progress))}%`
    case "queued":
      return "Queued"
    case "parsing":
      return "Parsing"
    case "embedding":
      return "Indexing"
    case "ready":
      return "Indexed"
    case "failed":
      return j.error ?? "Failed"
  }
}

export function UploadTray(): JSX.Element | null {
  const jobs = useKbUploads()
  const [collapsed, setCollapsed] = useState(false)

  if (jobs.length === 0) {
    return null
  }

  const active = jobs.filter(
    (j) => j.stage !== "ready" && j.stage !== "failed",
  ).length
  const summary =
    active > 0
      ? `Uploading ${String(active)} of ${String(jobs.length)}`
      : `${String(jobs.length)} upload${jobs.length === 1 ? "" : "s"}`

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-fade-up fixed bottom-4 right-4 z-30 w-[320px] max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-lg shadow-foreground/[0.08]"
    >
      <button
        type="button"
        onClick={(): void => {
          setCollapsed((c) => !c)
        }}
        className="flex w-full items-center justify-between gap-2 border-b border-border bg-surface-muted/60 px-3 py-2 text-[12.5px] font-medium text-foreground hover:bg-secondary/60"
        aria-expanded={!collapsed}
      >
        <span>{summary}</span>
        <ChevronDown
          className={cn(
            "h-3.5 w-3.5 text-muted-foreground transition",
            collapsed ? "" : "rotate-180",
          )}
          aria-hidden
          strokeWidth={1.75}
        />
      </button>
      {!collapsed ? (
        <ul className="max-h-[260px] overflow-y-auto">
          {jobs.map((j) => (
            <li
              key={j.id}
              className="flex items-center gap-2 border-b border-border/60 px-3 py-2 last:border-b-0"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[12.5px] font-medium text-foreground">
                  {j.fileName}
                </span>
                <span className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span>{formatBytes(j.sizeBytes)}</span>
                  <span aria-hidden>·</span>
                  <span
                    className={cn(
                      j.stage === "failed" && "text-destructive",
                      j.stage === "ready" && "text-emerald-600 dark:text-emerald-500",
                    )}
                  >
                    {stageLabel(j)}
                  </span>
                </span>
                {j.stage === "uploading" ? (
                  <span className="mt-1.5 block h-1 w-full overflow-hidden rounded-full bg-secondary">
                    <span
                      className="block h-full rounded-full bg-foreground/70 transition-[width]"
                      style={{ width: `${String(j.progress)}%` }}
                    />
                  </span>
                ) : null}
              </span>
              {j.stage === "ready" ? (
                <Check
                  className="h-3.5 w-3.5 text-emerald-600 dark:text-emerald-500"
                  aria-hidden
                  strokeWidth={2.25}
                />
              ) : (
                <button
                  type="button"
                  aria-label={
                    j.stage === "failed" ? "Dismiss" : "Cancel upload"
                  }
                  title={j.stage === "failed" ? "Dismiss" : "Cancel"}
                  onClick={(): void => {
                    cancelUpload(j.id)
                  }}
                  className="grid h-6 w-6 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                >
                  <X className="h-3 w-3" aria-hidden strokeWidth={2} />
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
