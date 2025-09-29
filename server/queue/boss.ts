import PgBoss from "pg-boss"
import config from "@/config"

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
export const boss = new PgBoss({
  connectionString: url,
  monitorStateIntervalMinutes: 10, // Monitor state every minute
})