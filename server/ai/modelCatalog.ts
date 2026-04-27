import fs from "fs"
import { AIProviders } from "@/ai/types"
import { getLogger } from "@/logger"
import type { ModelConfiguration } from "@/shared/types"
import { Subsystem } from "@/types"

const Logger = getLogger(Subsystem.AI)

type ExternalLiteLLMModelConfig = {
  id?: unknown
  labelName?: unknown
  actualName?: unknown
  provider?: unknown
  reasoning?: unknown
  websearch?: unknown
  deepResearch?: unknown
  description?: unknown
}

let externalModelConfigurationsCache: Record<string, ModelConfiguration> | null =
  null
let externalModelConfigurationsPath: string | undefined

const normalizeProvider = (provider: unknown): AIProviders | null => {
  if (provider === AIProviders.LiteLLM || provider === "LiteLLM") {
    return AIProviders.LiteLLM
  }
  return null
}

const parseExternalModelConfig = (
  entry: unknown,
  index: number,
): [string, ModelConfiguration] | null => {
  if (!entry || typeof entry !== "object") {
    Logger.warn(
      { index },
      "Skipping invalid LiteLLM model catalog entry: entry must be an object",
    )
    return null
  }

  const config = entry as ExternalLiteLLMModelConfig

  if (
    typeof config.id !== "string" ||
    !config.id.trim() ||
    typeof config.labelName !== "string" ||
    !config.labelName.trim() ||
    typeof config.actualName !== "string" ||
    !config.actualName.trim()
  ) {
    Logger.warn(
      { index },
      "Skipping invalid LiteLLM model catalog entry: id, labelName, and actualName are required",
    )
    return null
  }

  const provider = normalizeProvider(config.provider)
  if (!provider) {
    Logger.warn(
      { index, id: config.id, provider: config.provider },
      "Skipping invalid LiteLLM model catalog entry: only LiteLLM provider is supported",
    )
    return null
  }

  return [
    config.id.trim(),
    {
      actualName: config.actualName.trim(),
      labelName: config.labelName.trim(),
      provider,
      reasoning:
        typeof config.reasoning === "boolean" ? config.reasoning : true,
      websearch:
        typeof config.websearch === "boolean" ? config.websearch : false,
      deepResearch:
        typeof config.deepResearch === "boolean"
          ? config.deepResearch
          : false,
      description:
        typeof config.description === "string" ? config.description : "",
    },
  ]
}

export const getExternalModelConfigurations = (): Record<
  string,
  ModelConfiguration
> => {
  const configuredPath = process.env.LITELLM_MODEL_CONFIG_PATH?.trim()

  if (!configuredPath) {
    externalModelConfigurationsCache = {}
    externalModelConfigurationsPath = undefined
    return externalModelConfigurationsCache
  }

  if (
    externalModelConfigurationsCache &&
    externalModelConfigurationsPath === configuredPath
  ) {
    return externalModelConfigurationsCache
  }

  if (!fs.existsSync(configuredPath)) {
    Logger.warn(
      { path: configuredPath },
      "LiteLLM model catalog file does not exist; continuing without external model catalog",
    )
    externalModelConfigurationsCache = {}
    externalModelConfigurationsPath = undefined
    return externalModelConfigurationsCache
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(configuredPath, "utf8"))
    if (!Array.isArray(parsed)) {
      Logger.warn(
        { path: configuredPath },
        "LiteLLM model catalog must be a JSON array; continuing without external model catalog",
      )
      externalModelConfigurationsCache = {}
      externalModelConfigurationsPath = undefined
      return externalModelConfigurationsCache
    }

    externalModelConfigurationsCache = Object.fromEntries(
      parsed
        .map((entry, index) => parseExternalModelConfig(entry, index))
        .filter(
          (entry): entry is [string, ModelConfiguration] => entry !== null,
        ),
    )
    externalModelConfigurationsPath = configuredPath
    return externalModelConfigurationsCache
  } catch (error) {
    Logger.warn(
      {
        path: configuredPath,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to load LiteLLM model catalog; continuing without external model catalog",
    )
    externalModelConfigurationsCache = {}
    externalModelConfigurationsPath = undefined
    return externalModelConfigurationsCache
  }
}

export const resetExternalModelConfigurationsForTests = () => {
  externalModelConfigurationsCache = null
  externalModelConfigurationsPath = undefined
}
