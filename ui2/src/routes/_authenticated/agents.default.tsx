import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ChevronRight } from "lucide-react"
import { useEffect, useRef, useState } from "react"

import { Topbar } from "@/components/Topbar"
import { AgentForm } from "@/components/agents/AgentForm"
import type {
  AgentFormHandle,
  AgentFormValues,
} from "@/components/agents/AgentForm"
import {
  type Agent,
  ApiError,
  getDefaultAgent,
  updateDefaultAgent,
} from "@/lib/api"

// Dedicated route for the workspace-wide default agent. We deliberately
// don't reuse /agents/:agentId/edit because:
//   • The default row is identified by GET /v2/agents/default (server
//     auto-creates on first read) — callers never need its external_id.
//   • The PUT endpoint is /v2/agents/default, a different verb path
//     than the per-row PUT — keeps "edit the default" idempotent.
//   • Hiding identity / sharing for the default is cleaner as an
//     AgentForm prop than a runtime branch on isDefault inside the
//     existing edit route.
export const Route = createFileRoute("/_authenticated/agents/default")({
  component: DefaultAgentRoute,
})

function DefaultAgentRoute(): JSX.Element {
  const navigate = useNavigate()

  const [agent, setAgent] = useState<Agent | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const formRef = useRef<AgentFormHandle>(null)

  useEffect((): (() => void) => {
    let cancelled = false
    setAgent(null)
    setLoadError(null)
    getDefaultAgent()
      .then((a): void => {
        if (!cancelled) setAgent(a)
      })
      .catch((err: Error): void => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? "Default agent isn't reachable. Are you signed in?"
              : err.message,
          )
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [])

  const handleSubmit = async (values: AgentFormValues): Promise<void> => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      // PUT /v2/agents/default ignores name / sharing / permissions on
      // the server side, but the form still includes them in `values`.
      // Sending the full bag is harmless — the server strips what it
      // won't apply.
      const updated = await updateDefaultAgent(values)
      setAgent(updated)
      void navigate({ to: "/agents" })
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : (err as Error).message
      setSubmitError(message || "Couldn't save the default agent.")
      setSubmitting(false)
    }
  }

  const cancel = (): void => {
    void navigate({ to: "/agents" })
  }

  return (
    <div className="flex h-full flex-col">
      <Topbar title="Default agent" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to="/agents"
            aria-label="Back to agents"
            title="Back to agents"
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </Link>
          <nav
            aria-label="Default agent path"
            className="flex min-w-0 items-center gap-1 text-[13px] text-muted-foreground"
          >
            <Link
              to="/agents"
              className="inline-flex items-center rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
            >
              Agents
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
              Default agent
            </span>
          </nav>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={cancel}
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
            disabled={submitting || !agent}
            className="inline-flex h-7 items-center rounded-md border border-border bg-surface-elevated px-2.5 text-[12px] font-medium text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-3xl">
          <div className="mb-4 rounded-md border border-border bg-surface-muted px-3 py-2 text-[12.5px] text-muted-foreground">
            <strong className="font-medium text-foreground">
              Workspace default —
            </strong>{" "}
            this is the agent every chat falls back to when no specific
            agent is selected. Edits apply to everyone in your workspace.
            Identity and sharing are fixed and hidden here.
          </div>

          {loadError ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-[13.5px] text-destructive">
              {loadError}
            </div>
          ) : !agent ? (
            <div className="flex flex-col gap-4">
              <div className="h-10 w-full animate-breathe rounded-md bg-surface-elevated" />
              <div className="h-24 w-full animate-breathe rounded-md bg-surface-elevated" />
              <div className="h-10 w-full animate-breathe rounded-md bg-surface-elevated" />
            </div>
          ) : (
            <AgentForm
              ref={formRef}
              mode="edit"
              initial={agent}
              submitting={submitting}
              submitError={submitError}
              hideSubmitRow
              hideIdentity
              hideSharing
              hideKnowledge
              prefillSectionsFromDefaults
              onCancel={cancel}
              onSubmit={handleSubmit}
            />
          )}
        </div>
      </main>
    </div>
  )
}
