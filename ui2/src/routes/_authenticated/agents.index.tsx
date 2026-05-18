import { createFileRoute, Link, useNavigate } from "@tanstack/react-router"
import { Bot, Globe, Plus, Sparkles, Star } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { Topbar } from "@/components/Topbar"
import { SearchField } from "@/components/file-browser"
import { type Agent, type AgentListFilter, listAgents } from "@/lib/api"
import { getStarredAgents, toggleAgentStar } from "@/lib/agentStars"

type AgentsSearch = {
  tab?: FilterTab
  q?: string
}

type FilterTab = AgentListFilter | "starred"

export const Route = createFileRoute("/_authenticated/agents/")({
  validateSearch: (raw: Record<string, unknown>): AgentsSearch => {
    const out: AgentsSearch = {}
    if (
      raw["tab"] === "all" ||
      raw["tab"] === "madeByMe" ||
      raw["tab"] === "sharedToMe" ||
      raw["tab"] === "starred"
    ) {
      out.tab = raw["tab"]
    }
    if (typeof raw["q"] === "string" && raw["q"] !== "") {
      out.q = raw["q"]
    }
    return out
  },
  component: AgentsIndexRoute,
})

const TABS: ReadonlyArray<{ id: FilterTab; label: string }> = [
  { id: "all", label: "All" },
  { id: "madeByMe", label: "Mine" },
  { id: "sharedToMe", label: "Shared" },
  { id: "starred", label: "Starred" },
]

function AgentsIndexRoute(): JSX.Element {
  const { me } = Route.useRouteContext()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const tab: FilterTab = search.tab ?? "all"
  const query = search.q ?? ""

  const [agents, setAgents] = useState<Agent[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [starred, setStarred] = useState<Set<string>>(() =>
    getStarredAgents(me.email),
  )

  // The server-side filter only knows about all/madeByMe/sharedToMe; "starred"
  // is purely a client overlay on top of "all".
  const serverFilter: AgentListFilter = tab === "starred" ? "all" : tab

  useEffect((): (() => void) => {
    let cancelled = false
    setAgents(null)
    setError(null)
    listAgents({ limit: 200, offset: 0, filter: serverFilter })
      .then(({ agents: list }): void => {
        if (!cancelled) setAgents(list)
      })
      .catch((err: Error): void => {
        if (!cancelled) setError(err.message)
      })
    return (): void => {
      cancelled = true
    }
  }, [serverFilter])

  const filtered = useMemo<Agent[]>(() => {
    if (!agents) return []
    const needle = query.trim().toLowerCase()
    const base =
      tab === "starred"
        ? agents.filter((a) => starred.has(a.externalId))
        : agents
    const matched = needle
      ? base.filter((a) => {
          return (
            a.name.toLowerCase().includes(needle) ||
            a.description.toLowerCase().includes(needle) ||
            a.model.toLowerCase().includes(needle)
          )
        })
      : base
    return matched.slice().sort((a, b) => {
      const sa = starred.has(a.externalId) ? 0 : 1
      const sb = starred.has(b.externalId) ? 0 : 1
      if (sa !== sb) return sa - sb
      return a.name.localeCompare(b.name)
    })
  }, [agents, query, tab, starred])

  const setQuery = (next: string): void => {
    void navigate({
      replace: true,
      search: (prev: AgentsSearch): AgentsSearch => {
        const out: AgentsSearch = {}
        if (prev.tab !== undefined) out.tab = prev.tab
        if (next !== "") out.q = next
        return out
      },
    })
  }

  const setTab = (next: FilterTab): void => {
    void navigate({
      replace: true,
      search: (prev: AgentsSearch): AgentsSearch => {
        const out: AgentsSearch = {}
        if (next !== "all") out.tab = next
        if (prev.q !== undefined) out.q = prev.q
        return out
      },
    })
  }

  const handleToggleStar = (externalId: string): void => {
    setStarred(toggleAgentStar(me.email, externalId))
  }

  const count = filtered.length
  const showingSearch = query.trim().length > 0

  return (
    <div className="flex h-full flex-col">
      <Topbar title="Agents" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            Agents
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <TabBar value={tab} onChange={setTab} />
          <Link
            to="/agents/new"
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            New agent
          </Link>
          <SearchField
            value={query}
            onChange={setQuery}
            className="w-56"
            ariaLabel="Search agents"
            placeholder="Search agents"
          />
        </div>
      </div>

      <main className="flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-7xl">
          <p className="mb-3 text-[12px] text-muted-foreground">
            {agents === null
              ? "Loading…"
              : count === 0
                ? showingSearch
                  ? "No matches"
                  : tab === "starred"
                    ? "No starred agents yet"
                    : tab === "madeByMe"
                      ? "You haven't created any agents"
                      : tab === "sharedToMe"
                        ? "Nothing has been shared with you"
                        : "No agents in this workspace"
                : `${String(count)} agent${count === 1 ? "" : "s"}`}
          </p>

          {error ? (
            <ErrorPane message={error} />
          ) : agents === null ? (
            <SkeletonGrid />
          ) : count === 0 ? (
            <EmptyPane tab={tab} searching={showingSearch} query={query} />
          ) : (
            <ul
              role="list"
              className="grid animate-fade-up grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {filtered.map((agent) => (
                <li key={agent.externalId}>
                  <AgentCard
                    agent={agent}
                    starred={starred.has(agent.externalId)}
                    onToggleStar={handleToggleStar}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function TabBar({
  value,
  onChange,
}: {
  value: FilterTab
  onChange: (next: FilterTab) => void
}): JSX.Element {
  return (
    <div
      role="group"
      aria-label="Filter"
      className="inline-flex items-center rounded-full border border-border bg-surface-elevated p-0.5"
    >
      {TABS.map((t) => {
        const active = value === t.id
        return (
          <button
            key={t.id}
            type="button"
            onClick={(): void => {
              onChange(t.id)
            }}
            aria-pressed={active}
            className={
              "inline-flex h-7 items-center gap-1 rounded-full px-2.5 text-[12px] transition " +
              (active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:text-foreground")
            }
          >
            {t.id === "starred" ? (
              <Star
                className={`h-3 w-3 ${active ? "fill-current" : ""}`}
                aria-hidden
                strokeWidth={1.75}
              />
            ) : null}
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

function AgentCard({
  agent,
  starred,
  onToggleStar,
}: {
  agent: Agent
  starred: boolean
  onToggleStar: (externalId: string) => void
}): JSX.Element {
  return (
    <div className="group relative">
      <Link
        to="/agents/$agentId"
        params={{ agentId: agent.externalId }}
        className="flex h-full w-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface-elevated p-4 text-left transition hover:border-ring/40 hover:bg-secondary/60 active:scale-[0.99]"
        title={agent.name}
      >
        <div className="flex w-full items-start justify-between gap-2">
          <span
            aria-hidden
            className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-surface-muted text-foreground"
          >
            <Bot className="h-5 w-5" strokeWidth={1.5} />
          </span>
          <span className="invisible" aria-hidden>
            {/* Spacer to balance the star button mounted in the outer div */}
          </span>
        </div>
        <span className="flex w-full min-w-0 flex-col gap-0.5">
          <span className="truncate text-[13.5px] font-medium text-foreground">
            {agent.name}
          </span>
          <span className="line-clamp-2 min-h-[2rem] text-[11.5px] leading-snug text-muted-foreground">
            {agent.description || (
              <span className="italic text-muted-foreground/70">
                No description.
              </span>
            )}
          </span>
        </span>
        <div className="mt-auto flex flex-wrap items-center gap-1.5">
          {agent.isPublic ? (
            <Pill icon={<Globe className="h-3 w-3" aria-hidden strokeWidth={1.75} />}>
              Public
            </Pill>
          ) : null}
          {agent.isRagOn ? <Pill>RAG</Pill> : null}
          {agent.allowWebSearch ? <Pill>Web</Pill> : null}
        </div>
      </Link>
      <button
        type="button"
        aria-label={starred ? "Unstar agent" : "Star agent"}
        title={starred ? "Starred" : "Star"}
        onClick={(e): void => {
          e.preventDefault()
          e.stopPropagation()
          onToggleStar(agent.externalId)
        }}
        className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
      >
        <Star
          className={`h-3.5 w-3.5 transition ${
            starred
              ? "fill-amber-400 text-amber-400"
              : "text-muted-foreground"
          }`}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>
    </div>
  )
}

function Pill({
  children,
  icon,
}: {
  children: React.ReactNode
  icon?: JSX.Element
}): JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground">
      {icon}
      {children}
    </span>
  )
}

function SkeletonGrid(): JSX.Element {
  return (
    <ul
      role="list"
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
    >
      {Array.from({ length: 8 }).map((_, i) => (
        <li
          key={i}
          className="h-[148px] animate-breathe rounded-2xl border border-border bg-surface-elevated"
          aria-hidden
        />
      ))}
    </ul>
  )
}

function EmptyPane({
  tab,
  searching,
  query,
}: {
  tab: FilterTab
  searching: boolean
  query: string
}): JSX.Element {
  const headline = searching
    ? "No matches"
    : tab === "starred"
      ? "No starred agents yet"
      : tab === "madeByMe"
        ? "You haven't created any agents"
        : tab === "sharedToMe"
          ? "Nothing has been shared with you"
          : "No agents in this workspace"
  const detail = searching
    ? `We couldn't find anything matching "${query}". Try a broader term.`
    : tab === "starred"
      ? "Star an agent card to pin it here for quick access."
      : "Create your first agent to scope answers to a curated set of documents."
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
        {tab === "starred" ? (
          <Sparkles className="h-5 w-5" aria-hidden strokeWidth={1.5} />
        ) : (
          <Bot className="h-5 w-5" aria-hidden strokeWidth={1.5} />
        )}
      </span>
      <p className="text-[14px] font-medium text-foreground">{headline}</p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">{detail}</p>
      {tab !== "starred" && !searching ? (
        <Link
          to="/agents/new"
          className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New agent
        </Link>
      ) : null}
    </div>
  )
}

function ErrorPane({ message }: { message: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
      Couldn't load agents — {message}
    </div>
  )
}
