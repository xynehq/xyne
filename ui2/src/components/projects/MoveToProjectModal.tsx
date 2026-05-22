// Searchable list modal for moving a conversation into a project. Same
// portal + scrim + ESC pattern as CreateProjectModal. When the conversation
// is already in a project, surfaces a "Remove from project" affordance at
// the top of the list. A "Create new project…" entry sits at the bottom and
// chains into CreateProjectModal so the user can move-and-create in one go.

import { useEffect, useId, useMemo, useRef, useState } from "react"
import { createPortal } from "react-dom"
import { Check, FolderClosed, Loader2, Plus, Search, X } from "lucide-react"
import { cn } from "@/lib/utils"
import { projectsStore, useProjects } from "@/lib/projects-store"
import { chatStore } from "@/lib/chat-store"
import { CreateProjectModal } from "./CreateProjectModal"

type Props = {
  /** Conversation to move. When null the modal is closed. */
  conversationId: string | null
  onClose: () => void
}

export function MoveToProjectModal({
  conversationId,
  onClose,
}: Props): JSX.Element | null {
  const projects = useProjects()
  const [loaded, setLoaded] = useState(projectsStore.isAllLoaded())
  const [query, setQuery] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)
  const labelId = useId()

  const open = conversationId !== null
  const currentFolderId = conversationId
    ? chatStore.getConvFolder(conversationId)
    : null

  // Reset state every open.
  useEffect((): void => {
    if (open) {
      setQuery("")
      setError(null)
      setBusy(false)
    }
  }, [open])

  // Hydrate the full project list on first open (the sidebar only loads the
  // top 3, so the modal needs its own fetch). De-duped inside the store.
  useEffect((): void => {
    if (!open || loaded) return
    void projectsStore.loadAll().then((): void => {
      setLoaded(true)
    })
  }, [open, loaded])

  useEffect((): (() => void) | undefined => {
    if (!open) return undefined
    const id = window.setTimeout(() => {
      searchRef.current?.focus()
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

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return projects
    return projects.filter((p) => p.name.toLowerCase().includes(needle))
  }, [projects, query])

  if (!open || !conversationId || typeof document === "undefined") return null

  const doMove = async (folderId: string | null): Promise<void> => {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await projectsStore.moveConversation(conversationId, folderId)
      onClose()
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Couldn't move chat"
      setError(msg)
      setBusy(false)
    }
  }

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[12vh]"
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
          className="relative z-10 flex max-h-[60vh] w-full max-w-[440px] flex-col overflow-hidden rounded-2xl border border-border bg-surface-elevated shadow-2xl animate-scale-in"
          onMouseDown={(e): void => {
            e.stopPropagation()
          }}
        >
          <div className="flex items-start justify-between gap-3 px-4 pb-2 pt-3.5">
            <h2
              id={labelId}
              className="text-[14px] font-semibold leading-tight text-foreground"
            >
              Move to project
            </h2>
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

          <div className="px-4 pb-2">
            <div className="relative">
              <Search
                className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
                strokeWidth={1.75}
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                disabled={busy}
                onChange={(e): void => {
                  setQuery(e.target.value)
                }}
                placeholder="Search projects…"
                aria-label="Search projects"
                className="h-9 w-full rounded-lg bg-surface px-3 pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring/40 disabled:opacity-60"
              />
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-1">
            {currentFolderId ? (
              <button
                type="button"
                onClick={(): void => {
                  void doMove(null)
                }}
                disabled={busy}
                className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground disabled:opacity-50"
              >
                <X
                  className="h-3.5 w-3.5 shrink-0"
                  aria-hidden
                  strokeWidth={1.75}
                />
                <span className="block min-w-0 flex-1 truncate text-left">
                  Remove from project
                </span>
              </button>
            ) : null}

            {!loaded ? (
              <div className="space-y-1 px-1 py-2">
                {[60, 80, 50].map((w, i) => (
                  <div
                    key={i}
                    className="h-9 animate-pulse rounded-lg bg-secondary/50"
                    style={{ width: `${String(w)}%` }}
                  />
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <p className="px-3 py-4 text-center text-[12.5px] text-muted-foreground">
                {query.trim()
                  ? "No matching projects"
                  : "You don't have any projects yet"}
              </p>
            ) : (
              <ul className="flex flex-col gap-0.5">
                {filtered.map((p) => {
                  const isCurrent = p.id === currentFolderId
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        disabled={busy || isCurrent}
                        onClick={(): void => {
                          void doMove(p.id)
                        }}
                        className={cn(
                          "flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] transition disabled:opacity-60",
                          isCurrent
                            ? "bg-secondary/40 text-foreground"
                            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                        )}
                      >
                        <FolderClosed
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden
                          strokeWidth={1.75}
                        />
                        <span className="block min-w-0 flex-1 truncate text-left">
                          {p.name}
                        </span>
                        {isCurrent ? (
                          <Check
                            className="h-3.5 w-3.5 shrink-0 text-foreground"
                            aria-hidden
                            strokeWidth={2}
                          />
                        ) : null}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
          </div>

          <div className="border-t border-border px-2 py-1.5">
            <button
              type="button"
              disabled={busy}
              onClick={(): void => {
                setCreateOpen(true)
              }}
              className="flex h-9 w-full items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground disabled:opacity-50"
            >
              <Plus
                className="h-3.5 w-3.5 shrink-0"
                aria-hidden
                strokeWidth={1.75}
              />
              <span className="text-left">New project…</span>
            </button>
          </div>

          {error ? (
            <p
              role="alert"
              className="border-t border-border px-4 py-2 text-[11.5px] text-red-600 dark:text-red-400"
            >
              {error}
            </p>
          ) : null}
          {busy ? (
            <div className="absolute inset-x-0 bottom-0 flex items-center justify-center bg-surface-elevated/80 py-1.5 text-[11.5px] text-muted-foreground backdrop-blur">
              <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />
              Moving…
            </div>
          ) : null}
        </div>
      </div>

      <CreateProjectModal
        open={createOpen}
        mode="create"
        onClose={(): void => {
          setCreateOpen(false)
        }}
        onSubmit={async (input): Promise<void> => {
          // Create the project, then immediately drop the conversation into
          // it — a "move-and-create" gesture in a single click.
          const created = await projectsStore.createProject(input)
          setCreateOpen(false)
          await doMove(created.id)
        }}
      />
    </>,
    document.body,
  )
}
