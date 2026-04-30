import { AIProviders, Models } from "@/ai/types"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { MODEL_CONFIGURATIONS } from "./modelConfig"
import { getExternalModelConfigurations } from "./modelCatalog"
import { modelDetailsMap } from "./mappers"

const Logger = getLogger(Subsystem.AI)

// Helper function to parse cost value (handles both numbers and scientific notation strings)
function parseCostValue(value: any): number {
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "string") {
    // Handle scientific notation strings like "6e-07"
    const parsed = parseFloat(value)
    return isNaN(parsed) ? 0 : parsed
  }
  return 0
}

// Cache for model info from API
interface ModelInfoCache {
  data: any[]
  timestamp: number
}

let modelInfoCache: ModelInfoCache | null = null
const CACHE_TTL_MS = 5 * 60 * 1000 // 5 minutes

type AvailableModelConfig = {
  id: string
  actualName: string
  labelName: string
  provider: string
  reasoning: boolean
  websearch: boolean
  deepResearch: boolean
  description: string
}

const getAllowedModelIds = (): string[] | null =>
  config.modelList
    ? config.modelList
        .split(",")
        .map((id) => id.trim())
        .filter((id) => id.length > 0)
    : null

const isModelAllowed = (
  allowedModelIds: string[] | null,
  modelId: string,
  actualName?: string,
): boolean =>
  !allowedModelIds ||
  allowedModelIds.includes(modelId) ||
  Boolean(actualName && allowedModelIds.includes(actualName))

const toAvailableModelConfig = (
  modelId: string,
  model: {
    actualName?: string
    labelName: string
    provider?: string
    reasoning: boolean
    websearch: boolean
    deepResearch: boolean
    description: string
  },
): AvailableModelConfig => ({
  id: modelId,
  actualName: model.actualName ?? modelId,
  labelName: model.labelName,
  provider:
    model.provider === AIProviders.LiteLLM ? "LiteLLM" : model.provider || "",
  reasoning: model.reasoning,
  websearch: model.websearch,
  deepResearch: model.deepResearch,
  description: model.description,
})

// Shared function to fetch model info from API with caching
export async function fetchModelInfoFromAPI(
  forceRefresh = false,
): Promise<any[]> {
  // Return cached data if still valid
  if (!forceRefresh && modelInfoCache) {
    const age = Date.now() - modelInfoCache.timestamp
    if (age < CACHE_TTL_MS) {
      return modelInfoCache.data
    }
  }

  // Use API key from config
  if (!config.LiteLLMApiKey) {
    Logger.warn("LiteLLM API key not configured, returning empty array")
    return []
  }

  // Set timeout of 5 seconds
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 5000)

  try {
    const apiUrl = config.LiteLLMModelInfoUrl
    if (!apiUrl) {
      throw new Error("LiteLLM model info URL not configured")
    }
    const response = await fetch(apiUrl, {
      headers: {
        "x-litellm-api-key": config.LiteLLMApiKey,
        accept: "application/json",
        "x-litellm-disable-logging": "true",
      },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      throw new Error(`Failed to fetch model configs: ${response.statusText}`)
    }
    const responseData = await response.json()

    // API returns { data: [...] }, so extract the data array
    const data = Array.isArray(responseData)
      ? responseData
      : responseData.data || []

    // Update cache
    modelInfoCache = {
      data,
      timestamp: Date.now(),
    }

    Logger.info(`Fetched ${data.length} models from API and cached`)
    return data
  } catch (error) {
    clearTimeout(timeoutId)
    if (error instanceof Error && error.name === "AbortError") {
      Logger.warn(
        "Model info API call timed out, using cached data if available",
      )
    } else {
      Logger.warn("Failed to fetch model info from API", {
        error: error instanceof Error ? error.message : String(error),
      })
    }

    // Return cached data if available, even if stale
    if (modelInfoCache) {
      Logger.info("Using stale cached model info")
      return modelInfoCache.data
    }

    return []
  }
}

// Function to pre-warm the cache at startup
export const preloadModelInfoCache = async (): Promise<void> => {
  if (config.LiteLLMApiKey && config.LiteLLMBaseUrl) {
    try {
      await fetchModelInfoFromAPI(true) // Force refresh on startup
      Logger.info("Model info cache preloaded successfully")
    } catch (error) {
      Logger.warn("Failed to preload model info cache", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

// Export function to get cost config for a specific model (uses cached data)
export const getCostConfigForModel = async (
  modelId: string,
): Promise<{
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}> => {
  const data = await fetchModelInfoFromAPI()

  // Find the model in the API response
  // Match by model_name (enum value like "glm-latest") or by the actual model name in litellm_params.model
  // Also handle cases where modelId might be the full path like "hosted_vllm/zai-org/GLM-4.7-dev"
  const modelInfo = data.find((m: any) => {
    // Direct match by model_name (enum value)
    if (m.model_name === modelId) return true

    // Match by litellm_params.model (full path)
    if (m.litellm_params?.model === modelId) return true

    // Match if modelId is at the end of the full path
    if (m.litellm_params?.model?.endsWith(`/${modelId}`)) return true

    // Match if modelId contains the model_name
    if (m.litellm_params?.model?.includes(`/${modelId}`)) return true

    return false
  })

  if (modelInfo) {
    // Try to get costs from model_info first (as numbers), then from litellm_params (as strings)
    const inputCost =
      modelInfo.model_info?.input_cost_per_token ??
      modelInfo.litellm_params?.input_cost_per_token
    const outputCost =
      modelInfo.model_info?.output_cost_per_token ??
      modelInfo.litellm_params?.output_cost_per_token

    if (
      inputCost !== undefined &&
      inputCost !== null &&
      outputCost !== undefined &&
      outputCost !== null
    ) {
      const parsedInputCost = parseCostValue(inputCost)
      const parsedOutputCost = parseCostValue(outputCost)

      if (parsedInputCost > 0 || parsedOutputCost > 0) {
        return {
          pricePerThousandInputTokens: parsedInputCost * 1000,
          pricePerThousandOutputTokens: parsedOutputCost * 1000,
        }
      }
    }
  }

  // Fallback to default config from modelDetailsMap
  return (
    modelDetailsMap[modelId]?.cost?.onDemand ?? {
      pricePerThousandInputTokens: 0,
      pricePerThousandOutputTokens: 0,
    }
  )
}

export const fetchModelConfigs = async (): Promise<
  Array<AvailableModelConfig>
> => {
  const data = await fetchModelInfoFromAPI()

  const allowedModelIds = getAllowedModelIds()
  const modelRegistry: Record<string, AvailableModelConfig> = {}

  const modelAllowlist = {
    [Models.LiteLLM_Claude_Sonnet_4_6]: {
      enabled: config.allowSonnet46,
      name: "Claude Sonnet 4.6",
    },
    [Models.LiteLLM_Claude_Opus_4_6]: {
      enabled: config.allowOpus46,
      name: "Claude Opus 4.6",
    },
    [Models.LiteLLM_Claude_Haiku_4_5]: {
      enabled: config.allowHaiku45,
      name: "Claude Haiku 4.5",
    },
  } as const

  const isStaticLiteLLMModelEnabled = (modelId: string) => {
    const modelAllowlistInfo =
      modelAllowlist[modelId as keyof typeof modelAllowlist]
    return !modelAllowlistInfo || modelAllowlistInfo.enabled
  }

  Object.entries(MODEL_CONFIGURATIONS)
    .filter(([, model]) => model.provider === AIProviders.LiteLLM)
    .filter(([modelId]) => isStaticLiteLLMModelEnabled(modelId))
    .forEach(([modelId, model]) => {
      modelRegistry[modelId] = toAvailableModelConfig(modelId, model)
    })

  for (const modelInfo of data) {
    const modelId = modelInfo.model_name
    if (typeof modelId !== "string" || !modelId) {
      continue
    }

    const actualName = modelInfo.litellm_params?.model || modelId
    const isHostedVllm =
      modelInfo.model_info?.litellm_provider === "hosted_vllm"

    if (!isHostedVllm) {
      const modelAllowlistInfo =
        modelAllowlist[modelId as keyof typeof modelAllowlist]

      if (modelAllowlistInfo) {
        if (modelAllowlistInfo.enabled) {
          Logger.info(
            `Allowing ${modelAllowlistInfo.name} model despite litellm_provider not being 'hosted_vllm'`,
          )
        } else {
          continue
        }
      } else {
        continue
      }
    }

    const staticModel = MODEL_CONFIGURATIONS[modelId as Models]
    modelRegistry[modelId] = toAvailableModelConfig(modelId, {
      actualName,
      labelName: staticModel?.labelName || modelId,
      provider: AIProviders.LiteLLM,
      reasoning:
        staticModel?.reasoning ?? modelInfo.model_info?.reasoning ?? true,
      websearch:
        staticModel?.websearch ?? modelInfo.model_info?.websearch ?? false,
      deepResearch:
        staticModel?.deepResearch ??
        modelInfo.model_info?.deepResearch ??
        modelInfo.model_info?.deep_research ??
        false,
      description:
        staticModel?.description || modelInfo.model_info?.description || "",
    })
  }

  Object.entries(getExternalModelConfigurations())
    .filter(([, model]) => model.provider === AIProviders.LiteLLM)
    .forEach(([modelId, model]) => {
      modelRegistry[modelId] = toAvailableModelConfig(modelId, model)
    })

  const availableModels = Object.values(modelRegistry).filter((model) =>
    isModelAllowed(allowedModelIds, model.id, model.actualName),
  )

  Logger.info(`Processed ${availableModels.length} LiteLLM models`)

  return availableModels
}

// Main function to get available models - moved from config.ts for centralization
export const getAvailableModels = async (providerConfig: {
  AwsAccessKey?: string
  AwsSecretKey?: string
  OpenAIKey?: string
  OllamaModel?: string
  TogetherAIModel?: string
  TogetherApiKey?: string
  FireworksAIModel?: string
  FireworksApiKey?: string
  GeminiAIModel?: string
  GeminiApiKey?: string
  VertexAIModel?: string
  VertexProjectId?: string
  VertexRegion?: string
  LiteLLMApiKey?: string
  LiteLLMBaseUrl?: string
}) => {
  const availableModels: Array<{
    actualName: string
    labelName: string
    provider: string
    reasoning: boolean
    websearch: boolean
    deepResearch: boolean
    description: string
  }> = []

  // Priority (LiteLLM > AWS > OpenAI > Ollama > Together > Fireworks > Gemini > Vertex)
  // Using if-else logic to ensure only ONE provider is active at a time
  if (providerConfig.LiteLLMApiKey && providerConfig.LiteLLMBaseUrl) {
    // Fetch models from API and merge with local catalog overrides.
    const fetchedModels = await fetchModelConfigs()
    availableModels.push(...fetchedModels)
  } else if (providerConfig.AwsAccessKey && providerConfig.AwsSecretKey) {
    // Add only AWS Bedrock models
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.AwsBedrock)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "AWS Bedrock",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  } else if (providerConfig.OpenAIKey) {
    // Add only OpenAI models
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.OpenAI)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "OpenAI",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  } else if (providerConfig.OllamaModel) {
    // Add only Ollama model
    availableModels.push({
      actualName: providerConfig.OllamaModel,
      labelName: providerConfig.OllamaModel,
      provider: "Ollama",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (providerConfig.TogetherAIModel && providerConfig.TogetherApiKey) {
    // Add only Together AI model
    availableModels.push({
      actualName: providerConfig.TogetherAIModel,
      labelName: providerConfig.TogetherAIModel,
      provider: "Together AI",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (
    providerConfig.FireworksAIModel &&
    providerConfig.FireworksApiKey
  ) {
    // Add only Fireworks AI model
    availableModels.push({
      actualName: providerConfig.FireworksAIModel,
      labelName: providerConfig.FireworksAIModel,
      provider: "Fireworks AI",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (providerConfig.GeminiAIModel && providerConfig.GeminiApiKey) {
    // Add all Google AI models
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.GoogleAI)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "Google AI",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  } else if (providerConfig.VertexProjectId && providerConfig.VertexRegion) {
    // Add all Vertex AI models - no longer dependent on VERTEX_AI_MODEL being set
    Object.values(MODEL_CONFIGURATIONS)
      .filter((model) => model.provider === AIProviders.VertexAI)
      .forEach((model) => {
        availableModels.push({
          actualName: model.actualName ?? "",
          labelName: model.labelName,
          provider: "Vertex AI",
          reasoning: model.reasoning,
          websearch: model.websearch,
          deepResearch: model.deepResearch,
          description: model.description,
        })
      })
  }

  return availableModels
}

// Legacy function for backward compatibility (returns old format)
export const getAvailableModelsLegacy = async (providerConfig: {
  AwsAccessKey?: string
  AwsSecretKey?: string
  OpenAIKey?: string
  OllamaModel?: string
  TogetherAIModel?: string
  TogetherApiKey?: string
  FireworksAIModel?: string
  FireworksApiKey?: string
  GeminiAIModel?: string
  GeminiApiKey?: string
  VertexAIModel?: string
  VertexProjectId?: string
  VertexRegion?: string
  LiteLLMApiKey?: string
  LiteLLMBaseUrl?: string
}) => {
  const newModels = await getAvailableModels(providerConfig)
  return newModels.map(
    (model: {
      actualName: string
      labelName: string
      provider: string
      reasoning: boolean
      websearch: boolean
      deepResearch: boolean
    }) => ({
      label: model.labelName,
      provider: model.provider,
    }),
  )
}
