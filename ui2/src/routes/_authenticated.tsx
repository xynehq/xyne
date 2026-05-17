import {
  Outlet,
  createFileRoute,
  redirect,
  useNavigate,
} from "@tanstack/react-router"
import { ApiError, getMe, type Me } from "@/lib/api"
import { Sidebar } from "@/components/Sidebar"
import { ToastHost } from "@/components/Toast"
import { useChatHistory } from "@/hooks/useChatHistory"

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
    </div>
  )
}
