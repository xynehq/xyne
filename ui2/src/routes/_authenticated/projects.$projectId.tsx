import {
  Link,
  createFileRoute,
  useNavigate,
  useRouter,
} from "@tanstack/react-router"
import {
  ArrowLeft,
  FolderInput,
  FolderMinus,
  FolderOpen,
  Inbox,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Trash2,
} from "lucide-react"
import { useDndContext, useDroppable } from "@dnd-kit/core"
import { useEffect, useState } from "react"
import { Topbar } from "@/components/Topbar"
import { CreateProjectModal } from "@/components/projects/CreateProjectModal"
import { MoveToProjectModal } from "@/components/projects/MoveToProjectModal"
import { ConfirmDeleteProjectOverlay } from "@/components/projects/ConfirmDeleteProjectOverlay"
import { MenuPopover } from "@/components/MenuPopover"
import { InlineRenameField } from "@/components/InlineRenameField"
import { InlineConfirmRow } from "@/components/InlineConfirmRow"
import {
  projectsStore,
  useProject,
  useProjectConversations,
} from "@/lib/projects-store"

type RowAction =
  | { id: string; kind: "rename" }
  | { id: string; kind: "confirm-delete" }
  | null

export const Route = createFileRoute("/_authenticated/projects/$projectId")({
  component: ProjectDetailRoute,
})

function ProjectDetailRoute(): JSX.Element {
  const { projectId } = Route.useParams()
  const project = useProject(projectId)
  // Subscribed via the store so moves into this project (via sidebar drag
  // or the move-to-project modal) reflect on this open page without a
  // manual refresh.
  const conversations = useProjectConversations(projectId)
  const navigate = useNavigate()
  const router = useRouter()

  const [convError, setConvError] = useState<string | null>(null)
  const [editOpen, setEditOpen] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Conversation-row state — mirrors ChatHistory's inline rename/delete
  // pattern. The move-to-project modal is portalled so we just track which
  // conversation to move.
  const [rowAction, setRowAction] = useState<RowAction>(null)
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)

  useEffect((): (() => void) => {
    let cancelled = false
    // Hydrate the project (deep-link path: sidebar might not have loaded yet).
    void projectsStore.loadProject(projectId).catch((err: Error): void => {
      if (!cancelled) setError(err.message)
    })
    void projectsStore
      .loadProjectConversations(projectId)
      .catch((err: Error): void => {
        if (!cancelled) setConvError(err.message)
      })
    return (): void => {
      cancelled = true
    }
  }, [projectId])

  return (
    <div className="flex h-full flex-col">
      <Topbar title={project?.name ?? "Project"} />

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-background/70 px-5 py-2.5 backdrop-blur-md">
        <Link
          to="/projects"
          className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-[12.5px] text-muted-foreground transition hover:bg-secondary hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={1.75} />
          All projects
        </Link>
        {project ? (
          <MenuPopover
            align="right"
            trigger={({ open, toggle }): JSX.Element => (
              <button
                type="button"
                aria-label="Project actions"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={(): void => {
                  toggle()
                }}
                className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-secondary hover:text-foreground"
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
                label: "Edit details",
                onClick: (): void => {
                  setEditOpen(true)
                },
              },
              {
                icon: Trash2,
                label: "Delete project",
                tone: "danger",
                onClick: (): void => {
                  setConfirmDelete(true)
                },
              },
            ]}
          />
        ) : null}
      </div>

      <main className="flex-1 overflow-auto px-5 py-5">
        <div className="mx-auto w-full max-w-4xl">
          {error ? (
            <p className="mb-3 text-[12px] text-destructive">{error}</p>
          ) : null}

          {project ? (
            <header className="mb-6 flex items-start gap-3">
              <span
                aria-hidden
                className="grid h-12 w-12 flex-shrink-0 place-items-center rounded-2xl bg-surface-muted text-foreground"
              >
                <FolderOpen className="h-6 w-6" strokeWidth={1.5} />
              </span>
              <div className="min-w-0">
                <h1 className="truncate text-[18px] font-semibold leading-tight text-foreground">
                  {project.name}
                </h1>
                {project.description ? (
                  <p className="mt-1 text-[13px] leading-snug text-muted-foreground">
                    {project.description}
                  </p>
                ) : (
                  <p className="mt-1 text-[13px] italic text-muted-foreground/70">
                    No description.
                  </p>
                )}
              </div>
            </header>
          ) : (
            <div
              className="mb-6 h-16 animate-breathe rounded-2xl bg-surface-elevated"
              aria-hidden
            />
          )}

          <section>
            <h2 className="mb-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80">
              Conversations
            </h2>
            {convError ? (
              <p className="text-[12px] text-destructive">{convError}</p>
            ) : conversations === null ? (
              <ul className="space-y-1.5">
                {[80, 65, 70, 55].map((w, i) => (
                  <li
                    key={i}
                    className="h-10 animate-pulse rounded-lg bg-secondary/50"
                    style={{ width: `${String(w)}%` }}
                  />
                ))}
              </ul>
            ) : conversations.length === 0 ? (
              <EmptyDropZone projectId={projectId} />
            ) : (
              <>
                <DropStrip projectId={projectId} />
                <ul className="flex flex-col gap-1">
                  {conversations.map((c) => {
                  const mode =
                    rowAction?.id === c.id ? rowAction.kind : null
                  if (mode === "rename") {
                    return (
                      <li key={c.id}>
                        <InlineRenameField
                          initial={c.title}
                          onCancel={(): void => {
                            setRowAction(null)
                          }}
                          onCommit={async (next): Promise<void> => {
                            if (!next || next === c.title) {
                              setRowAction(null)
                              return
                            }
                            try {
                              await projectsStore.renameConversation(c.id, next)
                            } finally {
                              setRowAction(null)
                            }
                          }}
                        />
                      </li>
                    )
                  }
                  if (mode === "confirm-delete") {
                    return (
                      <li key={c.id}>
                        <InlineConfirmRow
                          message={
                            <>
                              Delete{" "}
                              <span className="text-foreground">
                                {c.title || "Untitled"}
                              </span>
                              ?
                            </>
                          }
                          confirmLabel="Delete"
                          tone="danger"
                          onCancel={(): void => {
                            setRowAction(null)
                          }}
                          onConfirm={async (): Promise<void> => {
                            await projectsStore.deleteConversation(c.id)
                            setRowAction(null)
                          }}
                        />
                      </li>
                    )
                  }
                  return (
                    <li key={c.id} className="group relative">
                      <Link
                        to="/c/$chatId"
                        params={{ chatId: c.id }}
                        className="flex h-9 w-full items-center gap-2 rounded-lg pl-2.5 pr-9 text-[13px] text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
                      >
                        <MessageSquare
                          className="h-3.5 w-3.5 shrink-0"
                          aria-hidden
                          strokeWidth={1.75}
                        />
                        <span className="block min-w-0 flex-1 truncate">
                          {c.title || "Untitled"}
                        </span>
                      </Link>
                      <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
                        <MenuPopover
                          align="right"
                          trigger={({ open, toggle }): JSX.Element => (
                            <button
                              type="button"
                              aria-label="More actions"
                              aria-haspopup="menu"
                              aria-expanded={open}
                              onClick={(e): void => {
                                e.preventDefault()
                                e.stopPropagation()
                                toggle()
                              }}
                              className={
                                "grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition-[background-color,color,opacity] duration-150 hover:bg-background/80 hover:text-foreground " +
                                (open
                                  ? "bg-background/80 text-foreground opacity-100"
                                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")
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
                                setRowAction({ id: c.id, kind: "rename" })
                              },
                            },
                            {
                              icon: FolderInput,
                              label: "Move",
                              onClick: (): void => {
                                setMoveTargetId(c.id)
                              },
                            },
                            {
                              icon: FolderMinus,
                              label: "Remove",
                              onClick: (): void => {
                                void projectsStore.moveConversation(c.id, null)
                              },
                            },
                            {
                              icon: Trash2,
                              label: "Delete",
                              tone: "danger",
                              onClick: (): void => {
                                setRowAction({
                                  id: c.id,
                                  kind: "confirm-delete",
                                })
                              },
                            },
                          ]}
                        />
                      </div>
                    </li>
                  )
                })}
                </ul>
              </>
            )}
          </section>
        </div>
      </main>

      <MoveToProjectModal
        conversationId={moveTargetId}
        onClose={(): void => {
          setMoveTargetId(null)
        }}
      />

      {project ? (
        <CreateProjectModal
          open={editOpen}
          mode="edit"
          initialName={project.name}
          initialDescription={project.description ?? ""}
          onClose={(): void => {
            setEditOpen(false)
          }}
          onSubmit={async (input): Promise<void> => {
            await projectsStore.renameProject(project.id, input)
            setEditOpen(false)
          }}
        />
      ) : null}

      {confirmDelete && project ? (
        <ConfirmDeleteProjectOverlay
          name={project.name}
          onCancel={(): void => {
            setConfirmDelete(false)
          }}
          onConfirm={async (): Promise<void> => {
            await projectsStore.deleteProject(project.id)
            setConfirmDelete(false)
            await navigate({ to: "/projects" })
            // Refresh the chat sidebar so any conversations that were inside
            // this project drop their folderId. router.invalidate() rehydrates
            // route loaders; cheap and matches the agents-page delete pattern.
            await router.invalidate()
          }}
        />
      ) : null}
    </div>
  )
}

/** Empty-state card — also the only drop target when the project has no
 *  conversations yet. Lights up when a chat is being dragged over it. */
function EmptyDropZone({ projectId }: { projectId: string }): JSX.Element {
  // Unique id distinct from the sidebar ProjectRow's droppable (which uses
  // `project-row-<id>`). Without this distinction @dnd-kit's id-keyed
  // droppable map silently overwrites whichever registered second, and
  // when this page unmounts that map entry vanishes — leaving the
  // sidebar's row orphaned even though its React component is still
  // mounted. The handler routes off `data.projectId`, so the id only
  // needs to be globally unique among droppables.
  const { isOver, setNodeRef } = useDroppable({
    id: `project-empty-${projectId}`,
    data: { kind: "project", projectId },
  })
  return (
    <div
      ref={setNodeRef}
      className={
        "flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed px-6 py-14 text-center transition-colors duration-150 " +
        (isOver
          ? "border-primary/50 bg-primary/[0.06]"
          : "border-border bg-surface-elevated/30")
      }
    >
      <span
        aria-hidden
        className={
          "grid h-12 w-12 place-items-center rounded-2xl transition-colors " +
          (isOver
            ? "bg-primary/15 text-foreground"
            : "bg-surface-muted text-muted-foreground")
        }
      >
        <Inbox className="h-5 w-5" strokeWidth={1.5} aria-hidden />
      </span>
      <div>
        <p className="text-[14px] font-medium text-foreground">
          {isOver ? "Drop to add to this project" : "Drag chats here"}
        </p>
        <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">
          Pull any chat from the sidebar onto this card to group it here.
          You can also use the chat&apos;s ⋯ menu and pick Move.
        </p>
      </div>
    </div>
  )
}

/** A thin drop slot rendered above the conversation list — but only while a
 *  drag is actually in progress. When idle, the list reads as a plain list;
 *  during a drag, this strip appears to show exactly where the dropped chat
 *  will land (top of the list). */
function DropStrip({ projectId }: { projectId: string }): JSX.Element | null {
  const { active } = useDndContext()
  // See EmptyDropZone above — needs an id distinct from the sidebar
  // ProjectRow's `project-row-<id>` droppable for the same project, or
  // they'll clobber each other in @dnd-kit's id-keyed map.
  const { isOver, setNodeRef } = useDroppable({
    id: `project-strip-${projectId}`,
    data: { kind: "project", projectId },
  })
  const isConvDrag =
    active !== null && String(active.id).startsWith("conv-")
  if (!isConvDrag) return null
  return (
    <div
      ref={setNodeRef}
      className={
        "mb-2 flex h-9 items-center justify-center rounded-lg border-2 border-dashed text-[12px] transition-colors duration-150 " +
        (isOver
          ? "border-primary/50 bg-primary/[0.08] text-foreground"
          : "border-border bg-surface-elevated/40 text-muted-foreground")
      }
    >
      {isOver ? "Release to add to this project" : "Drop a chat here"}
    </div>
  )
}
