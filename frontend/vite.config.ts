/// <reference types="vitest" />
import { defineConfig } from "vitest/config"
import { loadEnv } from "vite"
import path from "path"
import react from "@vitejs/plugin-react"
import svgr from "vite-plugin-svgr"
import fs from "fs"
import { viteStaticCopy } from "vite-plugin-static-copy"

// import viteReact from '@vitejs/plugin-react'
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"

export default defineConfig(({ mode }) => {
  // Load environment variables from .env.production if in production mode,
  // otherwise fall back to .env.default.
  const actualMode =
    mode === "production" && !fs.existsSync(".env.production")
      ? "default"
      : mode
  const env = loadEnv(actualMode, process.cwd(), "VITE")
  // process.env variables are available directly via the `env` object returned by loadEnv.
  // Avoid reassigning process.env globally here.
  process.env = {
    NODE_ENV: process.env.NODE_ENV,
    TZ: process.env.TZ,
    ...env,
  }
  return {
    plugins: [
      TanStackRouterVite({
        routeFileIgnorePattern: "\\.test\\.(ts|tsx|js|jsx)$",
      }),
      react({
        jsxRuntime: "automatic",
      }),
      svgr(),
      viteStaticCopy({
        targets: [
          {
            src: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
            dest: "",
            rename: "pdf.worker.min.js",
          },
        ],
      }),
    ],
    optimizeDeps: {
      exclude: ["zod"],
    },
    resolve: {
      alias: {
        "@": path.resolve(import.meta.dirname, "./src"),
        "@/server": path.resolve(import.meta.dirname, "../server"),
        "search/types": path.resolve(
          import.meta.dirname,
          "../server/search/types",
        ),
        shared: path.resolve(import.meta.dirname, "../server/shared"),
        react: path.resolve(import.meta.dirname, "./node_modules/react"),
      },
    },
    server: {
      host: "0.0.0.0",
      proxy: {
        "/api": {
          target: env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/ws": {
          target: env.VITE_WS_BASE_URL || "ws://localhost:3000",
          ws: true,
          rewriteWsOrigin: true,
        },
      },
    },
    test: {
      globals: true,
      environment: "jsdom",
      setupFiles: "./src/Tests.ts",
      deps: {
        inline: ["react", "react/jsx-runtime", "react/jsx-dev-runtime"],
      },
    },
  }
})
