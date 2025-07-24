import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Dashboard } from "../../components/Dashboard"

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, agentWhiteList } = matches[matches.length - 1].context
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
