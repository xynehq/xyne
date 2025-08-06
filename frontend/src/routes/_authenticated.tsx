import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { errorComponent } from "@/components/error"
import { authFetch } from "@/utils/authFetch"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    // Try to get user info
    const res = await authFetch("/api/v1/me")
    if (res.ok) return res.json()

    // If still not ok after refresh, redirect to login
    throw redirect({ to: "/auth" })
  },
  component: () => {
    return <Outlet />
  },
  errorComponent: errorComponent,
})
