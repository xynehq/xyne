import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { useEffect, useState } from "react"
import { createPortal } from "react-dom"
import {
  AlertTriangle,
  ArrowLeft,
  Bot,
  ChevronRight,
  Edit3,
  File,
  Folder,
  Globe,
  Library,
  Lock,
  MessageSquarePlus,
  Sparkles,
  Star,
  Trash2,
  X,
} from "lucide-react"
import { Topbar } from "@/components/Topbar"
import { type Agent, ApiError, deleteAgent, getAgent } from "@/lib/api"
import { useAgents } from "@/lib/agents"
import { getStarredAgents, toggleAgentStar } from "@/lib/agentStars"

export const Route = createFileRoute("/_authenticated/agents/$agentId/")({
  component: AgentDetailRoute,
})

function AgentDetailRoute(): JSX.Element {
  const { agentId } = Route.useParams()
  const { me } = Route.useRouteContext()
  const navigate = useNavigate()
  const { setSelected: setSelectedAgent } = useAgents()

  const [agent, setAgent] = useState<Agent | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starred, setStarred] = useState<Set<string>>(() =>
    getStarredAgents(me.email),
  )
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect((): (() => void) => {
    let cancelled = false
    setAgent(null)
    setError(null)
    getAgent(agentId)
      .then((a): void => {
        if (!cancelled) setAgent(a)
      })
      .catch((err: Error): void => {
        if (!cancelled) {
          setError(
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

  const handleToggleStar = (): void => {
    setStarred(toggleAgentStar(me.email, agentId))
  }

  const handleDelete = async (): Promise<void> => {
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteAgent(agentId)
      void navigate({ to: "/agents" })
    } catch (err) {
      const message =
        err instanceof ApiError ? err.message : (err as Error).message
      setDeleteError(message || "Couldn't delete the agent.")
      setDeleting(false)
    }
  }

  const isStarred = starred.has(agentId)
  const agentName = agent?.name ?? "Agent"

  return (
    <div className="flex h-full flex-col">
      <Topbar title={agentName} />

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
          <Crumbs name={agentName} />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-label={isStarred ? "Unstar agent" : "Star agent"}
            onClick={handleToggleStar}
            className="grid h-7 w-7 place-items-center rounded-md border border-border bg-surface-elevated text-muted-foreground transition hover:bg-secondary hover:text-foreground"
          >
            <Star
              className={`h-3.5 w-3.5 transition ${
                isStarred ? "fill-amber-400 text-amber-400" : ""
              }`}
              strokeWidth={1.75}
              aria-hidden
            />
          </button>
          {agent ? (
            <button
              type="button"
              onClick={(): void => {
                setSelectedAgent(agent.externalId)
                void navigate({ to: "/" })
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md bg-foreground px-2 text-[12px] font-medium text-background transition hover:opacity-90"
            >
              <MessageSquarePlus
                className="h-3.5 w-3.5"
                aria-hidden
                strokeWidth={1.75}
              />
              Use agent
            </button>
          ) : null}
          {agent ? (
            <Link
              to="/agents/$agentId/edit"
              params={{ agentId: agent.externalId }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
            >
              <Edit3 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Edit
            </Link>
          ) : null}
          {agent ? (
            <button
              type="button"
              onClick={(): void => {
                setConfirmDelete(true)
              }}
              className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:border-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
              Delete
            </button>
          ) : null}
        </div>
      </div>

      <main className="flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-5xl">
          {error ? (
            <div className="rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-[13.5px] text-destructive">
              {error}
            </div>
          ) : !agent ? (
            <SkeletonBody />
          ) : (
            <Body agent={agent} />
          )}
        </div>
      </main>

      {confirmDelete && agent ? (
        <ConfirmDeleteModal
          agentName={agent.name}
          deleting={deleting}
          error={deleteError}
          onCancel={(): void => {
            if (!deleting) {
              setConfirmDelete(false)
              setDeleteError(null)
            }
          }}
          onConfirm={(): void => {
            void handleDelete()
          }}
        />
      ) : null}
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function Crumbs({ name }: { name: string }): JSX.Element {
  return (
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
        className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60"
        aria-hidden
        strokeWidth={1.75}
      />
      <span
        aria-current="page"
        className="max-w-[40ch] truncate rounded-md px-1.5 py-0.5 font-medium text-foreground"
        title={name}
      >
        {name}
      </span>
    </nav>
  )
}

function SkeletonBody(): JSX.Element {
  return (
    <div className="flex flex-col gap-4">
      <div className="h-14 w-72 animate-breathe rounded-md bg-surface-elevated" />
      <div className="h-24 w-full animate-breathe rounded-2xl border border-border bg-surface-elevated" />
      <div className="h-40 w-full animate-breathe rounded-2xl border border-border bg-surface-elevated" />
    </div>
  )
}

function Body({ agent }: { agent: Agent }): JSX.Element {
  return (
    <div className="flex flex-col gap-6 animate-fade-up">
      {/* Hero */}
      <div className="flex items-start gap-4 rounded-2xl border border-border bg-surface-elevated p-5">
        <span
          aria-hidden
          className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl bg-surface-muted text-foreground"
        >
          <Bot className="h-6 w-6" strokeWidth={1.4} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-[18px] font-medium text-foreground">
              {agent.name}
            </h2>
            {agent.isPublic ? (
              <Pill icon={<Globe className="h-3 w-3" strokeWidth={1.75} />}>
                Public
              </Pill>
            ) : (
              <Pill icon={<Lock className="h-3 w-3" strokeWidth={1.75} />}>
                Private
              </Pill>
            )}
          </div>
          <p className="mt-1 text-[12px] text-muted-foreground">
            Model: <span className="font-medium text-foreground">{agent.model}</span>
          </p>
          <p className="mt-2 text-[13px] leading-relaxed text-foreground/90">
            {agent.description || (
              <span className="italic text-muted-foreground/80">
                No description.
              </span>
            )}
          </p>
        </div>
      </div>

      {/* Behaviour */}
      <Section title="Behaviour">
        <DefRow
          label="Use workspace knowledge"
          value={agent.isRagOn ? "On" : "Off"}
          hint="Retrieves and cites documents at answer time."
        />
        <DefRow
          label="Allow web search"
          value={agent.allowWebSearch ? "On" : "Off"}
          hint="Lets the agent reach the public web when needed."
        />
      </Section>

      {/* Prompt */}
      {agent.prompt ? (
        <Section
          title="System prompt"
          icon={<Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />}
        >
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap rounded-2xl border border-border bg-surface-elevated p-4 font-mono text-[12.5px] leading-relaxed text-foreground">
            {agent.prompt}
          </pre>
        </Section>
      ) : null}

      {/* KB sources */}
      <Section
        title="Knowledge sources"
        icon={<Library className="h-3.5 w-3.5" strokeWidth={1.75} />}
      >
        <KbSourcesReadonly
          docIds={agent.docIds}
          appIntegrations={agent.appIntegrations}
        />
      </Section>

      {/* Sharing */}
      {!agent.isPublic ? (
        <Section title="Sharing">
          <EmailList
            label="Viewers"
            emails={agent.userEmails}
            empty="No one else has access yet."
          />
          <EmailList
            label="Co-owners"
            emails={agent.ownerEmails}
            empty="No co-owners."
          />
        </Section>
      ) : null}

      <p className="text-[11.5px] text-muted-foreground/80">
        ID:{" "}
        <span className="font-mono text-[11px] text-muted-foreground">
          {agent.externalId}
        </span>
      </p>
    </div>
  )
}

function Pill({
  icon,
  children,
}: {
  icon?: JSX.Element
  children: React.ReactNode
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
      {icon}
      {children}
    </span>
  )
}

function Section({
  title,
  icon,
  children,
}: {
  title: string
  icon?: JSX.Element
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
        {icon}
        {title}
      </h3>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  )
}

function DefRow({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}): JSX.Element {
  return (
    <div className="flex items-start justify-between gap-4 rounded-2xl border border-border bg-surface-elevated px-4 py-3">
      <div className="min-w-0">
        <p className="text-[13px] font-medium text-foreground">{label}</p>
        {hint ? (
          <p className="mt-0.5 text-[11.5px] text-muted-foreground">{hint}</p>
        ) : null}
      </div>
      <span className="text-[12.5px] font-medium text-muted-foreground">
        {value}
      </span>
    </div>
  )
}

function KbSourcesReadonly({
  docIds,
  appIntegrations,
}: {
  docIds: unknown[] | undefined
  appIntegrations: unknown
}): JSX.Element {
  // `appIntegrations.knowledge_base.itemIds` is the canonical list retrieval
  // honors; `docIds` is just display metadata (names/entities). Read both so
  // that v1-created agents (which only populate the former) still show their
  // picked sources here. Order matches AgentForm.kbFromAgent for consistency.
  const docMeta = new Map<string, { name: string; entity: string }>()
  if (Array.isArray(docIds)) {
    for (const raw of docIds) {
      if (!raw || typeof raw !== "object") continue
      const r = raw as Record<string, unknown>
      const docId = typeof r["docId"] === "string" ? r["docId"] : null
      const name = typeof r["name"] === "string" ? r["name"] : null
      const entity = typeof r["entity"] === "string" ? r["entity"] : "file"
      if (!docId || !name) continue
      docMeta.set(docId, { name, entity })
    }
  }
  let itemIds: string[] = []
  if (
    appIntegrations &&
    typeof appIntegrations === "object" &&
    !Array.isArray(appIntegrations)
  ) {
    const kb = (appIntegrations as Record<string, unknown>)["knowledge_base"]
    if (kb && typeof kb === "object") {
      const raw = (kb as Record<string, unknown>)["itemIds"]
      if (Array.isArray(raw)) {
        itemIds = raw.filter((v): v is string => typeof v === "string")
      }
    }
  }
  const sources: { docId: string; name: string; entity: string }[] = []
  const seen = new Set<string>()
  if (itemIds.length > 0) {
    for (const id of itemIds) {
      if (seen.has(id)) continue
      seen.add(id)
      const meta = docMeta.get(id)
      sources.push({
        docId: id,
        name: meta?.name ?? id,
        entity: meta?.entity ?? (id.startsWith("clfd-") ? "folder" : "file"),
      })
    }
  } else {
    for (const [id, meta] of docMeta) {
      sources.push({ docId: id, name: meta.name, entity: meta.entity })
    }
  }

  if (sources.length === 0) {
    return (
      <p className="rounded-2xl border border-dashed border-border bg-surface-elevated px-4 py-3 text-[12.5px] italic text-muted-foreground">
        No specific sources — uses the workspace default.
      </p>
    )
  }

  return (
    <ul className="grid grid-cols-1 gap-1 rounded-2xl border border-border bg-surface-elevated p-1.5 sm:grid-cols-2">
      {sources.map((s) => (
        <li key={s.docId}>
          <div className="flex items-center gap-2 rounded-md px-2 py-1.5">
            <span
              aria-hidden
              className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md bg-surface-muted text-foreground"
            >
              {s.entity === "folder" ? (
                <Folder className="h-3.5 w-3.5" strokeWidth={1.6} />
              ) : (
                <File className="h-3.5 w-3.5" strokeWidth={1.6} />
              )}
            </span>
            <span className="min-w-0 flex-1 truncate text-[13px] text-foreground">
              {s.name}
            </span>
          </div>
        </li>
      ))}
    </ul>
  )
}

function EmailList({
  label,
  emails,
  empty,
}: {
  label: string
  emails: string[] | undefined
  empty: string
}): JSX.Element {
  const list = Array.isArray(emails) ? emails : []
  return (
    <div className="rounded-2xl border border-border bg-surface-elevated px-4 py-3">
      <p className="text-[12.5px] font-medium text-muted-foreground">{label}</p>
      {list.length === 0 ? (
        <p className="mt-1.5 text-[12.5px] italic text-muted-foreground/80">
          {empty}
        </p>
      ) : (
        <ul className="mt-2 flex flex-wrap gap-1.5">
          {list.map((e) => (
            <li
              key={e}
              className="inline-flex items-center rounded-full bg-secondary px-2 py-0.5 text-[12px] text-foreground"
            >
              {e}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ConfirmDeleteModal({
  agentName,
  deleting,
  error,
  onCancel,
  onConfirm,
}: {
  agentName: string
  deleting: boolean
  error: string | null
  onCancel: () => void
  onConfirm: () => void
}): JSX.Element {
  useEffect((): (() => void) => {
    const prev = document.body.style.overflow
    document.body.style.overflow = "hidden"
    return (): void => {
      document.body.style.overflow = prev
    }
  }, [])

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-agent-title"
      className="fixed inset-0 z-50 grid place-items-center bg-black/60 px-4 backdrop-blur-sm animate-fade-up dark:bg-black/70"
      onClick={(e): void => {
        if (e.target === e.currentTarget) onCancel()
      }}
    >
      <div className="w-full max-w-sm rounded-2xl border border-border bg-surface-elevated p-5 shadow-2xl dark:border-white/10 dark:shadow-[0_24px_60px_-20px_rgba(0,0,0,0.6)]">
        <div className="flex items-start gap-3">
          <span
            aria-hidden
            className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-2xl bg-destructive/10 text-destructive"
          >
            <AlertTriangle className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h3
              id="delete-agent-title"
              className="text-[15px] font-medium text-foreground"
            >
              Delete agent?
            </h3>
            <p className="mt-1 text-[13px] text-muted-foreground">
              <span className="font-medium text-foreground">{agentName}</span>{" "}
              will be removed for everyone who has access. This can't be
              undone.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            onClick={onCancel}
            disabled={deleting}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
          >
            <X className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
          </button>
        </div>

        {error ? (
          <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
            {error}
          </div>
        ) : null}

        <div className="mt-5 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            disabled={deleting}
            className="inline-flex h-8 items-center rounded-md border border-border bg-surface-elevated px-3 text-[12.5px] text-foreground transition hover:bg-secondary disabled:cursor-not-allowed disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={deleting}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-destructive px-3 text-[12.5px] font-medium text-destructive-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <Trash2 className="h-3.5 w-3.5" aria-hidden strokeWidth={1.75} />
            {deleting ? "Deleting…" : "Delete agent"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  )
}
