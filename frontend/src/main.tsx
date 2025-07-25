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
        const url = typeof queryKey[0] === "string" ? queryKey[0] : ""
        const res = await authFetch(url)
        if (res.status === 401) {
          // Token refresh failed, force logout or redirect
          window.location.href = "/auth"
          throw new Error("Unauthorized")
        }
        if (!res.ok) throw new Error(await res.text())
        return res.json()
      },
    },
    mutations: {
      mutationFn: async (variables) => {
        const { url, options } = variables as {
          url: string
          options?: RequestInit
        }
        const res = await authFetch(url, options)
        if (res.status === 401) {
          window.location.href = "/auth"
          throw new Error("Unauthorized")
        }
        if (!res.ok) throw new Error(await res.text())
        return res.json()
      },
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
