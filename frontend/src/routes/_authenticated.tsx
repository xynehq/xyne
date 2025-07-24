import { createFileRoute, Outlet, redirect } from "@tanstack/react-router"
import { api } from "@/api"
import { errorComponent } from "@/components/error"

async function refreshToken(): Promise<any> {
  try {
    const response = await fetch("/api/v1/refresh-token", {
      method: "POST",
      credentials: "include",
    })
    if (response.ok) {
      const json = response.json()
      return json
    }
  } catch {
    return false
  }
}

export const Route = createFileRoute("/_authenticated")({
  beforeLoad: async ({ context }) => {
    try {
      const res = await api.me.$get()
      if (!res.ok) {
        // If user is not logged in, take user to '/auth'
        const refreshSuccess = await refreshToken()
        if (refreshSuccess?.msg) {
          console.log("Everything working fine....")
          // todo basically try to do a retry here
          const res = await api.me.$get()
          return await res.json()
        } else {
          throw redirect({ to: "/auth" })
        }
      }

      return await res.json()
    } catch (e) {
      throw redirect({ to: "/auth" })
    }
  },
  component: () => {
    return <Outlet />
  },
  errorComponent: errorComponent,
})
