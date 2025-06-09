import { StrictMode, useEffect } from "react"
import { createRoot } from "react-dom/client"
// import App from './App.tsx'
import "./index.css"
import { RouterProvider, createRouter } from "@tanstack/react-router"

// Import the generated route tree
import { routeTree } from "@/routeTree.gen"

import { Toaster } from "@/components/ui/toaster"

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
  useEffect(() => {
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)")
    const handleChange = () => {
      const storedTheme = localStorage.getItem("theme")
      if (storedTheme) {
        document.documentElement.classList.toggle("dark", storedTheme === "dark")
      } else {
        document.documentElement.classList.toggle("dark", mediaQuery.matches)
      }
    }

    handleChange() // Initial check

    mediaQuery.addEventListener("change", handleChange)
    window.addEventListener('storage', handleChange); // Listen for changes from other tabs

    return () => {
      mediaQuery.removeEventListener("change", handleChange)
      window.removeEventListener('storage', handleChange);
    }
  }, [])

  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
      <Toaster />
    </QueryClientProvider>
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
