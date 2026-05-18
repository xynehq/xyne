import { Outlet, createRootRoute } from "@tanstack/react-router"
import { ThemeProvider } from "@/lib/theme"
import { ModelsProvider } from "@/lib/models"
import { AgentsProvider } from "@/lib/agents"
import { ThinkingProvider } from "@/lib/thinking"

export const Route = createRootRoute({
  component: RootComponent,
})

function RootComponent(): JSX.Element {
  return (
    <ThemeProvider>
      <ModelsProvider>
        <AgentsProvider>
          <ThinkingProvider>
            <Outlet />
          </ThinkingProvider>
        </AgentsProvider>
      </ModelsProvider>
    </ThemeProvider>
  )
}
