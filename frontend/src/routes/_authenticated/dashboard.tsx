import { createFileRoute } from "@tanstack/react-router"
import { Dashboard } from "../../components/Dashboard"

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: () => {
    const { user, agentWhiteList } = Route.useRouteContext()
    return (
      <Dashboard
        user={user}
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
    )
  },
})
