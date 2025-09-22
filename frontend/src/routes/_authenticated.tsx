import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { errorComponent } from "@/components/error"
import { authFetch } from "@/utils/authFetch"

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async () => {
    // Get user timezone
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone

    // Try to get user info and send timezone
    const res = await authFetch(
      `/api/v1/me?timeZone=${encodeURIComponent(timeZone)}`,
    )
    if (res.ok) return res.json()

    // If still not ok after refresh, redirect to login
    throw redirect({ to: "/auth" })
  },
  component: () => {
    return <Outlet />
  },
  errorComponent: errorComponent,
})
