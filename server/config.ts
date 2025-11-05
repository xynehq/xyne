import { isURLValid } from "@/validate"
import { Models } from "@/ai/types"
import { AuthType } from "./shared/types"
let vespaBaseHost = "0.0.0.0"
let vespaPort = process.env.VESPA_PORT || 8080
let postgresBaseHost = "0.0.0.0"
let port = process.env.PORT || 3000
let metricsPort = process.env.METRICS_PORT || 3001
let syncServerPort = process.env.SYNC_SERVER_PORT || 3010
let host = process.env.HOST || "http://localhost:3000"
let paddleStatusEndpoint =
  process.env.STATUS_ENDPOINT || "http://localhost:8000/instance_status"
let syncServerHost = process.env.SYNC_SERVER_HOST || "localhost"

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
let CurrentAuthType: AuthType =
  (process.env.AUTH_TYPE as AuthType) || AuthType.OAuth
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024
const MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES = 3 * 1024 // 3KB - generous limit for service account JSON files
const AccessTokenCookie = "access-token"

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
} else if (process.env["TOGETHER_MODEL"] && process.env["TOGETHER_API_KEY"]) {
  TogetherAIModel = process.env["TOGETHER_MODEL"]
  TogetherApiKey = process.env["TOGETHER_API_KEY"]
  defaultFastModel = process.env["TOGETHER_FAST_MODEL"]
    ? (process.env["TOGETHER_FAST_MODEL"] as Models)
    : (TogetherAIModel as Models)
  defaultBestModel = TogetherAIModel as Models
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
} else if (process.env["GEMINI_MODEL"] && process.env["GEMINI_API_KEY"]) {
  GeminiAIModel = process.env["GEMINI_MODEL"] as Models
  GeminiApiKey = process.env["GEMINI_API_KEY"]
  defaultFastModel = process.env["GEMINI_FAST_MODEL"]
    ? (process.env["GEMINI_FAST_MODEL"] as Models)
    : (GeminiAIModel as Models)
  defaultBestModel = GeminiAIModel as Models
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
}
let StartThinkingToken = "<think>"
let EndThinkingToken = "</think>"

if (process.env["REASONING"] === "true") {
  isReasoning = true
}

if (process.env["RAG_OFF_FEATURE"] === "true") {
  ragOffFeature = true
}

if (
  process.env["FAST_MODEL_REASONING"] &&
  process.env["FAST_MODEL_REASONING"] === "true"
) {
  fastModelReasoning = true
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
  vespaPort,
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
  aiProviderBaseUrl,
  redirectUri,
  postOauthRedirect,
  paddleStatusEndpoint,
  appleBundleId,
  // update user query session time
  userQueryUpdateInterval: 60 * 1000, // 1 minute
  defaultBestModel,
  defaultFastModel,
  vespaMaxRetryAttempts: 3,
  vespaRetryDelay: 1000, // 1 sec
  chatHistoryPageSize: 21,
  maxDefaultSummary: 10,
  chatPageSize: 20, // default page size for ai search
  VespaPageSize: 20, // default page size for vespa search
  maxGoogleDriveSummary: 50,
  maxUserRequestCount: 50,
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
  vespaEndpoint: `http://${vespaBaseHost}:8080`,
  defaultRecencyDecayRate: 0.1, // Decay rate for recency scoring in Vespa searches
  CurrentAuthType,
  getDatabaseUrl,
  AccessTokenCookie,
  fileProcessingWorkerThreads,
  fileProcessingTeamSize,
  pdfFileProcessingWorkerThreads,
  pdfFileProcessingTeamSize,
  useLegacyServiceAccountSync,
  useLegacySlackSync,
  // LangFuse configuration
  langfusePublicKey,
  langfuseSecretKey,
  langfuseBaseUrl,
  langfuseEnabled,
}
