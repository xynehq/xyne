import { Outlet, createFileRoute } from "@tanstack/react-router"

// Pure layout wrapper for /agents/:agentId. The view lives in
// `agents.$agentId.index.tsx` and the edit form in
// `agents.$agentId.edit.tsx`; this file exists so the parent path renders an
// outlet that the children can mount into.
export const Route = createFileRoute("/_authenticated/agents/$agentId")({
  component: () => <Outlet />,
})
