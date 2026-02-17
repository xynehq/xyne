import { AIProviders, Models } from "@/ai/types"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { MODEL_CONFIGURATIONS } from "./modelConfig"
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

// Shared function to fetch model info from API with caching
async function fetchModelInfoFromAPI(forceRefresh = false): Promise<any[]> {
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
    const apiUrl = config.LiteLLMModelInfoUrl || "https://grid.ai.juspay.net/v1/model/info"
    const response = await fetch(apiUrl, {
      headers: {
        "x-litellm-api-key": config.LiteLLMApiKey,
        "accept": "application/json",
      },
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    
    if (!response.ok) {
      throw new Error(`Failed to fetch model configs: ${response.statusText}`)
    }
    const responseData = await response.json()
    
    // API returns { data: [...] }, so extract the data array
    const data = Array.isArray(responseData) ? responseData : (responseData.data || [])

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
      Logger.warn("Model info API call timed out, using cached data if available")
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
): Promise<{ pricePerThousandInputTokens: number; pricePerThousandOutputTokens: number }> => {
  const data = await fetchModelInfoFromAPI()

  // Find the model in the API response
  // Match by model_name (enum value like "glm-latest") or by the actual model name in litellm_params.model
  // Also handle cases where modelId might be the full path like "hosted_vllm/zai-org/GLM-4.7-dev"
  const modelInfo = data.find(
    (m: any) => {
      // Direct match by model_name (enum value)
      if (m.model_name === modelId) return true
      
      // Match by litellm_params.model (full path)
      if (m.litellm_params?.model === modelId) return true
      
      // Match if modelId is at the end of the full path
      if (m.litellm_params?.model?.endsWith(`/${modelId}`)) return true
      
      // Match if modelId contains the model_name
      if (m.litellm_params?.model?.includes(`/${modelId}`)) return true
      
      return false
    },
  )

  if (modelInfo) {
    // Try to get costs from model_info first (as numbers), then from litellm_params (as strings)
    const inputCost = modelInfo.model_info?.input_cost_per_token ?? 
                     modelInfo.litellm_params?.input_cost_per_token
    const outputCost = modelInfo.model_info?.output_cost_per_token ?? 
                      modelInfo.litellm_params?.output_cost_per_token

    if (inputCost !== undefined && inputCost !== null &&
        outputCost !== undefined && outputCost !== null) {
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
  return modelDetailsMap[modelId]?.cost?.onDemand ?? {
    pricePerThousandInputTokens: 0,
    pricePerThousandOutputTokens: 0,
  }
}

export const fetchModelConfigs = async (): Promise<Array<{
  actualName: string
  labelName: string
  provider: string
  reasoning: boolean
  websearch: boolean
  deepResearch: boolean
  description: string
}>> => {
  const data = await fetchModelInfoFromAPI()

  const availableModels: Array<{
    actualName: string
    labelName: string
    provider: string
    reasoning: boolean
    websearch: boolean
    deepResearch: boolean
    description: string
  }> = []

  // Use Set to track seen model IDs to avoid duplicates
  const seenModelIds = new Set<string>()

  // Filter models with litellm_provider === "hosted_vllm" and return in expected format
  for (const modelInfo of data) {
    // Only process models with litellm_provider === "hosted_vllm"
    // Check model_info.litellm_provider (from API response structure)
    if (modelInfo.model_info?.litellm_provider !== "hosted_vllm") {
      continue
    }

    const modelId = modelInfo.model_name
    const actualName = modelInfo.litellm_params?.model || modelId

    // Skip if we've already processed this model (deduplicate by model_name)
    if (seenModelIds.has(modelId)) {
      continue
    }
    seenModelIds.add(modelId)

    // Find the corresponding enum key in Models
    const modelEnumKey = Object.keys(Models).find(
      (key) => Models[key as keyof typeof Models] === modelId,
    ) as keyof typeof Models | undefined

    // Get the enum value from the key (MODEL_CONFIGURATIONS is indexed by enum values, not keys)
    const modelEnumValue = modelEnumKey ? (Models[modelEnumKey] as Models) : undefined

    // Get model configuration from MODEL_CONFIGURATIONS if it exists
    const modelConfig = modelEnumValue ? MODEL_CONFIGURATIONS[modelEnumValue] : null

    if (modelConfig) {
      // Use configuration from MODEL_CONFIGURATIONS
      availableModels.push({
        actualName: actualName,
        labelName: modelConfig.labelName,
        provider: "LiteLLM",
        reasoning: modelConfig.reasoning,
        websearch: modelConfig.websearch,
        deepResearch: modelConfig.deepResearch,
        description: modelConfig.description,
      })
    } else {
      // For models not in MODEL_CONFIGURATIONS, use defaults
      availableModels.push({
        actualName: actualName,
        labelName: modelId, // Use model_name as fallback label
        provider: "LiteLLM",
        reasoning: false,
        websearch: true,
        deepResearch: false,
        description: "",
      })
    }
  }

  Logger.info(`Processed ${availableModels.length} hosted_vllm models from API`)
  return availableModels
}

// Main function to get available models - moved from config.ts for centralization
export const getAvailableModels = async (config: {
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
    if (config.LiteLLMApiKey && config.LiteLLMBaseUrl) {
        // Fetch models from API (hosted_vllm only)
        const fetchedModels = await fetchModelConfigs()
        if (fetchedModels.length > 0) {
        // Use models fetched from API
        availableModels.push(...fetchedModels)
        } else {
        // Fallback to static MODEL_CONFIGURATIONS if API call fails
        Object.values(MODEL_CONFIGURATIONS)
            .filter((model) => model.provider === AIProviders.LiteLLM)
            .forEach((model) => {
            availableModels.push({
                actualName: model.actualName ?? "",
                labelName: model.labelName,
                provider: "LiteLLM",
                reasoning: model.reasoning,
                websearch: model.websearch,
                deepResearch: model.deepResearch,
                description: model.description,
            })
            })
        }
    } else if (config.AwsAccessKey && config.AwsSecretKey) {
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
    } else if (config.OpenAIKey) {
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
    } else if (config.OllamaModel) {
        // Add only Ollama model
        availableModels.push({
        actualName: config.OllamaModel,
        labelName: config.OllamaModel,
        provider: "Ollama",
        reasoning: false,
        websearch: true,
        deepResearch: false,
        description: "",
        })
    } else if (config.TogetherAIModel && config.TogetherApiKey) {
        // Add only Together AI model
        availableModels.push({
        actualName: config.TogetherAIModel,
        labelName: config.TogetherAIModel,
        provider: "Together AI",
        reasoning: false,
        websearch: true,
        deepResearch: false,
        description: "",
        })
    } else if (config.FireworksAIModel && config.FireworksApiKey) {
        // Add only Fireworks AI model
        availableModels.push({
        actualName: config.FireworksAIModel,
        labelName: config.FireworksAIModel,
        provider: "Fireworks AI",
        reasoning: false,
        websearch: true,
        deepResearch: false,
        description: "",
        })
    } else if (config.GeminiAIModel && config.GeminiApiKey) {
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
    } else if (config.VertexProjectId && config.VertexRegion) {
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
export const getAvailableModelsLegacy = async (config: {
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
    const newModels = await getAvailableModels(config)
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