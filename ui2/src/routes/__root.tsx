import { Outlet, createRootRoute } from "@tanstack/react-router"
import { ThemeProvider } from "@/lib/theme"
import { ModelsProvider } from "@/lib/models"
import { AgentsProvider } from "@/lib/agents"

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent(): JSX.Element {
  return (
    <ThemeProvider>
      <ModelsProvider>
        <AgentsProvider>
          <Outlet />
        </AgentsProvider>
      </ModelsProvider>
    </ThemeProvider>
  )
}
