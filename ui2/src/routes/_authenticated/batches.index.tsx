import { Link, createFileRoute, useNavigate } from "@tanstack/react-router"
import { Download, ListChecks, Plus, Trash2, X } from "lucide-react"
import { useCallback, useEffect, useState } from "react"
import { Topbar } from "@/components/Topbar"
import {
  type Batch,
  cancelBatch,
  deleteBatch,
  downloadBatchResult,
  listBatches,
} from "@/lib/api"
import { toast } from "@/components/Toast"

export const Route = createFileRoute("/_authenticated/batches/")({
  component: BatchesIndexRoute,
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

function formatRelative(ms: number): string {
  const diff = Date.now() - ms
  const min = Math.floor(diff / 60000)
  if (min < 1) return "just now"
  if (min < 60) return `${String(min)}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${String(hr)}h ago`
  const day = Math.floor(hr / 24)
  return `${String(day)}d ago`
}

function progressPercent(b: Batch): number {
  if (b.totalRows === 0) return 0
  return Math.min(
    100,
    Math.round(((b.completedRows + b.erroredRows) / b.totalRows) * 100),
  )
}

function BatchesIndexRoute(): JSX.Element {
  const navigate = useNavigate()
  const [batches, setBatches] = useState<Batch[]>([])
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const { batches: b } = await listBatches()
      setBatches(b)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load batches")
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect((): (() => void) => {
    void refresh()
    // Poll while any batch is queued/running so the progress counters update
    // without the user manually refreshing.
    const id = setInterval((): void => {
      void refresh()
    }, 5000)
    return () => {
      clearInterval(id)
    }
  }, [refresh])

  const onDelete = async (id: string): Promise<void> => {
    if (!window.confirm("Delete this batch and its files?")) return
    try {
      await deleteBatch(id)
      setBatches((prev) => prev.filter((b) => b.id !== id))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Delete failed")
    }
  }

  const onCancel = async (id: string): Promise<void> => {
    try {
      await cancelBatch(id)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Cancel failed")
    }
  }

  const onDownload = async (id: string): Promise<void> => {
    try {
      const { blob, filename } = await downloadBatchResult(id)
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

  return (
    <>
      <Topbar
        title="Batches"
        rightSlot={
          <button
            type="button"
            onClick={(): void => {
              void navigate({ to: "/batches/new" })
            }}
            className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90"
          >
            <Plus className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            New batch
          </button>
        }
      />
      <main className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6">
        {loading ? (
          <p className="text-[13px] text-muted-foreground">Loading…</p>
        ) : batches.length === 0 ? (
          <div className="mx-auto max-w-md py-16 text-center">
            <ListChecks
              className="mx-auto mb-4 h-10 w-10 text-muted-foreground"
              aria-hidden
              strokeWidth={1.4}
            />
            <h2 className="text-[15px] font-medium">No batches yet</h2>
            <p className="mt-1 text-[13px] text-muted-foreground">
              Upload a sheet of questions to get bulk answers from your agent.
            </p>
            <Link
              to="/batches/new"
              className="mt-4 inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
              New batch
            </Link>
          </div>
        ) : (
          <div className="overflow-hidden rounded-xl border border-border">
            <table className="w-full text-[13px]">
              <thead className="bg-surface-elevated">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Name</th>
                  <th className="px-3 py-2 text-left font-medium">Status</th>
                  <th className="px-3 py-2 text-left font-medium">Progress</th>
                  <th className="px-3 py-2 text-left font-medium">Model</th>
                  <th className="px-3 py-2 text-left font-medium">Created</th>
                  <th className="px-3 py-2 text-right font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {batches.map((b) => (
                  <tr
                    key={b.id}
                    className="border-t border-border hover:bg-secondary/30"
                  >
                    <td className="px-3 py-2">
                      <Link
                        to="/batches/$batchId"
                        params={{ batchId: b.id }}
                        className="font-medium hover:underline"
                      >
                        {b.name}
                      </Link>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium " +
                          STATUS_TONE[b.status]
                        }
                      >
                        {STATUS_LABEL[b.status]}
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                          <div
                            className="h-full bg-primary transition-[width] duration-300"
                            style={{ width: `${String(progressPercent(b))}%` }}
                          />
                        </div>
                        <span className="text-[11.5px] text-muted-foreground tabular-nums">
                          {b.completedRows + b.erroredRows}/{b.totalRows}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {b.model ?? "Auto"}
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      {formatRelative(b.createdAt)}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          title="Download result"
                          onClick={(): void => {
                            void onDownload(b.id)
                          }}
                          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                        >
                          <Download className="h-3.5 w-3.5" aria-hidden />
                        </button>
                        {(b.status === "queued" || b.status === "running") && (
                          <button
                            type="button"
                            title="Cancel"
                            onClick={(): void => {
                              void onCancel(b.id)
                            }}
                            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </button>
                        )}
                        <button
                          type="button"
                          title="Delete"
                          onClick={(): void => {
                            void onDelete(b.id)
                          }}
                          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-red-500/10 hover:text-red-600"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </>
  )
}
