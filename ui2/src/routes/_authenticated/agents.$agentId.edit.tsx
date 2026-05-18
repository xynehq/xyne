import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { ArrowLeft, ChevronRight } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { Topbar } from "@/components/Topbar"
import { AgentForm } from "@/components/agents/AgentForm"
import type {
  AgentFormHandle,
  AgentFormValues,
} from "@/components/agents/AgentForm"
import { type Agent, ApiError, getAgent, updateAgent } from "@/lib/api"

export const Route = createFileRoute("/_authenticated/agents/$agentId/edit")({
  component: AgentEditRoute,
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

function AgentEditRoute(): JSX.Element {
  const { agentId } = Route.useParams()
  const { me } = Route.useRouteContext()
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
    getAgent(agentId)
      .then((a): void => {
        if (!cancelled) setAgent(a)
      })
      .catch((err: Error): void => {
        if (!cancelled) {
          setLoadError(
            err instanceof ApiError && err.status === 404
              ? "This agent doesn't exist, or you don't have access."
              : err.message,
          )
        }
      })
    return (): void => {
      cancelled = true
    }
  }, [agentId])

  const handleSubmit = async (values: AgentFormValues): Promise<void> => {
    setSubmitting(true)
    setSubmitError(null)
    try {
      // Always keep the current user in `ownerEmails` (and strip them from
      // `userEmails`) — v1's syncAgentUserPermissions wipes any current Owner
      // not present in the submitted list, which can otherwise revoke the
      // signed-in user's own access when they're an Owner via the agent's
      // creator row rather than an explicit Owner permission.
      const ownerEmails = dedupeCaseInsensitive([
        me.email,
        ...(values.ownerEmails ?? []),
      ])
      const userEmails = (values.userEmails ?? []).filter(
        (e) => e.toLowerCase() !== me.email.toLowerCase(),
      )
      await updateAgent(agentId, { ...values, ownerEmails, userEmails })
      void navigate({
        to: "/agents/$agentId",
        params: { agentId },
      })
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : (err as Error).message
      setSubmitError(message || "Couldn't save the agent.")
      setSubmitting(false)
    }
  }

  const cancel = (): void => {
    void navigate({
      to: "/agents/$agentId",
      params: { agentId },
    })
  }

  const agentName = agent?.name ?? "Edit agent"

  return (
    <div className="flex h-full flex-col">
      <Topbar title={agent ? `Edit · ${agent.name}` : "Edit agent"} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Link
            to={agent ? "/agents/$agentId" : "/agents"}
            {...(agent ? { params: { agentId } } : {})}
            aria-label={agent ? "Back to agent" : "Back to agents"}
            title={agent ? "Back to agent" : "Back to agents"}
            className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <ArrowLeft className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
          </Link>
          <nav
            aria-label="Agent path"
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
            {agent ? (
              <>
                <Link
                  to="/agents/$agentId"
                  params={{ agentId }}
                  className="max-w-[28ch] truncate rounded-md px-1.5 py-0.5 transition hover:bg-secondary hover:text-foreground"
                  title={agentName}
                >
                  {agentName}
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
                  Edit
                </span>
              </>
            ) : (
              <span
                aria-current="page"
                className="rounded-md px-1.5 py-0.5 font-medium text-foreground"
              >
                Edit
              </span>
            )}
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
            className="inline-flex h-7 items-center rounded-md bg-foreground px-2.5 text-[12px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {submitting ? "Saving…" : "Save changes"}
          </button>
        </div>
      </div>

      <main className="min-h-0 flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-3xl">
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
              onCancel={cancel}
              onSubmit={handleSubmit}
            />
          )}
        </div>
      </main>
    </div>
  )
}
