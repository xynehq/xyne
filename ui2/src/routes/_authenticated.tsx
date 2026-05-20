import { useEffect } from "react"
import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { ApiError, getMe, type Me } from "@/lib/api"
import { Sidebar } from "@/components/Sidebar"
import { ToastHost } from "@/components/Toast"
import { CommandPalette } from "@/components/CommandPalette"
import { UploadTray } from "@/components/UploadTray"
import { useChatHistory } from "@/hooks/useChatHistory"
import {
  closeFilePalette,
  toggleFilePalette,
  useFilePaletteState,
} from "@/lib/palette-store"

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
  )
}
