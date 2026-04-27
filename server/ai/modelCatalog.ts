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
  entry: ExternalLiteLLMModelConfig,
  index: number,
): [string, ModelConfiguration] | null => {
  if (
    typeof entry.id !== "string" ||
    !entry.id.trim() ||
    typeof entry.labelName !== "string" ||
    !entry.labelName.trim() ||
    typeof entry.actualName !== "string" ||
    !entry.actualName.trim()
  ) {
    Logger.warn(
      { index },
      "Skipping invalid LiteLLM model catalog entry: id, labelName, and actualName are required",
    )
    return null
  }

  const provider = normalizeProvider(entry.provider)
  if (!provider) {
    Logger.warn(
      { index, id: entry.id, provider: entry.provider },
      "Skipping invalid LiteLLM model catalog entry: only LiteLLM provider is supported",
    )
    return null
  }

  return [
    entry.id.trim(),
    {
      actualName: entry.actualName.trim(),
      labelName: entry.labelName.trim(),
      provider,
      reasoning:
        typeof entry.reasoning === "boolean" ? entry.reasoning : true,
      websearch:
        typeof entry.websearch === "boolean" ? entry.websearch : false,
      deepResearch:
        typeof entry.deepResearch === "boolean"
          ? entry.deepResearch
          : false,
      description:
        typeof entry.description === "string" ? entry.description : "",
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

  externalModelConfigurationsPath = configuredPath

  if (!fs.existsSync(configuredPath)) {
    Logger.warn(
      { path: configuredPath },
      "LiteLLM model catalog file does not exist; continuing without external model catalog",
    )
    externalModelConfigurationsCache = {}
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
      return externalModelConfigurationsCache
    }

    externalModelConfigurationsCache = Object.fromEntries(
      parsed
        .map((entry, index) =>
          parseExternalModelConfig(entry as ExternalLiteLLMModelConfig, index),
        )
        .filter(
          (entry): entry is [string, ModelConfiguration] => entry !== null,
        ),
    )
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
    return externalModelConfigurationsCache
  }
}

export const resetExternalModelConfigurationsForTests = () => {
  externalModelConfigurationsCache = null
  externalModelConfigurationsPath = undefined
}
