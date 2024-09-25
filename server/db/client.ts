import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import config from "@/config"

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
console.log(url)

const queryClient = postgres(url)
// We will use the exported variable to query our db:
export const db = drizzle(queryClient)