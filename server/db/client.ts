import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Db).child({ module: "client" })

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`

const queryClient = postgres(url, {
  idle_timeout: 0,
  connect_timeout: 30, // 30 seconds connect timeout
  max: 20, // Maximum number of connections
  max_lifetime: 60 * 30, // 30 minutes max connection lifetime
  onnotice: () => {}, // Suppress notices
})
// We will use the exported variable to query our db:
export const db = drizzle(queryClient)
