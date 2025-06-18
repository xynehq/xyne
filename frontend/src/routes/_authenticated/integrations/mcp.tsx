import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { MCPClient } from "../admin/integrations/mcp"

export const Route = createFileRoute("/_authenticated/integrations/mcp")({
  beforeLoad: async ({ params, context }) => {
    // @ts-ignore
    const userWorkspace = context
    // Admins should be redirected to visit /admin/integrations
    // if (
    //   userWorkspace?.user?.role === UserRole.SuperAdmin ||
    //   userWorkspace?.user?.role === UserRole.Admin
    // ) {
    //   throw redirect({ to: '/admin/integrations/' })
    // }
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace, agentWhiteList } =
      matches[matches.length - 1].context
    return (
      <MCPClient
        user={user}
        workspace={workspace}
        agentWhiteList={agentWhiteList}
      />
    )
  },
})
