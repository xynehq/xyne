import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"

export const Route = createFileRoute("/_authenticated/admin/integrations/")({
  component: RouteComponent,
})

function RouteComponent() {
  const navigate = useNavigate()

  useEffect(() => {
    navigate({ to: "/admin/integrations/google", replace: true })
  }, [navigate])

  return <></>
}
