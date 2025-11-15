import PgBoss from "pg-boss"
import config from "@/config"

export const boss = new PgBoss({
  connectionString: config.getDatabaseUrl(),
  monitorIntervalSeconds: 600, // Monitor state every 10 minutes
})
