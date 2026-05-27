import { createFileRoute, useNavigate } from "@tanstack/react-router"
import {
  Check,
  Copy,
  KeyRound,
  Loader2,
  Plus,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Topbar } from "@/components/Topbar"
import { SearchField } from "@/components/file-browser"
import { toast } from "@/components/Toast"
import { cn } from "@/lib/utils"
import {
  type Agent,
  type ApiKey,
  createApiKey,
  deleteApiKey,
  listAgents,
  listApiKeys,
} from "@/lib/api"

type ApiKeysSearch = { q?: string }

export const Route = createFileRoute("/_authenticated/api-keys")({
  validateSearch: (raw: Record<string, unknown>): ApiKeysSearch => {
    const out: ApiKeysSearch = {}
    if (typeof raw["q"] === "string" && raw["q"] !== "") {
      out.q = raw["q"]
    }
    return out
  },
  component: ApiKeysRoute,
})

function ApiKeysRoute(): JSX.Element {
  const search = Route.useSearch()
  const navigate = useNavigate({ from: Route.fullPath })
  const query = search.q ?? ""

  const [keys, setKeys] = useState<ApiKey[] | null>(null)
  const [agents, setAgents] = useState<Agent[]>([])
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null)
  // Plaintext is only briefly held in memory after creation so the success
  // dialog can show + copy it. Cleared on close.
  const [newKey, setNewKey] = useState<{ plaintext: string; meta: ApiKey } | null>(
    null,
  )

  const load = (signal?: { cancelled: boolean }): Promise<void> =>
    Promise.all([
      listApiKeys(),
      listAgents({ filter: "all" }).catch(() => ({ agents: [] as Agent[] })),
    ])
      .then(([k, a]): void => {
        if (signal?.cancelled) return
        setKeys(k)
        setAgents(a.agents)
      })
      .catch((err: Error): void => {
        if (signal?.cancelled) return
        setError(err.message)
      })

  useEffect((): (() => void) => {
    const signal = { cancelled: false }
    setKeys(null)
    setError(null)
    void load(signal)
    return (): void => {
      signal.cancelled = true
    }
  }, [])

  const setQuery = (next: string): void => {
    void navigate({
      replace: true,
      search: (): ApiKeysSearch => (next === "" ? {} : { q: next }),
    })
  }

  const filtered = useMemo<ApiKey[]>(() => {
    if (!keys) return []
    const needle = query.trim().toLowerCase()
    const base = needle
      ? keys.filter(
          (k) =>
            k.name.toLowerCase().includes(needle) ||
            k.displayKey.toLowerCase().includes(needle),
        )
      : keys
    return base
      .slice()
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
  }, [keys, query])

  const handleCreate = async (input: {
    name: string
    allowedAgents: string[]
  }): Promise<void> => {
    const res = await createApiKey(input)
    setKeys((prev) => (prev ? [...prev, res.apiKey] : [res.apiKey]))
    setNewKey({ plaintext: res.key, meta: res.apiKey })
    setCreating(false)
  }

  const handleDelete = async (id: string): Promise<void> => {
    setPendingDeleteId(id)
    try {
      await deleteApiKey(id)
      setKeys((prev) => (prev ? prev.filter((k) => k.id !== id) : prev))
      toast.success("API key revoked")
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to revoke key")
    } finally {
      setPendingDeleteId(null)
    }
  }

  const count = filtered.length
  const showingSearch = query.trim().length > 0

  return (
    <div className="flex h-full flex-col">
      <Topbar title="API Keys" />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            API keys
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={(): void => setCreating(true)}
            className="inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            New key
          </button>
          <SearchField
            value={query}
            onChange={setQuery}
            className="w-56"
            ariaLabel="Search API keys"
            placeholder="Search keys"
          />
        </div>
      </div>

      <main className="flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-7xl">
          <p className="mb-3 text-[12px] text-muted-foreground">
            {keys === null
              ? "Loading…"
              : count === 0
                ? showingSearch
                  ? "No matches"
                  : "No API keys yet"
                : `${String(count)} key${count === 1 ? "" : "s"}`}
          </p>

          {error ? (
            <ErrorPane message={error} />
          ) : keys === null ? (
            <SkeletonGrid />
          ) : count === 0 ? (
            <EmptyPane
              searching={showingSearch}
              query={query}
              onCreate={(): void => setCreating(true)}
            />
          ) : (
            <ul
              role="list"
              className="grid animate-fade-up grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
            >
              {filtered.map((k) => (
                <li key={k.id}>
                  <KeyCard
                    apiKey={k}
                    agents={agents}
                    deleting={pendingDeleteId === k.id}
                    onDelete={(): void => {
                      void handleDelete(k.id)
                    }}
                  />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <CreateDialog
        open={creating}
        agents={agents}
        onClose={(): void => setCreating(false)}
        onSubmit={handleCreate}
      />
      <NewKeyDialog
        entry={newKey}
        onClose={(): void => setNewKey(null)}
      />
    </div>
  )
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function KeyCard({
  apiKey,
  agents,
  deleting,
  onDelete,
}: {
  apiKey: ApiKey
  agents: Agent[]
  deleting: boolean
  onDelete: () => void
}): JSX.Element {
  const created = new Date(apiKey.createdAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })
  const agentNames = apiKey.allowedAgents
    .map((id) => agents.find((a) => a.externalId === id)?.name ?? id)
    .join(", ")
  return (
    <div
      className="group relative flex h-full w-full flex-col items-start gap-3 rounded-2xl border border-border bg-surface-elevated p-4 text-left transition hover:border-ring/40 hover:bg-secondary/60"
      title={apiKey.name}
    >
      <div className="flex w-full items-start justify-between gap-2">
        <span
          aria-hidden
          className="grid h-10 w-10 flex-shrink-0 place-items-center rounded-xl bg-surface-muted text-foreground"
        >
          <KeyRound className="h-5 w-5" strokeWidth={1.5} />
        </span>
        <span className="invisible" aria-hidden>
          {/* Spacer for the absolutely-positioned revoke button */}
        </span>
      </div>
      <span className="flex w-full min-w-0 flex-col gap-0.5">
        <span className="truncate text-[13.5px] font-medium text-foreground">
          {apiKey.name}
        </span>
        <code className="block truncate text-[11.5px] font-mono leading-snug text-muted-foreground">
          {apiKey.displayKey}
        </code>
      </span>
      <div className="mt-auto flex w-full flex-wrap items-center gap-1.5">
        <Pill>{created}</Pill>
        {apiKey.allowedAgents.length === 0 ? (
          <Pill>All agents</Pill>
        ) : (
          <Pill
            title={agentNames}
          >{`${String(apiKey.allowedAgents.length)} agent${apiKey.allowedAgents.length === 1 ? "" : "s"}`}</Pill>
        )}
      </div>
      <button
        type="button"
        aria-label={`Revoke ${apiKey.name}`}
        title="Revoke"
        disabled={deleting}
        onClick={onDelete}
        className="absolute right-3 top-3 grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-destructive disabled:opacity-50"
      >
        {deleting ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
        ) : (
          <Trash2 className="h-3.5 w-3.5" strokeWidth={1.75} />
        )}
      </button>
    </div>
  )
}

function Pill({
  children,
  title,
}: {
  children: React.ReactNode
  title?: string
}): JSX.Element {
  return (
    <span
      title={title}
      className="inline-flex items-center gap-1 rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-[0.06em] text-muted-foreground"
    >
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
      {Array.from({ length: 6 }).map((_, i) => (
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
  searching,
  query,
  onCreate,
}: {
  searching: boolean
  query: string
  onCreate: () => void
}): JSX.Element {
  const headline = searching ? "No matches" : "No API keys yet"
  const detail = searching
    ? `We couldn't find anything matching "${query}". Try a broader term.`
    : "Create a key to call /v2/consumer/* with your user's permissions. Each key acts as you — keep it secret."
  return (
    <div className="mx-auto flex max-w-md flex-col items-center justify-center gap-3 py-24 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-2xl bg-surface-muted text-muted-foreground">
        <KeyRound className="h-5 w-5" aria-hidden strokeWidth={1.5} />
      </span>
      <p className="text-[14px] font-medium text-foreground">{headline}</p>
      <p className="max-w-xs text-[12.5px] text-muted-foreground">{detail}</p>
      {!searching ? (
        <button
          type="button"
          onClick={onCreate}
          className="mt-1 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-surface-elevated px-2 text-[12px] text-foreground transition hover:bg-secondary"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New key
        </button>
      ) : null}
    </div>
  )
}

function ErrorPane({ message }: { message: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-md rounded-2xl border border-destructive/30 bg-destructive/5 px-4 py-3 text-[13px] text-destructive">
      Couldn't load API keys — {message}
    </div>
  )
}

// ── Dialogs ─────────────────────────────────────────────────────────────────

function CreateDialog({
  open,
  agents,
  onClose,
  onSubmit,
}: {
  open: boolean
  agents: Agent[]
  onClose: () => void
  onSubmit: (input: { name: string; allowedAgents: string[] }) => Promise<void>
}): JSX.Element | null {
  const [name, setName] = useState("")
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const labelId = useId()

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    setName("")
    setSelected(new Set())
    setBusy(false)
    setError(null)
    const id = window.setTimeout((): void => {
      inputRef.current?.focus()
    }, 10)
    return (): void => {
      window.clearTimeout(id)
    }
  }, [open])

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape" && !busy) {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [open, busy, onClose])

  if (!open || typeof document === "undefined") return null

  const trimmed = name.trim()
  const canSubmit = trimmed.length > 0 && !busy

  const submit = async (): Promise<void> => {
    if (!canSubmit) return
    setBusy(true)
    setError(null)
    try {
      await onSubmit({ name: trimmed, allowedAgents: Array.from(selected) })
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create API key")
      setBusy(false)
    }
  }

  const toggle = (id: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="presentation"
      onMouseDown={(e): void => {
        if (e.target === e.currentTarget && !busy) onClose()
      }}
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelId}
        className={cn(
          "relative z-10 flex max-h-[90vh] w-full max-w-[480px] flex-col overflow-hidden",
          "rounded-2xl border border-border bg-surface-elevated shadow-2xl animate-scale-in",
        )}
        onMouseDown={(e): void => {
          e.stopPropagation()
        }}
      >
        <div className="flex items-start justify-between gap-3 px-5 pb-2 pt-4">
          <div>
            <h2
              id={labelId}
              className="text-[15px] font-semibold leading-tight text-foreground"
            >
              Create API key
            </h2>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
              The full key shows once; copy it before closing the next dialog.
            </p>
          </div>
          <button
            type="button"
            aria-label="Close"
            disabled={busy}
            onClick={onClose}
            className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-40"
          >
            <X className="h-3.5 w-3.5" strokeWidth={1.75} />
          </button>
        </div>

        <form
          onSubmit={(e): void => {
            e.preventDefault()
            void submit()
          }}
          className="flex min-h-0 flex-1 flex-col gap-4 px-5 pb-4 pt-2"
        >
          <div>
            <label className="mb-1.5 block text-[12px] font-medium text-foreground">
              Name
            </label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              disabled={busy}
              maxLength={255}
              onChange={(e): void => {
                setName(e.target.value)
                if (error) setError(null)
              }}
              placeholder="My laptop, CI deploy, …"
              className={cn(
                "block w-full rounded-lg border bg-surface px-3 py-2 text-[13.5px] text-foreground transition placeholder:text-muted-foreground/70 focus:outline-none focus:ring-2 disabled:opacity-60",
                error
                  ? "border-red-400 focus:border-red-500 focus:ring-red-500/30"
                  : "border-border focus:border-ring focus:ring-ring/30",
              )}
            />
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="mb-1.5 flex items-baseline justify-between">
              <label className="block text-[12px] font-medium text-foreground">
                Restrict to agents
              </label>
              <span className="text-[11px] text-muted-foreground">
                Leave empty for all
              </span>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border bg-surface">
              {agents.length === 0 ? (
                <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
                  No agents available — key will work against all agents.
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {agents.map((a) => {
                    const checked = selected.has(a.externalId)
                    return (
                      <li key={a.externalId}>
                        <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 transition hover:bg-secondary/60">
                          <input
                            type="checkbox"
                            checked={checked}
                            disabled={busy}
                            onChange={(): void => toggle(a.externalId)}
                            className="h-3.5 w-3.5 rounded border-border text-foreground focus:ring-ring/40"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-[13px] text-foreground">
                              {a.name}
                            </span>
                            {a.description ? (
                              <span className="block truncate text-[11.5px] text-muted-foreground">
                                {a.description}
                              </span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          </div>

          {error ? (
            <p role="alert" className="text-[11.5px] text-red-600 dark:text-red-400">
              {error}
            </p>
          ) : null}

          <div className="mt-1 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="inline-flex h-8 items-center rounded-md px-3 text-[12.5px] text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!canSubmit}
              className="inline-flex h-8 items-center gap-1.5 rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" strokeWidth={1.75} />
              ) : null}
              Create key
            </button>
          </div>
        </form>
      </div>
    </div>,
    document.body,
  )
}

function NewKeyDialog({
  entry,
  onClose,
}: {
  entry: { plaintext: string; meta: ApiKey } | null
  onClose: () => void
}): JSX.Element | null {
  const [copied, setCopied] = useState(false)

  useEffect((): void => {
    if (entry) setCopied(false)
  }, [entry])

  if (!entry || typeof document === "undefined") return null

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(entry.plaintext)
      setCopied(true)
      toast.success("Copied to clipboard")
    } catch {
      toast.error("Could not copy — select and copy manually")
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="presentation"
    >
      <div
        aria-hidden
        className="absolute inset-0 bg-black/50 backdrop-blur-sm animate-fade-in"
      />
      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-[520px] overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl animate-scale-in"
      >
        <div className="flex items-start gap-3 px-5 pb-2 pt-4">
          <span className="grid h-8 w-8 flex-shrink-0 place-items-center rounded-full bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
            <KeyRound className="h-4 w-4" strokeWidth={1.75} />
          </span>
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold leading-tight text-foreground">
              Key created
            </h2>
            <p className="mt-1 text-[12px] leading-snug text-muted-foreground">
              Copy this now — once you close this dialog only the prefix is
              recoverable.
            </p>
          </div>
        </div>

        <div className="space-y-3 px-5 pb-4 pt-3">
          <div className="text-[12px] text-muted-foreground">
            <span className="text-foreground">{entry.meta.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 select-all overflow-x-auto whitespace-nowrap rounded-lg border border-border bg-surface px-3 py-2 font-mono text-[12.5px] text-foreground">
              {entry.plaintext}
            </code>
            <button
              type="button"
              onClick={(): void => void copy()}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-border px-3 text-[12.5px] text-foreground transition hover:border-ring"
            >
              {copied ? (
                <Check className="h-3.5 w-3.5" strokeWidth={1.75} />
              ) : (
                <Copy className="h-3.5 w-3.5" strokeWidth={1.75} />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="rounded-lg border border-amber-300/50 bg-amber-100/40 px-3 py-2 text-[11.5px] text-amber-900 dark:border-amber-700/40 dark:bg-amber-500/10 dark:text-amber-200">
            Store this somewhere safe. We hash it on the server — there's no way
            to display it again.
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={onClose}
              className="inline-flex h-8 items-center rounded-md bg-foreground px-3 text-[12.5px] font-medium text-background transition hover:opacity-90"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
