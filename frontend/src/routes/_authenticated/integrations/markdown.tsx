import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { PublicUser, PublicWorkspace, UserRole } from "shared/types"
import { MarkdownProcessor } from "@/components/MarkdownProcessor"
import { errorComponent } from "@/components/error"

interface MarkdownIntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
}

const MarkdownIntegration = ({ user, workspace }: MarkdownIntegrationProps) => {
  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user.role} />
      <div className="w-full h-full flex items-center justify-center">
        <div className="flex flex-col h-full items-center justify-center">
          <MarkdownProcessor isAdmin={false} />
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authenticated/integrations/markdown")({
  beforeLoad: async ({ params, context }) => {
    const userWorkspace = context
    // Admins should be redirected to visit /admin/integrations
    if (
      userWorkspace?.user?.role === UserRole.SuperAdmin ||
      userWorkspace?.user?.role === UserRole.Admin
    ) {
      throw redirect({ to: "/admin/integrations/markdown" })
    }
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <MarkdownIntegration user={user} workspace={workspace} />
  },
  errorComponent: errorComponent,
})

function redirect(arg0: { to: string }) {
  throw new Error("Function not implemented.")
}
