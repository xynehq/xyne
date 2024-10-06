// vite.config.ts
import { defineConfig, loadEnv } from "file:///home/oindrilabanerjee/xyne/RAG/xyne/search/frontend/node_modules/vite/dist/node/index.js";
import path from "path";
import react from "file:///home/oindrilabanerjee/xyne/RAG/xyne/search/frontend/node_modules/@vitejs/plugin-react/dist/index.mjs";
import { TanStackRouterVite } from "file:///home/oindrilabanerjee/xyne/RAG/xyne/search/frontend/node_modules/@tanstack/router-plugin/dist/esm/vite.js";
var __vite_injected_original_dirname = "/home/oindrilabanerjee/xyne/RAG/xyne/search/frontend";
var vite_config_default = defineConfig(({ mode }) => {
  process.env = { NODE_ENV: process.env.NODE_ENV, TZ: process.env.TZ, ...loadEnv(mode, process.cwd(), "VITE") };
  return {
    plugins: [
      TanStackRouterVite(),
      react()
    ],
    resolve: {
      alias: {
        "@": path.resolve(__vite_injected_original_dirname, "./src"),
        "@server": path.resolve(__vite_injected_original_dirname, "../server"),
        "@shared": path.resolve(__vite_injected_original_dirname, "../shared")
      }
    },
    server: {
      proxy: {
        "/api": {
          target: process.env.VITE_API_BASE_URL || "http://127.0.0.1:3000",
          changeOrigin: true
        },
        "/ws": {
          target: process.env.VITE_WS_BASE_URL || "ws://localhost:3000",
          ws: true,
          rewriteWsOrigin: true
        }
      }
    }
  };
});
export {
  vite_config_default as default
};
//# sourceMappingURL=data:application/json;base64,ewogICJ2ZXJzaW9uIjogMywKICAic291cmNlcyI6IFsidml0ZS5jb25maWcudHMiXSwKICAic291cmNlc0NvbnRlbnQiOiBbImNvbnN0IF9fdml0ZV9pbmplY3RlZF9vcmlnaW5hbF9kaXJuYW1lID0gXCIvaG9tZS9vaW5kcmlsYWJhbmVyamVlL3h5bmUvUkFHL3h5bmUvc2VhcmNoL2Zyb250ZW5kXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ZpbGVuYW1lID0gXCIvaG9tZS9vaW5kcmlsYWJhbmVyamVlL3h5bmUvUkFHL3h5bmUvc2VhcmNoL2Zyb250ZW5kL3ZpdGUuY29uZmlnLnRzXCI7Y29uc3QgX192aXRlX2luamVjdGVkX29yaWdpbmFsX2ltcG9ydF9tZXRhX3VybCA9IFwiZmlsZTovLy9ob21lL29pbmRyaWxhYmFuZXJqZWUveHluZS9SQUcveHluZS9zZWFyY2gvZnJvbnRlbmQvdml0ZS5jb25maWcudHNcIjtpbXBvcnQgeyBkZWZpbmVDb25maWcsIGxvYWRFbnYgfSBmcm9tICd2aXRlJ1xuaW1wb3J0IHBhdGggZnJvbSBcInBhdGhcIlxuaW1wb3J0IHJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xuXG4vLyBpbXBvcnQgdml0ZVJlYWN0IGZyb20gJ0B2aXRlanMvcGx1Z2luLXJlYWN0J1xuaW1wb3J0IHsgVGFuU3RhY2tSb3V0ZXJWaXRlIH0gZnJvbSAnQHRhbnN0YWNrL3JvdXRlci1wbHVnaW4vdml0ZSdcblxuZXhwb3J0IGRlZmF1bHQgZGVmaW5lQ29uZmlnKCh7IG1vZGUgfSkgPT4ge1xuICBwcm9jZXNzLmVudiA9IHsgTk9ERV9FTlY6IHByb2Nlc3MuZW52Lk5PREVfRU5WLCBUWjogcHJvY2Vzcy5lbnYuVFosIC4uLmxvYWRFbnYobW9kZSwgcHJvY2Vzcy5jd2QoKSwgXCJWSVRFXCIpIH07XG4gIHJldHVybiB7XG4gICAgcGx1Z2luczogW1xuICAgICAgVGFuU3RhY2tSb3V0ZXJWaXRlKCksXG4gICAgICByZWFjdCgpLFxuICAgIF0sXG4gICAgcmVzb2x2ZToge1xuICAgICAgYWxpYXM6IHtcbiAgICAgICAgXCJAXCI6IHBhdGgucmVzb2x2ZShpbXBvcnQubWV0YS5kaXJuYW1lLCBcIi4vc3JjXCIpLFxuICAgICAgICBcIkBzZXJ2ZXJcIjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi4vc2VydmVyXCIpLFxuICAgICAgICBcIkBzaGFyZWRcIjogcGF0aC5yZXNvbHZlKGltcG9ydC5tZXRhLmRpcm5hbWUsIFwiLi4vc2hhcmVkXCIpLFxuICAgICAgfSxcbiAgICB9LFxuICAgIHNlcnZlcjoge1xuICAgICAgcHJveHk6IHtcbiAgICAgICAgXCIvYXBpXCI6IHtcbiAgICAgICAgICB0YXJnZXQ6IHByb2Nlc3MuZW52LlZJVEVfQVBJX0JBU0VfVVJMIHx8ICdodHRwOi8vMTI3LjAuMC4xOjMwMDAnLFxuICAgICAgICAgIGNoYW5nZU9yaWdpbjogdHJ1ZVxuICAgICAgICB9LFxuICAgICAgICAnL3dzJzoge1xuICAgICAgICAgIHRhcmdldDogcHJvY2Vzcy5lbnYuVklURV9XU19CQVNFX1VSTCB8fCAnd3M6Ly9sb2NhbGhvc3Q6MzAwMCcsXG4gICAgICAgICAgd3M6IHRydWUsXG4gICAgICAgICAgcmV3cml0ZVdzT3JpZ2luOiB0cnVlLFxuICAgICAgICB9LFxuICAgICAgfSxcblxuICAgIH1cbiAgfVxufSlcbiJdLAogICJtYXBwaW5ncyI6ICI7QUFBOFUsU0FBUyxjQUFjLGVBQWU7QUFDcFgsT0FBTyxVQUFVO0FBQ2pCLE9BQU8sV0FBVztBQUdsQixTQUFTLDBCQUEwQjtBQUxuQyxJQUFNLG1DQUFtQztBQU96QyxJQUFPLHNCQUFRLGFBQWEsQ0FBQyxFQUFFLEtBQUssTUFBTTtBQUN4QyxVQUFRLE1BQU0sRUFBRSxVQUFVLFFBQVEsSUFBSSxVQUFVLElBQUksUUFBUSxJQUFJLElBQUksR0FBRyxRQUFRLE1BQU0sUUFBUSxJQUFJLEdBQUcsTUFBTSxFQUFFO0FBQzVHLFNBQU87QUFBQSxJQUNMLFNBQVM7QUFBQSxNQUNQLG1CQUFtQjtBQUFBLE1BQ25CLE1BQU07QUFBQSxJQUNSO0FBQUEsSUFDQSxTQUFTO0FBQUEsTUFDUCxPQUFPO0FBQUEsUUFDTCxLQUFLLEtBQUssUUFBUSxrQ0FBcUIsT0FBTztBQUFBLFFBQzlDLFdBQVcsS0FBSyxRQUFRLGtDQUFxQixXQUFXO0FBQUEsUUFDeEQsV0FBVyxLQUFLLFFBQVEsa0NBQXFCLFdBQVc7QUFBQSxNQUMxRDtBQUFBLElBQ0Y7QUFBQSxJQUNBLFFBQVE7QUFBQSxNQUNOLE9BQU87QUFBQSxRQUNMLFFBQVE7QUFBQSxVQUNOLFFBQVEsUUFBUSxJQUFJLHFCQUFxQjtBQUFBLFVBQ3pDLGNBQWM7QUFBQSxRQUNoQjtBQUFBLFFBQ0EsT0FBTztBQUFBLFVBQ0wsUUFBUSxRQUFRLElBQUksb0JBQW9CO0FBQUEsVUFDeEMsSUFBSTtBQUFBLFVBQ0osaUJBQWlCO0FBQUEsUUFDbkI7QUFBQSxNQUNGO0FBQUEsSUFFRjtBQUFBLEVBQ0Y7QUFDRixDQUFDOyIsCiAgIm5hbWVzIjogW10KfQo=
