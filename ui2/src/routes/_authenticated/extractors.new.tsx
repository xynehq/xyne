import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { ArrowLeft, ChevronRight } from "lucide-react"
import { Topbar } from "@/components/Topbar"
import { AgentForm } from "@/components/agents/AgentForm"
import type {
  AgentFormHandle,
  AgentFormValues,
} from "@/components/agents/AgentForm"
import { ApiError, createAgent } from "@/lib/api"

export const Route = createFileRoute("/_authenticated/extractors/new")({
  component: ExtractorsNewRoute,
})

const dedupeCaseInsensitive = (xs: string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const x of xs) {
    const k = x.toLowerCase()
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

function ExtractorsNewRoute(): JSX.Element {
  const navigate = useNavigate()
  const { me } = Route.useRouteContext()
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const formRef = useRef<AgentFormHandle>(null)

  const handleSubmit = async (values: AgentFormValues): Promise<void> => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      const ownerEmails = dedupeCaseInsensitive([
        me.email,
        ...(values.ownerEmails ?? []),
      ])
      const userEmails = (values.userEmails ?? []).filter(
        (e) => e.toLowerCase() !== me.email.toLowerCase(),
      )
      const created = await createAgent({
        ...values,
        model: "Auto",
        ownerEmails,
        userEmails,
      })
      void navigate({
        to: "/extractors/$extractorId/edit",
        params: { extractorId: created.externalId },
      })
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : (err as Error).message
      setSubmitError(message || "Couldn't create the extractor.")
      setSubmitting(false)
    }
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar title="New extractor" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to="/extractors"
            aria-label="Back to extractors"
            title="Back to extractors"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </Link>
          <nav
            aria-label="Extractor path"
            className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
          >
            <Link
              to="/extractors"
              className="inline-flex items-center rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
            >
              Extractors
            </Link>
            <ChevronRight
              className="h-3.5 w-3.5 text-muted-foreground/60"
              aria-hidden
              strokeWidth={1.75}
            />
            <span
              aria-current="page"
              className="rounded-md px-1.5 py-0.5 font-medium text-foreground"
            >
              New extractor
            </span>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(): void => {
              void navigate({ to: "/extractors" })
            }}
            disabled={submitting}
            className="inline-flex h-7 items-center rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={(): void => {
              formRef.current?.requestSubmit()
            }}
            disabled={submitting}
            className="inline-flex h-7 items-center rounded-md border border-border bg-surface-elevated px-2.5 text-[12px] font-medium text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Creating…" : "Create extractor"}
          </button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-3xl">
          <AgentForm
            ref={formRef}
            mode="create"
            submitting={submitting}
            submitError={submitError}
            hideSubmitRow
            extractor
            onCancel={(): void => {
              void navigate({ to: "/extractors" })
            }}
            onSubmit={handleSubmit}
          />
        </div>
      </main>
    </div>
  )
}
