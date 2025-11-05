import { createFileRoute, Outlet, useRouterState } from "@tanstack/react-router"
import BuzzSidebar from "@/components/BuzzSidebar"
import { Sidebar } from "@/components/Sidebar"

export const Route = createFileRoute("/_authenticated/buzz")({
  component: BuzzLayout,
})

function BuzzLayout() {
  const matches = useRouterState({ select: (s) => s.matches })
  const { user, agentWhiteList } = matches[matches.length - 1].context

  return (
    <>
      <Sidebar
        photoLink={user?.photoLink ?? ""}
        role={user?.role}
        isAgentMode={agentWhiteList}
      />
      <BuzzSidebar />
      <Outlet />
    </>
  )
}
