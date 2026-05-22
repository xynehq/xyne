import { useEffect } from "react"
import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core"
import { MessageSquare } from "lucide-react"
import { useState } from "react"
import { ApiError, getMe, type Me } from "@/lib/api"
import { Sidebar } from "@/components/Sidebar"
import { ToastHost } from "@/components/Toast"
import { CommandPalette } from "@/components/CommandPalette"
import { UploadTray } from "@/components/UploadTray"
import { useChatHistory } from "@/hooks/useChatHistory"
import { chatStore } from "@/lib/chat-store"
import { projectsStore } from "@/lib/projects-store"
import {
  closeFilePalette,
  toggleFilePalette,
  useFilePaletteState,
} from "@/lib/palette-store"

const CONV_DRAG_PREFIX = "conv-"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async (): Promise<{ me: Me }> => {
    try {
      return { me: await getMe() }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw redirect({ to: "/signin", replace: true })
      }
      throw err
    }
  },
  component: AuthenticatedLayout,
})

function AuthenticatedLayout(): JSX.Element {
  const { me } = Route.useRouteContext()
  const navigate = useNavigate()
  const chat = useChatHistory()
  const palette = useFilePaletteState()

  // DnD lives at the layout level so the project detail page (rendered via
  // <Outlet />) can register its own drop zone alongside the sidebar's
  // project rows. 4 px activation distance keeps clicks from being read as
  // drags. The drop handler routes any `conv-<id>` dragged onto a
  // `project-<id>` target through projectsStore.moveConversation.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
  )
  // Track the active drag so DragOverlay can render a floating ghost. The
  // overlay is portalled at the body level — that's how it escapes the
  // sidebar's `overflow: hidden` and follows the cursor all the way into
  // the project page area.
  const [activeDrag, setActiveDrag] = useState<{
    id: string
    title: string
  } | null>(null)

  const handleDragStart = (event: DragStartEvent): void => {
    const activeId = String(event.active.id)
    if (!activeId.startsWith(CONV_DRAG_PREFIX)) return
    const convId = activeId.slice(CONV_DRAG_PREFIX.length)
    const conv = chatStore.getList().find((c) => c.id === convId)
    setActiveDrag({ id: convId, title: conv?.title ?? "Untitled" })
  }
  const handleDragEnd = (event: DragEndEvent): void => {
    setActiveDrag(null)
    const { active, over } = event
    if (!over) return
    const activeId = String(active.id)
    if (!activeId.startsWith(CONV_DRAG_PREFIX)) return
    // Read the destination project from over.data, not from over.id.
    // Multiple droppables can target the same project at once (the sidebar
    // row + the project page's empty card or drop strip when you're on
    // that project's page). They share `data.projectId` but use distinct
    // ids so @dnd-kit's id-keyed droppable map doesn't have them clobber
    // each other.
    const data = over.data.current as
      | { kind?: string; projectId?: unknown }
      | undefined
    if (!data || data.kind !== "project") return
    const projectId = data.projectId
    if (typeof projectId !== "string") return
    const convId = activeId.slice(CONV_DRAG_PREFIX.length)
    void projectsStore.moveConversation(convId, projectId)
  }
  const handleDragCancel = (): void => {
    setActiveDrag(null)
  }

  // Global ⌘K / Ctrl+K toggles the file palette from any authenticated route.
  // Mounted on `window` (not the route component) so it fires even when the
  // user is deep inside a child component that owns input focus.
  // `preventDefault` wins back from the browser's default ⌘K (URL-bar focus
  // in some Chrome builds).
  useEffect((): (() => void) => {
    const onKey = (e: globalThis.KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault()
        toggleFilePalette()
      }
    }
    window.addEventListener("keydown", onKey)
    return (): void => {
      window.removeEventListener("keydown", onKey)
    }
  }, [])

  return (
    <DndContext
      sensors={sensors}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex h-full bg-background">
        <Sidebar
          me={me}
          {...chat}
          onAccount={(): void => {
            void navigate({ to: "/account" })
          }}
        />
        <div className="flex h-full min-w-0 flex-1 flex-col">
          <Outlet />
        </div>
        <ToastHost />
        <CommandPalette
          open={palette.open}
          initialQuery={palette.initialQuery}
          onClose={closeFilePalette}
        />
        <UploadTray />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDrag ? (
          <div className="pointer-events-none flex h-9 max-w-[260px] items-center gap-2 rounded-lg bg-surface-elevated px-2.5 text-[13px] text-foreground shadow-xl ring-1 ring-border">
            <MessageSquare
              className="h-3.5 w-3.5 shrink-0"
              aria-hidden
              strokeWidth={1.75}
            />
            <span className="truncate">{activeDrag.title}</span>
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  )
}
