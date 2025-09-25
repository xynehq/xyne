import { writeFileSync, existsSync, readFileSync } from "fs"
import { resolve } from "path"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.Server)

export const generateConfigFile = () => {
  try {
    const apiBaseUrl = config.apiBaseUrl
    const wsBaseUrl = config.wsBaseUrl

    if (!apiBaseUrl || !wsBaseUrl) {
      Logger.warn("API_BASE_URL or WS_BASE_URL not found. Skipping config injection.")
      return
    }

    const configContent = {
      API_BASE_URL: apiBaseUrl,
      WS_BASE_URL: wsBaseUrl,
    }

    const inlineScript = `<script>window.CONFIG = ${JSON.stringify(configContent, null, 2)};</script>\n`

    const indexHtmlPath = resolve(__dirname, "../dist/index.html")
    if (!existsSync(indexHtmlPath)) {
      Logger.warn(`index.html not found at ${indexHtmlPath}, skipping injection.`)
      return
    }

    let indexHtml = readFileSync(indexHtmlPath, "utf8")

    // Only add the script if it doesn't already exist
    if (!indexHtml.includes("window.CONFIG")) {
      // Add the inline script before the closing </head>
      indexHtml = indexHtml.replace(
        /<\/head>/,
        `    ${inlineScript}</head>`
      )

      writeFileSync(indexHtmlPath, indexHtml, "utf8")
      Logger.info("Injected window.CONFIG inline script into index.html")
      Logger.info(`Config content: ${JSON.stringify(configContent, null, 2)}`)
    } else {
      Logger.info("window.CONFIG script already exists in index.html, skipping injection")
    }
  } catch (error) {
    Logger.error("Failed to inject config into index.html:", error)
  }
}
