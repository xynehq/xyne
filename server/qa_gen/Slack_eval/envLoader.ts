import { config as loadEnv } from "dotenv"
import { resolve } from "path"

loadEnv({ path: resolve(__dirname, "../../.env") })
