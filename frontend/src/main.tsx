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

let isRefreshing = false
let refreshPromise: Promise<boolean> | null = null

async function refreshToken(): Promise<boolean> {
  console.log("refresh token ran...... in frontend")
  try {
    const response = await fetch("/api/v1/refresh-token", {
      method: "POST",
      credentials: "include",
    })
    return response.ok
  } catch {
    return false
  }
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => {
        // Don't retry if it's a 401 - let the mutation error handler deal with it
        if (error?.message?.includes("401")) {
          return false
        }
        return failureCount < 3
      },
    },
    mutations: {
      onError: async (error: any, variables, context) => {
        console.log("onError triggered....")
        // Check if error is 401 (token expired)
        if (error?.message?.includes("401") && !isRefreshing) {
          if (refreshPromise) {
            const refreshSuccess = await refreshPromise
            if (refreshSuccess) {
              // Invalidate queries to refetch with new token
              queryClient.invalidateQueries()
            }
            return
          }

          isRefreshing = true
          refreshPromise = refreshToken()

          try {
            const refreshSuccess = await refreshPromise
            if (refreshSuccess) {
              // Invalidate all queries to refetch with new token
              queryClient.invalidateQueries()
            } else {
              // Refresh failed - redirect to login
              window.location.href = "/auth"
            }
          } finally {
            isRefreshing = false
            refreshPromise = null
          }
        }
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
