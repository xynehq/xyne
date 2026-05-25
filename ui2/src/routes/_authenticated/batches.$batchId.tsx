import { Link, createFileRoute } from "@tanstack/react-router"
import { ArrowLeft, Download, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Topbar } from "@/components/Topbar"
import { toast } from "@/components/Toast"
import {
  type Batch,
  type BatchRow,
  cancelBatch,
  downloadBatchResult,
  getBatch,
  listBatchRows,
} from "@/lib/api"

export const Route = createFileRoute("/_authenticated/batches/$batchId")({
  component: BatchDetailRoute,
})

const STATUS_LABEL: Record<Batch["status"], string> = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
}

const STATUS_TONE: Record<Batch["status"], string> = {
  queued: "bg-muted text-muted-foreground",
  running: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-red-500/15 text-red-700 dark:text-red-300",
  cancelled: "bg-muted text-muted-foreground",
}

const ROW_STATUS_TONE: Record<BatchRow["status"], string> = {
  pending: "text-muted-foreground",
  running: "text-amber-600 dark:text-amber-300",
  done: "text-emerald-600 dark:text-emerald-300",
  error: "text-red-600 dark:text-red-300",
}

function BatchDetailRoute(): JSX.Element {
  const { batchId } = Route.useParams()
  const [batch, setBatch] = useState<Batch | null>(null)
  const [rows, setRows] = useState<BatchRow[]>([])
  const [loading, setLoading] = useState(true)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [b, r] = await Promise.all([
        getBatch(batchId),
        listBatchRows(batchId, { limit: 1000 }),
      ])
      setBatch(b)
      setRows(r.rows)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load batch")
    } finally {
      setLoading(false)
    }
  }, [batchId])

  useEffect((): (() => void) => {
    void refresh()
    const id = setInterval((): void => {
      void refresh()
    }, 3000)
    return (): void => {
      clearInterval(id)
    }
  }, [refresh])

  // Stop polling once the batch reaches a terminal state — saves bandwidth
  // on a tab the user leaves open after a batch finishes.
  useEffect((): void => {
    if (!batch) return
    if (
      batch.status === "completed" ||
      batch.status === "failed" ||
      batch.status === "cancelled"
    ) {
      // The polling interval above keeps running but counters won't change.
      // Cheap enough to leave alone; the next refresh sees the same state.
    }
  }, [batch])

  const onDownload = async (): Promise<void> => {
    try {
      const { blob, filename } = await downloadBatchResult(batchId)
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Download failed")
    }
  }

  const onCancel = async (): Promise<void> => {
    try {
      await cancelBatch(batchId)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed")
    }
  }

  const toggleRow = (id: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const progressPercent =
    batch && batch.totalRows > 0
      ? Math.min(
          100,
          Math.round(
            ((batch.completedRows + batch.erroredRows) / batch.totalRows) * 100,
          ),
        )
      : 0

  return (
    <>
      <Topbar
        title={batch ? batch.name : "Batch"}
        rightSlot={
          batch ? (
            <div className="flex items-center gap-2">
              {(batch.status === "queued" || batch.status === "running") && (
                <button
                  type="button"
                  onClick={(): void => {
                    void onCancel()
                  }}
                  className="inline-flex h-8 items-center gap-1 rounded-md border border-border bg-background px-3 text-[12.5px] text-muted-foreground transition hover:bg-secondary"
                >
                  <X className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
                  Cancel
                </button>
              )}
              <button
                type="button"
                onClick={(): void => {
                  void onDownload()
                }}
                className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90"
              >
                <Download className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
                {batch.status === "completed" ? "Download" : "Download (partial)"}
              </button>
            </div>
          ) : undefined
        }
      />
      <main className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6">
        <Link
          to="/batches"
          className="mb-4 inline-flex items-center gap-1 text-[12.5px] text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          Back to batches
        </Link>

        {loading || !batch ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : (
          <>
            <section className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-4">
              <StatCard label="Status">
                <span
                  className={
                    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                    STATUS_TONE[batch.status]
                  }
                >
                  {STATUS_LABEL[batch.status]}
                </span>
              </StatCard>
              <StatCard label="Progress">
                <div className="flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full bg-primary transition-[width] duration-300"
                      style={{ width: `${String(progressPercent)}%` }}
                    />
                  </div>
                  <span className="text-[11.5px] text-muted-foreground tabular-nums">
                    {batch.completedRows + batch.erroredRows}/{batch.totalRows}
                  </span>
                </div>
              </StatCard>
              <StatCard label="Errors">
                <span
                  className={
                    "text-[14px] font-medium " +
                    (batch.erroredRows > 0 ? "text-red-600" : "")
                  }
                >
                  {batch.erroredRows}
                </span>
              </StatCard>
              <StatCard label="Model">
                <span className="text-[13px]">{batch.model ?? "Auto"}</span>
              </StatCard>
            </section>

            <section className="overflow-hidden rounded-xl border border-border">
              <table className="w-full text-[13px]">
                <thead className="bg-surface-elevated">
                  <tr>
                    <th className="w-10 px-3 py-2 text-left font-medium">#</th>
                    <th className="px-3 py-2 text-left font-medium">
                      Question
                    </th>
                    <th className="w-24 px-3 py-2 text-left font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const open = expanded.has(r.id)
                    return (
                      <>
                        <tr
                          key={r.id}
                          className="cursor-pointer border-t border-border hover:bg-secondary/30"
                          onClick={(): void => {
                            toggleRow(r.id)
                          }}
                        >
                          <td className="px-3 py-2 text-muted-foreground tabular-nums">
                            {r.ordinal}
                          </td>
                          <td className="px-3 py-2 truncate">
                            <span className="line-clamp-2">{r.question}</span>
                          </td>
                          <td
                            className={
                              "px-3 py-2 text-[11.5px] uppercase tracking-wide " +
                              ROW_STATUS_TONE[r.status]
                            }
                          >
                            {r.status}
                          </td>
                        </tr>
                        {open && (
                          <tr key={`${r.id}-x`} className="bg-secondary/20">
                            <td colSpan={3} className="px-3 py-3">
                              {r.status === "done" && r.answer && (
                                <div className="whitespace-pre-wrap text-[12.5px]">
                                  {r.answer}
                                </div>
                              )}
                              {r.status === "error" && (
                                <div className="text-[12.5px] text-red-600">
                                  {r.error ?? "errored"}
                                </div>
                              )}
                              {(r.status === "pending" ||
                                r.status === "running") && (
                                <div className="text-[12.5px] text-muted-foreground">
                                  {r.status === "running"
                                    ? "In progress…"
                                    : "Waiting"}
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </>
                    )
                  })}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>
    </>
  )
}

function StatCard({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <div className="rounded-xl border border-border bg-surface-elevated p-3">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
        {label}
      </p>
      <div className="mt-1">{children}</div>
    </div>
  )
}
