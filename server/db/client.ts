import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import config from "@/config"
import { ServerLogger } from '@/logger';
import { LOGGERTYPES } from '@/types';

const Logger =  new ServerLogger(LOGGERTYPES.db)

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
Logger.info(url)

const queryClient = postgres(url, {
    idle_timeout: 0
})
// We will use the exported variable to query our db:
export const db = drizzle(queryClient)