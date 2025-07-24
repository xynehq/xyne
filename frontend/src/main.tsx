import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
// import App from './App.tsx'
import "./index.css"
import { RouterProvider, createRouter } from "@tanstack/react-router"

// Import the generated route tree
import { routeTree } from "@/routeTree.gen"
import { ThemeProvider } from "@/components/ThemeContext"
import { Toaster } from "@/components/ui/toaster"

import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { authFetch } from "@/utils/authFetch"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: async ({ queryKey }) => {
        // Example: queryKey = ["/api/v1/me"]
        const url = typeof queryKey[0] === "string" ? queryKey[0] : ""
        const res = await authFetch(url)
        if (!res.ok) throw new Error(await res.text())
        return res.json()
      },
      // ... existing retry logic if needed ...
    },
    mutations: {
      mutationFn: async (variables) => {
        // Expect variables to be { url, options }
        const { url, options } = variables as {
          url: string
          options?: RequestInit
        }
        const res = await authFetch(url, options)
        if (!res.ok) throw new Error(await res.text())
        return res.json()
      },
      // ... existing onError logic if needed ...
    },
  },
})

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
