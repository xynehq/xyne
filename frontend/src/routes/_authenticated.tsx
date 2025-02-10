import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context }) => {
    const res = await api.me.$get()
    if (!res.ok) {
      // If user is not logged in, take user to '/auth'
      throw redirect({ to: "/auth" })
    }

    return await res.json()
  },
  component: () => {
    return <Outlet />
  },
  errorComponent: errorComponent,
})
