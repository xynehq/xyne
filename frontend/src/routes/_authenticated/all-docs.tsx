import { createFileRoute } from '@tanstack/react-router'
import { AllDocsPage } from '@/components/AllDocsPage'
import { Sidebar } from '@/components/Sidebar'
import { useRouterState } from '@tanstack/react-router'
import { errorComponent } from '@/components/error'

const AllDocsRoute = () => {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context

  return (
    <div className="flex h-screen bg-gray-50 dark:bg-gray-900">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="flex-1 ml-[52px] overflow-auto">
        <AllDocsPage />
      </div>
    </div>
  )
}

export const Route = createFileRoute('/_authenticated/all-docs')({
  component: AllDocsRoute,
  errorComponent: errorComponent,
})
