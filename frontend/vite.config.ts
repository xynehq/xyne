import { defineConfig } from 'vite'
import path from "path"
import react from '@vitejs/plugin-react'

// import viteReact from '@vitejs/plugin-react'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'

export default defineConfig({
  plugins: [
    TanStackRouterVite(),
    // viteReact(),
    react(),
  ],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
      "@server": path.resolve(import.meta.dirname, "../"),
      "@shared": path.resolve(import.meta.dirname, "../shared"),
    },
  },
  server: {
    proxy: {
      "/api": {
        target: 'http://127.0.0.1:3000',
        changeOrigin: true
      },
      '/ws': {
        target: 'ws://localhost:3000w',
        ws: true,
        rewriteWsOrigin: true,
      },
    },

  }
})
