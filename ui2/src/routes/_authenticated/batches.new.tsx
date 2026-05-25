import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { FileSpreadsheet, Upload } from "lucide-react"
import { useState } from "react"
import { Topbar } from "@/components/Topbar"
import { useAgents } from "@/lib/agents"
import { useModels } from "@/lib/models"
import { ApiError, createBatch } from "@/lib/api"
import { toast } from "@/components/Toast"

export const Route = createFileRoute("/_authenticated/batches/new")({
  component: NewBatchRoute,
})

function NewBatchRoute(): JSX.Element {
  const navigate = useNavigate()
  const { models, selected: selectedModel } = useModels()
  const { agents, selected: selectedAgent } = useAgents()

  const [file, setFile] = useState<File | null>(null)
  const [questionColumn, setQuestionColumn] = useState<string>("")
  const [model, setModel] = useState<string>(selectedModel ?? "")
  const [agent, setAgent] = useState<string>(selectedAgent ?? "")
  const [submitting, setSubmitting] = useState(false)

  const onSubmit = async (
    e: React.FormEvent<HTMLFormElement>,
  ): Promise<void> => {
    e.preventDefault()
    if (!file) {
      toast.error("Pick a sheet to upload")
      return
    }
    setSubmitting(true)
    try {
      const form = new FormData()
      form.append("file", file)
      if (model) form.append("model", model)
      if (agent) form.append("agentId", agent)
      if (questionColumn.trim()) {
        form.append("questionColumn", questionColumn.trim())
      }
      const res = await createBatch(form)
      toast.success(`Batch started — ${String(res.preview.totalRows)} questions`)
      await navigate({
        to: "/batches/$batchId",
        params: { batchId: res.batch.id },
      })
    } catch (err) {
      const msg =
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Upload failed"
      toast.error(msg)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Topbar title="New batch" />
      <main className="min-h-0 flex-1 overflow-auto px-4 py-6 sm:px-6">
        <form
          onSubmit={(e): void => {
            void onSubmit(e)
          }}
          className="mx-auto flex max-w-xl flex-col gap-5"
        >
          <section>
            <p className="mb-1.5 text-[13px] font-medium">Sheet (CSV or XLSX)</p>
            <label
              htmlFor="batch-file"
              className={
                "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-6 py-8 text-center transition-colors " +
                (file
                  ? "border-primary/50 bg-primary/5"
                  : "border-border bg-surface-elevated hover:border-primary/40")
              }
            >
              <input
                id="batch-file"
                type="file"
                accept=".csv,.xls,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
                className="sr-only"
                onChange={(e): void => {
                  setFile(e.target.files?.[0] ?? null)
                }}
              />
              {file ? (
                <>
                  <FileSpreadsheet
                    className="h-6 w-6 text-primary"
                    aria-hidden
                    strokeWidth={1.5}
                  />
                  <div>
                    <p className="text-[13px] font-medium">{file.name}</p>
                    <p className="text-[11.5px] text-muted-foreground">
                      {(file.size / 1024).toFixed(1)} KB · click to change
                    </p>
                  </div>
                </>
              ) : (
                <>
                  <Upload
                    className="h-6 w-6 text-muted-foreground"
                    aria-hidden
                    strokeWidth={1.5}
                  />
                  <div>
                    <p className="text-[13px]">Click to choose a sheet</p>
                    <p className="text-[11.5px] text-muted-foreground">
                      CSV, XLS, or XLSX up to 25 MB
                    </p>
                  </div>
                </>
              )}
            </label>
          </section>

          <section>
            <label
              htmlFor="batch-question-col"
              className="mb-1.5 block text-[13px] font-medium"
            >
              Question column (optional)
            </label>
            <input
              id="batch-question-col"
              type="text"
              value={questionColumn}
              onChange={(e): void => {
                setQuestionColumn(e.target.value)
              }}
              placeholder="leave blank to auto-detect"
              className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition focus:border-primary"
            />
            <p className="mt-1 text-[11.5px] text-muted-foreground">
              Headers we look for: question, query, prompt, ask. Falls back to
              the first column that&apos;s mostly non-empty.
            </p>
          </section>

          <section>
            <label
              htmlFor="batch-model"
              className="mb-1.5 block text-[13px] font-medium"
            >
              Model
            </label>
            <select
              id="batch-model"
              value={model}
              onChange={(e): void => {
                setModel(e.target.value)
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition focus:border-primary"
            >
              <option value="">Auto</option>
              {models.map((m) => (
                <option key={m.labelName} value={m.labelName}>
                  {m.labelName}
                </option>
              ))}
            </select>
          </section>

          <section>
            <label
              htmlFor="batch-agent"
              className="mb-1.5 block text-[13px] font-medium"
            >
              Agent
            </label>
            <select
              id="batch-agent"
              value={agent}
              onChange={(e): void => {
                setAgent(e.target.value)
              }}
              className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-[13px] outline-none transition focus:border-primary"
            >
              <option value="">General agent (your KB only)</option>
              {agents.map((a) => (
                <option key={a.externalId} value={a.externalId}>
                  {a.name}
                </option>
              ))}
            </select>
            {agent && (
              <p className="mt-1 text-[11.5px] text-muted-foreground">
                Each question runs through this agent&apos;s scope and system
                prompt.
              </p>
            )}
          </section>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={(): void => {
                void navigate({ to: "/batches" })
              }}
              className="inline-flex h-8 items-center rounded-md border border-border bg-background px-3 text-[12.5px] text-muted-foreground transition hover:bg-secondary"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting || !file}
              className="inline-flex h-8 items-center gap-1 rounded-md bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition hover:opacity-90 disabled:opacity-50"
            >
              {submitting ? "Uploading…" : "Start batch"}
            </button>
          </div>
        </form>
      </main>
    </>
  )
}
