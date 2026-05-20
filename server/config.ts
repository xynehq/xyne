import { Models } from "@/ai/types"
import { isURLValid } from "@/validate"
import { AuthType } from "./shared/types"
let vespaBaseHost = "0.0.0.0"
let vespaFeedPort = parseInt(process.env.VESPA_FEED_PORT || "8080", 10)
let vespaQueryPort = parseInt(process.env.VESPA_QUERY_PORT || "8081", 10)
let postgresBaseHost = "0.0.0.0"
let port = process.env.PORT || 3000
let metricsPort = process.env.METRICS_PORT || 3001
let syncServerPort = process.env.SYNC_SERVER_PORT || 3010
let host = process.env.HOST || "http://localhost:3000"
let paddleStatusEndpoint =
  process.env.STATUS_ENDPOINT || "http://localhost:8000/instance_status"
let doclingServiceUrl =
  process.env.DOCLING_SERVICE_URL || "http://localhost:8000"
const doclingEnabled = process.env.DOCLING_ENABLED === "true"
const doclingAsyncEnabled = process.env.DOCLING_ASYNC_ENABLED === "true"
const doclingAsyncSchedulerEnabled =
  process.env.DOCLING_ASYNC_SCHEDULER_ENABLED === "true"
const pdfProcessingDisableFallbacks =
  process.env.PDF_PROCESSING_DISABLE_FALLBACKS === "true"
const parsePositiveInteger = (
  value: string | undefined,
  fallback: number,
): number => {
  const parsed = Number.parseInt(value || "", 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}
const maxPdfPageCount = parsePositiveInteger(
  process.env.MAX_PDF_PAGE_COUNT,
  10000,
)
const doclingPageChunkSize = parsePositiveInteger(
  process.env.DOCLING_PAGE_CHUNK_SIZE,
  25,
)
const doclingStreamingMinPages = parsePositiveInteger(
  process.env.DOCLING_STREAMING_MIN_PAGES,
  doclingPageChunkSize + 1,
)
const doclingTempResultsDir =
  process.env.DOCLING_TEMP_RESULTS_DIR || "storage/tempDoclingResults"
const doclingKeepTempResults = process.env.DOCLING_KEEP_TEMP_RESULTS === "true"
const doclingSchedulerStorageRoot =
  process.env.DOCLING_ASYNC_STORAGE_ROOT ||
  process.env.DOCLING_TEMP_RESULTS_DIR ||
  "storage/doclingAsync"
const knowledgeBaseStorageRoot =
  process.env.KB_STORAGE_ROOT ||
  process.env.XYNE_KB_STORAGE_ROOT ||
  "storage/kb_files"
const doclingSchedulerPollMs = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_POLL_MS,
  1000,
)
const doclingSchedulerLeaseMs = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_LEASE_MS,
  10 * 60 * 1000,
)
const doclingSchedulerSplitConcurrency = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_SPLIT_CONCURRENCY,
  1,
)
const doclingSchedulerActiveOcrFiles = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_ACTIVE_OCR_FILES,
  4,
)
const doclingSchedulerPerFileInflightParts = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_PER_FILE_INFLIGHT_PARTS,
  2,
)
const doclingSchedulerMaxPartAttempts = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_MAX_PART_ATTEMPTS,
  3,
)
const doclingSchedulerMaxWriteAttempts = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_MAX_WRITE_ATTEMPTS,
  5,
)
const doclingSchedulerRetryBaseMs = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_RETRY_BASE_MS,
  30 * 1000,
)
const doclingSchedulerRetryMaxMs = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_RETRY_MAX_MS,
  10 * 60 * 1000,
)
const doclingSchedulerVespaWritePermits = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_VESPA_WRITE_PERMITS,
  1,
)
const doclingSchedulerVespaWritePermitTtlMs = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_VESPA_WRITE_PERMIT_TTL_MS,
  30 * 60 * 1000,
)
const doclingSchedulerVespaWriteTimeoutMs = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_VESPA_WRITE_TIMEOUT_MS,
  5 * 60 * 1000,
)
const doclingSchedulerMaxVespaPayloadBytes = parsePositiveInteger(
  process.env.DOCLING_SCHEDULER_MAX_VESPA_PAYLOAD_BYTES,
  9 * 1024 * 1024,
)
const doclingAsyncPartSubmitConcurrency = parsePositiveInteger(
  process.env.DOCLING_ASYNC_PART_SUBMIT_CONCURRENCY,
  2,
)
const doclingResultConcurrency = parsePositiveInteger(
  process.env.DOCLING_RESULT_CONCURRENCY,
  2,
)
const doclingResultReadCount = parsePositiveInteger(
  process.env.DOCLING_RESULT_READ_COUNT,
  doclingResultConcurrency,
)
const doclingResultBlockMs = parsePositiveInteger(
  process.env.DOCLING_RESULT_BLOCK_MS,
  5000,
)
const doclingResultMinIdleMs = parsePositiveInteger(
  process.env.DOCLING_RESULT_MIN_IDLE_MS,
  600000,
)
const doclingAsyncStateTtlSeconds = parsePositiveInteger(
  process.env.DOCLING_ASYNC_STATE_TTL_SECONDS,
  7 * 24 * 60 * 60,
)
const doclingAsyncApplyLockTtlMs = parsePositiveInteger(
  process.env.DOCLING_ASYNC_APPLY_LOCK_TTL_MS,
  10 * 60 * 1000,
)
const doclingAsyncSubmitPermits = parsePositiveInteger(
  process.env.DOCLING_ASYNC_SUBMIT_PERMITS,
  16,
)
const doclingAsyncSubmitPermitsEnabled =
  process.env.DOCLING_ASYNC_SUBMIT_PERMITS_ENABLED === "true"
const doclingAsyncSubmitPermitLeaseTtlMs = parsePositiveInteger(
  process.env.DOCLING_ASYNC_SUBMIT_PERMIT_LEASE_TTL_MS,
  6 * 60 * 60 * 1000,
)
const doclingAsyncSubmitPermitPollMs = parsePositiveInteger(
  process.env.DOCLING_ASYNC_SUBMIT_PERMIT_POLL_MS,
  3 * 60 * 1000,
)
const doclingAsyncSubmitPermitMaxWaitMs = Math.max(
  0,
  Number.parseInt(
    process.env.DOCLING_ASYNC_SUBMIT_PERMIT_MAX_WAIT_MS || "0",
    10,
  ) || 0,
)
const doclingActiveFileLimit = Math.max(
  0,
  Number.parseInt(process.env.DOCLING_ACTIVE_FILE_LIMIT || "0", 10) || 0,
)
const redisUrl = process.env.REDIS_URL || "redis://redis:6379/0"
const doclingResultsStream =
  process.env.DOCLING_RESULTS_STREAM || "docling:results"
const doclingResultGroup = process.env.DOCLING_RESULT_GROUP || "app-sync"
const doclingSchedulerResultGroup =
  process.env.DOCLING_SCHEDULER_RESULT_GROUP || "app-sync-scheduler"
let syncServerHost = process.env.SYNC_SERVER_HOST || "localhost"

export const parseOCRProviders = (providers?: string): string[] => {
  const seen = new Set<string>()

  return (providers || "")
    .split(",")
    .map((provider) => provider.trim().toLowerCase())
    .filter((provider) => {
      if (!provider || seen.has(provider)) {
        return false
      }

      seen.add(provider)
      return true
    })
}

const ocrProviders = parseOCRProviders(process.env.OCR_PROVIDERS)

// Centralized database URL construction
function getDatabaseUrl(): string {
  return (
    process.env.DATABASE_URL ||
    `postgres://xyne:xyne@${postgresBaseHost}:5432/xyne`
  )
}

let redirectUri = process.env.GOOGLE_REDIRECT_URI!
let postOauthRedirect = "/"
let appleBundleId = process.env.APPLE_BUNDLE_ID || ""
const googleWebLoginEnabled = process.env.GOOGLE_WEB_LOGIN_ENABLED !== "false"
const keycloakWebLoginEnabled = process.env.KEYCLOAK_WEB_ENABLED === "true"
const keycloakPublicBaseUrl = process.env.KEYCLOAK_PUBLIC_BASE_URL || ""
const keycloakInternalBaseUrl =
  process.env.KEYCLOAK_INTERNAL_BASE_URL || keycloakPublicBaseUrl
const keycloakRealm = process.env.KEYCLOAK_REALM || ""
const keycloakClientId = process.env.KEYCLOAK_CLIENT_ID || ""
const keycloakClientSecret = process.env.KEYCLOAK_CLIENT_SECRET || ""
const keycloakWorkspaceExternalId =
  process.env.KEYCLOAK_WORKSPACE_EXTERNAL_ID || ""
const keycloakLogoutRedirectUrl =
  process.env.KEYCLOAK_LOGOUT_REDIRECT_URL || "/auth"

// Vespa configuration constants
export const NAMESPACE = "namespace"
export const CLUSTER = "my_content"

if (process.env.NODE_ENV === "production") {
  postgresBaseHost = process.env.DATABASE_HOST!
  vespaBaseHost = process.env.VESPA_HOST!
  host = process.env.HOST!
  redirectUri = process.env.GOOGLE_PROD_REDIRECT_URI!
}
// Adding this since in dev mode the vite FE is hosted on localhost:5173,
// but server does auth using localhost:3000, so we need to manually redirect to the correct address post oauth
if (process.env.NODE_ENV !== "production") {
  postOauthRedirect = "http://localhost:5173/"
}
let defaultFastModel: Models = "" as Models
let defaultBestModel: Models = "" as Models
let defaultBestModelAgenticMode: Models = "" as Models
//Todo: GLM_FLASH fallback is correct for LiteLLM flow as this model is supported by LiteLLM. Non LiteLLM providers will fail set it's env value as the model ID which is suported by them modelProvider you choose.
let consumerAgentDefaultModel: Models = Object.values(Models).includes(
  process.env["CONSUMER_AGENT_DEFAULT_MODEL"] as Models,
)
  ? (process.env["CONSUMER_AGENT_DEFAULT_MODEL"] as Models)
  : Models.GLM_FLASH
let defaultDeepResearchModel: Models = Models.o3_Deep_Research
let defaultWebSearchModel: Models = "" as Models
let AwsAccessKey = ""
let AwsSecretKey = ""
let OpenAIKey = ""
let OllamaModel = ""
let TogetherAIModel = ""
let FireworksAIModel = ""
let GeminiAIModel = ""
let TogetherApiKey = ""
let FireworksApiKey = ""
let GeminiApiKey = ""
let VertexProjectId = ""
let VertexRegion = ""
let VertexAIModel = ""
let aiProviderBaseUrl = ""
let isReasoning = false
let sqlInferenceModel = ""
let LiteLLMApiKey = ""
let LiteLLMModel = ""
let LiteLLMBaseUrl = ""
const LiteLLMModelInfoUrl = process.env.LITELLM_MODEL_INFO_URL
const LiteLLMModelConfigPath = process.env.LITELLM_MODEL_CONFIG_PATH
const allowSonnet46 = process.env.ALLOW_SONNET_4_6 === "true"
const allowOpus46 = process.env.ALLOW_OPUS_4_6 === "true"
const allowHaiku45 = process.env.ALLOW_HAIKU_4_5 === "true"
const useAgenticFiltering = process.env.USE_AGENTIC_FILTERING === "true"
const enableJaf = process.env.ENABLE_JAF === "true"
const modelList = process.env.MODELS_LIST
const enableImages = process.env.ENABLE_IMAGES === "true"
const disableIntegrationSyncWorkers =
  process.env.DISABLE_INTEGRATION_SYNC_WORKERS === "true"

// Pi-mono sessions directory
const piMonoSessionsDir =
  process.env.PI_MONO_SESSIONS_DIR || "./data/pi-mono-sessions"
// File processing worker configuration
let fileProcessingWorkerThreads = parseInt(
  process.env.FILE_PROCESSING_WORKER_THREADS || "4",
  10,
)
let fileProcessingTeamSize = parseInt(
  process.env.FILE_PROCESSING_TEAM_SIZE || "4",
  10,
)
let pdfFileProcessingWorkerThreads = parseInt(
  process.env.PDF_FILE_PROCESSING_WORKER_THREADS || "2",
  10,
)
let pdfFileProcessingTeamSize = parseInt(
  process.env.PDF_FILE_PROCESSING_TEAM_SIZE || "2",
  10,
)
let fastModelReasoning = false
let slackHost = process.env.SLACK_HOST
let VESPA_NAMESPACE = "my_content"
let ragOffFeature = true
let useLegacyServiceAccountSync =
  process.env.USE_LEGACY_SERVICE_ACCOUNT_SYNC === "true"
let useLegacySlackSync = process.env.USE_LEGACY_SLACK_SYNC === "true"
let delegationAgentic = "true"
let CurrentAuthType: AuthType =
  (process.env.AUTH_TYPE as AuthType) || AuthType.OAuth
let ZohoClientId = process.env.ZOHO_CLIENT_ID || ""
let ZohoClientSecret = process.env.ZOHO_CLIENT_SECRET || ""
let ZohoOrgId = process.env.ZOHO_ORG_ID || ""
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024
const MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES = 3 * 1024 // 3KB - generous limit for service account JSON files
const AccessTokenCookie = "access-token"

// Four-layer memory architecture (agentic RAG)
export const MEMORY_CONFIG = {
  WORKING_MEMORY_MESSAGES: parseInt(
    process.env.WORKING_MEMORY_MESSAGES || "6",
    10,
  ),
  MAX_CHAT_MEMORY_CHUNKS: 6,
  MAX_EPISODIC_MEMORIES: 6,
}
export const IMAGE_CONTEXT_CONFIG = {
  enabled: enableImages, // Enable image context tracking by default
  recencyWindow: 2, // Keep images from last 2 turns
  maxImagesPerCall: 5, // 0 = no limit, pass all recent images
  alwaysIncludeAttachments: enableImages,
  maxImagesPerFile: 2,
}

// LangFuse configuration
let langfusePublicKey = process.env["LANGFUSE_PUBLIC_KEY"]?.trim() || ""
let langfuseSecretKey = process.env["LANGFUSE_SECRET_KEY"]?.trim() || ""
let langfuseBaseUrl =
  process.env["LANGFUSE_BASE_URL"]?.trim() || "http://localhost:3003"
let langfuseEnabled = process.env["LANGFUSE_ENABLED"] === "true"
// TODO:
// instead of TOGETHER_MODEL, OLLAMA_MODEL we should just have MODEL if present means they are selecting the model
// since even docs have to be updated we can make this change in one go including that, so will be done later

// Priority (AWS > OpenAI > Ollama > Together > Fireworks > Gemini > Vertex)
// Using if-else logic to ensure only ONE provider is active at a time
if (process.env["AWS_ACCESS_KEY"] && process.env["AWS_SECRET_KEY"]) {
  AwsAccessKey = process.env["AWS_ACCESS_KEY"]
  AwsSecretKey = process.env["AWS_SECRET_KEY"]
  defaultFastModel = Models.Claude_3_5_Haiku
  defaultBestModel = Models.Claude_Sonnet_4
  sqlInferenceModel = Models.Claude_Sonnet_4
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = Models.DeepSeek_R1
  }
  defaultWebSearchModel = Models.Claude_3_5_Sonnet
} else if (process.env["OPENAI_API_KEY"]) {
  if (process.env["BASE_URL"]) {
    if (!isURLValid(process.env["BASE_URL"])) {
      console.warn(`Configuration Warning : Encountered invalid base url`)
    } else {
      aiProviderBaseUrl = process.env["BASE_URL"]
    }
  }
  OpenAIKey = process.env["OPENAI_API_KEY"]
  defaultFastModel = Models.Gpt_4o_mini
  defaultBestModel = Models.Gpt_4o
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = Models.o3_Deep_Research
  }
  defaultWebSearchModel = Models.Gpt_4o
} else if (process.env["OLLAMA_MODEL"]) {
  if (process.env["BASE_URL"]) {
    if (!isURLValid(process.env["BASE_URL"])) {
      console.warn(`Configuration Warning : Encountered invalid base url`)
    } else {
      aiProviderBaseUrl = process.env["BASE_URL"]
    }
  }
  OllamaModel = process.env["OLLAMA_MODEL"]
  defaultFastModel = process.env["OLLAMA_FAST_MODEL"]
    ? (process.env["OLLAMA_FAST_MODEL"] as Models)
    : (OllamaModel as Models)
  defaultBestModel = OllamaModel as Models
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = OllamaModel as Models
  }
  defaultWebSearchModel = OllamaModel as Models
} else if (process.env["TOGETHER_MODEL"] && process.env["TOGETHER_API_KEY"]) {
  TogetherAIModel = process.env["TOGETHER_MODEL"]
  TogetherApiKey = process.env["TOGETHER_API_KEY"]
  defaultFastModel = process.env["TOGETHER_FAST_MODEL"]
    ? (process.env["TOGETHER_FAST_MODEL"] as Models)
    : (TogetherAIModel as Models)
  defaultBestModel = TogetherAIModel as Models
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = TogetherAIModel as Models
  }
  defaultWebSearchModel = TogetherAIModel as Models
  if (process.env["BASE_URL"]) {
    if (!isURLValid(process.env["BASE_URL"])) {
      console.warn(`Configuration Warning : Encountered invalid base url`)
    } else {
      aiProviderBaseUrl = process.env["BASE_URL"]
    }
  }
} else if (process.env["FIREWORKS_MODEL"] && process.env["FIREWORKS_API_KEY"]) {
  FireworksAIModel = process.env["FIREWORKS_MODEL"] as Models
  FireworksApiKey = process.env["FIREWORKS_API_KEY"]
  defaultFastModel = process.env["FIREWORKS_FAST_MODEL"]
    ? (process.env["FIREWORKS_FAST_MODEL"] as Models)
    : (FireworksAIModel as Models)
  defaultBestModel = FireworksAIModel as Models
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = FireworksAIModel as Models
  }
  defaultWebSearchModel = FireworksAIModel as Models
} else if (process.env["GEMINI_MODEL"] && process.env["GEMINI_API_KEY"]) {
  GeminiAIModel = process.env["GEMINI_MODEL"] as Models
  GeminiApiKey = process.env["GEMINI_API_KEY"]
  defaultFastModel = process.env["GEMINI_FAST_MODEL"]
    ? (process.env["GEMINI_FAST_MODEL"] as Models)
    : (GeminiAIModel as Models)
  defaultBestModel = GeminiAIModel as Models
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = GeminiAIModel as Models
  }
  defaultWebSearchModel = GeminiAIModel as Models
} else if (process.env["VERTEX_PROJECT_ID"] && process.env["VERTEX_REGION"]) {
  VertexProjectId = process.env["VERTEX_PROJECT_ID"]
  VertexRegion = process.env["VERTEX_REGION"]
  // Set default models for Vertex AI (no longer requiring VERTEX_AI_MODEL to be set)
  defaultFastModel = process.env["VERTEX_FAST_MODEL"]
    ? (process.env["VERTEX_FAST_MODEL"] as Models)
    : Models.Vertex_Claude_Sonnet_4 // Default fast model
  defaultBestModel = process.env["VERTEX_BEST_MODEL"]
    ? (process.env["VERTEX_BEST_MODEL"] as Models)
    : Models.Vertex_Claude_Sonnet_4 // Default best model
  sqlInferenceModel = Models.Vertex_Claude_Sonnet_4
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = Models.Vertex_Gemini_2_5_Pro
  }
  defaultWebSearchModel = Models.Vertex_Gemini_2_5_Flash
} else if (process.env["LITELLM_API_KEY"]) {
  if (process.env["LITELLM_BASE_URL"]) {
    if (!isURLValid(process.env["LITELLM_BASE_URL"])) {
      console.warn(`Configuration Warning : Encountered invalid base url`)
    } else {
      LiteLLMBaseUrl = process.env["LITELLM_BASE_URL"]
    }
  }
  LiteLLMApiKey = process.env["LITELLM_API_KEY"]
  defaultBestModelAgenticMode = process.env["LITELLM_BEST_AGENTIC_MODEL"]
    ? (process.env["LITELLM_BEST_AGENTIC_MODEL"] as Models)
    : Models.OPEN_LARGE
  // Set default models for LiteLLM (no longer requiring LITELLM_MODEL to be set)
  defaultFastModel = process.env["LITELLM_FAST_MODEL"]
    ? (process.env["LITELLM_FAST_MODEL"] as Models)
    : Models.OPEN_FAST // Default fast model
  defaultBestModel = process.env["LITELLM_BEST_MODEL"]
    ? (process.env["LITELLM_BEST_MODEL"] as Models)
    : Models.OPEN_LARGE // Default best model
  sqlInferenceModel = process.env["LITELLM_SQL_INFERENCE_MODEL"]
    ? (process.env["LITELLM_SQL_INFERENCE_MODEL"] as Models)
    : Models.OPEN_LARGE // Default sql inference model
  if (defaultDeepResearchModel === ("" as Models)) {
    defaultDeepResearchModel = process.env["LITELLM_DEEP_RESEARCH_MODEL"]
      ? (process.env["LITELLM_DEEP_RESEARCH_MODEL"] as Models)
      : Models.OPEN_LARGE // Default deep research model
  }
  defaultWebSearchModel = process.env["LITELLM_WEB_SEARCH_MODEL"]
    ? (process.env["LITELLM_WEB_SEARCH_MODEL"] as Models)
    : Models.LiteLLM_Gemini_3_Flash // Default web search model
}
let StartThinkingToken = "<think>"
let EndThinkingToken = "</think>"

if (process.env["REASONING"] === "true") {
  isReasoning = true
}

if (process.env["RAG_OFF_FEATURE"] === "true") {
  ragOffFeature = true
}

if (!slackHost) {
  slackHost = host
}
export default {
  // default page size for regular search
  page: 8,
  // default page size for default search over answers
  answerPage: 12,
  // the max token length of input tokens before
  // we clean up using the metadata
  maxTokenBeforeMetadataCleanup: 3000,
  JwtPayloadKey: "jwtPayload",
  vespaBaseHost,
  postgresBaseHost,
  port,
  metricsPort,
  syncServerPort,
  syncServerHost,
  host,
  vespaFeedPort,
  vespaQueryPort,
  // slack oauth does not work on http
  slackHost,
  AwsAccessKey,
  AwsSecretKey,
  OpenAIKey,
  OllamaModel,
  TogetherAIModel,
  TogetherApiKey,
  FireworksAIModel,
  FireworksApiKey,
  GeminiAIModel,
  GeminiApiKey,
  VertexAIModel,
  sqlInferenceModel,
  VertexProjectId,
  VertexRegion,
  LiteLLMApiKey,
  LiteLLMModel,
  LiteLLMBaseUrl,
  LiteLLMModelInfoUrl,
  LiteLLMModelConfigPath,
  allowSonnet46,
  allowOpus46,
  allowHaiku45,
  aiProviderBaseUrl,
  redirectUri,
  postOauthRedirect,
  googleWebLoginEnabled,
  keycloakWebLoginEnabled,
  keycloakPublicBaseUrl,
  keycloakInternalBaseUrl,
  keycloakRealm,
  keycloakClientId,
  keycloakClientSecret,
  keycloakWorkspaceExternalId,
  keycloakLogoutRedirectUrl,
  paddleStatusEndpoint,
  doclingServiceUrl,
  doclingEnabled,
  doclingAsyncEnabled,
  doclingAsyncSchedulerEnabled,
  pdfProcessingDisableFallbacks,
  maxPdfPageCount,
  doclingPageChunkSize,
  doclingStreamingMinPages,
  doclingTempResultsDir,
  doclingKeepTempResults,
  doclingSchedulerStorageRoot,
  knowledgeBaseStorageRoot,
  doclingSchedulerPollMs,
  doclingSchedulerLeaseMs,
  doclingSchedulerSplitConcurrency,
  doclingSchedulerActiveOcrFiles,
  doclingSchedulerPerFileInflightParts,
  doclingSchedulerMaxPartAttempts,
  doclingSchedulerMaxWriteAttempts,
  doclingSchedulerRetryBaseMs,
  doclingSchedulerRetryMaxMs,
  doclingSchedulerVespaWritePermits,
  doclingSchedulerVespaWritePermitTtlMs,
  doclingSchedulerVespaWriteTimeoutMs,
  doclingSchedulerMaxVespaPayloadBytes,
  doclingAsyncPartSubmitConcurrency,
  doclingResultConcurrency,
  doclingResultReadCount,
  doclingResultBlockMs,
  doclingResultMinIdleMs,
  doclingAsyncStateTtlSeconds,
  doclingAsyncApplyLockTtlMs,
  doclingAsyncSubmitPermits,
  doclingAsyncSubmitPermitsEnabled,
  doclingAsyncSubmitPermitLeaseTtlMs,
  doclingAsyncSubmitPermitPollMs,
  doclingAsyncSubmitPermitMaxWaitMs,
  doclingActiveFileLimit,
  redisUrl,
  doclingResultsStream,
  doclingResultGroup,
  doclingSchedulerResultGroup,
  ocrProviders,
  appleBundleId,
  // update user query session time
  userQueryUpdateInterval: 60 * 1000, // 1 minute
  defaultBestModel,
  defaultBestModelAgenticMode,
  consumerAgentDefaultModel,
  defaultFastModel,
  defaultDeepResearchModel,
  defaultWebSearchModel,
  vespaMaxRetryAttempts: parseInt(
    process.env.VESPA_MAX_RETRY_ATTEMPTS || "8",
    10,
  ),
  vespaRetryDelay: parseInt(process.env.VESPA_RETRY_DELAY_MS || "1000", 10),
  vespaDocumentUpdateTimeout:
    process.env.VESPA_DOCUMENT_UPDATE_TIMEOUT || "900s",
  vespaDocumentUpdateFetchTimeoutMs: parseInt(
    process.env.VESPA_DOCUMENT_UPDATE_FETCH_TIMEOUT_MS || "960000",
    10,
  ),
  chatHistoryPageSize: 21,
  maxDefaultSummary: 6, // Reduced from 15 to limit context per document
  maxChunksPerTool: 50,
  maxChunksPerPage: 200,
  chatPageSize: 20, // default page size for ai search
  VespaPageSize: 20, // default page size for vespa search
  maxGoogleDriveSummary: 50,
  maxUserRequestCount: 15,
  isReasoning,
  fastModelReasoning,
  StartThinkingToken,
  EndThinkingToken,
  JobExpiryHours: 23,
  maxValidLinks: 15,
  isDebugMode: process.env.XYNE_DEBUG_MODE === "true",
  VESPA_NAMESPACE,
  agentWhiteList: (process.env.AGENT_WHITELIST || "")
    .split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0),
  llmTimeFormat: "YYYY-MM-DDTHH:mm:ss.SSS+05:30",
  ragOffFeature,
  AccessTokenTTL: 60 * 60, // Access token expires in 1 hour
  RefreshTokenTTL: 60 * 60 * 24 * 30, // Refresh token expires in 30 days
  MAX_IMAGE_SIZE_BYTES,
  MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES,
  vespaEndpoint: {
    feedEndpoint: `http://${vespaBaseHost}:${vespaFeedPort}`,
    queryEndpoint: `http://${vespaBaseHost}:${vespaQueryPort}`,
  },
  defaultRecencyDecayRate: 0.1, // Decay rate for recency scoring in Vespa searches
  CurrentAuthType,
  getDatabaseUrl,
  AccessTokenCookie,
  fileProcessingWorkerThreads,
  fileProcessingTeamSize,
  pdfFileProcessingWorkerThreads,
  pdfFileProcessingTeamSize,
  disableIntegrationSyncWorkers,
  useLegacyServiceAccountSync,
  useLegacySlackSync,
  // LangFuse configuration
  langfusePublicKey,
  langfuseSecretKey,
  langfuseBaseUrl,
  langfuseEnabled,
  IMAGE_CONTEXT_CONFIG,
  MEMORY_CONFIG,
  delegation_agentic: delegationAgentic,
  ZohoClientId,
  ZohoClientSecret,
  ZohoOrgId,
  useAgenticFiltering,
  modelList,
  piMonoSessionsDir,
  enableJaf,
}
