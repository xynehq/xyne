import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// import App from './App.tsx'
import "./index.css"
import { RouterProvider, createRouter } from "@tanstack/react-router"
// Import the generated route tree
import { routeTree } from "@/routeTree.gen"
import { ThemeProvider } from "@/components/ThemeContext"
import { Toaster } from "@/components/ui/toaster"
import UploadProgressWidget from "@/components/UploadProgressWidget"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"

const queryClient = new QueryClient({})

// Create a new router instance
const router = createRouter({ routeTree })
// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
  interface HistoryState {
    isQueryTyped: boolean
  }
}
const App = () => {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <Toaster />
        <UploadProgressWidget />
      </QueryClientProvider>
    </ThemeProvider>
  )
}
// Render the app
const rootElement = document.getElementById("root")!
if (!rootElement.innerHTML) {
  const root = createRoot(rootElement)
  root.render(
    <StrictMode>
      <App />
    </StrictMode>,
  )
}
