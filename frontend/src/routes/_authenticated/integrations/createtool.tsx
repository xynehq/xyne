import { IntegrationsSidebar } from '@/components/IntegrationsSidebar'
import { useRouterState } from "@tanstack/react-router"
import { createFileRoute } from '@tanstack/react-router'
import { Sidebar } from "@/components/Sidebar"
import { MCPClient } from '../admin/integrations/mcp'
import { useState } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export const Route = createFileRoute('/_authenticated/integrations/createtool')(
  {
    component: RouteComponent,
  },
)

function RouteComponent() {

  const matches = useRouterState({ select: (s) => s.matches })
  const [toolName, setToolName] = useState("")
  const { user, workspace, agentWhiteList } =
    matches[matches.length - 1].context
  // const [state, setState] = useState<String>("")]
  // useEffect(() => {
  //   setState("")
  // }, [])
  return (
    <div className="flex w-full h-full">
      <Sidebar photoLink={user?.photoLink ?? ""} role={user?.role} />
      <IntegrationsSidebar role={user.role} isAgentMode={agentWhiteList} />
      <div className="w-full">
        <Label
          htmlFor="toolName"
          className="text-sm font-medium text-gray-700 dark:text-gray-300"
        >
          Name
        </Label>
        <Input
          id="agentName"
          value={toolName}
          onChange={(e) => setToolName(e.target.value)}
          className="mt-1 bg-white dark:bg-slate-700 border border-gray-300 dark:border-slate-600 rounded-lg w-full text-base h-11 px-3 dark:text-gray-100"
        />
      </div>
    </div>
  )
}
