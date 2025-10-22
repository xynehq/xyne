import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import * as schema from "@/db/schema"

const Logger = getLogger(Subsystem.Db).child({ module: "client" })

const url = config.getDatabaseUrl()

const queryClient = postgres(url, {
  idle_timeout: 0,
})
// We will use the exported variable to query our db:
export const db = drizzle(queryClient, { schema })
