import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// import App from './App.tsx'
import "./index.css"
import { RouterProvider, createRouter } from "@tanstack/react-router"

// Import the generated route tree
import { routeTree } from "@/routeTree.gen"

import { Toaster } from "@/components/ui/toaster"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { StateContextProvider } from "./StateProvider"

const queryClient = new QueryClient({})

// Create a new router instance
const router = createRouter({ routeTree })

// Register the router instance for type safety
declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router
  }
}

// Render the app
const rootElement = document.getElementById("root")!
if (!rootElement.innerHTML) {
  const root = createRoot(rootElement)
  root.render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <StateContextProvider>
          <RouterProvider router={router} />
          <Toaster />
        </StateContextProvider>
      </QueryClientProvider>
    </StrictMode>,
  )
}
