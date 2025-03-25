import config from "@/config"
import { defineConfig } from "drizzle-kit"
import dotenv from 'dotenv';

const envFiles = ['.env.development', `.env.${process.env.NODE_ENV}`, '.env', ];

for (const file of envFiles) {
  if (require('fs').existsSync(file)) {
    dotenv.config({ path: file });
    break;
  }
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./db/schema.ts",
  out: "./migrations",
  dbCredentials: {
    url: `postgres://xyne:xyne@${config.postgresBaseHost}:5432/xyne`,
  },
})
