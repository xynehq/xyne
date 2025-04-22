import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { PublicUser, PublicWorkspace, UserRole } from "shared/types"
import { MarkdownProcessor } from "@/components/MarkdownProcessor"
import { errorComponent } from "@/components/error"

interface AdminMarkdownIntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
}

const AdminMarkdownIntegration = ({
  user,
  workspace,
}: AdminMarkdownIntegrationProps) => {
  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col h-full items-center justify-center">
          <MarkdownProcessor isAdmin={true} />
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/markdown",
)({
  beforeLoad: async ({ params, context }) => {
    const userWorkspace = context
    // Only admins can access this page
    if (
      userWorkspace?.user?.role !== UserRole.SuperAdmin &&
      userWorkspace?.user?.role !== UserRole.Admin
    ) {
      throw redirect({ to: "/integrations/markdown" })
    }
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <AdminMarkdownIntegration user={user} workspace={workspace} />
  },
  errorComponent: errorComponent,
})
