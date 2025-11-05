import { Langfuse } from "langfuse"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.AI)

let langfuseInstance: Langfuse | null = null

export function getLangfuseInstance(): Langfuse | null {
  if (!config.langfuseEnabled) {
    return null
  }

  if (!langfuseInstance) {
    if (!config.langfusePublicKey || !config.langfuseSecretKey) {
      Logger.warn(
        "LangFuse is enabled but PUBLIC_KEY or SECRET_KEY is missing.",
      )
      return null
    }

    langfuseInstance = new Langfuse({
      publicKey: config.langfusePublicKey,
      secretKey: config.langfuseSecretKey,
      baseUrl: config.langfuseBaseUrl,
      flushAt: 1,
      flushInterval: 1000,
    })

    Logger.info(
      `✅ LangFuse initialized successfully! Base URL: ${config.langfuseBaseUrl}`,
    )
  }

  return langfuseInstance
}
