import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import * as schema from "@/db/schema"

const Logger = getLogger(Subsystem.Db).child({ module: "client" })

const url = config.getDatabaseUrl()

const queryClient = postgres(url, {
  max: Number(process.env.DB_POOL_MAX ?? 5),
  idle_timeout: Number(process.env.DB_POOL_IDLE_TIMEOUT ?? 30),
  connection: {
    application_name: process.env.DB_APPLICATION_NAME ?? "xyne-drizzle",
  },
})
// We will use the exported variable to query our db:
export const db = drizzle(queryClient, { schema })
