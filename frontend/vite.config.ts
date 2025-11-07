/// <reference types="vitest" />
import { defineConfig } from "vite"
import { loadEnv } from "vite"
import path from "path"
import react from "@vitejs/plugin-react"
import svgr from "vite-plugin-svgr"
import fs from "fs"
import { viteStaticCopy } from "vite-plugin-static-copy"
import { TanStackRouterVite } from "@tanstack/router-plugin/vite"
import pkg from "./package.json"

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
    define: {
      __APP_VERSION__: JSON.stringify(pkg.version),
    },
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
          // PDF.js worker - modern version
          {
            src: "node_modules/pdfjs-dist/build/pdf.worker.min.mjs",
            dest: "pdfjs",
          },
          // PDF.js worker - legacy version for Bun compatibility
          {
            src: "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs",
            dest: "pdfjs/legacy",
          },
          // Character maps for text rendering
          {
            src: "node_modules/pdfjs-dist/cmaps/*",
            dest: "pdfjs/cmaps",
          },
          // Standard fonts
          {
            src: "node_modules/pdfjs-dist/standard_fonts/*",
            dest: "pdfjs/standard_fonts",
          },
          // WASM files for JPEG2000 and color profiles
          {
            src: "node_modules/pdfjs-dist/wasm/openjpeg.wasm",
            dest: "pdfjs/wasm",
          },
          {
            src: "node_modules/pdfjs-dist/wasm/qcms_bg.wasm",
            dest: "pdfjs/wasm",
          },
          {
            src: "node_modules/pdfjs-dist/wasm/openjpeg_nowasm_fallback.js",
            dest: "pdfjs/wasm",
          },
          // Annotation icons for PDF.js (both modern and legacy)
          {
            src: "node_modules/pdfjs-dist/web/images/*",
            dest: "pdfjs/images",
          },
          {
            src: "node_modules/pdfjs-dist/legacy/web/images/*",
            dest: "pdfjs/legacy/images",
          },
          // ICC color profiles for accurate color rendering
          {
            src: "node_modules/pdfjs-dist/iccs/*",
            dest: "pdfjs/iccs",
          },
          // PDF viewer CSS for proper styling
          {
            src: "node_modules/pdfjs-dist/web/pdf_viewer.css",
            dest: "pdfjs",
          },
          {
            src: "node_modules/pdfjs-dist/legacy/web/pdf_viewer.css",
            dest: "pdfjs/legacy",
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
          target: env.VITE_WS_BASE_URL || "ws://127.0.0.1:3000",
          ws: true,
          changeOrigin: true,
          rewriteWsOrigin: true,
        },
        // OAuth endpoints
        "/v1/auth/callback": {
          target: env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/oauth/start": {
          target: env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
          changeOrigin: true,
        },
        "/oauth/success": {
          target: env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
          changeOrigin: true,
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
