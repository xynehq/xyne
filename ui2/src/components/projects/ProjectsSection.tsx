// Sidebar section that shows the top N most-used projects with a hover-
// revealed "+" button on the section header. Self-loads on mount; consumers
// just have to render <ProjectsSection /> inside the expanded sidebar shell.
//
// Auto-expand: when the user is on a chat that belongs to a project, that
// project's row is pinned (if it wasn't in the top-N) and expanded inline
// with its conversation list so the active chat is always discoverable.
//
// Drag-and-drop drop targets are wired here (each project row is a drop
// zone for chat conversations). The corresponding draggable side lives on
// ChatHistory rows.

import { Link, useLocation, useNavigate } from "@tanstack/react-router"
import { useDraggable, useDroppable } from "@dnd-kit/core"
import {
  ChevronRight,
  FolderClosed,
  FolderInput,
  FolderMinus,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  Trash2,
} from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { useConversation, useConversationList } from "@/lib/chat-store"
import {
  projectsStore,
  useProject,
  useProjectConversations,
  useProjects,
  useTopProjects,
  type ProjectConv,
} from "@/lib/projects-store"
import { MenuPopover } from "@/components/MenuPopover"
import { InlineRenameField } from "@/components/InlineRenameField"
import { InlineConfirmRow } from "@/components/InlineConfirmRow"
import { CreateProjectModal } from "./CreateProjectModal"
import { ConfirmDeleteProjectOverlay } from "./ConfirmDeleteProjectOverlay"
import { MoveToProjectModal } from "./MoveToProjectModal"

type ConvRowAction =
  | { id: string; kind: "rename" }
  | { id: string; kind: "confirm-delete" }
  | null

type Props = {
  /** Active chat id from the parent layout. When the chat belongs to a
   *  project, that project is pinned + expanded inline so siblings are
   *  one click away. */
  activeChatId?: string | undefined
}

const TOP_LIMIT = 3
const INLINE_CONV_LIMIT = 8

export function ProjectsSection({ activeChatId }: Props): JSX.Element {
  const topProjects = useTopProjects()
  // Full-list count drives the "All projects ›" link visibility — we hide
  // it when everything is already on screen. De-duped + cheap inside the
  // store; safe to call alongside loadTop.
  const allProjects = useProjects()
  const [createOpen, setCreateOpen] = useState(false)
  const [editTargetId, setEditTargetId] = useState<string | null>(null)
  const [deleteTargetId, setDeleteTargetId] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(projectsStore.isTopLoaded())
  const navigate = useNavigate()

  // Subscribed reads — keep modal contents in sync if the project gets
  // renamed elsewhere while the menu is open.
  const editTarget = useProject(editTargetId ?? "")
  const deleteTarget = useProject(deleteTargetId ?? "")

  // Reactive read of the active chat's parent folder. We deliberately prefer
  // convList over per-conv state — convList is populated by loadList on app
  // mount with folderId for every chat in the top-N, so switching to a chat
  // we haven't opened yet still resolves its folder immediately.
  //
  // Without this, useConversation(Y).folderId would be undefined until
  // loadConvMeta lands, the expanded inline list would collapse for ~100 ms
  // mid-navigation, then re-open once meta arrives — a visible jerk that
  // felt like a page refresh. Per-conv state stays as a fallback for
  // deep-linked chats that aren't in the convList window.
  const allChats = useConversationList()
  const conv = useConversation(activeChatId ?? "")
  const folderFromChat: string | null = useMemo(() => {
    if (!activeChatId) return null
    const fromList = allChats.find((c) => c.id === activeChatId)?.folderId
    if (typeof fromList === "string") return fromList
    if (typeof conv.folderId === "string") return conv.folderId
    return null
  }, [activeChatId, allChats, conv.folderId])

  const { pathname } = useLocation()
  const projectFromPath = projectIdFromPath(pathname)
  // The project to pin + expand inline. Two trigger paths:
  //   • user opened a chat that lives in a project → expand its parent
  //   • user is on /projects/<id> → expand that one so the conv list is one
  //     click away from anywhere in the sidebar
  // Path wins when both apply (rare — only if you deep-link to a project
  // page while a sibling chat is active).
  const expandedProjectId = projectFromPath ?? folderFromChat

  // Cache-backed view of the active project + its conversations. Both can be
  // null briefly while the auto-load below populates them.
  const activeProject = useProject(expandedProjectId ?? "")
  const activeProjectConvs = useProjectConversations(expandedProjectId ?? "")

  useEffect((): void => {
    if (loaded) return
    void projectsStore.loadTop(TOP_LIMIT).then((): void => {
      setLoaded(true)
    })
  }, [loaded])

  // Populate the full list so the "All projects ›" link knows whether there
  // are projects beyond what's visible.
  useEffect((): void => {
    void projectsStore.loadAll()
  }, [])

  // Auto-load the active project + its conversation list so the inline
  // expansion populates without a manual refresh. De-duped inside the store.
  useEffect((): void => {
    if (!expandedProjectId) return
    void projectsStore.loadProject(expandedProjectId)
    void projectsStore.loadProjectConversations(expandedProjectId)
  }, [expandedProjectId])

  // Row highlight: same as expanded, because in both trigger cases the
  // "current location" naturally maps to that project.
  const derivedActive = expandedProjectId

  // Pin the active project at the top of the visible list when it isn't in
  // the top-N rank. Keeps the page (or chat's home) reachable in one glance.
  const projectsToShow = useMemo(() => {
    const top = topProjects.slice(0, TOP_LIMIT)
    if (!expandedProjectId || !activeProject) return top
    if (top.some((p) => p.id === expandedProjectId)) return top
    return [
      {
        ...activeProject,
        lastTouchedAt: null,
        conversationCount: 0,
      },
      ...top,
    ]
  }, [topProjects, expandedProjectId, activeProject])

  return (
    <div className="group/projects">
      <div className="flex items-center justify-between pb-1 pl-2.5 pr-1.5 pt-3">
        <Link
          to="/projects"
          className="text-sm font-medium text-muted-foreground transition hover:text-foreground"
        >
          Projects
        </Link>
        <button
          type="button"
          aria-label="New project"
          title="New project"
          onClick={(): void => {
            setCreateOpen(true)
          }}
          className="grid h-5 w-5 place-items-center rounded text-muted-foreground/70 opacity-0 transition hover:bg-secondary/70 hover:text-foreground group-hover/projects:opacity-100 focus:opacity-100"
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>

      {projectsToShow.length === 0 ? (
        <p className="px-2.5 pb-1 text-[13px] text-muted-foreground/70">
          {loaded ? "No projects yet" : "Loading…"}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {projectsToShow.map((p) => (
            <li key={p.id}>
              <ProjectRow
                id={p.id}
                name={p.name}
                active={derivedActive === p.id}
                onEdit={(): void => {
                  setEditTargetId(p.id)
                }}
                onDelete={(): void => {
                  setDeleteTargetId(p.id)
                }}
              />
              {p.id === expandedProjectId &&
              activeProjectConvs &&
              activeProjectConvs.length > 0 ? (
                <InlineConvList
                  projectId={p.id}
                  convs={activeProjectConvs}
                  activeChatId={activeChatId}
                />
              ) : null}
            </li>
          ))}
          {allProjects.length > projectsToShow.length ? (
            <li>
              <Link
                to="/projects"
                className="flex h-8 w-full items-center justify-between gap-2 rounded-lg pl-2.5 pr-2 text-xs text-muted-foreground transition hover:bg-secondary/60 hover:text-foreground"
              >
                <span>All projects</span>
                <ChevronRight
                  className="h-3.5 w-3.5 shrink-0 opacity-60"
                  aria-hidden
                  strokeWidth={1.75}
                />
              </Link>
            </li>
          ) : null}
        </ul>
      )}

      <CreateProjectModal
        open={createOpen}
        mode="create"
        onClose={(): void => {
          setCreateOpen(false)
        }}
        onSubmit={async (input): Promise<void> => {
          await projectsStore.createProject(input)
          setCreateOpen(false)
        }}
      />

      {editTargetId && editTarget ? (
        <CreateProjectModal
          open
          mode="edit"
          initialName={editTarget.name}
          initialDescription={editTarget.description ?? ""}
          onClose={(): void => {
            setEditTargetId(null)
          }}
          onSubmit={async (input): Promise<void> => {
            await projectsStore.renameProject(editTargetId, input)
            setEditTargetId(null)
          }}
        />
      ) : null}

      {deleteTargetId && deleteTarget ? (
        <ConfirmDeleteProjectOverlay
          name={deleteTarget.name}
          onCancel={(): void => {
            setDeleteTargetId(null)
          }}
          onConfirm={async (): Promise<void> => {
            const targetId = deleteTargetId
            await projectsStore.deleteProject(targetId)
            setDeleteTargetId(null)
            // If the user is currently on the deleted project's page,
            // bounce them back to /projects so they're not staring at a
            // ghost route.
            if (pathname === `/projects/${targetId}`) {
              void navigate({ to: "/projects" })
            }
          }}
        />
      ) : null}
    </div>
  )
}

/** Inline list of conversations under the active project row. Capped so the
 *  sidebar stays scannable; "Show all" links into the project detail page
 *  when the list overflows.
 *
 *  Each row has the same hover ⋯ menu as the project detail page rows
 *  (Rename / Move / Remove / Delete) AND is a @dnd-kit draggable, so the
 *  user can grab a chat out of one project and drop it onto another sidebar
 *  project. */
function InlineConvList({
  projectId,
  convs,
  activeChatId,
}: {
  projectId: string
  convs: ProjectConv[]
  activeChatId?: string | undefined
}): JSX.Element {
  const visible = convs.slice(0, INLINE_CONV_LIMIT)
  const overflow = convs.length - visible.length
  const [rowAction, setRowAction] = useState<ConvRowAction>(null)
  const [moveTargetId, setMoveTargetId] = useState<string | null>(null)
  return (
    <>
      <ul className="mt-0.5 flex flex-col gap-0.5 pl-4">
        {visible.map((c) => (
          <InlineConvRow
            key={c.id}
            conv={c}
            isActive={c.id === activeChatId}
            mode={rowAction?.id === c.id ? rowAction.kind : null}
            onStartRename={(): void => {
              setRowAction({ id: c.id, kind: "rename" })
            }}
            onStartConfirmDelete={(): void => {
              setRowAction({ id: c.id, kind: "confirm-delete" })
            }}
            onStartMove={(): void => {
              setMoveTargetId(c.id)
            }}
            onCancelAction={(): void => {
              setRowAction(null)
            }}
          />
        ))}
        {overflow > 0 ? (
          <li>
            <Link
              to="/projects/$projectId"
              params={{ projectId }}
              className="flex h-7 w-full items-center pl-2 pr-2 text-xs text-muted-foreground/80 transition hover:text-foreground"
            >
              Show all ({convs.length})
            </Link>
          </li>
        ) : null}
      </ul>
      <MoveToProjectModal
        conversationId={moveTargetId}
        onClose={(): void => {
          setMoveTargetId(null)
        }}
      />
    </>
  )
}

/** Single inline conversation row. Owns its draggable hook so the sidebar's
 *  DndContext can route a drop onto another project's row. The hook is
 *  always called (rules of hooks) even when the row is in rename / confirm
 *  mode — setNodeRef just goes unused for those variants. */
function InlineConvRow({
  conv,
  isActive,
  mode,
  onStartRename,
  onStartConfirmDelete,
  onStartMove,
  onCancelAction,
}: {
  conv: ProjectConv
  isActive: boolean
  mode: "rename" | "confirm-delete" | null
  onStartRename: () => void
  onStartConfirmDelete: () => void
  onStartMove: () => void
  onCancelAction: () => void
}): JSX.Element {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `conv-${conv.id}`,
  })

  if (mode === "rename") {
    return (
      <li>
        <InlineRenameField
          className="flex h-8 items-center rounded-md bg-secondary px-1.5"
          inputClassName="h-6 w-full min-w-0 flex-1 rounded bg-transparent px-1.5 text-[13px] text-foreground focus:outline-none"
          initial={conv.title}
          onCancel={onCancelAction}
          onCommit={async (next): Promise<void> => {
            if (!next || next === conv.title) {
              onCancelAction()
              return
            }
            try {
              await projectsStore.renameConversation(conv.id, next)
            } finally {
              onCancelAction()
            }
          }}
        />
      </li>
    )
  }
  if (mode === "confirm-delete") {
    return (
      <li>
        <InlineConfirmRow
          message={
            <>
              Delete{" "}
              <span className="text-foreground">
                {conv.title || "Untitled"}
              </span>
              ?
            </>
          }
          confirmLabel="Delete"
          tone="danger"
          onCancel={onCancelAction}
          onConfirm={async (): Promise<void> => {
            await projectsStore.deleteConversation(conv.id)
            onCancelAction()
          }}
        />
      </li>
    )
  }

  // No inline transform — the floating ghost is rendered by <DragOverlay>
  // in the layout (so it isn't clipped by the sidebar's overflow:hidden).
  // The source fades to signal "picked up".
  return (
    <li
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      className={"group relative " + (isDragging ? "opacity-40" : "")}
    >
      <Link
        to="/c/$chatId"
        params={{ chatId: conv.id }}
        aria-current={isActive ? "page" : undefined}
        className={
          "flex h-8 w-full items-center gap-1.5 rounded-md pl-2 pr-8 text-[13px] transition-colors duration-150 " +
          (isActive
            ? "bg-secondary text-foreground"
            : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground")
        }
      >
        <MessageSquare
          className="h-3 w-3 shrink-0"
          aria-hidden
          strokeWidth={1.75}
        />
        <span className="block min-w-0 flex-1 truncate">
          {conv.title || "Untitled"}
        </span>
      </Link>
      <div className="absolute right-1 top-1/2 -translate-y-1/2">
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
                "grid h-6 w-6 place-items-center rounded text-muted-foreground transition-[background-color,color,opacity] duration-150 hover:bg-background/80 hover:text-foreground " +
                (open
                  ? "bg-background/80 text-foreground opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100")
              }
            >
              <MoreHorizontal
                className="h-3.5 w-3.5"
                aria-hidden
                strokeWidth={1.75}
              />
            </button>
          )}
          items={[
            { icon: Pencil, label: "Rename", onClick: onStartRename },
            { icon: FolderInput, label: "Move", onClick: onStartMove },
            {
              icon: FolderMinus,
              label: "Remove",
              onClick: (): void => {
                void projectsStore.moveConversation(conv.id, null)
              },
            },
            {
              icon: Trash2,
              label: "Delete",
              tone: "danger",
              onClick: onStartConfirmDelete,
            },
          ]}
        />
      </div>
    </li>
  )
}

/** A single project row. Wired up as a @dnd-kit drop target so a chat
 *  dragged from ChatHistory can be released onto it. The drop handler lives
 *  on the parent DndContext (see Sidebar.tsx) — we just signal "over me" via
 *  the visual hover state.
 *
 *  Hover reveals a ⋯ context menu on the right with Edit details / Delete.
 *  Modal state lives in the parent ProjectsSection so a single modal is
 *  shared across rows. */
function ProjectRow({
  id,
  name,
  active,
  onEdit,
  onDelete,
}: {
  id: string
  name: string
  active: boolean
  onEdit: () => void
  onDelete: () => void
}): JSX.Element {
  // Distinct id from the project page's drop zones — both can be mounted
  // at the same time (you're viewing /projects/<id> with the sidebar row
  // for the same project visible). @dnd-kit keys its droppable map by id,
  // so a duplicate id would silently overwrite this registration the
  // moment the project page mounted. The actual destination is read off
  // `data.projectId` in the drop handler, so the id just needs to be
  // unique per droppable, not per project.
  const { isOver, setNodeRef } = useDroppable({
    id: `project-row-${id}`,
    data: { kind: "project", projectId: id },
  })
  return (
    <div ref={setNodeRef} className="group relative">
      <Link
        to="/projects/$projectId"
        params={{ projectId: id }}
        aria-current={active ? "page" : undefined}
        className={
          "flex h-9 w-full items-center gap-2 rounded-lg pl-2.5 pr-9 text-sm transition-colors duration-150 " +
          (isOver
            ? "bg-primary/15 text-foreground ring-1 ring-primary/40 "
            : active
              ? "bg-secondary text-foreground "
              : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground ")
        }
      >
        <FolderClosed
          className="h-3.5 w-3.5 shrink-0"
          aria-hidden
          strokeWidth={1.75}
        />
        <span className="block min-w-0 flex-1 truncate">{name}</span>
      </Link>
      <div className="absolute right-1.5 top-1/2 -translate-y-1/2">
        <MenuPopover
          align="right"
          trigger={({ open, toggle }): JSX.Element => (
            <button
              type="button"
              aria-label="Project actions"
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
              label: "Edit details",
              onClick: onEdit,
            },
            {
              icon: Trash2,
              label: "Delete project",
              tone: "danger",
              onClick: onDelete,
            },
          ]}
        />
      </div>
    </div>
  )
}

const projectIdFromPath = (pathname: string): string | undefined => {
  const m = /^\/projects\/([^/]+)/.exec(pathname)
  return m?.[1]
}
