import {
  createFileRoute,
  useRouterState,
  redirect,
} from "@tanstack/react-router"
import { Sidebar } from "@/components/Sidebar"
import { IntegrationsSidebar } from "@/components/IntegrationsSidebar"
import { PublicUser, PublicWorkspace, UserRole } from "shared/types"
import { MarkdownProcessor } from "@/components/MarkdownProcessor"
import { errorComponent } from "@/components/error"

interface PrivateStoreIntegrationProps {
  user: PublicUser
  workspace: PublicWorkspace
}

function PrivateStoreIntegration({
  user,
  workspace,
}: PrivateStoreIntegrationProps) {
  return (
    <div className="flex h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user?.role} />
      <div className="flex-1 flex items-center justify-center bg-white">
        <div className="w-full max-w-3xl px-8">
          <MarkdownProcessor />
        </div>
      </div>
    </div>
  )
}

export const Route = createFileRoute(
  "/_authenticated/admin/integrations/private-store",
)({
  beforeLoad: async ({ params, context }) => {
    const userWorkspace = context
    // Only allow admins to access this route
    if (
      userWorkspace?.user?.role !== UserRole.SuperAdmin &&
      userWorkspace?.user?.role !== UserRole.Admin
    ) {
      throw redirect({ to: "/integrations/private-store" })
    }
    return params
  },
  loader: async (params) => {
    return params
  },
  component: () => {
    const matches = useRouterState({ select: (s) => s.matches })
    const { user, workspace } = matches[matches.length - 1].context
    return <PrivateStoreIntegration user={user} workspace={workspace} />
  },
  errorComponent: errorComponent,
})
