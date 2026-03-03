import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { DatabaseIntegration } from "@/routes/_authenticated/integrations/database"
import type { PublicUser, PublicWorkspace } from "shared/types"

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/database",
)({
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const ctx = matches[matches.length - 1].context as {
      user: PublicUser
      workspace: PublicWorkspace
      agentWhiteList: boolean
    }
    return (
      <DatabaseIntegration
        user={ctx.user}
        workspace={ctx.workspace}
        agentWhiteList={ctx.agentWhiteList}
        isAdmin={true}
      />
    )
  },
})
