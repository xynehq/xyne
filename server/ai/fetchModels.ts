import { AIProviders, Models } from "@/ai/types"
import config from "@/config"
import { getLogger } from "@/logger"
import { Subsystem } from "@/types"
import { MODEL_CONFIGURATIONS } from "./modelConfig"
import { modelDetailsMap } from "./mappers"

const Logger = getLogger(Subsystem.AI)

const CACHE_TTL_MS = 5 * 60 * 1000
const DEFAULT_MAX_INPUT_TOKENS = 128_000

type NumericLike = number | string | null | undefined

interface RawLiteLLMParams {
  model?: string
  input_cost_per_token?: NumericLike
  output_cost_per_token?: NumericLike
  custom_llm_provider?: string
}

interface RawModelInfoDetails {
  description?: string | null
  deep_research?: boolean | null
  id?: string
  input_cost_per_token?: NumericLike
  litellm_provider?: string | null
  max_input_tokens?: number | null
  max_output_tokens?: number | null
  output_cost_per_token?: NumericLike
  reasoning?: boolean | null
  supports_function_calling?: boolean | null
  supports_reasoning?: boolean | null
  supports_web_search?: boolean | null
  supports_vision?: boolean | null
  websearch?: boolean | null
}

export interface RawModelInfoRecord {
  model_name: string
  litellm_params?: RawLiteLLMParams | null
  model_info?: RawModelInfoDetails | null
}

export interface NormalizedModelMetadata {
  actualName: string
  customLLMProvider?: string
  deepResearch: boolean
  description: string
  hasConflictingMaxInputTokens: boolean
  hasConflictingMaxOutputTokens: boolean
  inputCostPerToken?: number
  litellmProvider?: string
  maxInputTokens?: number
  maxOutputTokens?: number
  modelInfoId?: string
  modelName: string
  outputCostPerToken?: number
  reasoning: boolean
  sourceCount: number
  supportsFunctionCalling: boolean
  supportsVision: boolean
  websearch: boolean
}

interface ModelInfoCache {
  rawData: RawModelInfoRecord[]
  normalizedByModelName: Map<string, NormalizedModelMetadata>
  timestamp: number
}

let modelInfoCache: ModelInfoCache | null = null

const warnedMissingTokenLimitKeys = new Set<string>()

function parseCostValue(value: NumericLike): number {
  if (typeof value === "number") {
    return value
  }
  if (typeof value === "string") {
    const parsed = parseFloat(value)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

function parseOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value
  }
  return undefined
}

function parseOptionalCost(value: NumericLike): number | undefined {
  const parsed = parseCostValue(value)
  return parsed > 0 ? parsed : undefined
}

function hasConflictingValues(values: number[]): boolean {
  return new Set(values).size > 1
}

function resolveMinValue(values: Array<number | undefined>): {
  value?: number
  hasConflict: boolean
} {
  const presentValues = values.filter((value): value is number => value !== undefined)
  if (presentValues.length === 0) {
    return { value: undefined, hasConflict: false }
  }

  return {
    value: Math.min(...presentValues),
    hasConflict: hasConflictingValues(presentValues),
  }
}

function firstNonEmpty(values: Array<string | null | undefined>): string | undefined {
  return values.find((value) => typeof value === "string" && value.trim().length > 0)?.trim()
}

function normalizeBoolean(value: unknown): boolean {
  return value === true
}

function normalizeModelInfoRecords(
  records: RawModelInfoRecord[],
): Map<string, NormalizedModelMetadata> {
  const groupedRecords = new Map<string, RawModelInfoRecord[]>()

  for (const record of records) {
    if (!record.model_name) continue
    const existing = groupedRecords.get(record.model_name) ?? []
    existing.push(record)
    groupedRecords.set(record.model_name, existing)
  }

  const normalized = new Map<string, NormalizedModelMetadata>()

  for (const [modelName, group] of groupedRecords.entries()) {
    const actualName =
      firstNonEmpty(group.map((record) => record.litellm_params?.model)) ?? modelName
    const inputTokenResolution = resolveMinValue(
      group.map((record) => parseOptionalNumber(record.model_info?.max_input_tokens)),
    )
    const outputTokenResolution = resolveMinValue(
      group.map((record) => parseOptionalNumber(record.model_info?.max_output_tokens)),
    )
    const inputCost = resolveMinValue(
      group.map((record) =>
        parseOptionalCost(record.model_info?.input_cost_per_token) ??
        parseOptionalCost(record.litellm_params?.input_cost_per_token),
      ),
    ).value
    const outputCost = resolveMinValue(
      group.map((record) =>
        parseOptionalCost(record.model_info?.output_cost_per_token) ??
        parseOptionalCost(record.litellm_params?.output_cost_per_token),
      ),
    ).value

    const metadata: NormalizedModelMetadata = {
      actualName,
      customLLMProvider: firstNonEmpty(
        group.map((record) => record.litellm_params?.custom_llm_provider),
      ),
      deepResearch: group.some(
        (record) => normalizeBoolean(record.model_info?.deep_research),
      ),
      description: firstNonEmpty(
        group.map((record) => record.model_info?.description),
      ) ?? "",
      hasConflictingMaxInputTokens: inputTokenResolution.hasConflict,
      hasConflictingMaxOutputTokens: outputTokenResolution.hasConflict,
      inputCostPerToken: inputCost,
      litellmProvider: firstNonEmpty(
        group.map((record) => record.model_info?.litellm_provider),
      ),
      maxInputTokens: inputTokenResolution.value,
      maxOutputTokens: outputTokenResolution.value,
      modelInfoId: firstNonEmpty(group.map((record) => record.model_info?.id)),
      modelName,
      outputCostPerToken: outputCost,
      reasoning: group.some(
        (record) =>
          normalizeBoolean(record.model_info?.reasoning) ||
          normalizeBoolean(record.model_info?.supports_reasoning),
      ),
      sourceCount: group.length,
      supportsFunctionCalling: group.some(
        (record) => normalizeBoolean(record.model_info?.supports_function_calling),
      ),
      supportsVision: group.some(
        (record) => normalizeBoolean(record.model_info?.supports_vision),
      ),
      websearch: group.some(
        (record) =>
          normalizeBoolean(record.model_info?.websearch) ||
          normalizeBoolean(record.model_info?.supports_web_search),
      ),
    }

    normalized.set(modelName, metadata)
  }

  return normalized
}

function logNormalizationConflicts(
  normalizedByModelName: Map<string, NormalizedModelMetadata>,
) {
  for (const metadata of normalizedByModelName.values()) {
    if (
      !metadata.hasConflictingMaxInputTokens &&
      !metadata.hasConflictingMaxOutputTokens
    ) {
      continue
    }

    Logger.warn(
      {
        modelName: metadata.modelName,
        actualName: metadata.actualName,
        maxInputTokens: metadata.maxInputTokens,
        maxOutputTokens: metadata.maxOutputTokens,
        sourceCount: metadata.sourceCount,
        hasConflictingMaxInputTokens: metadata.hasConflictingMaxInputTokens,
        hasConflictingMaxOutputTokens: metadata.hasConflictingMaxOutputTokens,
      },
      "[ModelInfo] Resolved duplicate upstream model records conservatively.",
    )
  }
}

function updateModelInfoCache(records: RawModelInfoRecord[]) {
  const normalizedByModelName = normalizeModelInfoRecords(records)
  modelInfoCache = {
    rawData: records,
    normalizedByModelName,
    timestamp: Date.now(),
  }

  logNormalizationConflicts(normalizedByModelName)
}

function getCachedNormalizedModelMetadata(): NormalizedModelMetadata[] {
  return [...(modelInfoCache?.normalizedByModelName.values() ?? [])]
}

function matchesModelIdentifier(
  metadata: NormalizedModelMetadata,
  modelId: string,
): boolean {
  if (metadata.modelName === modelId) return true
  if (metadata.actualName === modelId) return true
  if (metadata.actualName.endsWith(`/${modelId}`)) return true
  if (modelId.endsWith(`/${metadata.modelName}`)) return true
  return false
}

function resolveModelMetadata(
  modelId?: Models | string | null,
): NormalizedModelMetadata | undefined {
  if (!modelId) {
    return undefined
  }

  const normalizedMetadata = getCachedNormalizedModelMetadata()
  const requestedModelId = String(modelId)
  const configuredActualName =
    MODEL_CONFIGURATIONS[requestedModelId as Models]?.actualName

  return normalizedMetadata.find((metadata) => {
    if (matchesModelIdentifier(metadata, requestedModelId)) return true
    if (configuredActualName && matchesModelIdentifier(metadata, configuredActualName)) {
      return true
    }
    return false
  })
}

function warnMissingTokenLimitOnce(
  modelId: string,
  tokenKind: "input" | "output" | "metadata",
) {
  const key = `${modelId}:${tokenKind}`
  if (warnedMissingTokenLimitKeys.has(key)) {
    return
  }

  warnedMissingTokenLimitKeys.add(key)
  Logger.warn(
    { modelId, tokenKind },
    "[ModelInfo] Missing upstream token metadata for model in use.",
  )
}

function isLiteLLMAllowlistedModel(modelName: string): boolean {
  if (
    modelName === Models.LiteLLM_Claude_Sonnet_4_6 &&
    config.allowSonnet46
  ) {
    return true
  }
  if (modelName === Models.LiteLLM_Claude_Opus_4_6 && config.allowOpus46) {
    return true
  }
  return false
}

function shouldIncludeLiteLLMModelForListing(
  metadata: NormalizedModelMetadata,
): boolean {
  if (metadata.litellmProvider === "hosted_vllm") {
    return true
  }
  return isLiteLLMAllowlistedModel(metadata.modelName)
}

type AvailableModel = {
  actualName: string
  labelName: string
  provider: string
  reasoning: boolean
  websearch: boolean
  deepResearch: boolean
  description: string
}

export type ResolvedModelTokenLimits = {
  maxInputTokens: number
  maxOutputTokens?: number
}

export async function fetchModelInfoFromAPI(
  forceRefresh = false,
): Promise<RawModelInfoRecord[]> {
  if (!forceRefresh && modelInfoCache) {
    const age = Date.now() - modelInfoCache.timestamp
    if (age < CACHE_TTL_MS) {
      return modelInfoCache.rawData
    }
  }

  if (!config.LiteLLMApiKey) {
    Logger.warn("LiteLLM API key not configured, returning empty array")
    return modelInfoCache?.rawData ?? []
  }

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
    const rawData = (
      Array.isArray(responseData) ? responseData : responseData.data || []
    ) as RawModelInfoRecord[]

    updateModelInfoCache(rawData)
    Logger.info(
      { modelCount: rawData.length },
      "[ModelInfo] Fetched upstream model metadata and refreshed cache.",
    )
    return rawData
  } catch (error) {
    clearTimeout(timeoutId)

    if (error instanceof Error && error.name === "AbortError") {
      Logger.warn("[ModelInfo] Model info API call timed out; attempting stale cache fallback.")
    } else {
      Logger.warn(
        {
          error: error instanceof Error ? error.message : String(error),
        },
        "[ModelInfo] Failed to fetch model info from API.",
      )
    }

    if (modelInfoCache) {
      Logger.info("[ModelInfo] Using stale cached model metadata.")
      return modelInfoCache.rawData
    }

    return []
  }
}

export async function fetchNormalizedModelMetadata(
  forceRefresh = false,
): Promise<NormalizedModelMetadata[]> {
  await fetchModelInfoFromAPI(forceRefresh)
  return getCachedNormalizedModelMetadata()
}

export const preloadModelInfoCache = async (): Promise<void> => {
  if (config.LiteLLMApiKey && config.LiteLLMBaseUrl) {
    try {
      await fetchModelInfoFromAPI(true)
      Logger.info("Model info cache preloaded successfully")
    } catch (error) {
      Logger.warn("Failed to preload model info cache", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export const getModelTokenLimits = (
  modelId?: Models | string | null,
): ResolvedModelTokenLimits => {
  if (!modelId) {
    return { maxInputTokens: DEFAULT_MAX_INPUT_TOKENS }
  }

  const metadata = resolveModelMetadata(modelId)
  const requestedModelId = String(modelId)

  if (!metadata) {
    warnMissingTokenLimitOnce(requestedModelId, "metadata")
    return { maxInputTokens: DEFAULT_MAX_INPUT_TOKENS }
  }

  if (metadata.maxInputTokens === undefined) {
    warnMissingTokenLimitOnce(requestedModelId, "input")
  }

  if (metadata.maxOutputTokens === undefined) {
    warnMissingTokenLimitOnce(requestedModelId, "output")
  }

  return {
    maxInputTokens: metadata.maxInputTokens ?? DEFAULT_MAX_INPUT_TOKENS,
    maxOutputTokens: metadata.maxOutputTokens,
  }
}

export const getEffectiveMaxOutputTokens = (
  modelId: Models | string | null | undefined,
  requestedMaxTokens?: number,
): number | undefined => {
  if (requestedMaxTokens === undefined) {
    return undefined
  }

  const { maxOutputTokens } = getModelTokenLimits(modelId)
  return maxOutputTokens !== undefined
    ? Math.min(requestedMaxTokens, maxOutputTokens)
    : requestedMaxTokens
}

export const getCostConfigForModel = async (
  modelId: string,
): Promise<{
  pricePerThousandInputTokens: number
  pricePerThousandOutputTokens: number
}> => {
  await fetchModelInfoFromAPI()
  const metadata = resolveModelMetadata(modelId)

  if (
    metadata?.inputCostPerToken !== undefined &&
    metadata?.outputCostPerToken !== undefined &&
    (metadata.inputCostPerToken > 0 || metadata.outputCostPerToken > 0)
  ) {
    return {
      pricePerThousandInputTokens: metadata.inputCostPerToken * 1000,
      pricePerThousandOutputTokens: metadata.outputCostPerToken * 1000,
    }
  }

  return modelDetailsMap[modelId]?.cost?.onDemand ?? {
    pricePerThousandInputTokens: 0,
    pricePerThousandOutputTokens: 0,
  }
}

export const fetchModelConfigs = async (): Promise<AvailableModel[]> => {
  const metadata = await fetchNormalizedModelMetadata()
  const availableModels: AvailableModel[] = []

  for (const modelMetadata of metadata) {
    if (!shouldIncludeLiteLLMModelForListing(modelMetadata)) {
      continue
    }

    const modelConfig =
      MODEL_CONFIGURATIONS[modelMetadata.modelName as Models] ?? null

    if (modelConfig) {
      availableModels.push({
        actualName: modelMetadata.actualName,
        labelName: modelConfig.labelName,
        provider: "LiteLLM",
        reasoning: modelConfig.reasoning,
        websearch: modelConfig.websearch,
        deepResearch: modelConfig.deepResearch,
        description: modelConfig.description,
      })
      continue
    }

    availableModels.push({
      actualName: modelMetadata.actualName,
      labelName: modelMetadata.modelName,
      provider: "LiteLLM",
      reasoning: modelMetadata.reasoning,
      websearch: modelMetadata.websearch,
      deepResearch: modelMetadata.deepResearch,
      description: modelMetadata.description,
    })
  }

  Logger.info(
    { modelCount: availableModels.length },
    "[ModelInfo] Processed LiteLLM models for availability listing.",
  )
  return availableModels
}

export const getLiteLLMWorkflowModels = async (): Promise<
  Array<{
    enumValue: string
    labelName: string
    actualName: string
    description: string
    reasoning: boolean
    websearch: boolean
    deepResearch: boolean
    modelType: string
  }>
> => {
  const metadata = await fetchNormalizedModelMetadata()
  const models = metadata
    .filter(shouldIncludeLiteLLMModelForListing)
    .map((modelMetadata) => {
      const modelConfig =
        MODEL_CONFIGURATIONS[modelMetadata.modelName as Models] ?? null
      const labelName = modelConfig?.labelName ?? modelMetadata.modelName
      const description = modelConfig?.description ?? modelMetadata.description
      const reasoning = modelConfig?.reasoning ?? modelMetadata.reasoning
      const websearch = modelConfig?.websearch ?? modelMetadata.websearch
      const deepResearch =
        modelConfig?.deepResearch ?? modelMetadata.deepResearch
      const modelType = modelMetadata.modelName.includes("gemini")
        ? "gemini"
        : modelMetadata.modelName.includes("claude")
          ? "claude"
          : "other"

      return {
        enumValue: modelMetadata.modelName,
        labelName,
        actualName: modelMetadata.actualName,
        description,
        reasoning,
        websearch,
        deepResearch,
        modelType,
      }
    })

  models.sort((a, b) => {
    const typeOrder: Record<string, number> = { claude: 1, gemini: 2, other: 3 }
    const orderA = typeOrder[a.modelType] ?? 99
    const orderB = typeOrder[b.modelType] ?? 99
    if (orderA !== orderB) {
      return orderA - orderB
    }
    return a.labelName.localeCompare(b.labelName)
  })

  return models
}

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
  const availableModels: AvailableModel[] = []

  if (providerConfig.LiteLLMApiKey && providerConfig.LiteLLMBaseUrl) {
    const fetchedModels = await fetchModelConfigs()
    if (fetchedModels.length > 0) {
      availableModels.push(...fetchedModels)
    } else {
      Object.entries(MODEL_CONFIGURATIONS)
        .filter(([, model]) => model.provider === AIProviders.LiteLLM)
        .filter(([modelId]) => {
          const id = modelId as Models
          if (id === Models.LiteLLM_Claude_Sonnet_4_6) {
            return config.allowSonnet46
          }
          if (id === Models.LiteLLM_Claude_Opus_4_6) {
            return config.allowOpus46
          }
          return true
        })
        .forEach(([modelId, model]) => {
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
  } else if (providerConfig.AwsAccessKey && providerConfig.AwsSecretKey) {
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
    availableModels.push({
      actualName: providerConfig.TogetherAIModel,
      labelName: providerConfig.TogetherAIModel,
      provider: "Together AI",
      reasoning: false,
      websearch: true,
      deepResearch: false,
      description: "",
    })
  } else if (providerConfig.FireworksAIModel && providerConfig.FireworksApiKey) {
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

export const __modelInfoInternals = {
  getCachedNormalizedModelMetadata,
  normalizeModelInfoRecords,
  resolveModelMetadata,
  resetModelInfoCacheForTests: () => {
    modelInfoCache = null
    warnedMissingTokenLimitKeys.clear()
  },
  setModelInfoCacheForTests: (records: RawModelInfoRecord[]) => {
    warnedMissingTokenLimitKeys.clear()
    updateModelInfoCache(records)
  },
}
