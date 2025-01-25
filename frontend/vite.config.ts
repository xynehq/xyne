import { defineConfig, loadEnv } from "vite"
import path from "path"
import react from "@vitejs/plugin-react"
import svgr from "vite-plugin-svgr"

// import viteReact from '@vitejs/plugin-react'
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
export default defineConfig(({ mode }) => {
  process.env = {
    NODE_ENV: process.env.NODE_ENV,
    TZ: process.env.TZ,
    ...loadEnv(mode, process.cwd(), "VITE"),
  }
  return {
    plugins: [TanStackRouterVite(), react(), svgr()],
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        "@/server": path.resolve(import.meta.dirname, "../server"),
        "search/types": path.resolve(
          import.meta.dirname,
          "../server/search/types",
        ),
        shared: path.resolve(import.meta.dirname, "../server/shared"),
      },
    },
    server: {
      proxy: {
        "/api": {
          target: process.env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/ws": {
          target: process.env.VITE_WS_BASE_URL || "ws://localhost:3000",
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
  }
})
