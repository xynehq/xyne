import config from "@/config"
import * as schema from "@/db/schema"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { drizzle } from "drizzle-orm/postgres-js"
import postgres from "postgres"

const Logger = getLogger(Subsystem.Db).child({ module: "client" })

const url = config.getDatabaseUrl()

const queryClient = postgres(url, {
  idle_timeout: 0,
})
// We will use the exported variable to query our db:
export const db = drizzle(queryClient, { schema })

export const closeDbClient = async () => {
  await queryClient.end()
}
