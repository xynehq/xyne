import PgBoss from "pg-boss"
import config from "@/config"

export const boss = new PgBoss({
  connectionString: config.getDatabaseUrl(),
  max: Number.parseInt(process.env.PGBOSS_POOL_MAX || "5", 10) || 5,
  application_name: process.env.PGBOSS_APPLICATION_NAME ?? "xyne-pgboss",
  monitorStateIntervalMinutes: 10, // Monitor state every 10 minutes
})
