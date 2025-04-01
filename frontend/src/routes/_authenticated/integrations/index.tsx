import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"

export const Route = createFileRoute("/_authenticated/integrations/")({
  component: RouteComponent,
})

function RouteComponent() {
  const navigate = useNavigate()

  useEffect(() => {
    navigate({ to: "/integrations/google", replace: true })
  }, [navigate])

  return <></>
}
