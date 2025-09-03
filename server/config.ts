import { isURLValid } from "@/validate"
import { Models } from "@/ai/types"
let vespaBaseHost = "0.0.0.0"
let postgresBaseHost = "0.0.0.0"
let port = process.env.PORT || 3000
let metricsPort = process.env.METRICS_PORT || 3001
let host = process.env.HOST || "http://localhost:3000"
let redirectUri = process.env.GOOGLE_REDIRECT_URI!
let postOauthRedirect = "/"
if (process.env.NODE_ENV === "production") {
  postgresBaseHost = process.env.DATABASE_HOST!
  vespaBaseHost = process.env.VESPA_HOST!
  port = 80
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
let fastModelReasoning = false
let slackHost = process.env.SLACK_HOST
let VESPA_NAMESPACE = "my_content"
let ragOffFeature = true
const MAX_IMAGE_SIZE_BYTES = 4 * 1024 * 1024
const MAX_SERVICE_ACCOUNT_FILE_SIZE_BYTES = 3 * 1024 // 3KB - generous limit for service account JSON files
// TODO:
// instead of TOGETHER_MODEL, OLLAMA_MODEL we should just have MODEL if present means they are selecting the model
// since even docs have to be updated we can make this change in one go including that, so will be done later

// Priority (AWS > OpenAI > Ollama > Together > Fireworks > Gemini)
if (process.env["AWS_ACCESS_KEY"] && process.env["AWS_SECRET_KEY"]) {
  AwsAccessKey = process.env["AWS_ACCESS_KEY"]
  AwsSecretKey = process.env["AWS_SECRET_KEY"]
  defaultFastModel = Models.Claude_3_5_Haiku
  defaultBestModel = Models.Claude_Sonnet_4
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
  VertexAIModel = process.env["VERTEX_AI_MODEL"] as Models
  VertexProjectId = process.env["VERTEX_PROJECT_ID"]
  VertexRegion = process.env["VERTEX_REGION"]
  defaultFastModel = process.env["VERTEX_FAST_MODEL"]
    ? (process.env["VERTEX_FAST_MODEL"] as Models)
    : (VertexAIModel as Models)
  defaultBestModel = VertexAIModel as Models
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

// TODO: Implement multi-provider support.
// Allow dynamic model selection based on current use case:
// - Use OpenAI models for deep-research
// - Use Vertex models for general chat and web-search
if (process.env["VERTEX_PROJECT_ID"] && process.env["VERTEX_REGION"]) {
  VertexAIModel = process.env["VERTEX_AI_MODEL"] as Models
  VertexProjectId = process.env["VERTEX_PROJECT_ID"]
  VertexRegion = process.env["VERTEX_REGION"]
  defaultFastModel = process.env["VERTEX_FAST_MODEL"]
    ? (process.env["VERTEX_FAST_MODEL"] as Models)
    : (VertexAIModel as Models)
  defaultBestModel = VertexAIModel as Models
}

if (process.env["OPENAI_API_KEY"]) {
  if (process.env["BASE_URL"]) {
    if (!isURLValid(process.env["BASE_URL"])) {
      console.warn(`Configuration Warning : Encountered invalid base url`)
    } else {
      aiProviderBaseUrl = process.env["BASE_URL"]
    }
  }
  OpenAIKey = process.env["OPENAI_API_KEY"]
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
  host,
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
  VertexProjectId,
  VertexRegion,
  aiProviderBaseUrl,
  redirectUri,
  postOauthRedirect,
  // update user query session time
  userQueryUpdateInterval: 60 * 1000, // 1 minute
  defaultBestModel,
  defaultFastModel,
  vespaMaxRetryAttempts: 3,
  vespaRetryDelay: 1000, // 1 sec
  chatHistoryPageSize: 21,
  maxDefaultSummary: 6,
  chatPageSize: 20, // default page size for ai search
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
}
