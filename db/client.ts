import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const queryClient = postgres(process.env.DATABASE_URL!);
// We will use the exported variable to query our db:
export const db = drizzle(queryClient);