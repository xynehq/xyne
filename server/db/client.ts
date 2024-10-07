import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import config from "@/config"
import { getLogger } from '@/shared/logger';
import { LOGGERTYPES } from '@/shared/types';

const Logger =  getLogger(LOGGERTYPES.server).child({module: 'db'}).child({module: 'client'})

const url = `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`
Logger.info(url)

const queryClient = postgres(url, {
    idle_timeout: 0
})
// We will use the exported variable to query our db:
export const db = drizzle(queryClient)