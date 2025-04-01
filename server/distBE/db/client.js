import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import config from "../config.js"
import { getLogger } from "../logger/index.js";
import { Subsystem } from "../types.js"
const Logger = getLogger(Subsystem.Db).child({ module: "client" });
const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`;
const queryClient = postgres(url, {
    idle_timeout: 0,
});
// We will use the exported variable to query our db:
export const db = drizzle(queryClient);
