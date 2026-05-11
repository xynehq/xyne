const path = require("path")

module.exports = {
  apps: [
    {
      name: "xyne-app",
      cwd: path.resolve(__dirname), // Set working directory to server folder
      script: "bun",
      args: "run server.ts", // Use binary fork pattern to avoid 'require ESM' errors
      instances: "4",
      exec_mode: "fork", // Let Bun handle port sharing via reusePort
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      merge_logs: true,
      env_production: {
        NODE_ENV: "production",
        BUN_ARGUMENTS: "--max-old-space-size=4096", // Prevent V8 heap crashes
      },
    },
    {
      name: "xyne-app-sync",
      cwd: path.resolve(__dirname), // Set working directory to server folder
      script: "bun",
      args: "run sync-server.ts",
      exec_mode: "fork", // Keep as fork if it handles its own threading
      instances: 1,
      log_date_format: "YYYY-MM-DD HH:mm:ss Z",
      env: {
        NODE_ENV: "production",
      },
    },
  ],
}
