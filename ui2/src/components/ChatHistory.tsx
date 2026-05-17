import { useMemo, useRef, useState } from "react"
import { MessageSquarePlus, MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { SidebarListRow } from "./SidebarListRow"
import { InlineRenameField } from "./InlineRenameField"
import { InlineConfirmRow } from "./InlineConfirmRow"
import { MenuPopover } from "./MenuPopover"

export type ChatHistoryItem = {
  id: string
  title: string
  updatedAt: number
}

type Props = {
  items: ChatHistoryItem[]
  activeId?: string | undefined
  loading?: boolean | undefined
  query?: string | undefined
  emptyTitle?: string | undefined
  emptySubtitle?: string | undefined
  sectionLabel?: string | undefined
  onSelect: (id: string) => void
  onRename: (id: string, title: string) => Promise<void>
  onDelete: (id: string) => Promise<void>
}

type RowAction =
  | { id: string; kind: "rename" }
  | { id: string; kind: "confirm-delete" }
  | null

export function ChatHistory({
  items,
  activeId,
  loading,
  query = "",
  emptyTitle = "No conversations yet",
  emptySubtitle = "Start a new chat above to see it here.",
  sectionLabel = "Recents",
  onSelect,
  onRename,
  onDelete,
}: Props): JSX.Element {
  const [action, setAction] = useState<RowAction>(null)
  // Keyed refs to each row's button so we can restore focus after an inline
  // edit/cancel — otherwise focus snaps to <body> and Tab restarts.
  const rowRefs = useRef(new Map<string, HTMLButtonElement>())

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return items
    return items.filter((it) => it.title.toLowerCase().includes(q))
  }, [items, query])

  // Close any inline action and restore keyboard focus to the row's button on
  // the next paint (after React commits the swapped-in display row).
  const exitAction = (focusBackId: string): void => {
    setAction(null)
    requestAnimationFrame(() => {
      rowRefs.current.get(focusBackId)?.focus()
    })
  }

  if (loading && items.length === 0) {
    return <SkeletonList />
  }

  if (filtered.length === 0) {
    return (
      <EmptyHint
        hasQuery={query.trim().length > 0}
        query={query}
        title={emptyTitle}
        subtitle={emptySubtitle}
      />
    )
  }

  return (
    <div>
      <div className="px-2.5 pb-1 pt-3 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
        {sectionLabel}
      </div>
      <ul className="flex flex-col gap-0.5">
        {filtered.map((it) => {
          const mode = action?.id === it.id ? action.kind : null
          if (mode === "rename") {
            return (
              <li key={it.id}>
                <InlineRenameField
                  initial={it.title}
                  onCancel={(): void => {
                    exitAction(it.id)
                  }}
                  onCommit={async (next): Promise<void> => {
                    if (!next || next === it.title) {
                      exitAction(it.id)
                      return
                    }
                    try {
                      await onRename(it.id, next)
                    } finally {
                      exitAction(it.id)
                    }
                  }}
                />
              </li>
            )
          }
          if (mode === "confirm-delete") {
            return (
              <li key={it.id}>
                <InlineConfirmRow
                  message={
                    <>
                      Delete{" "}
                      <span className="text-foreground">
                        {it.title || "Untitled"}
                      </span>
                      ?
                    </>
                  }
                  confirmLabel="Delete"
                  tone="danger"
                  onCancel={(): void => {
                    exitAction(it.id)
                  }}
                  onConfirm={async (): Promise<void> => {
                    await onDelete(it.id)
                  }}
                />
              </li>
            )
          }
          return (
            <li key={it.id}>
              <SidebarListRow
                title={it.title}
                active={it.id === activeId}
                ariaCurrent={it.id === activeId ? "page" : undefined}
                onClick={(): void => {
                  onSelect(it.id)
                }}
                buttonRef={(el): void => {
                  if (el) {
                    rowRefs.current.set(it.id, el)
                  } else {
                    rowRefs.current.delete(it.id)
                  }
                }}
                actions={
                  <MenuPopover
                    align="right"
                    trigger={({ open, toggle }): JSX.Element => (
                      <button
                        type="button"
                        aria-label="More actions"
                        aria-haspopup="menu"
                        aria-expanded={open}
                        onClick={(e): void => {
                          e.stopPropagation()
                          toggle()
                        }}
                        className={
                          "grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-background/80 hover:text-foreground " +
                          (open ? "bg-background/80 text-foreground" : "")
                        }
                      >
                        <MoreHorizontal
                          className="h-4 w-4"
                          aria-hidden
                          strokeWidth={1.75}
                        />
                      </button>
                    )}
                    items={[
                      {
                        icon: Pencil,
                        label: "Rename",
                        onClick: (): void => {
                          setAction({ id: it.id, kind: "rename" })
                        },
                      },
                      {
                        icon: Trash2,
                        label: "Delete",
                        tone: "danger",
                        onClick: (): void => {
                          setAction({ id: it.id, kind: "confirm-delete" })
                        },
                      },
                    ]}
                  />
                }
              />
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ─── Internals ──────────────────────────────────────────────────────────────
function EmptyHint({
  hasQuery,
  query,
  title,
  subtitle,
}: {
  hasQuery: boolean
  query: string
  title: string
  subtitle: string
}): JSX.Element {
  return (
    <div className="px-3 pt-10 text-center">
      <div className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-secondary/60">
        <MessageSquarePlus
          className="h-4 w-4 text-muted-foreground"
          aria-hidden
          strokeWidth={1.5}
        />
      </div>
      {hasQuery ? (
        <p className="text-[12.5px] text-muted-foreground">
          No matches for{" "}
          <span className="text-foreground">&quot;{query}&quot;</span>
        </p>
      ) : (
        <>
          <p className="text-[13px] text-foreground">{title}</p>
          <p className="mt-1 text-[12px] text-muted-foreground">{subtitle}</p>
        </>
      )}
    </div>
  )
}

function SkeletonList(): JSX.Element {
  return (
    <div className="space-y-1.5 px-2 pt-3">
      {[60, 80, 45, 70, 55, 80, 50].map((w, i) => (
        <div
          key={i}
          className="h-9 animate-pulse rounded-lg bg-secondary/50"
          style={{ width: `${String(w)}%` }}
        />
      ))}
    </div>
  )
}
