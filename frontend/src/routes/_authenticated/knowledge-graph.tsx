import { createFileRoute, useRouterState } from "@tanstack/react-router"
import { KnowledgeGraph } from "../../components/KnowledgeGraph"
import { Sidebar } from "../../components/Sidebar"
import { errorComponent } from "@/components/error"

const KnowledgeGraphPage = () => {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context

  return (
    <div className="h-full w-full flex dark:bg-[#1E1E1E]">
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <div className="flex flex-col flex-grow h-full ml-[52px]">
        <KnowledgeGraph />
      </div>
    </div>
  )
}

export const Route = createFileRoute("/_authenticated/knowledge-graph")({
  component: KnowledgeGraphPage,
  errorComponent: errorComponent,
})
