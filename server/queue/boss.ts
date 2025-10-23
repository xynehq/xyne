import PgBoss from "pg-boss"
import config from "@/config"

export const boss = new PgBoss({
  connectionString: config.getDatabaseUrl(),
  monitorStateIntervalMinutes: 10, // Monitor state every 10 minutes
})
