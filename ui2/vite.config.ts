import { defineConfig, loadEnv } from "vite"
import react from "@vitejs/plugin-react"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import path from "path"

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "")
  const target = env.VITE_BACKENDV2_BASE_URL || "http://127.0.0.1:3000"
  const v1Target = env.VITE_BACKENDV1_BASE_URL || "http://127.0.0.1:3000"
  return {
    plugins: [
      TanStackRouterVite({
        target: "react",
        autoCodeSplitting: true,
        routesDirectory: "./src/routes",
        generatedRouteTree: "./src/routeTree.gen.ts",
      }),
      react(),
    ],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
      },
    },
    server: {
      host: "0.0.0.0",
      port: 5176,
      strictPort: true,
      proxy: {
        // backendv2 API surface
        "/v2": { target, changeOrigin: true },
        // OAuth callbacks live on /v1/auth/* — paths registered with the
        // upstream Google client and Keycloak xyne-web client.
        "/v1/auth": { target, changeOrigin: true },
        // Reach back into v1 for endpoints v2 doesn't (yet) expose — agents
        // CRUD, agent documents, etc. Same access-token cookie works on both
        // (shared JWT secret), so this is a transparent passthrough.
        "/api/v1": { target: v1Target, changeOrigin: true },
      },
    },
  }
})
