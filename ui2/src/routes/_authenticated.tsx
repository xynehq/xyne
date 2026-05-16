import { Outlet, createFileRoute, redirect } from "@tanstack/react-router"
import { ApiError, getMe, type Me } from "@/lib/api"
import { Sidebar } from "@/components/Sidebar"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async (): Promise<{ me: Me }> => {
    try {
      const me = await getMe()
      return { me }
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        // TanStack Router uses thrown redirects as control flow.
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
  return (
    <div className="flex h-full bg-background">
      <Sidebar me={me} />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Outlet />
      </div>
    </div>
  )
}
