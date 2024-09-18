import { defineConfig } from 'drizzle-kit'
export default defineConfig({
    dialect: "postgresql",
    schema: "./db/schema.ts",
    out: "./migrations",
    dbCredentials: {
        url: 'postgres://xyne:xyne@0.0.0.0:5432/xyne'
    }
})